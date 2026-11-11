// Main-process side of the on-device model: owns the utilityProcess that runs
// node-llama-cpp, so a native crash in llama.cpp takes down only that process.
//
// - Lazy start on the first request; the worker loads the model on demand.
// - After IDLE_UNLOAD_MS without requests the worker is stopped, which frees
//   all model, context and GPU memory at once.
// - If the worker dies, pending requests reject with code WORKER_EXITED and the
//   next request starts a fresh worker. After repeated crashes during requests
//   the worker is asked to run on the CPU only.
// - A request timeout kills the worker, since native evaluation may not notice
//   an abort in time; the next request restarts it.

const {
  MAX_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  IDLE_UNLOAD_MS
} = require('./modelInfo')

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const MAX_REQUEST_TIMEOUT_MS = 30 * 60 * 1000
const SHUTDOWN_GRACE_MS = 3000
const CRASHES_BEFORE_CPU_FALLBACK = 2
const WORKER_SERVICE_NAME = 'DoneThat On-device Model'
const STDERR_LOG_LIMIT = 500

// The worker gets only what the OS, Node and llama.cpp need to start and find
// GPU runtimes: no tokens, keys or app configuration.
const WORKER_ENV_KEYS = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG',
  'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'
])
const WORKER_ENV_PATTERNS = [/^CUDA_PATH(_V\d+_\d+)?$/i]

function buildWorkerEnv(sourceEnv = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(sourceEnv || {})) {
    if (typeof value !== 'string') continue
    if (WORKER_ENV_KEYS.has(key.toUpperCase()) || WORKER_ENV_PATTERNS.some(pattern => pattern.test(key))) {
      env[key] = value
    }
  }
  env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = 'true'
  return env
}

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  const error = new Error('On-device generation aborted')
  error.name = 'AbortError'
  error.code = 'ABORTED'
  return error
}

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function createLocalModelClient({
  utilityProcess,
  workerPath,
  getModelPath,
  log,
  env = process.env,
  idleUnloadMs = IDLE_UNLOAD_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  shutdownGraceMs = SHUTDOWN_GRACE_MS
}) {
  let worker = null
  let nextRequestId = 1
  let idleTimer = null
  let consecutiveCrashes = 0
  let cpuOnly = false
  const pending = new Map()

  function clearIdleTimer() {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  function scheduleIdleUnload() {
    clearIdleTimer()
    if (!worker || pending.size > 0) return
    idleTimer = setTimeout(() => {
      log.info('[localModel] Unloading on-device model after idle period')
      stopWorker()
    }, idleUnloadMs)
    idleTimer.unref?.()
  }

  function rejectPendingFor(handle, error) {
    for (const entry of Array.from(pending.values())) {
      if (handle && entry.handle !== handle) continue
      entry.fail(error)
    }
  }

  function handleMessage(handle, message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'log') {
      const level = ['error', 'warn', 'info', 'debug'].includes(message.level) ? message.level : 'info'
      log[level](`[localModel worker] ${String(message.message || '').slice(0, STDERR_LOG_LIMIT)}`)
      return
    }
    if (message.type !== 'result') return
    const entry = pending.get(message.id)
    if (!entry || entry.handle !== handle) return
    entry.settle(message)
  }

  function handleExit(handle, code) {
    handle.resolveExited(code)
    if (worker === handle) worker = null
    const hadPending = Array.from(pending.values()).some(entry => entry.handle === handle)
    if (handle.expectedExit) {
      rejectPendingFor(handle, codedError('WORKER_EXITED', 'On-device model was stopped'))
    } else {
      log.error(`[localModel] On-device model process exited unexpectedly (code ${code})`)
      rejectPendingFor(handle, codedError('WORKER_EXITED', `On-device model process exited unexpectedly (code ${code})`))
      if (hadPending) consecutiveCrashes++
      if (!cpuOnly && consecutiveCrashes >= CRASHES_BEFORE_CPU_FALLBACK) {
        cpuOnly = true
        log.warn('[localModel] Repeated crashes; running the on-device model on CPU only from now on')
      }
    }
    if (!worker) clearIdleTimer()
  }

  function spawnWorker() {
    const proc = utilityProcess.fork(workerPath, [], {
      serviceName: WORKER_SERVICE_NAME,
      env: buildWorkerEnv(env),
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const handle = { proc, expectedExit: false, resolveExited: null, exited: null }
    handle.exited = new Promise(resolve => {
      handle.resolveExited = resolve
    })
    proc.on('message', message => handleMessage(handle, message))
    proc.on('exit', code => handleExit(handle, code))
    proc.on('error', type => log.error(`[localModel] On-device model process error: ${type}`))
    proc.stderr?.on('data', chunk => {
      log.warn(`[localModel worker stderr] ${String(chunk).trim().slice(0, STDERR_LOG_LIMIT)}`)
    })
    worker = handle
    return handle
  }

  function post(handle, message) {
    try {
      handle.proc.postMessage(message)
      return true
    } catch (error) {
      log.warn('[localModel] Could not reach on-device model process:', error.message)
      return false
    }
  }

  function killWorker(handle) {
    handle.expectedExit = true
    if (worker === handle) worker = null
    try {
      handle.proc.kill()
    } catch (error) {
      log.warn('[localModel] Could not kill on-device model process:', error.message)
    }
  }

  async function stopWorker() {
    const handle = worker
    if (!handle) return
    worker = null
    clearIdleTimer()
    handle.expectedExit = true
    post(handle, { type: 'shutdown' })
    const exitedGracefully = await Promise.race([handle.exited.then(() => true), delay(shutdownGraceMs).then(() => false)])
    if (exitedGracefully) return
    killWorker(handle)
    await Promise.race([handle.exited, delay(shutdownGraceMs)])
  }

  function resolveTimeoutMs(timeoutMs) {
    const value = Number(timeoutMs)
    if (!Number.isFinite(value) || value <= 0) return requestTimeoutMs
    return Math.min(Math.ceil(value), MAX_REQUEST_TIMEOUT_MS)
  }

  /**
   * Run one JSON-schema-constrained generation on the on-device model.
   * @param {{ prompt: string, schema: object, signal?: AbortSignal, maxTokens?: number,
   *   timeoutMs?: number, systemPrompt?: string, temperature?: number }} request
   * @returns {Promise<object>} The parsed JSON object matching the schema
   */
  function generateStructured({ prompt, schema, signal, maxTokens, timeoutMs, systemPrompt, temperature = DEFAULT_TEMPERATURE } = {}) {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return Promise.reject(codedError('INVALID_REQUEST', 'prompt must be a non-empty string'))
    }
    if (!schema || typeof schema !== 'object') {
      return Promise.reject(codedError('INVALID_REQUEST', 'schema must be an object'))
    }
    if (signal?.aborted) return Promise.reject(abortError(signal))
    const modelPath = getModelPath()
    if (!modelPath) {
      return Promise.reject(codedError('MODEL_NOT_READY', 'On-device model is not downloaded and verified'))
    }

    let handle
    try {
      handle = worker || spawnWorker()
    } catch (error) {
      return Promise.reject(codedError('WORKER_START_FAILED', `Could not start the on-device model process: ${error.message}`))
    }
    clearIdleTimer()
    const id = nextRequestId++
    const resolvedMaxTokens = Math.min(Number(maxTokens) > 0 ? Math.floor(Number(maxTokens)) : MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS)
    const resolvedTimeoutMs = resolveTimeoutMs(timeoutMs)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        log.warn(`[localModel] Generation timed out after ${resolvedTimeoutMs} ms; restarting the on-device model process`)
        entry.fail(codedError('TIMEOUT', `On-device generation timed out after ${resolvedTimeoutMs} ms`))
        killWorker(handle)
      }, resolvedTimeoutMs)
      const onAbort = () => {
        post(handle, { type: 'abort', id })
        entry.fail(abortError(signal))
      }

      function cleanup() {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        pending.delete(id)
        scheduleIdleUnload()
      }

      const entry = {
        handle,
        fail(error) {
          if (!pending.has(id)) return
          cleanup()
          reject(error)
        },
        settle(message) {
          if (!pending.has(id)) return
          cleanup()
          if (message.ok) {
            consecutiveCrashes = 0
            resolve(message.value)
            return
          }
          const error = message.error || {}
          reject(codedError(error.code || 'GENERATION_FAILED', error.message || 'On-device generation failed'))
        }
      }

      pending.set(id, entry)
      signal?.addEventListener?.('abort', onAbort, { once: true })
      const sent = post(handle, {
        type: 'generate',
        id,
        modelPath,
        prompt,
        schema,
        systemPrompt,
        maxTokens: resolvedMaxTokens,
        temperature,
        cpuOnly
      })
      if (!sent) {
        entry.fail(codedError('WORKER_EXITED', 'On-device model process is not reachable'))
        killWorker(handle)
      }
    })
  }

  async function shutdown() {
    clearIdleTimer()
    rejectPendingFor(null, codedError('WORKER_EXITED', 'On-device model was shut down'))
    await stopWorker()
  }

  function isRunning() {
    return Boolean(worker)
  }

  return { generateStructured, shutdown, isRunning }
}

module.exports = {
  createLocalModelClient,
  buildWorkerEnv,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  WORKER_SERVICE_NAME,
  CRASHES_BEFORE_CPU_FALLBACK
}
