const { createWorker } = require('../localModel/worker')
const { CONTEXT_SIZE, MAX_PROMPT_TOKENS, MAX_OUTPUT_TOKENS } = require('../localModel/modelInfo')

const MODEL_PATH = '/tmp/user-data/models/model.gguf'
const SCHEMA = { type: 'object', properties: { oneline: { type: 'string' } } }

function createFakeLib({ gpuLoadFails = false, cpuBuildMissing = false, promptTokens = 100, prompt } = {}) {
  const lib = { instances: [], sessions: [] }
  lib.LlamaLogLevel = { warn: 'warn' }
  lib.QwenChatWrapper = jest.fn(function QwenChatWrapper(options) {
    this.options = options
  })
  lib.LlamaChatSession = jest.fn(function LlamaChatSession(options) {
    this.options = options
    this.prompt = jest.fn(prompt || (async () => '{"oneline":"Writing tests"}'))
    this.dispose = jest.fn()
    lib.sessions.push(this)
  })
  lib.getLlama = jest.fn(async options => {
    if (options.gpu === false && cpuBuildMissing) throw new Error('NoBinaryFoundError')
    const context = { getSequence: jest.fn(() => ({ id: 'sequence' })), dispose: jest.fn(async () => {}) }
    const model = {
      tokenize: jest.fn(() => new Array(promptTokens).fill(1)),
      createContext: jest.fn(async () => context),
      dispose: jest.fn(async () => {})
    }
    const llama = {
      gpu: options.gpu === false ? false : 'metal',
      options,
      model,
      context,
      loadModel: jest.fn(async ({ gpuLayers }) => {
        if (gpuLayers !== 0 && gpuLoadFails) throw new Error('ggml_metal_init failed')
        return model
      }),
      createGrammarForJsonSchema: jest.fn(async schema => ({ schema, parse: jest.fn(text => JSON.parse(text)) })),
      dispose: jest.fn(async () => {})
    }
    lib.instances.push(llama)
    return llama
  })
  return lib
}

function setup(libOptions) {
  const lib = createFakeLib(libOptions)
  const messages = []
  const parentPort = { on: jest.fn(), postMessage: jest.fn(message => messages.push(message)) }
  const exit = jest.fn()
  const worker = createWorker({ parentPort, importLlama: jest.fn(async () => lib), exit })
  const results = () => messages.filter(message => message.type === 'result')
  const logs = () => messages.filter(message => message.type === 'log').map(message => message.message).join('\n')
  const generate = (overrides = {}) => worker.handleMessage({
    type: 'generate',
    id: overrides.id || 1,
    modelPath: MODEL_PATH,
    prompt: 'Summarise: secret screen text',
    schema: SCHEMA,
    maxTokens: 400,
    temperature: 0.2,
    cpuOnly: false,
    ...overrides
  })
  return { lib, worker, parentPort, messages, results, logs, generate, exit }
}

describe('local model worker', () => {
  test('loads prebuilt binaries only and generates schema-constrained JSON without thinking', async () => {
    const { lib, results, generate, parentPort } = setup()
    expect(parentPort.on).toHaveBeenCalledWith('message', expect.any(Function))

    await generate()

    const [llama] = lib.instances
    expect(lib.getLlama).toHaveBeenCalledTimes(1)
    expect(llama.options).toMatchObject({ gpu: 'auto', build: 'never', skipDownload: true, usePrebuiltBinaries: true, progressLogs: false })
    expect(llama.loadModel).toHaveBeenCalledWith({ modelPath: MODEL_PATH, gpuLayers: { fitContext: { contextSize: CONTEXT_SIZE } } })
    expect(llama.model.createContext).toHaveBeenCalledWith({ contextSize: CONTEXT_SIZE, sequences: 1 })
    expect(llama.context.getSequence).toHaveBeenCalledWith()
    expect(llama.createGrammarForJsonSchema).toHaveBeenCalledWith(SCHEMA)

    expect(lib.QwenChatWrapper).toHaveBeenCalledWith({ variation: '3.5', thoughts: 'discourage' })
    const [session] = lib.sessions
    expect(session.options).toMatchObject({ autoDisposeSequence: true, systemPrompt: expect.any(String) })
    const [promptText, promptOptions] = session.prompt.mock.calls[0]
    expect(promptText).toBe('Summarise: secret screen text')
    expect(promptOptions).toMatchObject({ maxTokens: 400, temperature: 0.2, budgets: { thoughtTokens: 0 } })
    expect(promptOptions.grammar.schema).toBe(SCHEMA)
    expect(promptOptions.signal).toBeInstanceOf(AbortSignal)
    expect(session.dispose).toHaveBeenCalled()

    expect(results()).toEqual([{ type: 'result', id: 1, ok: true, value: { oneline: 'Writing tests' } }])
  })

  test('keeps the model loaded between requests', async () => {
    const { lib, results, generate } = setup()
    await generate({ id: 1 })
    await generate({ id: 2 })
    expect(lib.getLlama).toHaveBeenCalledTimes(1)
    expect(lib.instances[0].loadModel).toHaveBeenCalledTimes(1)
    expect(results().map(result => result.ok)).toEqual([true, true])
  })

  test('falls back to the CPU build when GPU loading fails', async () => {
    const { lib, results, generate, logs } = setup({ gpuLoadFails: true })
    await generate()

    expect(lib.instances).toHaveLength(2)
    expect(lib.instances[0].dispose).toHaveBeenCalled()
    expect(lib.instances[1].options).toMatchObject({ gpu: false, build: 'never' })
    expect(lib.instances[1].loadModel).toHaveBeenCalledWith({ modelPath: MODEL_PATH, gpuLayers: 0 })
    expect(results()[0].ok).toBe(true)
    expect(logs()).toContain('retrying on CPU')
  })

  test('runs the GPU build with zero GPU layers when no CPU-only build exists', async () => {
    const { lib, results, generate } = setup({ cpuBuildMissing: true })
    await generate({ cpuOnly: true })

    const used = lib.instances[lib.instances.length - 1]
    expect(used.options).toMatchObject({ gpu: 'auto', build: 'never' })
    expect(used.loadModel).toHaveBeenCalledWith({ modelPath: MODEL_PATH, gpuLayers: 0 })
    expect(results()[0].ok).toBe(true)
  })

  test('reloads on CPU when the main process asks for CPU only', async () => {
    const { lib, generate } = setup()
    await generate({ id: 1 })
    await generate({ id: 2, cpuOnly: true })
    expect(lib.instances).toHaveLength(2)
    expect(lib.instances[0].dispose).toHaveBeenCalled()
    expect(lib.instances[1].options.gpu).toBe(false)
  })

  test('rejects prompts that do not fit the context', async () => {
    const { results, generate, lib } = setup({ promptTokens: MAX_PROMPT_TOKENS + 1 })
    await generate()
    expect(results()[0]).toMatchObject({ ok: false, error: { code: 'PROMPT_TOO_LONG' } })
    expect(lib.sessions).toHaveLength(0)
  })

  test('caps maxTokens at the output budget', async () => {
    const { lib, generate } = setup()
    await generate({ maxTokens: 50000 })
    expect(lib.sessions[0].prompt.mock.calls[0][1].maxTokens).toBe(MAX_OUTPUT_TOKENS)
  })

  test('reports output that does not parse without echoing it', async () => {
    const { results, generate, logs } = setup({ prompt: async () => '{"oneline": "secret generated summary' })
    await generate()
    const [result] = results()
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_OUTPUT' } })
    expect(JSON.stringify(result)).not.toContain('secret generated summary')
    expect(logs()).not.toContain('secret')
  })

  test('aborts a running generation', async () => {
    let started
    const startedPromise = new Promise(resolve => { started = resolve })
    const { results, worker, generate } = setup({
      prompt: (text, options) => new Promise((resolve, reject) => {
        started()
        options.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const running = generate({ id: 7 })
    await startedPromise
    worker.handleMessage({ type: 'abort', id: 7 })
    await running
    expect(results()[0]).toEqual({ type: 'result', id: 7, ok: false, error: { code: 'ABORTED', message: 'Generation aborted' } })
  })

  test('shutdown aborts work, disposes the runtime and exits', async () => {
    const { lib, worker, generate, exit } = setup()
    await generate()
    await worker.handleMessage({ type: 'shutdown' })
    const [llama] = lib.instances
    expect(llama.context.dispose).toHaveBeenCalled()
    expect(llama.model.dispose).toHaveBeenCalled()
    expect(llama.dispose).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0)
  })

  test('never logs the prompt', async () => {
    const { generate, logs } = setup()
    await generate()
    expect(logs()).not.toContain('secret screen text')
  })
})
