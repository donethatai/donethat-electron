const { desktopCapturer } = require('electron')
const { recordScreenLock } = require('./telemetry')

let activeRequest = null
const queuedRequests = []

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    const pairs = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    return `{${pairs.join(',')}}`
  }

  return JSON.stringify(value)
}

function normalizeOptions(options = {}) {
  const types = Array.isArray(options.types)
    ? Array.from(new Set(options.types.map((type) => String(type)))).sort()
    : []

  const thumbnailSize = options.thumbnailSize || {}
  const thumbnailWidth = Number.isFinite(thumbnailSize.width) ? Math.max(0, Math.floor(thumbnailSize.width)) : 0
  const thumbnailHeight = Number.isFinite(thumbnailSize.height) ? Math.max(0, Math.floor(thumbnailSize.height)) : 0
  const fetchWindowIcons = !!options.fetchWindowIcons

  const extras = { ...options }
  delete extras.types
  delete extras.thumbnailSize
  delete extras.fetchWindowIcons

  return {
    types,
    thumbnailWidth,
    thumbnailHeight,
    fetchWindowIcons,
    extrasJson: stableStringify(extras)
  }
}

function sameTypes(left, right) {
  if (left.types.length !== right.types.length) return false
  for (let i = 0; i < left.types.length; i += 1) {
    if (left.types[i] !== right.types[i]) return false
  }
  return true
}

function canServe(existing, requested) {
  if (!sameTypes(existing, requested)) return false
  if (existing.thumbnailWidth < requested.thumbnailWidth) return false
  if (existing.thumbnailHeight < requested.thumbnailHeight) return false
  if (requested.fetchWindowIcons && !existing.fetchWindowIcons) return false
  return existing.extrasJson === requested.extrasJson
}

function isScreenCaptureLocked() {
  return !!activeRequest || queuedRequests.length > 0
}

function removeQueuedRequestIfEmpty(request) {
  if (request.waiters.length > 0) return
  const idx = queuedRequests.indexOf(request)
  if (idx >= 0) {
    queuedRequests.splice(idx, 1)
  }
}

function settleWaiter(waiter, result) {
  if (waiter.done) return
  waiter.done = true
  if (waiter.timeoutId) {
    clearTimeout(waiter.timeoutId)
    waiter.timeoutId = null
  }
  recordScreenLock(waiter.caller, Date.now() - waiter.startedAt, false)
  waiter.resolve(result)
}

function rejectWaiter(waiter, error) {
  if (waiter.done) return
  waiter.done = true
  if (waiter.timeoutId) {
    clearTimeout(waiter.timeoutId)
    waiter.timeoutId = null
  }
  recordScreenLock(waiter.caller, Date.now() - waiter.startedAt, false)
  waiter.reject(error)
}

function timeoutWaiter(waiter, request) {
  if (waiter.done) return
  waiter.done = true
  waiter.timeoutId = null

  const idx = request.waiters.indexOf(waiter)
  if (idx >= 0) {
    request.waiters.splice(idx, 1)
  }
  removeQueuedRequestIfEmpty(request)
  recordScreenLock(waiter.caller, Date.now() - waiter.startedAt, true)
  waiter.resolve(null)
}

function createWaiter(request, caller, timeoutMs) {
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const waiter = {
      caller,
      startedAt,
      timeoutId: null,
      done: false,
      resolve,
      reject
    }

    if (timeoutMs > 0) {
      waiter.timeoutId = setTimeout(() => {
        timeoutWaiter(waiter, request)
      }, timeoutMs)
    }

    request.waiters.push(waiter)
  })
}

function findQueuedCompatibleRequest(normalized) {
  return queuedRequests.find((request) => canServe(request.normalizedOptions, normalized))
}

function startNextRequest() {
  if (activeRequest || queuedRequests.length === 0) return

  const nextRequest = queuedRequests.shift()
  activeRequest = nextRequest

  desktopCapturer.getSources(nextRequest.rawOptions)
    .then((sources) => {
      const waiters = nextRequest.waiters.slice()
      waiters.forEach((waiter) => settleWaiter(waiter, sources))
    })
    .catch((error) => {
      const waiters = nextRequest.waiters.slice()
      waiters.forEach((waiter) => rejectWaiter(waiter, error))
    })
    .finally(() => {
      if (activeRequest === nextRequest) {
        activeRequest = null
      }
      startNextRequest()
    })
}

function queueRequest(rawOptions, normalizedOptions, caller, timeoutMs) {
  const request = {
    rawOptions,
    normalizedOptions,
    waiters: []
  }
  queuedRequests.push(request)
  const resultPromise = createWaiter(request, caller, timeoutMs)
  startNextRequest()
  return resultPromise
}

async function getScreenSources(options = {}, control = {}) {
  const { wait = true, timeoutMs = 0, caller = 'unknown' } = control
  const normalizedOptions = normalizeOptions(options)

  if (isScreenCaptureLocked() && !wait) {
    recordScreenLock(caller, 0, true)
    return null
  }

  if (activeRequest && canServe(activeRequest.normalizedOptions, normalizedOptions)) {
    return createWaiter(activeRequest, caller, timeoutMs)
  }

  const queuedCompatible = findQueuedCompatibleRequest(normalizedOptions)
  if (queuedCompatible) {
    return createWaiter(queuedCompatible, caller, timeoutMs)
  }

  return queueRequest(options, normalizedOptions, caller, timeoutMs)
}

module.exports = {
  getScreenSources,
  isScreenCaptureLocked
}
