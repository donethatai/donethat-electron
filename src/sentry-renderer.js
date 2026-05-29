const Sentry = require('@sentry/electron/renderer')
const { version } = require('../package.json')
const { getErrorText, isLocalStorageUnavailableError } = require('./storage-errors.js')

if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    if (!isLocalStorageUnavailableError(event.reason)) return

    event.preventDefault()
    window.__donethatLocalStorageUnavailableDetected = true
    console.warn('Suppressed local-storage-unavailable unhandled rejection:', getErrorText(event.reason))
    try {
      window.dispatchEvent(new CustomEvent('donethat:local-storage-unavailable', {
        detail: { message: getErrorText(event.reason) }
      }))
    } catch (_) {}
  }, true)
}

Sentry.init({
  dsn: 'https://c133ed0231c60f905e847ccf2ce2dfc9@o4511426462285824.ingest.de.sentry.io/4511426468642896',
  release: `donethat@${version}`,
  sendDefaultPii: false,
  beforeSend(event, hint) {
    if (isLocalStorageUnavailableError(hint?.originalException) || isLocalStorageUnavailableError(event)) {
      return null
    }

    return event
  }
})
