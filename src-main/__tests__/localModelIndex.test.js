jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }))

const path = require('path')
const localModel = require('../localModel')
const { MODEL, isAllowedDownloadUrl } = require('../localModel/modelInfo')

const GIB = 1024 ** 3
const originalPlatform = process.platform

describe('local model module', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  test('exposes the pinned model', () => {
    expect(localModel.getModelInfo()).toEqual({
      id: MODEL.id,
      name: 'Qwen3.5 2B (Q4_K_M)',
      fileName: 'Qwen3.5-2B-Q4_K_M.gguf',
      sizeBytes: 1280835840,
      sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223'
    })
    expect(MODEL.url).toBe('https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf')
  })

  test('is supported on macOS and Windows with enough memory only', () => {
    expect(localModel.isBundledSupported({ platform: 'darwin', totalMemoryBytes: 16 * GIB })).toBe(true)
    expect(localModel.isBundledSupported({ platform: 'darwin', totalMemoryBytes: 8 * GIB })).toBe(true)
    expect(localModel.isBundledSupported({ platform: 'win32', totalMemoryBytes: 7.8 * GIB })).toBe(true)
    expect(localModel.isBundledSupported({ platform: 'win32', totalMemoryBytes: 4 * GIB })).toBe(false)
    expect(localModel.isBundledSupported({ platform: 'linux', totalMemoryBytes: 64 * GIB })).toBe(false)
    expect(localModel.getBundledUnsupportedReason({ platform: 'linux', totalMemoryBytes: 64 * GIB })).toBe('platform')
    expect(localModel.getBundledUnsupportedReason({ platform: 'linux', totalMemoryBytes: 4 * GIB })).toBe('platform')
    expect(localModel.getBundledUnsupportedReason({ platform: 'win32', totalMemoryBytes: 4 * GIB })).toBe('memory')
    expect(localModel.getBundledUnsupportedReason({ platform: 'darwin', totalMemoryBytes: 16 * GIB })).toBeNull()
  })

  test('refuses to generate on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    await expect(localModel.generateStructured({ prompt: 'x', schema: {} })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  test('resolves the worker script next to the module', () => {
    expect(localModel.WORKER_PATH).toBe(path.join(__dirname, '..', 'localModel', 'worker.js'))
  })

  test('allows only https Hugging Face download hosts', () => {
    expect(isAllowedDownloadUrl('https://huggingface.co/a/b')).toBe(true)
    expect(isAllowedDownloadUrl('https://cdn-lfs-us-1.hf.co/x')).toBe(true)
    expect(isAllowedDownloadUrl('https://cas-bridge.xethub.hf.co/x')).toBe(true)
    expect(isAllowedDownloadUrl('http://huggingface.co/a/b')).toBe(false)
    expect(isAllowedDownloadUrl('https://huggingface.co.evil.com/a')).toBe(false)
    expect(isAllowedDownloadUrl('https://evilhuggingface.co/a')).toBe(false)
    expect(isAllowedDownloadUrl('not a url')).toBe(false)
  })
})
