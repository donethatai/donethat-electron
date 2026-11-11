// Entry point of the on-device model utilityProcess (see client.js).
//
// Runs node-llama-cpp (ESM, loaded via dynamic import) with prebuilt binaries
// only: `build: 'never'` and `skipDownload` mean it never clones, compiles or
// downloads llama.cpp at runtime. No sockets are opened; the only channel is
// the parent port. The model path comes from the main process, which only
// passes a file whose sha256 has been verified.
//
// Requests are processed one at a time. Prompt text and generated output are
// never logged or written anywhere; errors carry codes and generic messages.

const {
  CONTEXT_SIZE,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_TOKENS,
  DEFAULT_TEMPERATURE
} = require('./modelInfo')

const DEFAULT_SYSTEM_PROMPT = 'Follow the instructions in the user message. Reply only with JSON in the required format.'
const SAMPLING = { topP: 0.8, topK: 20 }
const LOG_LIMIT = 500

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createWorker({ parentPort, importLlama, exit = code => process.exit(code) }) {
  let libraryPromise = null
  let runtime = null
  let queue = Promise.resolve()
  const controllers = new Map()

  function post(message) {
    parentPort.postMessage(message)
  }

  function logToParent(level, message) {
    post({ type: 'log', level, message: String(message).slice(0, LOG_LIMIT) })
  }

  function loadLibrary() {
    if (!libraryPromise) {
      libraryPromise = importLlama().catch(error => {
        libraryPromise = null
        throw error
      })
    }
    return libraryPromise
  }

  function llamaOptions(lib, gpu) {
    return {
      gpu,
      build: 'never',
      usePrebuiltBinaries: true,
      skipDownload: true,
      progressLogs: false,
      logLevel: lib.LlamaLogLevel?.warn || 'warn',
      logger: (level, message) => {
        const parentLevel = level === 'fatal' || level === 'error' ? 'error' : 'warn'
        logToParent(parentLevel, `llama.cpp: ${message}`)
      }
    }
  }

  async function getLlamaFor(lib, cpuOnly) {
    if (!cpuOnly) return lib.getLlama(llamaOptions(lib, 'auto'))
    try {
      return await lib.getLlama(llamaOptions(lib, false))
    } catch (error) {
      // Apple Silicon ships only the Metal build; run it with zero GPU layers.
      return lib.getLlama(llamaOptions(lib, 'auto'))
    }
  }

  async function createRuntime(lib, modelPath, cpuOnly) {
    const llama = await getLlamaFor(lib, cpuOnly)
    try {
      const model = await llama.loadModel({
        modelPath,
        gpuLayers: cpuOnly ? 0 : { fitContext: { contextSize: CONTEXT_SIZE } }
      })
      try {
        const context = await model.createContext({ contextSize: CONTEXT_SIZE, sequences: 1 })
        const backend = cpuOnly || !llama.gpu ? 'cpu' : String(llama.gpu)
        logToParent('info', `Model loaded (backend: ${backend})`)
        return { llama, model, context, modelPath, cpuOnly, backend }
      } catch (error) {
        await model.dispose()
        throw error
      }
    } catch (error) {
      await llama.dispose()
      throw error
    }
  }

  async function disposeRuntime() {
    const current = runtime
    runtime = null
    if (!current) return
    try {
      await current.context.dispose()
      await current.model.dispose()
      await current.llama.dispose()
    } catch (error) {
      logToParent('warn', `Dispose failed: ${error.message}`)
    }
  }

  async function ensureRuntime(lib, modelPath, cpuOnly) {
    if (runtime && runtime.modelPath === modelPath && (runtime.cpuOnly || !cpuOnly)) return runtime
    await disposeRuntime()
    try {
      runtime = await createRuntime(lib, modelPath, cpuOnly)
    } catch (error) {
      if (cpuOnly) throw error
      logToParent('warn', `GPU load failed, retrying on CPU: ${error.message}`)
      runtime = await createRuntime(lib, modelPath, true)
    }
    return runtime
  }

  function parseOutput(grammar, text, outputTokens) {
    try {
      return grammar.parse(text)
    } catch (error) {
      throw codedError('INVALID_OUTPUT', `Model output did not match the schema (${outputTokens} output tokens, ${text.length} chars)`)
    }
  }

  async function generate(request, signal) {
    const lib = await loadLibrary()
    const current = await ensureRuntime(lib, request.modelPath, Boolean(request.cpuOnly))
    if (signal.aborted) throw codedError('ABORTED', 'Generation aborted')

    const promptTokens = current.model.tokenize(request.prompt).length
    if (promptTokens > MAX_PROMPT_TOKENS) {
      throw codedError('PROMPT_TOO_LONG', `Prompt has ${promptTokens} tokens; the limit is ${MAX_PROMPT_TOKENS}`)
    }

    let grammar
    try {
      grammar = await current.llama.createGrammarForJsonSchema(request.schema)
    } catch (error) {
      throw codedError('INVALID_SCHEMA', `Unsupported JSON schema: ${error.message}`)
    }

    const session = new lib.LlamaChatSession({
      contextSequence: current.context.getSequence(),
      // Qwen3.5 thinks by default. "discourage" renders an empty
      // <think></think> block into the reply (the template's non-thinking
      // mode) and stops force-opening a thought segment.
      chatWrapper: new lib.QwenChatWrapper({ variation: '3.5', thoughts: 'discourage' }),
      systemPrompt: request.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      autoDisposeSequence: true
    })
    try {
      const text = await session.prompt(request.prompt, {
        grammar,
        signal,
        maxTokens: Math.min(request.maxTokens || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
        temperature: typeof request.temperature === 'number' ? request.temperature : DEFAULT_TEMPERATURE,
        ...SAMPLING,
        budgets: { thoughtTokens: 0 }
      })
      const outputTokens = current.model.tokenize(text).length
      return { value: parseOutput(grammar, text, outputTokens), promptTokens, outputTokens, backend: current.backend }
    } finally {
      session.dispose()
    }
  }

  async function runGenerate(request, controller) {
    const startedAt = Date.now()
    try {
      if (controller.signal.aborted) throw codedError('ABORTED', 'Generation aborted')
      const { value, promptTokens, outputTokens, backend } = await generate(request, controller.signal)
      logToParent('debug', `Generated in ${Date.now() - startedAt} ms (${promptTokens} prompt tokens, ${outputTokens} output tokens, ${backend})`)
      post({ type: 'result', id: request.id, ok: true, value })
    } catch (error) {
      const code = controller.signal.aborted ? 'ABORTED' : (error.code || 'GENERATION_FAILED')
      const message = controller.signal.aborted ? 'Generation aborted' : (error.message || 'Generation failed')
      logToParent('warn', `Generation failed after ${Date.now() - startedAt} ms (${code}): ${message}`)
      post({ type: 'result', id: request.id, ok: false, error: { code, message: String(message).slice(0, LOG_LIMIT) } })
    } finally {
      controllers.delete(request.id)
    }
  }

  function enqueueGenerate(request) {
    const controller = new AbortController()
    controllers.set(request.id, controller)
    queue = queue.then(() => runGenerate(request, controller))
    return queue
  }

  async function shutdown() {
    for (const controller of controllers.values()) controller.abort()
    await disposeRuntime()
    exit(0)
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return undefined
    if (message.type === 'generate') return enqueueGenerate(message)
    if (message.type === 'abort') {
      controllers.get(message.id)?.abort()
      return undefined
    }
    if (message.type === 'shutdown') return shutdown()
    return undefined
  }

  parentPort.on('message', event => handleMessage(event?.data))

  return { handleMessage, getRuntime: () => runtime }
}

if (process.parentPort) {
  process.on('unhandledRejection', error => {
    process.parentPort.postMessage({ type: 'log', level: 'error', message: `Unhandled rejection: ${error?.message || error}` })
  })
  createWorker({ parentPort: process.parentPort, importLlama: () => import('node-llama-cpp') })
}

module.exports = { createWorker }
