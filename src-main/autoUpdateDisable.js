const AUTO_UPDATE_DISABLED_UNTIL_STORE_KEY = 'autoUpdateDisabledUntil'
const AUTO_UPDATE_DISABLE_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const AUTO_UPDATE_DISABLE_ENV = 'DONETHAT_DISABLE_AUTO_UPDATE'

function parseTimestamp(value) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0
}

function isTruthyEnvFlag(value) {
  if (value == null) return false
  const normalized = String(value).trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no' && normalized !== 'off'
}

function isAutoUpdateDisabledByEnv(env = process.env) {
  return isTruthyEnvFlag(env?.[AUTO_UPDATE_DISABLE_ENV])
}

function readDisabledUntil(store) {
  try {
    return parseTimestamp(store?.get?.(AUTO_UPDATE_DISABLED_UNTIL_STORE_KEY))
  } catch (_) {
    return 0
  }
}

function describeAutoUpdateDisableState(state) {
  if (state?.source === 'env') {
    return 'Auto-update is disabled by DONETHAT_DISABLE_AUTO_UPDATE.'
  }
  if (state?.disabled && state.until) {
    try {
      const label = new Date(state.until).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      })
      if (label) return `Auto-update paused until ${label}.`
    } catch (_) {}
    return 'Auto-update paused for 7 days.'
  }
  return 'Auto-update re-enabled.'
}

function getAutoUpdateDisableState({ store, env = process.env, now = Date.now() } = {}) {
  if (isAutoUpdateDisabledByEnv(env)) {
    return { disabled: true, until: null, source: 'env' }
  }

  const until = readDisabledUntil(store)
  if (until > now) {
    return { disabled: true, until, source: 'store' }
  }

  return { disabled: false, until: null, source: null }
}

function isAutoUpdateDisabled(opts) {
  return getAutoUpdateDisableState(opts).disabled
}

function toggleAutoUpdateDisabled({
  store,
  env = process.env,
  now = Date.now(),
  durationMs = AUTO_UPDATE_DISABLE_DURATION_MS
} = {}) {
  if (isAutoUpdateDisabledByEnv(env)) {
    return getAutoUpdateDisableState({ store, env, now })
  }

  if (getAutoUpdateDisableState({ store, env, now }).disabled) {
    try { store?.delete?.(AUTO_UPDATE_DISABLED_UNTIL_STORE_KEY) } catch (_) {}
    return { disabled: false, until: null, source: null }
  }

  const until = now + durationMs
  try { store?.set?.(AUTO_UPDATE_DISABLED_UNTIL_STORE_KEY, until) } catch (_) {}
  return { disabled: true, until, source: 'store' }
}

module.exports = {
  AUTO_UPDATE_DISABLED_UNTIL_STORE_KEY,
  AUTO_UPDATE_DISABLE_DURATION_MS,
  AUTO_UPDATE_DISABLE_ENV,
  isAutoUpdateDisabledByEnv,
  getAutoUpdateDisableState,
  isAutoUpdateDisabled,
  toggleAutoUpdateDisabled,
  describeAutoUpdateDisableState
}
