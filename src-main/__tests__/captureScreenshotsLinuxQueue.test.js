const mockExecCalls = []

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
Object.defineProperty(process, 'platform', {
  value: 'linux',
  configurable: true
})

jest.mock('child_process', () => ({
  exec: jest.fn((command, options, callback) => {
    mockExecCalls.push({ command, options, callback })
  })
}))
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }))
jest.mock('electron-store', () => ({
  __esModule: true,
  default: jest.fn(() => ({ get: jest.fn(), set: jest.fn() }))
}))
jest.mock('../screenCaptureSemaphore', () => ({ getScreenSources: jest.fn() }))
jest.mock('../telemetry', () => ({ recordPermissionCheck: jest.fn(), recordSignal: jest.fn() }))
jest.mock('electron', () => ({
  nativeImage: { createFromBuffer: jest.fn() },
  ipcMain: { on: jest.fn(), handle: jest.fn() },
  shell: { openExternal: jest.fn() },
  app: { getPath: jest.fn(() => '/tmp/test-user-data') },
  systemPreferences: { getMediaAccessStatus: jest.fn() }
}))

const {
  captureScreenshotDetailed,
  checkScreenCapturePermission,
  setLinuxScreenshotCommand
} = require('../captureScreenshots')

const flush = () => new Promise(resolve => setImmediate(resolve))

afterAll(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
})

describe('Linux screenshot command queue', () => {
  test('runs one screenshot command at a time and shares concurrent permission checks', async () => {
    setLinuxScreenshotCommand('take-screenshot %s')

    const firstCheck = checkScreenCapturePermission('first')
    const secondCheck = checkScreenCapturePermission('second')
    await flush()

    expect(mockExecCalls).toHaveLength(1)
    expect(mockExecCalls[0].options).toEqual({ timeout: 5000 })

    const capture = captureScreenshotDetailed({ caller: 'capture-cycle' })
    await flush()
    expect(mockExecCalls).toHaveLength(1)

    mockExecCalls[0].callback(new Error('timed out'))
    await expect(firstCheck).resolves.toBe(false)
    await expect(secondCheck).resolves.toBe(false)
    await flush()

    expect(mockExecCalls).toHaveLength(2)
    expect(mockExecCalls[1].command).toMatch(/^take-screenshot ".*screenshot-\d+\.png"$/)

    mockExecCalls[1].callback(null)
    await expect(capture).resolves.toEqual([])
  })
})
