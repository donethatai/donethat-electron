const { EventEmitter } = require('events')
const {
  createLocalModelClient,
  buildWorkerEnv,
  CRASHES_BEFORE_CPU_FALLBACK,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS
} = require('../localModel/client')
const { MAX_OUTPUT_TOKENS, IDLE_UNLOAD_MS } = require('../localModel/modelInfo')

const MODEL_PATH = '/tmp/user-data/models/model.gguf'
const SCHEMA = { type: 'object', properties: { oneline: { type: 'string' } } }

function createFakeUtilityProcess({ exitOnShutdown = true } = {}) {
  const children = []
  const utilityProcess = {
    fork: jest.fn((modulePath, args, options) => {
      const child = new EventEmitter()
      child.modulePath = modulePath
      child.options = options
      child.sent = []
      child.stderr = new EventEmitter()
      child.postMessage = jest.fn(message => {
        child.sent.push(message)
        if (message.type === 'shutdown' && exitOnShutdown) setImmediate(() => child.emit('exit', 0))
      })
      child.kill = jest.fn(() => {
        setImmediate(() => child.emit('exit', null))
        return true
      })
      child.lastGenerate = () => child.sent.filter(message => message.type === 'generate').pop()
      child.reply = (value) => child.emit('message', { type: 'result', id: child.lastGenerate().id, ok: true, value })
      children.push(child)
      return child
    })
  }
  return { utilityProcess, children }
}

function createLog() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}

function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

describe('local model client', () => {
  function setup(options = {}) {
    const fake = createFakeUtilityProcess(options.fake)
    const log = createLog()
    const client = createLocalModelClient({
      utilityProcess: fake.utilityProcess,
      workerPath: '/app/src-main/localModel/worker.js',
      getModelPath: options.getModelPath || (() => MODEL_PATH),
      log,
      env: { PATH: '/usr/bin', HOME: '/Users/me', FIREBASE_TOKEN: 'secret', GEMINI_API_KEY: 'key' },
      shutdownGraceMs: 50,
      ...options.client
    })
    return { ...fake, client, log }
  }

  test('starts the worker lazily with a minimal environment and returns the result', async () => {
    const { client, utilityProcess, children } = setup()
    expect(utilityProcess.fork).not.toHaveBeenCalled()

    const result = client.generateStructured({ prompt: 'Describe the work', schema: SCHEMA })
    const child = children[0]
    expect(child.modulePath).toBe('/app/src-main/localModel/worker.js')
    expect(child.options.serviceName).toBeTruthy()
    expect(child.options.env).toEqual({ PATH: '/usr/bin', HOME: '/Users/me', NODE_LLAMA_CPP_SKIP_DOWNLOAD: 'true' })
    expect(child.lastGenerate()).toMatchObject({
      type: 'generate',
      modelPath: MODEL_PATH,
      prompt: 'Describe the work',
      schema: SCHEMA,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      cpuOnly: false
    })

    child.reply({ oneline: 'Writing code' })
    await expect(result).resolves.toEqual({ oneline: 'Writing code' })

    const second = client.generateStructured({ prompt: 'Again', schema: SCHEMA, maxTokens: 50000 })
    expect(utilityProcess.fork).toHaveBeenCalledTimes(1)
    expect(child.lastGenerate().maxTokens).toBe(MAX_OUTPUT_TOKENS)
    child.reply({ oneline: 'Still coding' })
    await expect(second).resolves.toEqual({ oneline: 'Still coding' })
    await client.shutdown()
  })

  test('refuses to start without a verified model file', async () => {
    const { client, utilityProcess } = setup({ getModelPath: () => null })
    await expect(client.generateStructured({ prompt: 'x', schema: SCHEMA })).rejects.toMatchObject({ code: 'MODEL_NOT_READY' })
    expect(utilityProcess.fork).not.toHaveBeenCalled()
  })

  test('reports a worker that cannot be started', async () => {
    const { client, utilityProcess } = setup()
    utilityProcess.fork.mockImplementationOnce(() => { throw new Error('app not ready') })
    await expect(client.generateStructured({ prompt: 'x', schema: SCHEMA })).rejects.toMatchObject({ code: 'WORKER_START_FAILED' })
  })

  test('validates the request', async () => {
    const { client } = setup()
    await expect(client.generateStructured({ prompt: '', schema: SCHEMA })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.generateStructured({ prompt: 'x' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  test('passes worker errors through with their code', async () => {
    const { client, children } = setup()
    const result = client.generateStructured({ prompt: 'x', schema: SCHEMA })
    const child = children[0]
    child.emit('message', { type: 'result', id: child.lastGenerate().id, ok: false, error: { code: 'INVALID_OUTPUT', message: 'Model output did not match the schema' } })
    await expect(result).rejects.toMatchObject({ code: 'INVALID_OUTPUT' })
    await client.shutdown()
  })

  test('a worker crash rejects pending requests and the next request starts a new worker', async () => {
    const { client, utilityProcess, children, log } = setup()
    const first = client.generateStructured({ prompt: 'x', schema: SCHEMA })
    children[0].emit('exit', 134)

    await expect(first).rejects.toMatchObject({ code: 'WORKER_EXITED', message: expect.stringContaining('134') })
    expect(log.error).toHaveBeenCalled()
    expect(client.isRunning()).toBe(false)

    const second = client.generateStructured({ prompt: 'x', schema: SCHEMA })
    expect(utilityProcess.fork).toHaveBeenCalledTimes(2)
    children[1].reply({ oneline: 'ok' })
    await expect(second).resolves.toEqual({ oneline: 'ok' })
    await client.shutdown()
  })

  test('falls back to CPU after repeated crashes during requests', async () => {
    const { client, children } = setup()
    for (let crash = 0; crash < CRASHES_BEFORE_CPU_FALLBACK; crash++) {
      const request = client.generateStructured({ prompt: 'x', schema: SCHEMA })
      expect(children[crash].lastGenerate().cpuOnly).toBe(false)
      children[crash].emit('exit', 139)
      await expect(request).rejects.toMatchObject({ code: 'WORKER_EXITED' })
    }

    const request = client.generateStructured({ prompt: 'x', schema: SCHEMA })
    const child = children[CRASHES_BEFORE_CPU_FALLBACK]
    expect(child.lastGenerate().cpuOnly).toBe(true)
    child.reply({ oneline: 'ok' })
    await expect(request).resolves.toEqual({ oneline: 'ok' })
    await client.shutdown()
  })

  test('abort rejects at once, tells the worker and ignores a late result', async () => {
    const { client, children } = setup()
    const controller = new AbortController()
    const request = client.generateStructured({ prompt: 'x', schema: SCHEMA, signal: controller.signal })
    const child = children[0]
    const { id } = child.lastGenerate()

    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.sent).toContainEqual({ type: 'abort', id })

    child.emit('message', { type: 'result', id, ok: true, value: { oneline: 'late' } })
    await client.shutdown()
  })

  test('an already aborted signal never reaches the worker', async () => {
    const { client, utilityProcess } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(client.generateStructured({ prompt: 'x', schema: SCHEMA, signal: controller.signal })).rejects.toBeTruthy()
    expect(utilityProcess.fork).not.toHaveBeenCalled()
  })

  test('a timeout rejects and kills the worker; the next request restarts it', async () => {
    const { client, children, utilityProcess } = setup()
    const request = client.generateStructured({ prompt: 'x', schema: SCHEMA, timeoutMs: 20 })

    await expect(request).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(children[0].kill).toHaveBeenCalled()

    const next = client.generateStructured({ prompt: 'x', schema: SCHEMA })
    expect(utilityProcess.fork).toHaveBeenCalledTimes(2)
    children[1].reply({ oneline: 'ok' })
    await expect(next).resolves.toEqual({ oneline: 'ok' })
    await client.shutdown()
  })

  test.each([
    [undefined, DEFAULT_REQUEST_TIMEOUT_MS],
    [0, DEFAULT_REQUEST_TIMEOUT_MS],
    [-5, DEFAULT_REQUEST_TIMEOUT_MS],
    ['soon', DEFAULT_REQUEST_TIMEOUT_MS],
    [12 * 60 * 1000, 12 * 60 * 1000],
    [MAX_REQUEST_TIMEOUT_MS * 3, MAX_REQUEST_TIMEOUT_MS]
  ])('uses the caller timeout %p as %p ms', async (timeoutMs, expectedMs) => {
    const { client, children } = setup()
    const timerSpy = jest.spyOn(global, 'setTimeout')
    try {
      const request = client.generateStructured({ prompt: 'x', schema: SCHEMA, timeoutMs })
      expect(timerSpy.mock.calls.map(call => call[1])).toContain(expectedMs)
      children[0].reply({ oneline: 'ok' })
      await request
    } finally {
      timerSpy.mockRestore()
    }
    await client.shutdown()
  })

  test('stops the worker after the idle period', async () => {
    jest.useFakeTimers()
    try {
      const { client, children } = setup()
      const request = client.generateStructured({ prompt: 'x', schema: SCHEMA })
      children[0].reply({ oneline: 'ok' })
      await request

      jest.advanceTimersByTime(IDLE_UNLOAD_MS - 1)
      expect(children[0].sent.some(message => message.type === 'shutdown')).toBe(false)
      jest.advanceTimersByTime(1)
      expect(children[0].sent.some(message => message.type === 'shutdown')).toBe(true)
      expect(client.isRunning()).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  test('shutdown rejects pending requests and kills a worker that does not exit', async () => {
    const { client, children } = setup({ fake: { exitOnShutdown: false } })
    const request = client.generateStructured({ prompt: 'x', schema: SCHEMA })
    const child = children[0]

    await client.shutdown()

    await expect(request).rejects.toMatchObject({ code: 'WORKER_EXITED' })
    expect(child.sent.some(message => message.type === 'shutdown')).toBe(true)
    expect(child.kill).toHaveBeenCalled()
    await flush()
    expect(client.isRunning()).toBe(false)
  })

  test('relays worker log messages and stderr without request content', async () => {
    const { client, children, log } = setup()
    const request = client.generateStructured({ prompt: 'secret screen text', schema: SCHEMA })
    const child = children[0]
    child.emit('message', { type: 'log', level: 'warn', message: 'GPU load failed, retrying on CPU' })
    child.stderr.emit('data', Buffer.from('ggml_metal_init: error'))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('GPU load failed'))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ggml_metal_init'))
    child.reply({ oneline: 'ok' })
    await request
    const logged = [log.info, log.warn, log.error].flatMap(fn => fn.mock.calls).flat().join(' ')
    expect(logged).not.toContain('secret screen text')
    await client.shutdown()
  })

  test('buildWorkerEnv keeps only OS and GPU runtime variables', () => {
    const env = buildWorkerEnv({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      CUDA_PATH: 'C:\\CUDA',
      CUDA_PATH_V12_4: 'C:\\CUDA12',
      GH_TOKEN: 'ghp_x',
      DONETHAT_ID_TOKEN: 'abc',
      NODE_OPTIONS: '--require evil.js',
      NODE_LLAMA_CPP_GPU: 'vulkan'
    })
    expect(env).toEqual({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      CUDA_PATH: 'C:\\CUDA',
      CUDA_PATH_V12_4: 'C:\\CUDA12',
      NODE_LLAMA_CPP_SKIP_DOWNLOAD: 'true'
    })
  })
})
