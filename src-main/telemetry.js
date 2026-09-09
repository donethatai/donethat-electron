const os = require('os')
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const TELEMETRY_SCHEMA_VERSION = 1
const MAX_COMPLETED_QUEUE = 24
const MAX_LOG_ENTRIES_PER_CYCLE = 100
// Only the tail of the previous session is worth carrying over. A full queue
// would take two hours to drain at one record per capture cycle, and by then
// the interesting part - the cycles just before the process died - is stale.
const MAX_RESTORED_CYCLES = 8
// The backlog is rewritten in place, so this is a throughput knob, not a cap on
// how much we keep: one write a minute of a ~200KB file.
const BACKLOG_WRITE_INTERVAL_MS = 60 * 1000
const BACKLOG_FILE = 'telemetry-backlog.json'
const MAX_LOG_MESSAGE_CHARS = 600
const MAX_LOG_META_LENGTH = 240

let pendingAggregate = createAggregate()
let activeCycle = null
const pendingLogs = []
const completedQueue = []
let cycleSeq = 0

const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
let backlogPath = null
let backlogDirty = false
let backlogWriteTimer = null
let shutdownRecorded = false
let backlogTmpSeq = 0

function createAggregate() {
  return {
    permissionChecks: Object.create(null),
    screenLock: Object.create(null),
    audioRestart: Object.create(null),
    activeWindowProbeTimeoutCount: 0,
    captureCycleSkippedOverlapCount: 0,
    localQuotaCooldownSkipCount: 0,
    localBudgetExceededCount: 0
  }
}

function cloneAggregate(source) {
  return {
    permissionChecks: { ...source.permissionChecks },
    screenLock: { ...source.screenLock },
    audioRestart: { ...source.audioRestart },
    activeWindowProbeTimeoutCount: source.activeWindowProbeTimeoutCount || 0,
    captureCycleSkippedOverlapCount: source.captureCycleSkippedOverlapCount || 0,
    localQuotaCooldownSkipCount: source.localQuotaCooldownSkipCount || 0,
    localBudgetExceededCount: source.localBudgetExceededCount || 0
  }
}

function resetAggregate(target) {
  target.permissionChecks = Object.create(null)
  target.screenLock = Object.create(null)
  target.audioRestart = Object.create(null)
  target.activeWindowProbeTimeoutCount = 0
  target.captureCycleSkippedOverlapCount = 0
  target.localQuotaCooldownSkipCount = 0
  target.localBudgetExceededCount = 0
}

function getTargetAggregate() {
  return activeCycle ? activeCycle.aggregate : pendingAggregate
}

function trimLogs(logs) {
  while (logs.length > MAX_LOG_ENTRIES_PER_CYCLE) {
    logs.shift()
  }
}

function cloneLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return []
  return logs.slice(-MAX_LOG_ENTRIES_PER_CYCLE)
}

function getTargetLogs() {
  return activeCycle && Array.isArray(activeCycle.logs)
    ? activeCycle.logs
    : pendingLogs
}

function parsePositiveNumber(value, fallback = 0) {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return fallback
  return num
}

function clampString(value, fallback = 'unknown', maxLen = 64) {
  const raw = (value === undefined || value === null) ? '' : String(value).trim()
  if (!raw) return fallback
  return raw.slice(0, maxLen)
}

function redactSensitiveText(text) {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/=]+/gi, '$1[REDACTED]')
    .replace(/((?:idToken|accessToken|refreshToken|authorization)\s*[:=]\s*)[^,\s]+/gi, '$1[REDACTED]')
}

function formatLogMessage(message) {
  let out = ''
  if (typeof message === 'string') {
    out = message
  } else if (message instanceof Error) {
    out = `${message.name}: ${message.message}`
  } else {
    try {
      out = JSON.stringify(message)
    } catch (_) {
      out = String(message)
    }
  }
  out = redactSensitiveText(out)
  return out.slice(0, MAX_LOG_MESSAGE_CHARS)
}

function sanitizeMeta(meta = {}) {
  const result = {}
  if (!meta || typeof meta !== 'object') return result
  for (const [key, value] of Object.entries(meta)) {
    const cleanKey = clampString(key, '', 32)
    if (!cleanKey) continue
    const cleanValue = redactSensitiveText(String(value ?? '')).slice(0, MAX_LOG_META_LENGTH)
    result[cleanKey] = cleanValue
  }
  return result
}

function recordLog(level, source, message, meta = null) {
  const logs = getTargetLogs()
  const entry = {
    ts: Date.now(),
    level: clampString(level, 'info', 16),
    source: clampString(source, 'unknown', 80),
    message: formatLogMessage(message)
  }
  if (meta && typeof meta === 'object') {
    const cleanedMeta = sanitizeMeta(meta)
    if (Object.keys(cleanedMeta).length > 0) {
      entry.meta = cleanedMeta
    }
  }
  logs.push(entry)
  trimLogs(logs)
  markBacklogDirty()
}

function recordSignal(name, fields = {}) {
  const signalName = clampString(name, 'unknown', 64)
  if (!signalName || signalName === 'unknown') return
  recordLog('info', 'signal', `signal:${signalName}`, fields)
}

function getAppVersion() {
  try {
    return app?.getVersion?.() || 'unknown'
  } catch (_) {
    return 'unknown'
  }
}

function mapToArray(mapObj, mapper) {
  return Object.keys(mapObj)
    .sort()
    .map((key) => mapper(key, mapObj[key]))
}

function beginCycle(metadata = {}) {
  cycleSeq += 1
  const now = Date.now()
  const mergedAggregate = cloneAggregate(pendingAggregate)
  resetAggregate(pendingAggregate)

  activeCycle = {
    id: cycleSeq,
    startedAt: now,
    phaseDurationsMs: Object.create(null),
    metadata: {
      captureIntervalMin: parsePositiveNumber(metadata.captureIntervalMin, 0)
    },
    aggregate: mergedAggregate,
    logs: cloneLogs(pendingLogs)
  }
  pendingLogs.length = 0
  trimLogs(activeCycle.logs)
}

function recordCyclePhaseDuration(phase, durationMs) {
  if (!activeCycle) return
  const phaseName = clampString(phase, 'unknown', 48)
  const duration = Math.round(parsePositiveNumber(durationMs, 0))
  if (duration <= 0) return
  activeCycle.phaseDurationsMs[phaseName] = (activeCycle.phaseDurationsMs[phaseName] || 0) + duration
}

function recordPermissionCheck(type, source, result, durationMs = 0) {
  const target = getTargetAggregate()
  const permissionType = clampString(type, 'unknown', 32)
  const checkSource = clampString(source, 'unknown', 48)
  const checkResult = clampString(result, 'unknown', 32)
  const key = `${permissionType}|${checkSource}|${checkResult}`
  if (!target.permissionChecks[key]) {
    target.permissionChecks[key] = { count: 0, durationMs: 0 }
  }
  target.permissionChecks[key].count += 1
  target.permissionChecks[key].durationMs += Math.round(parsePositiveNumber(durationMs, 0))
}

function recordScreenLock(caller, waitMs, timedOut) {
  const target = getTargetAggregate()
  const callerName = clampString(caller, 'unknown', 48)
  if (!target.screenLock[callerName]) {
    target.screenLock[callerName] = {
      count: 0,
      timeoutCount: 0,
      totalWaitMs: 0,
      maxWaitMs: 0
    }
  }
  const entry = target.screenLock[callerName]
  const wait = Math.round(parsePositiveNumber(waitMs, 0))
  entry.count += 1
  if (timedOut) {
    entry.timeoutCount += 1
  }
  entry.totalWaitMs += wait
  if (wait > entry.maxWaitMs) {
    entry.maxWaitMs = wait
  }
}

function recordAudioRestart(reason, action) {
  const target = getTargetAggregate()
  const restartReason = clampString(reason, 'unknown', 48)
  const restartAction = clampString(action, 'unknown', 32)
  const key = `${restartReason}|${restartAction}`
  if (!target.audioRestart[key]) {
    target.audioRestart[key] = { count: 0 }
  }
  target.audioRestart[key].count += 1
}

function recordActiveWindowProbeTimeout() {
  const target = getTargetAggregate()
  target.activeWindowProbeTimeoutCount += 1
}

function recordCaptureCycleSkippedOverlap() {
  const target = getTargetAggregate()
  target.captureCycleSkippedOverlapCount += 1
}

function recordLocalQuotaCooldownSkip() {
  const target = getTargetAggregate()
  target.localQuotaCooldownSkipCount += 1
}

function recordLocalBudgetExceeded() {
  const target = getTargetAggregate()
  target.localBudgetExceededCount += 1
}

function endCycle(metadata = {}) {
  if (!activeCycle) {
    return null
  }

  const finishedAt = Date.now()
  const memoryUsage = process.memoryUsage ? process.memoryUsage() : null
  const aggregate = activeCycle.aggregate

  const telemetry = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    cycleId: activeCycle.id,
    cycleStartedAt: activeCycle.startedAt,
    cycleEndedAt: finishedAt,
    captureCycleDurationMs: Math.max(0, finishedAt - activeCycle.startedAt),
    dimensions: {
      appVersion: getAppVersion(),
      platform: process.platform,
      os: `${os.platform()} ${os.release()}`,
      arch: process.arch,
      captureIntervalMin: activeCycle.metadata.captureIntervalMin || null
    },
    phaseDurationsMs: { ...activeCycle.phaseDurationsMs },
    counters: {
      permissionChecks: mapToArray(aggregate.permissionChecks, (key, value) => {
        const [type, source, result] = key.split('|')
        return {
          type,
          source,
          result,
          count: value.count,
          totalDurationMs: value.durationMs
        }
      }),
      screenLock: mapToArray(aggregate.screenLock, (caller, value) => ({
        caller,
        count: value.count,
        timeoutCount: value.timeoutCount,
        totalWaitMs: value.totalWaitMs,
        maxWaitMs: value.maxWaitMs
      })),
      audioRestart: mapToArray(aggregate.audioRestart, (key, value) => {
        const [reason, action] = key.split('|')
        return {
          reason,
          action,
          count: value.count
        }
      }),
      activeWindowProbeTimeoutCount: aggregate.activeWindowProbeTimeoutCount,
      captureCycleSkippedOverlapCount: aggregate.captureCycleSkippedOverlapCount,
      localQuotaCooldownSkipCount: aggregate.localQuotaCooldownSkipCount,
      localBudgetExceededCount: aggregate.localBudgetExceededCount
    },
    memoryMb: {
      rss: memoryUsage ? Math.round((memoryUsage.rss / (1024 * 1024)) * 100) / 100 : null,
      heapUsed: memoryUsage ? Math.round((memoryUsage.heapUsed / (1024 * 1024)) * 100) / 100 : null,
      external: memoryUsage ? Math.round((memoryUsage.external / (1024 * 1024)) * 100) / 100 : null
    },
    logs: Array.isArray(activeCycle.logs)
      ? activeCycle.logs.slice(-MAX_LOG_ENTRIES_PER_CYCLE)
      : [],
    outcome: {
      status: clampString(metadata.status, 'unknown', 32),
      authError: !!metadata.authError,
      tokenExpired: !!metadata.tokenExpired
    }
  }

  completedQueue.push(telemetry)
  if (completedQueue.length > MAX_COMPLETED_QUEUE) {
    completedQueue.shift()
  }

  activeCycle = null
  markBacklogDirty()
  return telemetry
}

// ---------------------------------------------------------------------------
// Crash-survivable backlog
//
// Completed telemetry rides out on the next capture send, so anything still
// queued when the process ends is lost - and the cycles right before an
// unexpected exit are exactly the ones worth reading. The same goes for
// `pendingLogs`, which holds everything that happened after the last cycle
// closed. Both are mirrored to disk so the next launch can ship them.
// ---------------------------------------------------------------------------

function resolveBacklogPath() {
  if (backlogPath) return backlogPath
  try {
    backlogPath = path.join(app.getPath('userData'), BACKLOG_FILE)
  } catch (_) {
    // getPath throws before the app is ready; the caller retries next tick.
    return null
  }
  return backlogPath
}

/** The slice worth keeping: recent completed cycles plus the un-closed tail. */
function buildBacklogSnapshot(cleanShutdown) {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    sessionId,
    savedAt: Date.now(),
    cleanShutdown: !!cleanShutdown,
    appVersion: getAppVersion(),
    queue: completedQueue.slice(-MAX_RESTORED_CYCLES),
    // Logs recorded since the last cycle closed. On a clean run this is a few
    // heartbeats; after a stall it is the whole record of what went wrong.
    tailLogs: cloneLogs(activeCycle ? activeCycle.logs : pendingLogs)
  }
}

/**
 * Each write gets its own scratch file. The shutdown flush can land while a
 * timed write is still in flight, and sharing one temp path let the two
 * interleave into a file that parsed as nothing.
 */
function nextBacklogTmpPath(target) {
  backlogTmpSeq += 1
  return `${target}.${process.pid}.${backlogTmpSeq}.tmp`
}

/** Atomic so a kill mid-write cannot leave an unparseable file behind. */
function writeBacklogSync(cleanShutdown) {
  const target = resolveBacklogPath()
  if (!target) return false
  const tmp = nextBacklogTmpPath(target)
  try {
    fs.writeFileSync(tmp, JSON.stringify(buildBacklogSnapshot(cleanShutdown)))
    fs.renameSync(tmp, target)
    backlogDirty = false
    return true
  } catch (_) {
    try { fs.unlinkSync(tmp) } catch (_) {}
    return false
  }
}

/**
 * The timed write. Synchronous on purpose: publication has to be serialized
 * against the shutdown flush, and on a single thread that is what `sync` buys.
 * An async rename could still be queued when `before-quit` runs, land after the
 * shutdown snapshot, and replace it with an older one - losing the last logs and
 * relabelling a clean exit as a crash. Checking a flag before the rename does
 * not help, because the rename itself yields. The cost is one ~200KB write a
 * minute on the main thread.
 */
function writeBacklogTimed() {
  if (shutdownRecorded) return
  writeBacklogSync(false)
}

/**
 * Marks the on-disk copy stale. Writes are coalesced onto a timer because
 * `recordLog` runs on every heartbeat and every signal.
 */
function markBacklogDirty() {
  if (shutdownRecorded) return
  backlogDirty = true
  if (backlogWriteTimer) return
  backlogWriteTimer = setTimeout(() => {
    backlogWriteTimer = null
    if (backlogDirty) writeBacklogTimed()
  }, BACKLOG_WRITE_INTERVAL_MS)
  if (typeof backlogWriteTimer.unref === 'function') backlogWriteTimer.unref()
}

/**
 * Loads the previous session's leftovers into the queue so they ship with the
 * next capture. Call once, after the app is ready.
 *
 * @returns {{restored: number, cleanShutdown: boolean|null}} What was recovered.
 */
function restorePersistedTelemetry() {
  const target = resolveBacklogPath()
  const result = { restored: 0, cleanShutdown: null }
  if (!target) return result

  let saved = null
  try {
    saved = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch (_) {
    // Missing or corrupt: nothing to recover, and nothing to report.
    return result
  }
  // Guard against reading our own file back after a same-session re-init.
  if (!saved || typeof saved !== 'object' || saved.sessionId === sessionId) return result

  const previous = Array.isArray(saved.queue) ? saved.queue.slice(-MAX_RESTORED_CYCLES) : []
  const tailLogs = Array.isArray(saved.tailLogs) ? saved.tailLogs : []

  // The tail is not a cycle, but it travels the same way. Shaped like one so
  // the server keeps logging it without a schema change.
  if (tailLogs.length > 0) {
    previous.push({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      kind: 'session-tail',
      cycleId: null,
      cycleStartedAt: tailLogs[0]?.ts ?? null,
      cycleEndedAt: tailLogs[tailLogs.length - 1]?.ts ?? null,
      captureCycleDurationMs: 0,
      dimensions: { appVersion: saved.appVersion || 'unknown', platform: process.platform },
      phaseDurationsMs: {},
      counters: {},
      memoryMb: {},
      logs: tailLogs,
      outcome: { status: 'session-tail', authError: false, tokenExpired: false }
    })
  }

  for (const entry of previous) {
    if (!entry || typeof entry !== 'object') continue
    entry.previousSession = {
      sessionId: saved.sessionId || 'unknown',
      savedAt: saved.savedAt || null,
      // False here is the interesting case: the process did not shut down
      // through `before-quit`, so it was killed, crashed, or lost power.
      cleanShutdown: !!saved.cleanShutdown
    }
    completedQueue.push(entry)
    result.restored += 1
  }
  while (completedQueue.length > MAX_COMPLETED_QUEUE) completedQueue.shift()

  result.cleanShutdown = !!saved.cleanShutdown
  try { fs.unlinkSync(target) } catch (_) {}

  if (result.restored > 0) {
    recordSignal('telemetry_backlog_restored', {
      records: result.restored,
      previousSessionId: saved.sessionId || 'unknown',
      previousCleanShutdown: saved.cleanShutdown ? '1' : '0',
      previousSavedAt: saved.savedAt || 0,
      staleSeconds: saved.savedAt ? Math.round((Date.now() - saved.savedAt) / 1000) : -1
    })
  }
  return result
}

/**
 * Final synchronous flush. Runs on `before-quit`, which is also what stamps the
 * backlog as a clean shutdown - a file without that stamp means the process
 * went away without warning.
 */
function flushTelemetryForShutdown() {
  if (shutdownRecorded) return
  recordSignal('telemetry_session_shutdown', { sessionId })
  shutdownRecorded = true
  if (backlogWriteTimer) {
    clearTimeout(backlogWriteTimer)
    backlogWriteTimer = null
  }
  writeBacklogSync(true)
}

function consumeCompletedCycleTelemetry() {
  if (completedQueue.length === 0) return null
  const next = completedQueue.shift()
  markBacklogDirty()
  return next
}

function requeueCompletedCycleTelemetry(telemetry) {
  if (!telemetry || typeof telemetry !== 'object') return
  completedQueue.unshift(telemetry)
  if (completedQueue.length > MAX_COMPLETED_QUEUE) {
    completedQueue.pop()
  }
  markBacklogDirty()
}

module.exports = {
  beginCycle,
  endCycle,
  consumeCompletedCycleTelemetry,
  requeueCompletedCycleTelemetry,
  recordCyclePhaseDuration,
  recordLog,
  recordSignal,
  recordPermissionCheck,
  recordScreenLock,
  recordAudioRestart,
  recordActiveWindowProbeTimeout,
  recordCaptureCycleSkippedOverlap,
  recordLocalQuotaCooldownSkip,
  recordLocalBudgetExceeded,
  restorePersistedTelemetry,
  flushTelemetryForShutdown,
  __test__: {
    writeBacklogSync,
    writeBacklogTimed
  }
}
