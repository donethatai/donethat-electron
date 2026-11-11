jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }))

const mockManager = {
  getModelStatus: jest.fn(() => ({ state: 'ready' })),
  getVerifiedModelPath: jest.fn(() => '/models/model.gguf'),
  deleteModel: jest.fn(async ({ beforeRemove } = {}) => {
    if (beforeRemove) await beforeRemove()
  }),
  removeOrphanedFiles: jest.fn(async () => ['old.gguf']),
  cancelDownload: jest.fn()
}
const mockClient = {
  generateStructured: jest.fn(async () => ({ ok: true })),
  shutdown: jest.fn(async () => {})
}

jest.mock('electron', () => ({
  app: { getPath: () => '/user-data' },
  utilityProcess: { fork: jest.fn() }
}))
jest.mock('../localModel/modelManager', () => ({ createModelManager: jest.fn(() => mockManager) }))
jest.mock('../localModel/client', () => ({
  createLocalModelClient: jest.fn(() => mockClient),
  WORKER_SERVICE_NAME: 'DoneThat On-device Model'
}))

const originalPlatform = process.platform

describe('local model module delete and cleanup', () => {
  let localModel

  beforeEach(() => {
    jest.clearAllMocks()
    jest.isolateModules(() => {
      localModel = require('../localModel')
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  test('delete without a started worker does not start one', async () => {
    await localModel.deleteModel()
    expect(mockManager.deleteModel).toHaveBeenCalledWith({ beforeRemove: expect.any(Function) })
    expect(mockClient.shutdown).not.toHaveBeenCalled()
  })

  test('delete stops a running worker from inside the manager delete, before the files go', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    jest.spyOn(require('os'), 'totalmem').mockReturnValue(16 * 1024 ** 3)
    await localModel.generateStructured({ prompt: 'x', schema: {} })

    const order = []
    mockClient.shutdown.mockImplementation(async () => { order.push('shutdown') })
    mockManager.deleteModel.mockImplementation(async ({ beforeRemove }) => {
      order.push('deleting')
      await beforeRemove()
      order.push('removed')
    })

    await localModel.deleteModel()
    expect(order).toEqual(['deleting', 'shutdown', 'removed'])
  })

  test('cleans up files of a previous model through the manager', async () => {
    await expect(localModel.cleanupOrphanedModelFiles()).resolves.toEqual(['old.gguf'])
    expect(mockManager.removeOrphanedFiles).toHaveBeenCalledTimes(1)
  })
})
