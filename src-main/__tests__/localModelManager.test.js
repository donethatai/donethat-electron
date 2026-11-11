const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { createModelManager } = require('../localModel/modelManager')

const CONTENT = Buffer.from('GGUF'.repeat(4096))
const MODEL_URL = 'https://huggingface.co/acme/tiny-GGUF/resolve/0123abcd/tiny.gguf'
const CDN_URL = 'https://cas-bridge.xethub.hf.co/xet-bridge/tiny.gguf?sig=abc'

function testModel(overrides = {}) {
  return {
    id: 'tiny',
    fileName: 'tiny.gguf',
    sizeBytes: CONTENT.length,
    sha256: crypto.createHash('sha256').update(CONTENT).digest('hex'),
    url: MODEL_URL,
    ...overrides
  }
}

function createLog() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}

function headers(values = {}) {
  const lower = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]))
  return { get: name => lower[name.toLowerCase()] ?? null }
}

function splitChunks(buffer, count = 4) {
  const size = Math.ceil(buffer.length / count)
  const chunks = []
  for (let start = 0; start < buffer.length; start += size) chunks.push(buffer.subarray(start, start + size))
  return chunks
}

// Async-iterable body that honours the fetch AbortSignal like node-fetch does.
function streamBody(chunks, signal, { holdAfter = null, hold = null } = {}) {
  return (async function* body() {
    for (let index = 0; index < chunks.length; index++) {
      if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      if (holdAfter === index) {
        await new Promise((resolve, reject) => {
          hold?.then(resolve)
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
        })
      }
      yield chunks[index]
    }
  })()
}

function fullResponse(buffer, signal, options) {
  return { status: 200, headers: headers({ 'content-length': buffer.length }), body: streamBody(splitChunks(buffer), signal, options) }
}

function rangeResponse(buffer, offset, signal) {
  const slice = buffer.subarray(offset)
  return {
    status: 206,
    headers: headers({ 'content-range': `bytes ${offset}-${buffer.length - 1}/${buffer.length}`, 'content-length': slice.length }),
    body: streamBody(splitChunks(slice), signal)
  }
}

function rangeOffset(options) {
  const match = /^bytes=(\d+)-$/.exec(options.headers.Range || '')
  return match ? Number(match[1]) : 0
}

describe('local model manager', () => {
  let modelsDir

  beforeEach(() => {
    modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donethat-models-'))
  })

  afterEach(() => {
    fs.rmSync(modelsDir, { recursive: true, force: true })
  })

  function createManager({ fetchImpl, model = testModel(), ...rest } = {}) {
    return createModelManager({
      modelsDir,
      model,
      fetchImpl: fetchImpl || jest.fn(async (url, options) => fullResponse(CONTENT, options.signal)),
      log: createLog(),
      statfs: async () => ({ bavail: 1e9, bsize: 4096 }),
      progressIntervalMs: 0,
      ...rest
    })
  }

  function filePaths(model = testModel()) {
    const modelPath = path.join(modelsDir, model.fileName)
    return { modelPath, partPath: `${modelPath}.part`, markerPath: `${modelPath}.verified.json` }
  }

  test('starts absent, downloads, verifies and atomically moves the file into place', async () => {
    const fetchImpl = jest.fn(async (url, options) => fullResponse(CONTENT, options.signal))
    const manager = createManager({ fetchImpl })
    const states = []
    manager.onStatusChange(status => states.push(status.state))

    expect(manager.getModelStatus()).toEqual({ state: 'absent', receivedBytes: 0, totalBytes: CONTENT.length, error: null })
    await manager.downloadModel()

    const { modelPath, partPath, markerPath } = filePaths()
    expect(fs.readFileSync(modelPath).equals(CONTENT)).toBe(true)
    expect(fs.existsSync(partPath)).toBe(false)
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    expect(marker).toMatchObject({ sha256: testModel().sha256, sizeBytes: CONTENT.length, mtimeMs: fs.statSync(modelPath).mtimeMs })
    expect(manager.getModelStatus()).toEqual({ state: 'ready', receivedBytes: CONTENT.length, totalBytes: CONTENT.length, error: null })
    expect(manager.getVerifiedModelPath()).toBe(modelPath)
    expect(states[0]).toBe('downloading')
    expect(states).toContain('verifying')
    expect(states[states.length - 1]).toBe('ready')

    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe(MODEL_URL)
    expect(options.redirect).toBe('manual')
    expect(options.headers.Range).toBeUndefined()
  })

  test('reports progress through status events and stops after unsubscribe', async () => {
    const manager = createManager()
    const received = []
    const unsubscribe = manager.onStatusChange(status => received.push(status.receivedBytes))
    await manager.downloadModel()
    expect(received.some(bytes => bytes > 0 && bytes < CONTENT.length)).toBe(true)

    unsubscribe()
    const countBefore = received.length
    await manager.deleteModel()
    expect(received.length).toBe(countBefore)
  })

  test('resumes an existing .part file with an HTTP Range request', async () => {
    const { partPath, modelPath } = filePaths()
    const offset = 5000
    fs.writeFileSync(partPath, CONTENT.subarray(0, offset))
    const fetchImpl = jest.fn(async (url, options) => rangeResponse(CONTENT, rangeOffset(options), options.signal))
    const manager = createManager({ fetchImpl })

    expect(manager.getModelStatus()).toMatchObject({ state: 'absent', receivedBytes: offset })
    await manager.downloadModel()

    expect(fetchImpl.mock.calls[0][1].headers.Range).toBe(`bytes=${offset}-`)
    expect(fs.readFileSync(modelPath).equals(CONTENT)).toBe(true)
    expect(manager.getModelStatus().state).toBe('ready')
  })

  test('restarts from zero when the server ignores the Range header', async () => {
    const { partPath, modelPath } = filePaths()
    fs.writeFileSync(partPath, Buffer.from('stale bytes that are not the model'))
    const fetchImpl = jest.fn(async (url, options) => fullResponse(CONTENT, options.signal))
    const manager = createManager({ fetchImpl })

    await manager.downloadModel()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(modelPath).equals(CONTENT)).toBe(true)
    expect(manager.getModelStatus().state).toBe('ready')
  })

  test('restarts from zero when the resume range is rejected', async () => {
    const { partPath, modelPath } = filePaths()
    fs.writeFileSync(partPath, CONTENT.subarray(0, 100))
    const fetchImpl = jest.fn(async (url, options) => {
      if (options.headers.Range) return { status: 416, headers: headers(), body: streamBody([], options.signal) }
      return fullResponse(CONTENT, options.signal)
    })
    const manager = createManager({ fetchImpl })

    await manager.downloadModel()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1][1].headers.Range).toBeUndefined()
    expect(fs.readFileSync(modelPath).equals(CONTENT)).toBe(true)
  })

  test('finalises a complete .part without downloading again', async () => {
    const { partPath, modelPath } = filePaths()
    fs.writeFileSync(partPath, CONTENT)
    const fetchImpl = jest.fn()
    const manager = createManager({ fetchImpl })

    await manager.downloadModel()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(fs.existsSync(modelPath)).toBe(true)
    expect(manager.getModelStatus().state).toBe('ready')
  })

  test('rejects a download whose sha256 does not match and discards it', async () => {
    const corrupt = Buffer.from(CONTENT)
    corrupt[10] = corrupt[10] ^ 0xff
    const manager = createManager({ fetchImpl: jest.fn(async (url, options) => fullResponse(corrupt, options.signal)) })

    await expect(manager.downloadModel()).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' })

    const { modelPath, partPath, markerPath } = filePaths()
    expect(fs.existsSync(modelPath)).toBe(false)
    expect(fs.existsSync(partPath)).toBe(false)
    expect(fs.existsSync(markerPath)).toBe(false)
    expect(manager.getModelStatus()).toMatchObject({ state: 'error', error: expect.stringContaining('checksum') })
    expect(manager.getVerifiedModelPath()).toBeNull()
  })

  test('cancel keeps the partial file for a later resume', async () => {
    let releaseHold
    const hold = new Promise(resolve => { releaseHold = resolve })
    const fetchImpl = jest.fn(async (url, options) => {
      if (options.headers.Range) return rangeResponse(CONTENT, rangeOffset(options), options.signal)
      return fullResponse(CONTENT, options.signal, { holdAfter: 2, hold })
    })
    const manager = createManager({ fetchImpl })
    let cancelled = false
    manager.onStatusChange(status => {
      if (!cancelled && status.state === 'downloading' && status.receivedBytes > 0) {
        cancelled = true
        manager.cancelDownload()
      }
    })

    await expect(manager.downloadModel()).resolves.toBeUndefined()
    releaseHold()

    const { partPath, modelPath } = filePaths()
    const status = manager.getModelStatus()
    expect(status.state).toBe('absent')
    expect(status.receivedBytes).toBeGreaterThan(0)
    expect(fs.existsSync(partPath)).toBe(true)
    expect(fs.existsSync(modelPath)).toBe(false)

    await manager.downloadModel()
    expect(fetchImpl.mock.calls[1][1].headers.Range).toBe(`bytes=${status.receivedBytes}-`)
    expect(fs.readFileSync(modelPath).equals(CONTENT)).toBe(true)
  })

  test('delete cancels a running download and removes every model file', async () => {
    const fetchImpl = jest.fn(async (url, options) => fullResponse(CONTENT, options.signal, { holdAfter: 1, hold: new Promise(() => {}) }))
    const manager = createManager({ fetchImpl })
    const download = manager.downloadModel()
    await new Promise(resolve => setTimeout(resolve, 20))

    await manager.deleteModel()
    await download

    const { modelPath, partPath, markerPath } = filePaths()
    expect([modelPath, partPath, markerPath].some(filePath => fs.existsSync(filePath))).toBe(false)
    expect(manager.getModelStatus()).toMatchObject({ state: 'absent', receivedBytes: 0 })
  })

  test('delete removes a ready model', async () => {
    const manager = createManager()
    await manager.downloadModel()
    await manager.deleteModel()
    expect(fs.readdirSync(modelsDir)).toEqual([])
    expect(manager.getVerifiedModelPath()).toBeNull()
  })

  test('follows redirects to the Hugging Face CDN and keeps the Range header', async () => {
    const { partPath } = filePaths()
    fs.writeFileSync(partPath, CONTENT.subarray(0, 10))
    const fetchImpl = jest.fn(async (url, options) => {
      if (url === MODEL_URL) return { status: 302, headers: headers({ location: CDN_URL }), body: null }
      return rangeResponse(CONTENT, rangeOffset(options), options.signal)
    })
    const manager = createManager({ fetchImpl })

    await manager.downloadModel()

    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([MODEL_URL, CDN_URL])
    expect(fetchImpl.mock.calls[1][1].headers.Range).toBe('bytes=10-')
    expect(manager.getModelStatus().state).toBe('ready')
  })

  test('refuses redirects to hosts other than Hugging Face', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 302, headers: headers({ location: 'https://evil.example.com/model.gguf' }), body: null }))
    const manager = createManager({ fetchImpl })

    await expect(manager.downloadModel()).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(manager.getModelStatus().state).toBe('error')
  })

  test('refuses a model URL that is not Hugging Face', async () => {
    const fetchImpl = jest.fn()
    const manager = createManager({ fetchImpl, model: testModel({ url: 'http://huggingface.co/insecure.gguf' }) })
    await expect(manager.downloadModel()).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('fails on an HTTP error and on an unexpected content length', async () => {
    const notFound = createManager({ fetchImpl: jest.fn(async () => ({ status: 404, headers: headers(), body: null })) })
    await expect(notFound.downloadModel()).rejects.toMatchObject({ code: 'HTTP_ERROR' })

    const wrongSize = createManager({
      fetchImpl: jest.fn(async (url, options) => ({ status: 200, headers: headers({ 'content-length': 12 }), body: streamBody([], options.signal) }))
    })
    await expect(wrongSize.downloadModel()).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
  })

  test('fails early when there is not enough disk space', async () => {
    const fetchImpl = jest.fn()
    const manager = createManager({ fetchImpl, statfs: async () => ({ bavail: 10, bsize: 4096 }) })
    await expect(manager.downloadModel()).rejects.toMatchObject({ code: 'DISK_SPACE' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('aborts a stalled download', async () => {
    const fetchImpl = jest.fn(async (url, options) => fullResponse(CONTENT, options.signal, { holdAfter: 1, hold: new Promise(() => {}) }))
    const manager = createManager({ fetchImpl, stallTimeoutMs: 30 })
    await expect(manager.downloadModel()).rejects.toMatchObject({ code: 'STALLED' })
    expect(manager.getModelStatus().state).toBe('error')
    expect(fs.existsSync(filePaths().partPath)).toBe(true)
  })

  test('concurrent download calls share one download', async () => {
    const fetchImpl = jest.fn(async (url, options) => fullResponse(CONTENT, options.signal))
    const manager = createManager({ fetchImpl })
    await Promise.all([manager.downloadModel(), manager.downloadModel()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await manager.downloadModel()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  // The first chunk arrives only after the write stream has already failed and
  // closed, so a listener added for 'close' afterwards would never fire.
  function slowResponse() {
    return {
      status: 200,
      headers: headers({ 'content-length': CONTENT.length }),
      body: (async function* body() {
        for (const chunk of splitChunks(CONTENT)) {
          await new Promise(resolve => setTimeout(resolve, 20))
          yield chunk
        }
      })()
    }
  }

  test('a write error on the .part file rejects instead of hanging', async () => {
    const manager = createManager({ fetchImpl: jest.fn(async () => slowResponse()) })
    const writeError = Object.assign(new Error('disk gone'), { code: 'EIO' })
    const originalCreateWriteStream = fs.createWriteStream
    const spy = jest.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
      const stream = originalCreateWriteStream(...args)
      // Fail and close before the first chunk arrives, like an unwritable folder.
      process.nextTick(() => stream.destroy(writeError))
      return stream
    })
    try {
      const outcome = await Promise.race([
        manager.downloadModel().then(() => 'resolved', error => error),
        new Promise(resolve => setTimeout(() => resolve('hung'), 2000))
      ])
      expect(outcome).toBe(writeError)
      expect(manager.getModelStatus()).toMatchObject({ state: 'error', error: 'disk gone' })
    } finally {
      spy.mockRestore()
    }
  })

  test('an unwritable models folder rejects instead of hanging', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    fs.chmodSync(modelsDir, 0o555)
    try {
      const manager = createManager({ fetchImpl: jest.fn(async () => slowResponse()) })
      const outcome = await Promise.race([
        manager.downloadModel().then(() => 'resolved', error => error.code),
        new Promise(resolve => setTimeout(() => resolve('hung'), 2000))
      ])
      expect(outcome).toBe('EACCES')
      expect(manager.getModelStatus().state).toBe('error')
    } finally {
      fs.chmodSync(modelsDir, 0o755)
    }
  })

  test('retries the final rename while Windows holds the file', async () => {
    const manager = createManager({ renameRetryDelayMs: 1 })
    const originalRename = fs.promises.rename
    let partRenameFailures = 0
    const spy = jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (from.endsWith('.part') && partRenameFailures < 2) {
        partRenameFailures++
        throw Object.assign(new Error('locked'), { code: partRenameFailures === 1 ? 'EPERM' : 'EBUSY' })
      }
      return originalRename(from, to)
    })
    try {
      await manager.downloadModel()
    } finally {
      spy.mockRestore()
    }
    expect(partRenameFailures).toBe(2)
    expect(manager.getModelStatus().state).toBe('ready')
    expect(fs.readFileSync(filePaths().modelPath).equals(CONTENT)).toBe(true)
  })

  test('gives up the final rename after a few attempts and keeps the .part', async () => {
    const manager = createManager({ renameRetryDelayMs: 1 })
    const originalRename = fs.promises.rename
    const spy = jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (from.endsWith('.part')) throw Object.assign(new Error('locked'), { code: 'EACCES' })
      return originalRename(from, to)
    })
    try {
      await expect(manager.downloadModel()).rejects.toMatchObject({ code: 'EACCES' })
      expect(spy.mock.calls.filter(([from]) => from.endsWith('.part'))).toHaveLength(5)
    } finally {
      spy.mockRestore()
    }
    expect(manager.getModelStatus().state).toBe('error')
    expect(fs.existsSync(filePaths().partPath)).toBe(true)
  })

  test('does not retry a rename that fails for another reason', async () => {
    const manager = createManager({ renameRetryDelayMs: 1 })
    const originalRename = fs.promises.rename
    const spy = jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (from.endsWith('.part')) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return originalRename(from, to)
    })
    try {
      await expect(manager.downloadModel()).rejects.toMatchObject({ code: 'ENOENT' })
      expect(spy.mock.calls.filter(([from]) => from.endsWith('.part'))).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  describe('delete', () => {
    test('reports deleting and hands out no model path before the worker is stopped', async () => {
      const manager = createManager()
      await manager.downloadModel()
      const states = []
      manager.onStatusChange(status => states.push(status.state))
      let duringStop = null
      let finishStop
      const beforeRemove = jest.fn(() => new Promise(resolve => {
        duringStop = {
          state: manager.getModelStatus().state,
          path: manager.getVerifiedModelPath(),
          fileStillThere: fs.existsSync(filePaths().modelPath)
        }
        finishStop = resolve
      }))

      const deletion = manager.deleteModel({ beforeRemove })
      expect(manager.getModelStatus().state).toBe('deleting')
      expect(manager.getVerifiedModelPath()).toBeNull()
      await new Promise(resolve => setImmediate(resolve))
      expect(beforeRemove).toHaveBeenCalledTimes(1)
      expect(duringStop).toEqual({ state: 'deleting', path: null, fileStillThere: true })
      await expect(manager.downloadModel()).rejects.toMatchObject({ code: 'DELETING' })
      expect(manager.deleteModel()).toBe(deletion)

      finishStop()
      await deletion

      expect(fs.readdirSync(modelsDir)).toEqual([])
      expect(states[0]).toBe('deleting')
      expect(states[states.length - 1]).toBe('absent')
      expect(manager.getModelStatus()).toMatchObject({ state: 'absent', receivedBytes: 0 })
    })

    test('stays deleting while a cancelled download winds down', async () => {
      const fetchImpl = jest.fn(async (url, options) => fullResponse(CONTENT, options.signal, { holdAfter: 1, hold: new Promise(() => {}) }))
      const manager = createManager({ fetchImpl })
      const download = manager.downloadModel()
      await new Promise(resolve => setTimeout(resolve, 20))
      const states = []
      manager.onStatusChange(status => states.push(status.state))

      await manager.deleteModel()
      await download

      expect(states.slice(0, -1).every(state => state === 'deleting')).toBe(true)
      expect(states[states.length - 1]).toBe('absent')
    })

    test('removes the files with retries for locked files', async () => {
      const manager = createManager()
      await manager.downloadModel()
      const spy = jest.spyOn(fs.promises, 'rm')
      try {
        await manager.deleteModel()
        expect(spy).toHaveBeenCalledWith(filePaths().modelPath, { force: true, maxRetries: 5, retryDelay: 200 })
      } finally {
        spy.mockRestore()
      }
    })

    test('a failed delete leaves the state matching the files on disk', async () => {
      const manager = createManager()
      await manager.downloadModel()
      const spy = jest.spyOn(fs.promises, 'rm').mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      try {
        await expect(manager.deleteModel()).rejects.toMatchObject({ code: 'EBUSY' })
      } finally {
        spy.mockRestore()
      }
      expect(manager.getModelStatus().state).toBe('ready')
      expect(manager.getVerifiedModelPath()).toBe(filePaths().modelPath)
    })
  })

  describe('orphaned files', () => {
    test('removes files of a previously pinned model and keeps the current ones', async () => {
      const { partPath } = filePaths()
      fs.writeFileSync(partPath, CONTENT.subarray(0, 100))
      for (const name of ['old-model.gguf', 'old-model.gguf.part', 'old-model.gguf.verified.json', 'old-model.gguf.verified.json.tmp']) {
        fs.writeFileSync(path.join(modelsDir, name), 'x')
      }
      fs.writeFileSync(path.join(modelsDir, 'notes.txt'), 'keep')
      fs.mkdirSync(path.join(modelsDir, 'folder.gguf'))

      const manager = createManager()
      const removed = await manager.removeOrphanedFiles()

      expect(removed.sort()).toEqual(['old-model.gguf', 'old-model.gguf.part', 'old-model.gguf.verified.json', 'old-model.gguf.verified.json.tmp'])
      expect(fs.readdirSync(modelsDir).sort()).toEqual(['folder.gguf', 'notes.txt', path.basename(partPath)])
    })

    test('does nothing when the models folder does not exist', async () => {
      fs.rmSync(modelsDir, { recursive: true, force: true })
      const manager = createManager()
      await expect(manager.removeOrphanedFiles()).resolves.toEqual([])
    })
  })

  describe('startup state', () => {
    async function downloadOnce() {
      const manager = createManager()
      await manager.downloadModel()
    }

    test('a verified file is ready without re-hashing', async () => {
      await downloadOnce()
      const manager = createManager()
      expect(manager.getModelStatus().state).toBe('ready')
      expect(manager.getVerifiedModelPath()).toBe(filePaths().modelPath)
    })

    test('a file without a marker is verified before it can be used', async () => {
      await downloadOnce()
      fs.rmSync(filePaths().markerPath)
      const manager = createManager()
      const states = []
      manager.onStatusChange(status => states.push(status.state))

      expect(manager.getModelStatus().state).toBe('verifying')
      expect(manager.getVerifiedModelPath()).toBeNull()
      await manager.downloadModel()

      expect(states).toContain('ready')
      expect(manager.getVerifiedModelPath()).toBe(filePaths().modelPath)
    })

    test('a same-size file with different content is removed', async () => {
      await downloadOnce()
      const { modelPath, markerPath } = filePaths()
      fs.rmSync(markerPath)
      fs.writeFileSync(modelPath, Buffer.alloc(CONTENT.length, 1))
      const manager = createManager({ fetchImpl: jest.fn() })

      await new Promise(resolve => {
        manager.onStatusChange(status => status.state === 'absent' && resolve())
        manager.getModelStatus()
      })

      expect(fs.existsSync(modelPath)).toBe(false)
      expect(manager.getVerifiedModelPath()).toBeNull()
    })

    test('a file with the wrong size is removed', async () => {
      const { modelPath } = filePaths()
      fs.writeFileSync(modelPath, Buffer.from('truncated'))
      const manager = createManager()
      expect(manager.getModelStatus().state).toBe('absent')
      expect(fs.existsSync(modelPath)).toBe(false)
    })

    test('a file modified after verification is not handed out', async () => {
      await downloadOnce()
      const manager = createManager()
      expect(manager.getModelStatus().state).toBe('ready')
      const { modelPath } = filePaths()
      const later = new Date(Date.now() + 60000)
      fs.utimesSync(modelPath, later, later)

      expect(manager.getVerifiedModelPath()).toBeNull()
      expect(manager.getModelStatus().state).toBe('verifying')
    })
  })
})
