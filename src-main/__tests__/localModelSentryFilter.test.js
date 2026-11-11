const { isLocalModelWorkerSentryEvent, ELECTRON_NODE_SERVICE } = require('../localModel/sentryFilter')
const { WORKER_SERVICE_NAME } = require('../localModel/client')

const MINIDUMP_HINT = { attachments: [{ attachmentType: 'event.minidump', filename: 'dump.dmp' }] }

function nativeEvent({ processTag, electron = {} } = {}) {
  return {
    level: 'fatal',
    platform: 'native',
    tags: { 'event.environment': 'native', 'event.process': processTag },
    contexts: { electron }
  }
}

describe('on-device model Sentry filter', () => {
  test('drops a live child-process-gone crash of the worker', () => {
    const event = nativeEvent({
      processTag: 'utility',
      electron: {
        details: { type: 'Utility', reason: 'crashed', exitCode: 11, name: WORKER_SERVICE_NAME, serviceName: ELECTRON_NODE_SERVICE },
        'crashpad.process_type': 'utility',
        'crashpad.service-name': ELECTRON_NODE_SERVICE
      }
    })
    expect(isLocalModelWorkerSentryEvent(event, MINIDUMP_HINT)).toBe(true)
  })

  test('drops a utilityProcess minidump found at startup (no Electron details)', () => {
    const event = nativeEvent({
      processTag: 'utility',
      electron: { 'crashpad.process_type': 'utility', 'crashpad.utility-sub-type': ELECTRON_NODE_SERVICE }
    })
    expect(isLocalModelWorkerSentryEvent(event, MINIDUMP_HINT)).toBe(true)
  })

  test('drops a utility minidump without a service annotation, since it may be the worker', () => {
    expect(isLocalModelWorkerSentryEvent(nativeEvent({ processTag: 'utility' }), MINIDUMP_HINT)).toBe(true)
    expect(isLocalModelWorkerSentryEvent(nativeEvent({ processTag: 'unknown', electron: { 'crashpad.process_type': 'utility-process' } }), MINIDUMP_HINT)).toBe(true)
  })

  test('drops a worker minidump batched into another process crash', () => {
    const event = nativeEvent({
      processTag: 'utility',
      electron: {
        details: { type: 'GPU', reason: 'crashed', exitCode: 1 },
        'crashpad.process_type': 'utility',
        'crashpad.service-name': ELECTRON_NODE_SERVICE
      }
    })
    expect(isLocalModelWorkerSentryEvent(event, MINIDUMP_HINT)).toBe(true)
  })

  test('keeps crashes of other Chromium utility services', () => {
    const event = nativeEvent({
      processTag: 'utility',
      electron: {
        details: { type: 'Utility', reason: 'crashed', name: 'Network Service', serviceName: 'network.mojom.NetworkService' },
        'crashpad.process_type': 'utility',
        'crashpad.service-name': 'network.mojom.NetworkService'
      }
    })
    expect(isLocalModelWorkerSentryEvent(event, MINIDUMP_HINT)).toBe(false)
  })

  test('keeps renderer, GPU and browser crashes', () => {
    expect(isLocalModelWorkerSentryEvent(nativeEvent({ processTag: 'renderer', electron: { 'crashpad.process_type': 'renderer' } }), MINIDUMP_HINT)).toBe(false)
    expect(isLocalModelWorkerSentryEvent(nativeEvent({ processTag: 'gpu', electron: { details: { type: 'GPU', reason: 'crashed' } } }), MINIDUMP_HINT)).toBe(false)
    expect(isLocalModelWorkerSentryEvent(nativeEvent({ processTag: 'browser' }), MINIDUMP_HINT)).toBe(false)
  })

  test('keeps ordinary JavaScript events, including the app child-process-gone message', () => {
    expect(isLocalModelWorkerSentryEvent({ message: 'Something failed', tags: { 'event.process': 'browser' } }, {})).toBe(false)
    expect(isLocalModelWorkerSentryEvent({
      message: `Electron child process exited: ${WORKER_SERVICE_NAME} (abnormal-exit)`,
      tags: { 'event.process': 'Utility' },
      contexts: { electron_child_process: { type: 'Utility', name: WORKER_SERVICE_NAME } }
    }, undefined)).toBe(false)
    expect(isLocalModelWorkerSentryEvent(undefined, undefined)).toBe(false)
  })

  test('uses the minidump attachment when the event has no native markers', () => {
    const event = { tags: { 'event.process': 'utility' }, contexts: { electron: {} } }
    expect(isLocalModelWorkerSentryEvent(event, MINIDUMP_HINT)).toBe(true)
    expect(isLocalModelWorkerSentryEvent(event, {})).toBe(false)
  })
})
