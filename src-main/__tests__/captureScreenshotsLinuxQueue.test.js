const { EventEmitter } = require('events')

const mockSpawnCalls = []

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
Object.defineProperty(process, 'platform', {
  value: 'linux',
  configurable: true
})

jest.mock('child_process', () => ({
  spawn: jest.fn((file, args, options) => {
    const { EventEmitter: Emitter } = require('events')
    const child = new Emitter()
    child.pid = 4000 + mockSpawnCalls.length
    mockSpawnCalls.push({ file, args, options, child })
    return child
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

beforeEach(() => {
  mockSpawnCalls.length = 0
  setLinuxScreenshotCommand('take-screenshot %s')
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

afterAll(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
})

describe('Linux screenshot command queue', () => {
  test('runs one screenshot command at a time and shares concurrent permission checks', async () => {
    const firstCheck = checkScreenCapturePermission('first')
    const secondCheck = checkScreenCapturePermission('second')
    await flush()

    expect(mockSpawnCalls).toHaveLength(1)
    expect(mockSpawnCalls[0].file).toBe('/bin/sh')
    expect(mockSpawnCalls[0].options).toEqual({ detached: true, stdio: 'ignore' })

    const capture = captureScreenshotDetailed({ caller: 'capture-cycle' })
    await flush()
    expect(mockSpawnCalls).toHaveLength(1)

    mockSpawnCalls[0].child.emit('exit', 1, null)
    await expect(firstCheck).resolves.toBe(false)
    await expect(secondCheck).resolves.toBe(false)
    await flush()

    expect(mockSpawnCalls).toHaveLength(2)
    expect(mockSpawnCalls[1].args[1]).toMatch(/^take-screenshot ".*screenshot-\d+\.png"$/)

    mockSpawnCalls[1].child.emit('exit', 0, null)
    await expect(capture).resolves.toEqual([])
  })

  test('gives up on a slow command, removes its late output, and starts the next one only after it exits', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true)
    const rmSync = jest.spyOn(require('fs'), 'rmSync').mockImplementation(() => {})

    const check = checkScreenCapturePermission('slow')
    await flush()
    expect(mockSpawnCalls).toHaveLength(1)

    jest.advanceTimersByTime(5000)
    await expect(check).resolves.toBe(false)

    const capture = captureScreenshotDetailed({ caller: 'capture-cycle' })
    await flush()
    expect(mockSpawnCalls).toHaveLength(1)

    jest.advanceTimersByTime(55000)
    expect(kill).toHaveBeenCalledWith(-mockSpawnCalls[0].child.pid, 'SIGKILL')
    expect(mockSpawnCalls).toHaveLength(1)

    mockSpawnCalls[0].child.emit('exit', null, 'SIGKILL')
    await flush()
    expect(mockSpawnCalls).toHaveLength(2)
    expect(rmSync).toHaveBeenCalledWith(expect.stringMatching(/test-screenshot-\d+\.png$/), { force: true })

    mockSpawnCalls[1].child.emit('exit', 0, null)
    await expect(capture).resolves.toEqual([])
  })

  test('removes the output of a command that finishes after its caller gave up', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const rmSync = jest.spyOn(require('fs'), 'rmSync').mockImplementation(() => {})

    const capture = captureScreenshotDetailed({ caller: 'capture-cycle' })
    await flush()
    jest.advanceTimersByTime(5000)
    await expect(capture).resolves.toEqual([])
    expect(rmSync).not.toHaveBeenCalled()

    mockSpawnCalls[0].child.emit('exit', 0, null)
    await flush()

    expect(rmSync).toHaveBeenCalledWith(expect.stringMatching(/screenshot-\d+\.png$/), { force: true })
  })
})
