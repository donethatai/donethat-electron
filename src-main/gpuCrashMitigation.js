const GPU_DISABLED_ARG = '--donethat-disable-gpu'
const GPU_DISABLED_UNTIL_STORE_KEY = 'gpuHardwareAccelerationDisabledUntil'
const GPU_DISABLE_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const GPU_CRASH_WINDOW_MS = 2 * 60 * 1000
const GPU_CRASH_RELAUNCH_THRESHOLD = 2
const GPU_MITIGATION_PLATFORMS = new Set(['win32', 'darwin', 'linux'])

const GPU_CRASH_REASONS = new Set([
  'abnormal-exit',
  'crashed',
  'launch-failed',
  'integrity-failure',
  'oom'
])

function parseTimestamp(value) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0
}

function hasDisableGpuArg(argv = []) {
  return Array.isArray(argv) && argv.includes(GPU_DISABLED_ARG)
}

function isGpuMitigationSupportedPlatform(platform = process.platform) {
  return GPU_MITIGATION_PLATFORMS.has(platform)
}

function shouldDisableHardwareAcceleration({ platform = process.platform, argv = [], disabledUntil = 0, now = Date.now() } = {}) {
  if (!isGpuMitigationSupportedPlatform(platform)) return false
  return hasDisableGpuArg(argv) || parseTimestamp(disabledUntil) > now
}

function applyStartupGpuMitigation({ app, store, log, platform = process.platform, argv = process.argv, now = Date.now() } = {}) {
  if (!isGpuMitigationSupportedPlatform(platform)) return false

  let disabledUntil = 0
  try {
    disabledUntil = parseTimestamp(store?.get?.(GPU_DISABLED_UNTIL_STORE_KEY))
  } catch (error) {
    log?.warn?.('Unable to read GPU mitigation state:', error.message)
  }

  if (!shouldDisableHardwareAcceleration({ platform, argv, disabledUntil, now })) {
    return false
  }

  app?.disableHardwareAcceleration?.()
  app?.commandLine?.appendSwitch?.('disable-gpu')

  if (hasDisableGpuArg(argv) && store?.set) {
    try {
      store.set(GPU_DISABLED_UNTIL_STORE_KEY, now + GPU_DISABLE_DURATION_MS)
    } catch (error) {
      log?.warn?.('Unable to persist GPU mitigation state:', error.message)
    }
  }

  log?.warn?.('GPU mitigation active; hardware acceleration disabled for this launch', { platform })
  return true
}

function isGpuProcessCrash(details = {}) {
  const type = String(details.type || '').toLowerCase()
  const reason = String(details.reason || '').toLowerCase()
  return type === 'gpu' && GPU_CRASH_REASONS.has(reason)
}

function buildRelaunchArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice(1) : []
  return [...args.filter(arg => arg !== GPU_DISABLED_ARG), GPU_DISABLED_ARG]
}

function createGpuCrashMitigator({
  app,
  store,
  getStore,
  log,
  recordSignal,
  platform = process.platform,
  argv = process.argv,
  now = () => Date.now(),
  alreadyDisabled = false,
  beforeRelaunch
} = {}) {
  let gpuCrashTimestamps = []
  let relaunching = false

  function handleChildProcessGone(details = {}, fields = {}) {
    if (!isGpuMitigationSupportedPlatform(platform) || alreadyDisabled || relaunching) return false
    if (!isGpuProcessCrash(details)) return false

    const currentTime = now()
    const windowStart = currentTime - GPU_CRASH_WINDOW_MS
    gpuCrashTimestamps = [...gpuCrashTimestamps, currentTime].filter(timestamp => timestamp >= windowStart)

    if (gpuCrashTimestamps.length < GPU_CRASH_RELAUNCH_THRESHOLD) {
      return false
    }

    relaunching = true
    const disabledUntil = currentTime + GPU_DISABLE_DURATION_MS
    try {
      const writeStore = typeof getStore === 'function' ? getStore() : store
      writeStore?.set?.(GPU_DISABLED_UNTIL_STORE_KEY, disabledUntil)
    } catch (error) {
      log?.warn?.('Unable to persist GPU mitigation state before relaunch:', error.message)
    }

    const signalFields = {
      ...fields,
      gpuCrashCount: String(gpuCrashTimestamps.length),
      mitigationDurationHours: String(Math.round(GPU_DISABLE_DURATION_MS / (60 * 60 * 1000)))
    }
    log?.warn?.('GPU process crashed repeatedly; relaunching with hardware acceleration disabled', signalFields)
    recordSignal?.('gpu-mitigation-relaunch', signalFields)

    try {
      beforeRelaunch?.()
    } catch (error) {
      log?.warn?.('Cleanup before GPU mitigation relaunch failed:', error.message)
    }
    app?.relaunch?.({ args: buildRelaunchArgs(argv) })
    app?.exit?.(0)
    return true
  }

  return { handleChildProcessGone }
}

module.exports = {
  GPU_DISABLED_ARG,
  GPU_DISABLED_UNTIL_STORE_KEY,
  GPU_DISABLE_DURATION_MS,
  GPU_CRASH_WINDOW_MS,
  GPU_CRASH_RELAUNCH_THRESHOLD,
  applyStartupGpuMitigation,
  buildRelaunchArgs,
  createGpuCrashMitigator,
  hasDisableGpuArg,
  isGpuMitigationSupportedPlatform,
  isGpuProcessCrash,
  shouldDisableHardwareAcceleration
}
