// Native crash reports (minidumps) of the on-device model process hold its
// memory, which can include prompt text (OCR and window text). They must never
// reach Sentry.
//
// @sentry/electron's SentryMinidump integration builds these events:
// - on `child-process-gone`, with the Electron details in
//   `contexts.electron.details` (for a utilityProcess, `details.name` is the
//   `serviceName` passed to utilityProcess.fork);
// - at startup, for dumps left by the previous run, without those details.
// Every dump also carries its crashpad annotations as `contexts.electron['crashpad.*']`.
// Chromium tags utility processes with the mojo service they run; every
// Electron utilityProcess runs `node.mojom.NodeService`, and the on-device
// model worker is the app's only utilityProcess.

const { WORKER_SERVICE_NAME } = require('./client')

const ELECTRON_NODE_SERVICE = 'node.mojom.NodeService'

function isMinidumpEvent(event, hint) {
  if (Array.isArray(hint?.attachments) && hint.attachments.some(attachment => attachment?.attachmentType === 'event.minidump')) {
    return true
  }
  return event?.platform === 'native' || event?.tags?.['event.environment'] === 'native'
}

function normalizeProcessType(value) {
  return String(value || '').toLowerCase().replace(/-process$/, '')
}

function isLocalModelWorkerSentryEvent(event, hint) {
  const electron = event?.contexts?.electron || {}
  const details = electron.details || {}
  if (details.name === WORKER_SERVICE_NAME || details.serviceName === WORKER_SERVICE_NAME) return true
  if (!isMinidumpEvent(event, hint)) return false

  const processType = normalizeProcessType(electron['crashpad.process_type'] || event?.tags?.['event.process'])
  if (processType !== 'utility') return false
  const service = electron['crashpad.service-name'] || electron['crashpad.utility-sub-type']
  // Without a service annotation the dump cannot be told apart from the worker's.
  return !service || service === ELECTRON_NODE_SERVICE
}

module.exports = {
  isLocalModelWorkerSentryEvent,
  ELECTRON_NODE_SERVICE
}
