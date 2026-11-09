// Linux self-heal for a main window that never loads.
//
// On some Linux machines the window stays blank: the browser gets the file://
// response for index.html, then waits forever on the out-of-process network
// service to parse its headers, so the page never commits. Running the network
// service inside the browser process skips that round-trip. When the main window
// has not loaded within LOAD_TIMEOUT_MS we relaunch once with it in-process and
// keep that for MITIGATION_DURATION_MS. A launch that is already mitigated never
// relaunches again, so this cannot loop.

const RELAUNCH_ARG = '--donethat-network-in-process'
const ENABLED_UNTIL_STORE_KEY = 'linuxNetworkServiceInProcessUntil'
const PENDING_REPORT_STORE_KEY = 'linuxNetworkServiceStallReport'
// Chromium 150 names the feature "NetworkServiceInProcess2" (content_features.cc).
const IN_PROCESS_FEATURE = 'NetworkServiceInProcess2'
const LOAD_TIMEOUT_MS = 20 * 1000
const MITIGATION_DURATION_MS = 30 * 24 * 60 * 60 * 1000

function parseTimestamp(value) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0
}

function hasRelaunchArg(argv = []) {
  return Array.isArray(argv) && argv.includes(RELAUNCH_ARG)
}

function buildRelaunchArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice(1) : []
  return [...args.filter(arg => arg !== RELAUNCH_ARG), RELAUNCH_ARG]
}

// An AppImage runs from a FUSE mount that goes away when the app exits, so it has
// to be relaunched through the AppImage file itself.
function buildRelaunchOptions(argv = [], env = process.env) {
  const options = { args: buildRelaunchArgs(argv) }
  const appImagePath = typeof env?.APPIMAGE === 'string' ? env.APPIMAGE.trim() : ''
  if (appImagePath) options.execPath = appImagePath
  return options
}

function shouldRunNetworkServiceInProcess({ platform = process.platform, argv = [], enabledUntil = 0, now = Date.now() } = {}) {
  if (platform !== 'linux') return false
  return hasRelaunchArg(argv) || parseTimestamp(enabledUntil) > now
}

// Must run before app ready: Chromium reads --enable-features once at startup.
function applyStartupNetworkServiceMitigation({ app, store, log, platform = process.platform, argv = process.argv, now = Date.now() } = {}) {
  if (platform !== 'linux') return false

  let enabledUntil = 0
  try {
    enabledUntil = parseTimestamp(store?.get?.(ENABLED_UNTIL_STORE_KEY))
  } catch (error) {
    log?.warn?.('Unable to read network service mitigation state:', error.message)
  }

  if (!shouldRunNetworkServiceInProcess({ platform, argv, enabledUntil, now })) {
    return false
  }

  app?.commandLine?.appendSwitch?.('enable-features', IN_PROCESS_FEATURE)
  log?.warn?.('Network service mitigation active; running the network service in-process for this launch')
  return true
}

function summarizeProcessTypes(metrics = []) {
  if (!Array.isArray(metrics)) return ''
  return metrics
    .map(metric => metric?.serviceName || metric?.name || metric?.type)
    .filter(Boolean)
    .join(',')
}

function createMainWindowLoadWatchdog({
  app,
  getStore,
  log,
  recordSignal,
  reportToSentry,
  platform = process.platform,
  argv = process.argv,
  env = process.env,
  alreadyMitigated = false,
  beforeRelaunch,
  timeoutMs = LOAD_TIMEOUT_MS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let timer = null

  function readStore() {
    try {
      return typeof getStore === 'function' ? getStore() : null
    } catch (error) {
      log?.warn?.('Unable to open store for network service mitigation:', error.message)
      return null
    }
  }

  function collectStallFields(startedAt) {
    let processTypes = ''
    try {
      processTypes = summarizeProcessTypes(app?.getAppMetrics?.())
    } catch (_) {}
    return {
      waitedMs: String(now() - startedAt),
      alreadyMitigated: String(alreadyMitigated),
      processTypes
    }
  }

  function handleStall(startedAt) {
    timer = null
    const fields = collectStallFields(startedAt)
    log?.warn?.('Main window did not finish loading', fields)
    recordSignal?.('main-window-load-stalled', fields)
    reportToSentry?.('Main window did not finish loading', fields)

    if (alreadyMitigated) return

    const store = readStore()
    try {
      store?.set?.(ENABLED_UNTIL_STORE_KEY, now() + MITIGATION_DURATION_MS)
      store?.set?.(PENDING_REPORT_STORE_KEY, { ...fields, stalledAt: String(now()) })
    } catch (error) {
      log?.warn?.('Unable to persist network service mitigation state before relaunch:', error.message)
    }

    log?.warn?.('Relaunching with the network service in-process')
    try {
      beforeRelaunch?.()
    } catch (error) {
      log?.warn?.('Cleanup before network service relaunch failed:', error.message)
    }
    app?.relaunch?.(buildRelaunchOptions(argv, env))
    app?.exit?.(0)
  }

  // The stall report from the launch that relaunched is sent from the launch that
  // recovered: while the network service is stuck, Sentry itself may not get out.
  function reportRecovery() {
    if (!alreadyMitigated) return
    const store = readStore()
    let pending = null
    try {
      pending = store?.get?.(PENDING_REPORT_STORE_KEY) || null
      if (pending) store?.delete?.(PENDING_REPORT_STORE_KEY)
    } catch (error) {
      log?.warn?.('Unable to read network service stall report:', error.message)
    }
    if (!pending) return
    const fields = { ...pending, recovered: 'true' }
    log?.info?.('Main window loaded after relaunching with the network service in-process', fields)
    recordSignal?.('main-window-load-recovered', fields)
    reportToSentry?.('Main window loaded after network service relaunch', fields)
  }

  function cancel() {
    if (!timer) return false
    clearTimer(timer)
    timer = null
    return true
  }

  function watch(webContents) {
    if (platform !== 'linux' || !webContents) return
    cancel()
    const startedAt = now()
    timer = setTimer(() => handleStall(startedAt), timeoutMs)
    webContents.once('dom-ready', () => {
      if (cancel()) reportRecovery()
    })
    // Never relaunch an app the user is quitting or a window that is gone.
    webContents.once('destroyed', cancel)
    app?.once?.('before-quit', cancel)
  }

  return { watch }
}

module.exports = {
  ENABLED_UNTIL_STORE_KEY,
  IN_PROCESS_FEATURE,
  LOAD_TIMEOUT_MS,
  MITIGATION_DURATION_MS,
  PENDING_REPORT_STORE_KEY,
  RELAUNCH_ARG,
  applyStartupNetworkServiceMitigation,
  buildRelaunchArgs,
  buildRelaunchOptions,
  createMainWindowLoadWatchdog,
  hasRelaunchArg,
  shouldRunNetworkServiceInProcess
}
