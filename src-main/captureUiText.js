const log = require('electron-log')
const { app, systemPreferences } = require('electron')
const windowsCapture = require('./captureWindows')

const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32'])
const SNAPSHOT_DEBOUNCE_MS = 1500
const SNAPSHOT_TIMEOUT_MS = 1500
// Window chrome plus the web area sit within ~8 levels, leaving room for the
// page's own nesting; deeper levels are mostly layout wrappers that cost
// native read time without adding text.
const SNAPSHOT_MAX_DEPTH = 20
const MAX_TOTAL_CHARS = 8000
const MAX_ENTRIES = 200
const MAX_NODE_CHARS = 300
const MAX_EXTRACTED_CHARS = MAX_TOTAL_CHARS * 2
const MAX_BUFFERED_CHARS = MAX_TOTAL_CHARS * 4
const MAX_BUFFERED_SNAPSHOTS = 200
const FOREGROUND_POLL_MS = 3000
const FOREGROUND_PROBE_TIMEOUT_MS = 300
const APP_LOOKUP_TIMEOUT_MS = 1000
const WEB_ACCESSIBILITY_TIMEOUT_MS = 1000
const FINAL_SNAPSHOT_BUDGET_MS = 3000
const BASE_BACKOFF_MS = 1500
const MAX_BACKOFF_MS = 60000
const SKIPPED_ROLES = new Set(['scroll_bar', 'scroll_thumb', 'separator'])
// Roles whose value is what the user typed or edits. Only their label is read;
// their value and everything below them (rich editors expose typed text as
// child static text) is skipped.
const EDITABLE_ROLES = new Set(['text_field', 'text_area', 'combo_box', 'spin_button', 'document'])
const SENSITIVE_NAME_PATTERN = /pass(word|code|wort|phrase)|kennwort|mot de passe|contraseña|secret|\bpin\b/i
const TIMEOUT = Symbol('ui-text-timeout')

let xa11yModule
let isTracking = false
let pollTimer = null
let debounceTimer = null
let pollInFlight = null
let snapshotInFlight = null
let current = null
let webAccessibilityAttemptedPids = new Set()
let pendingNativeCalls = new Map()
let buffer = createEmptyBuffer()
let lastCycleStats = null

function createEmptyBuffer() {
  return { snapshots: [], storedChars: 0, truncated: false }
}

function createTarget(info) {
  return { ...info, app: null, subscription: null, consecutiveFailures: 0, cooldownUntil: 0, permissionDenied: false }
}

function isUiTextSupported() {
  return SUPPORTED_PLATFORMS.has(process.platform)
}

function isLibraryUnavailable() {
  return xa11yModule === null
}

function loadXa11y() {
  if (xa11yModule !== undefined) return xa11yModule
  try {
    xa11yModule = require('@crowecawcaw/xa11y')
  } catch (error) {
    log.warn('[ui-text] Accessibility library unavailable:', error?.code || error?.name || 'Error')
    xa11yModule = null
  }
  return xa11yModule
}

function errorKind(error) {
  return error?.name || error?.constructor?.name || 'Error'
}

function isPermissionError(error) {
  const PermissionDeniedError = xa11yModule?.PermissionDeniedError
  if (PermissionDeniedError && error instanceof PermissionDeniedError) return true
  return errorKind(error) === 'PermissionDeniedError'
}

function withTimeout(promise, timeoutMs) {
  let timer = null
  const guarded = Promise.resolve(promise)
  guarded.catch(() => {})
  return Promise.race([
    guarded,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

function hasAccessibilityPermission() {
  if (process.platform !== 'darwin') return true
  try {
    return systemPreferences.isTrustedAccessibilityClient(false) === true
  } catch (_) {
    return false
  }
}

function isOwnProcess(pid) {
  if (pid === process.pid) return true
  try {
    return (app.getAppMetrics?.() || []).some((metric) => metric?.pid === pid)
  } catch (_) {
    return false
  }
}

async function loadAppExclusions() {
  const { default: Store } = require('electron-store')
  const store = new Store({ name: 'donethat-config', cwd: app.getPath('userData') })
  const exclusions = store.get('appExclusions')
  return Array.isArray(exclusions) ? exclusions : []
}

async function isExcludedTarget(appName, titles) {
  let exclusions
  try {
    exclusions = await loadAppExclusions()
  } catch (error) {
    log.warn('[ui-text] Could not read app exclusions; skipping snapshot:', errorKind(error))
    return true
  }
  if (exclusions.length === 0) return false
  const candidateTitles = titles.filter((title) => typeof title === 'string')
  if (candidateTitles.length === 0) candidateTitles.push('')
  return candidateTitles.some((title) => windowsCapture.shouldExcludeWindow({ appName, title }, exclusions))
}

function isSensitiveNode(node) {
  if (node.password === true) return true
  if (Array.isArray(node.states) && node.states.some((state) => /password|secure/i.test(String(state)))) return true
  return typeof node.name === 'string' && SENSITIVE_NAME_PATTERN.test(node.name)
}

function extractLines(tree) {
  const lines = []
  let extractedChars = 0
  let truncated = false
  let exhausted = false

  const pushNodeText = (texts) => {
    let nodeChars = 0
    for (const raw of texts) {
      if (typeof raw !== 'string') continue
      for (const part of raw.split(/\r?\n/)) {
        let line = part.replace(/\s+/g, ' ').trim()
        if (!line) continue
        const remaining = MAX_NODE_CHARS - nodeChars
        if (remaining <= 0) {
          truncated = true
          return
        }
        if (line.length > remaining) {
          line = line.slice(0, remaining)
          truncated = true
        }
        if (extractedChars + line.length > MAX_EXTRACTED_CHARS) {
          truncated = true
          exhausted = true
          return
        }
        extractedChars += line.length
        nodeChars += line.length
        lines.push(line)
      }
    }
  }

  const visit = (node, depth) => {
    if (exhausted || !node || typeof node !== 'object' || depth > SNAPSHOT_MAX_DEPTH) return
    if (EDITABLE_ROLES.has(node.role)) {
      pushNodeText([node.name])
      return
    }
    if (!SKIPPED_ROLES.has(node.role)) {
      pushNodeText(isSensitiveNode(node) ? [node.name] : [node.name, node.value])
    }
    if (!Array.isArray(node.children)) return
    for (const child of node.children) visit(child, depth + 1)
  }

  visit(tree, 0)
  return { lines, truncated }
}

function normalizeTitle(title) {
  return typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().toLowerCase() : ''
}

function isSameSnapshot(a, b) {
  return a.appName === b.appName &&
    a.windowTitle === b.windowTitle &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, index) => line === b.lines[index])
}

function addSnapshotToBuffer({ appName, windowTitle, titles = [], lines, truncated, capturedAtMs }) {
  if (truncated) buffer.truncated = true
  if (lines.length === 0) return
  const snapshot = {
    appName,
    windowTitle,
    titles: titles.map(normalizeTitle).filter(Boolean),
    lines,
    capturedAtMs,
    chars: lines.reduce((sum, line) => sum + line.length + 1, 0)
  }
  const previous = buffer.snapshots[buffer.snapshots.length - 1]
  if (previous && isSameSnapshot(previous, snapshot)) return

  buffer.snapshots.push(snapshot)
  buffer.storedChars += snapshot.chars
  while (buffer.snapshots.length > 1 &&
    (buffer.storedChars > MAX_BUFFERED_CHARS || buffer.snapshots.length > MAX_BUFFERED_SNAPSHOTS)) {
    buffer.storedChars -= buffer.snapshots.shift().chars
    buffer.truncated = true
  }
}

function entryKey(appName, windowTitle) {
  return `${appName}\u0000${windowTitle ?? ''}`
}

function collectTitlesByApp() {
  const titlesByApp = new Map()
  for (const snapshot of buffer.snapshots) {
    let titles = titlesByApp.get(snapshot.appName)
    if (!titles) {
      titles = new Set()
      titlesByApp.set(snapshot.appName, titles)
    }
    for (const title of snapshot.titles) titles.add(title)
  }
  return titlesByApp
}

/**
 * Picks lines newest snapshot first, so when the cap is hit the cut falls on
 * the oldest text rather than the window the user ended the cycle on, then
 * emits them in capture order.
 */
function selectLinesNewestFirst(includeWindowTitles) {
  const seenLinesByApp = new Map()
  const entryKeys = new Set()
  const keptBySnapshot = new Array(buffer.snapshots.length)
  let totalChars = 0
  let truncated = buffer.truncated
  const hiddenTitlesByApp = includeWindowTitles ? null : collectTitlesByApp()

  for (let index = buffer.snapshots.length - 1; index >= 0; index--) {
    const snapshot = buffer.snapshots[index]
    const key = entryKey(snapshot.appName, includeWindowTitles ? snapshot.windowTitle : null)
    const hiddenTitles = hiddenTitlesByApp?.get(snapshot.appName)
    let seen = seenLinesByApp.get(snapshot.appName)
    if (!seen) {
      seen = new Set()
      seenLinesByApp.set(snapshot.appName, seen)
    }

    const kept = []
    for (const line of snapshot.lines) {
      if (hiddenTitles?.has(normalizeTitle(line)) || seen.has(line)) continue
      if (totalChars + line.length + 1 > MAX_TOTAL_CHARS) {
        keptBySnapshot[index] = kept
        return { keptBySnapshot, truncated: true }
      }
      if (!entryKeys.has(key) && entryKeys.size >= MAX_ENTRIES) {
        truncated = true
        break
      }
      entryKeys.add(key)
      seen.add(line)
      kept.push(line)
      totalChars += line.length + 1
    }
    keptBySnapshot[index] = kept
  }
  return { keptBySnapshot, truncated }
}

function recordSnapshotFailure(target, error) {
  target.consecutiveFailures = Math.min(target.consecutiveFailures + 1, 6)
  const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, target.consecutiveFailures - 1), MAX_BACKOFF_MS)
  target.cooldownUntil = Date.now() + backoffMs
  if (error && isPermissionError(error)) target.permissionDenied = true
  log.warn(`[ui-text] Snapshot failed (${error ? errorKind(error) : 'timeout'}); backing off ${backoffMs}ms`)
}

function recordSnapshotSuccess(target) {
  target.consecutiveFailures = 0
  target.cooldownUntil = 0
  target.permissionDenied = false
}

/**
 * Runs one native call per pid and kind at a time. The guard is held until the
 * native promise settles, not until our timeout fires, so a hung app never
 * gets a second read stacked on top of the first.
 * @returns {Promise|null} null when a call of this kind is still pending for the pid
 */
function runExclusiveNativeCall(kind, pid, call) {
  const key = `${kind}:${pid}`
  if (pendingNativeCalls.has(key)) return null
  const pending = Promise.resolve().then(call)
  pendingNativeCalls.set(key, pending)
  const release = () => {
    if (pendingNativeCalls.get(key) === pending) pendingNativeCalls.delete(key)
  }
  pending.then(release, release)
  return pending
}

function releaseSubscription() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  const subscription = current?.subscription
  if (!subscription) return
  current.subscription = null
  try {
    subscription.close()
  } catch (error) {
    log.warn('[ui-text] Failed to close accessibility subscription:', errorKind(error))
  }
}

function scheduleSnapshot() {
  if (!isTracking) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    snapshotFocusedWindow().catch(() => {})
  }, SNAPSHOT_DEBOUNCE_MS)
}

async function maybeEnableWebAccessibility(appHandle, pid) {
  if (process.platform !== 'darwin') return
  if (webAccessibilityAttemptedPids.has(pid)) return
  webAccessibilityAttemptedPids.add(pid)
  if (typeof appHandle?.enableWebAccessibility !== 'function') return
  try {
    await withTimeout(appHandle.enableWebAccessibility({ timeout: WEB_ACCESSIBILITY_TIMEOUT_MS }), WEB_ACCESSIBILITY_TIMEOUT_MS + 250)
  } catch (_) {}
}

async function subscribeWithTimeout(appHandle) {
  const pending = Promise.resolve().then(() => appHandle.subscribe())
  const result = await withTimeout(pending, APP_LOOKUP_TIMEOUT_MS)
  if (result !== TIMEOUT) return result
  pending.then((lateSubscription) => {
    try { lateSubscription?.close() } catch (_) {}
  }, () => {})
  return null
}

async function attachToApp(target) {
  const xa11y = loadXa11y()
  if (!xa11y) return
  if (isOwnProcess(target.pid)) return
  if (await isExcludedTarget(target.appName, [target.title])) return

  const lookup = runExclusiveNativeCall('lookup', target.pid, () => xa11y.App.byPid(target.pid, { timeout: 0 }))
  if (!lookup) return

  let appHandle
  try {
    appHandle = await withTimeout(lookup, APP_LOOKUP_TIMEOUT_MS)
  } catch (error) {
    recordSnapshotFailure(target, error)
    return
  }
  if (appHandle === TIMEOUT || !appHandle || current !== target || !isTracking) return
  target.app = appHandle

  await maybeEnableWebAccessibility(appHandle, target.pid)
  if (current !== target || !isTracking) return

  let subscription = null
  try {
    subscription = await subscribeWithTimeout(appHandle)
  } catch (error) {
    log.warn('[ui-text] Could not subscribe to accessibility events:', errorKind(error))
  }
  if (subscription && (current !== target || !isTracking)) {
    try { subscription.close() } catch (_) {}
    return
  }
  if (subscription) {
    subscription.on('error', (error) => log.warn('[ui-text] Accessibility subscription error:', errorKind(error)))
    subscription.on('windowActivated', scheduleSnapshot)
    target.subscription = subscription
  }
  scheduleSnapshot()
}

function readForegroundInfo(activeWindowInfo) {
  if (!activeWindowInfo || typeof activeWindowInfo !== 'object') return null
  const pid = activeWindowInfo.owner?.processId
  if (!Number.isInteger(pid) || pid <= 0) return null
  return {
    pid,
    appName: activeWindowInfo.owner?.name || activeWindowInfo.owner?.processName || 'Unknown',
    title: typeof activeWindowInfo.title === 'string' ? activeWindowInfo.title : null
  }
}

async function refreshForeground() {
  if (!isTracking) return
  if (!hasAccessibilityPermission()) {
    releaseSubscription()
    current = null
    return
  }

  const info = readForegroundInfo(await windowsCapture.getActiveWindowSafe(FOREGROUND_PROBE_TIMEOUT_MS))
  if (!info || !isTracking) return

  if (current && current.pid === info.pid) {
    current.title = info.title
    current.appName = info.appName
    if (!current.app && Date.now() >= current.cooldownUntil) await attachToApp(current)
    return
  }

  releaseSubscription()
  current = createTarget(info)
  await attachToApp(current)
}

function pollForeground() {
  if (pollInFlight) return pollInFlight
  pollInFlight = refreshForeground()
    .catch((error) => log.warn('[ui-text] Foreground refresh failed:', errorKind(error)))
    .finally(() => { pollInFlight = null })
  return pollInFlight
}

async function readFocusedWindowTree(appHandle) {
  const windows = await appHandle.windows()
  if (!Array.isArray(windows) || windows.length === 0) return null
  const window = windows.find((candidate) => candidate?.active) ||
    windows.find((candidate) => candidate?.focused) ||
    windows[0]
  const tree = await window.tree(SNAPSHOT_MAX_DEPTH)
  return { windowTitle: typeof window.name === 'string' && window.name ? window.name : null, tree }
}

async function takeSnapshot() {
  const target = current
  if (!isTracking || !target?.app) return
  if (Date.now() < target.cooldownUntil) return

  const read = runExclusiveNativeCall('tree', target.pid, () => readFocusedWindowTree(target.app))
  if (!read) return

  let result
  try {
    result = await withTimeout(read, SNAPSHOT_TIMEOUT_MS)
  } catch (error) {
    recordSnapshotFailure(target, error)
    return
  }
  if (result === TIMEOUT) {
    recordSnapshotFailure(target, null)
    return
  }
  recordSnapshotSuccess(target)
  if (!result || !isTracking) return

  const windowTitle = result.windowTitle || target.title || null
  if (await isExcludedTarget(target.appName, [target.title, result.windowTitle])) return

  const { lines, truncated } = extractLines(result.tree)
  if (!isTracking || (lines.length === 0 && !truncated)) return
  addSnapshotToBuffer({
    appName: target.appName,
    windowTitle,
    titles: [target.title, result.windowTitle],
    lines,
    truncated,
    capturedAtMs: Date.now()
  })
}

function snapshotFocusedWindow() {
  if (snapshotInFlight) return snapshotInFlight
  snapshotInFlight = takeSnapshot()
    .catch((error) => log.warn('[ui-text] Snapshot handling failed:', errorKind(error)))
    .finally(() => { snapshotInFlight = null })
  return snapshotInFlight
}

/**
 * @param {{includeWindowTitles?: boolean}} options false drops window titles,
 *   both as entry metadata and as text lines, when Active applications is off
 */
function buildPayload({ includeWindowTitles = true } = {}) {
  const { keptBySnapshot, truncated } = selectLinesNewestFirst(includeWindowTitles)
  const entries = []
  const entriesByKey = new Map()
  buffer.snapshots.forEach((snapshot, index) => {
    const kept = keptBySnapshot[index]
    if (!kept || kept.length === 0) return
    const windowTitle = includeWindowTitles ? snapshot.windowTitle : null
    const key = entryKey(snapshot.appName, windowTitle)
    let entry = entriesByKey.get(key)
    if (!entry) {
      entry = { app: snapshot.appName, windowTitle, lines: [], capturedAtMs: snapshot.capturedAtMs }
      entriesByKey.set(key, entry)
      entries.push(entry)
    }
    entry.lines.push(...kept)
  })
  if (entries.length === 0) return null
  return {
    entries: entries.map((entry) => ({
      app: entry.app,
      windowTitle: entry.windowTitle,
      text: entry.lines.join('\n'),
      capturedAtMs: entry.capturedAtMs
    })),
    truncated
  }
}

/**
 * Size counters for tuning the caps. Numbers only, never text.
 * uniqueChars is the deduplicated text the cycle had before the per-cycle cap.
 */
function computeCycleStats(payload, includeWindowTitles) {
  const hiddenTitlesByApp = includeWindowTitles ? null : collectTitlesByApp()
  const seenLinesByApp = new Map()
  let uniqueChars = 0
  for (const snapshot of buffer.snapshots) {
    const hiddenTitles = hiddenTitlesByApp?.get(snapshot.appName)
    let seen = seenLinesByApp.get(snapshot.appName)
    if (!seen) {
      seen = new Set()
      seenLinesByApp.set(snapshot.appName, seen)
    }
    for (const line of snapshot.lines) {
      if (hiddenTitles?.has(normalizeTitle(line)) || seen.has(line)) continue
      seen.add(line)
      uniqueChars += line.length + 1
    }
  }
  const entries = payload?.entries || []
  return {
    uniqueChars,
    sentChars: entries.reduce((sum, entry) => sum + entry.text.length, 0)
  }
}

function getLastCycleStats() {
  return lastCycleStats
}

/**
 * Take one last snapshot of the focused window, then return the cycle's UI text.
 * @param {boolean} resetBuffers Clear the buffer after reading it
 * @param {{includeWindowTitles?: boolean}} options Pass false when Active applications is off
 * @returns {Promise<{entries: Array, truncated: boolean}|null>} null when nothing was captured
 */
async function getUiTextBuffer(resetBuffers = true, { includeWindowTitles = true } = {}) {
  lastCycleStats = null
  if (!isTracking) return null

  const finalSnapshot = (async () => {
    await pollForeground()
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    await snapshotFocusedWindow()
  })()
  try {
    await withTimeout(finalSnapshot, FINAL_SNAPSHOT_BUDGET_MS)
  } catch (error) {
    log.warn('[ui-text] Cycle-end snapshot failed:', errorKind(error))
  }

  const payload = buildPayload({ includeWindowTitles })
  lastCycleStats = computeCycleStats(payload, includeWindowTitles)
  if (resetBuffers) buffer = createEmptyBuffer()
  if (payload) {
    log.debug('[ui-text] Collected window text', {
      entries: String(payload.entries.length),
      chars: String(payload.entries.reduce((sum, entry) => sum + entry.text.length, 0)),
      truncated: payload.truncated ? 'true' : 'false'
    })
  }
  return payload
}

/**
 * Start following the frontmost app and snapshotting its focused window text.
 * @returns {Promise<boolean>} false when unsupported, the library is missing, or Accessibility is not granted
 */
async function startTracking() {
  if (!isUiTextSupported()) return false
  if (isTracking) return true
  if (!hasAccessibilityPermission()) return false
  if (!loadXa11y()) return false

  buffer = createEmptyBuffer()
  isTracking = true
  pollTimer = setInterval(() => { pollForeground() }, FOREGROUND_POLL_MS)
  pollForeground()
  return true
}

function stopTracking() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  releaseSubscription()
  current = null
  isTracking = false
  buffer = createEmptyBuffer()
  lastCycleStats = null
}

function isTrackingActive() {
  return isTracking
}

/**
 * permissionDenied covers a missing Accessibility grant or a refusal from the
 * app currently in front; a refusal from an app the user has left no longer counts.
 */
function getStatus() {
  const supported = isUiTextSupported()
  const accessibilityTrusted = !supported || hasAccessibilityPermission()
  return {
    supported,
    tracking: isTracking,
    permissionDenied: supported && (!accessibilityTrusted || current?.permissionDenied === true),
    accessibilityTrusted,
    libraryUnavailable: supported && isLibraryUnavailable()
  }
}

module.exports = {
  isUiTextSupported,
  startTracking,
  stopTracking,
  getUiTextBuffer,
  getLastCycleStats,
  getStatus,
  isTracking: isTrackingActive,
  __test__: {
    computeCycleStats,
    extractLines,
    addSnapshotToBuffer,
    buildPayload,
    pollForeground,
    snapshotFocusedWindow,
    resetState() {
      stopTracking()
      xa11yModule = undefined
      pollInFlight = null
      snapshotInFlight = null
      webAccessibilityAttemptedPids = new Set()
      pendingNativeCalls = new Map()
    },
    constants: { MAX_TOTAL_CHARS, MAX_ENTRIES, MAX_NODE_CHARS, SNAPSHOT_MAX_DEPTH, SNAPSHOT_TIMEOUT_MS, SNAPSHOT_DEBOUNCE_MS }
  }
}
