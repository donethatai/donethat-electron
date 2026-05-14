const os = require('os')
const { app } = require('electron')

const TELEMETRY_SCHEMA_VERSION = 1
const MAX_COMPLETED_QUEUE = 24
const MAX_LOG_ENTRIES_PER_CYCLE = 100
const MAX_LOG_MESSAGE_CHARS = 600
const MAX_LOG_META_LENGTH = 240

let pendingAggregate = createAggregate()
let activeCycle = null
const pendingLogs = []
const completedQueue = []
let cycleSeq = 0

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
  return telemetry
}

function consumeCompletedCycleTelemetry() {
  if (completedQueue.length === 0) return null
  return completedQueue.shift()
}

function requeueCompletedCycleTelemetry(telemetry) {
  if (!telemetry || typeof telemetry !== 'object') return
  completedQueue.unshift(telemetry)
  if (completedQueue.length > MAX_COMPLETED_QUEUE) {
    completedQueue.pop()
  }
}

module.exports = {
  beginCycle,
  endCycle,
  consumeCompletedCycleTelemetry,
  requeueCompletedCycleTelemetry,
  recordCyclePhaseDuration,
  recordLog,
  recordPermissionCheck,
  recordScreenLock,
  recordAudioRestart,
  recordActiveWindowProbeTimeout,
  recordCaptureCycleSkippedOverlap,
  recordLocalQuotaCooldownSkip,
  recordLocalBudgetExceeded
}
