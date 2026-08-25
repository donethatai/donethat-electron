const mockGetScreenSources = jest.fn()
const mockCreateFromBuffer = jest.fn()
const mockGetMediaAccessStatus = jest.fn()

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}

const mockStore = {
  get: jest.fn(),
  set: jest.fn()
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
Object.defineProperty(process, 'platform', {
  value: 'darwin',
  configurable: true
})

jest.mock('electron-log', () => mockLog)
jest.mock('electron-store', () => ({
  __esModule: true,
  default: jest.fn(() => mockStore)
}))
jest.mock('../screenCaptureSemaphore', () => ({
  getScreenSources: (...args) => mockGetScreenSources(...args)
}))
jest.mock('../telemetry', () => ({
  recordPermissionCheck: jest.fn(),
  recordSignal: jest.fn()
}))
jest.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (...args) => mockCreateFromBuffer(...args)
  },
  ipcMain: {
    on: jest.fn(),
    handle: jest.fn()
  },
  shell: {
    openExternal: jest.fn()
  },
  app: {
    getPath: jest.fn(() => '/tmp/test-user-data')
  },
  systemPreferences: {
    getMediaAccessStatus: (...args) => mockGetMediaAccessStatus(...args)
  }
}))

const expectedImageDataUrl = `data:image/jpeg;base64,${Buffer.from('jpeg-image').toString('base64')}`

const { recordPermissionCheck } = require('../telemetry')

const {
  captureScreenshot,
  captureScreenshotDetailed,
  checkScreenCapturePermission,
  getMacScreenAccessStatus
} = require('../captureScreenshots')

const minimalScreenSource = {
  id: 'screen-1',
  name: 'Display 1',
  display_id: '0',
  thumbnail: {
    getSize: () => ({ width: 1, height: 1 }),
    toDataURL: () => 'data:image/png;base64,AA'
  }
}

describe('captureScreenshot detailed metadata', () => {
  afterAll(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockStore.get.mockReturnValue(undefined)
    mockCreateFromBuffer.mockReturnValue({
      getSize: () => ({ width: 1000, height: 700 }),
      resize() {
        return this
      },
      toJPEG: () => Buffer.from('jpeg-image')
    })
  })

  test('returns detailed screenshot entries with normalized display IDs while keeping public API unchanged', async () => {
    mockGetScreenSources.mockResolvedValue([
      {
        id: 'screen-b',
        name: 'Display B',
        display_id: 200,
        thumbnail: {
          toDataURL: () => 'data:image/png;base64,AAAA',
          getSize: () => ({ width: 1920, height: 1080 })
        }
      },
      {
        id: 'screen-a',
        name: 'Display A',
        display_id: '100',
        thumbnail: {
          toDataURL: () => 'data:image/png;base64,AAAA',
          getSize: () => ({ width: 1920, height: 1080 })
        }
      }
    ])

    const detailedScreenshots = await captureScreenshotDetailed({ caller: 'unit-test' })
    const publicScreenshots = await captureScreenshot({ caller: 'unit-test' })

    expect(detailedScreenshots).toEqual([
      { imageDataUrl: expectedImageDataUrl, displayId: '200', merged: false },
      { imageDataUrl: expectedImageDataUrl, displayId: '100', merged: false }
    ])
    expect(publicScreenshots).toEqual([
      expectedImageDataUrl,
      expectedImageDataUrl
    ])
  })
})

describe('checkScreenCapturePermission (desktopCapturer probe)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetScreenSources.mockReset()
    mockGetMediaAccessStatus.mockReset()
    // Default: TCC says "not-determined" so the probe path is exercised in the
    // pre-existing probe-focused tests below.
    mockGetMediaAccessStatus.mockReturnValue('not-determined')
    mockStore.get.mockReturnValue(undefined)
    mockCreateFromBuffer.mockReturnValue({
      getSize: () => ({ width: 1000, height: 700 }),
      resize() {
        return this
      },
      toJPEG: () => Buffer.from('jpeg-image')
    })
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    }
  })

  afterEach(() => {
    jest.useRealTimers()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  test('grants after timeout then sources', async () => {
    jest.useFakeTimers()
    mockGetScreenSources
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([minimalScreenSource])

    const pending = checkScreenCapturePermission('unit-timeout-retry')
    await jest.advanceTimersByTimeAsync(400)
    const result = await pending

    expect(result).toBe(true)
    expect(mockGetScreenSources).toHaveBeenCalledTimes(2)
    expect(recordPermissionCheck).toHaveBeenLastCalledWith(
      'screen',
      'unit-timeout-retry',
      'granted',
      expect.any(Number)
    )
  })

  test('empty sources are retried until attempts exhausted', async () => {
    jest.useFakeTimers()
    mockGetScreenSources.mockResolvedValue([])

    const pending = checkScreenCapturePermission('unit-empty')
    await jest.advanceTimersByTimeAsync(400 + 800 + 1600 + 2000)
    const result = await pending

    expect(result).toBe(false)
    expect(mockGetScreenSources).toHaveBeenCalledTimes(4)
    expect(recordPermissionCheck).toHaveBeenLastCalledWith(
      'screen',
      'unit-empty',
      'denied',
      expect.any(Number)
    )
  })

  test('all attempts time out yields undefined', async () => {
    jest.useFakeTimers()
    mockGetScreenSources.mockResolvedValue(null)

    const pending = checkScreenCapturePermission('unit-all-timeout')
    await jest.advanceTimersByTimeAsync(400 + 800 + 1600 + 2000)
    const result = await pending

    expect(result).toBeUndefined()
    expect(mockGetScreenSources).toHaveBeenCalledTimes(4)
    expect(recordPermissionCheck).toHaveBeenLastCalledWith(
      'screen',
      'unit-all-timeout',
      'skipped_busy',
      expect.any(Number)
    )
  })

  test('retries empty sources before granting', async () => {
    jest.useFakeTimers()
    mockGetScreenSources
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([minimalScreenSource])

    const pending = checkScreenCapturePermission('unit-empty-then-grant')
    await jest.advanceTimersByTimeAsync(400)
    const result = await pending

    expect(result).toBe(true)
    expect(mockGetScreenSources).toHaveBeenCalledTimes(2)
  })

  test('interactive probe caps attempts when timing out', async () => {
    jest.useFakeTimers()
    mockGetScreenSources.mockResolvedValue(null)

    const pending = checkScreenCapturePermission('unit-interactive-timeout', { interactive: true })
    await jest.advanceTimersByTimeAsync(400)
    const result = await pending

    expect(result).toBeUndefined()
    expect(mockGetScreenSources).toHaveBeenCalledTimes(2)
  })
})

describe('checkScreenCapturePermission (macOS TCC priority)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetScreenSources.mockReset()
    mockGetMediaAccessStatus.mockReset()
    mockStore.get.mockReturnValue(undefined)
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    }
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  test('TCC "granted" short-circuits without probing desktopCapturer', async () => {
    mockGetMediaAccessStatus.mockReturnValue('granted')
    mockGetScreenSources.mockResolvedValue([])

    const result = await checkScreenCapturePermission('unit-tcc-granted')

    expect(result).toBe(true)
    expect(mockGetMediaAccessStatus).toHaveBeenCalledWith('screen')
    // Probe must NOT run when TCC is authoritative.
    expect(mockGetScreenSources).not.toHaveBeenCalled()
    expect(recordPermissionCheck).toHaveBeenLastCalledWith(
      'screen',
      'unit-tcc-granted',
      'granted',
      expect.any(Number)
    )
  })

  test('TCC "denied" short-circuits without probing desktopCapturer', async () => {
    mockGetMediaAccessStatus.mockReturnValue('denied')
    mockGetScreenSources.mockResolvedValue([{ id: 'screen-1' }])

    const result = await checkScreenCapturePermission('unit-tcc-denied')

    expect(result).toBe(false)
    expect(mockGetScreenSources).not.toHaveBeenCalled()
    expect(recordPermissionCheck).toHaveBeenLastCalledWith(
      'screen',
      'unit-tcc-denied',
      'denied',
      expect.any(Number)
    )
  })

  test('interactive check probes despite TCC "denied" so macOS can prompt', async () => {
    // CGPreflightScreenCaptureAccess reports "denied" for an app that was never
    // asked, and getSources is what raises the prompt — so the request path has
    // to probe or a first-run user can never grant access.
    jest.useFakeTimers()
    mockGetMediaAccessStatus.mockReturnValue('denied')
    mockGetScreenSources.mockResolvedValueOnce([minimalScreenSource])

    const pending = checkScreenCapturePermission('unit-tcc-denied-interactive', { interactive: true })
    await jest.advanceTimersByTimeAsync(0)
    const result = await pending

    expect(result).toBe(true)
    expect(mockGetScreenSources).toHaveBeenCalled()
    jest.useRealTimers()
  })

  test('TCC "restricted" short-circuits as denied even when interactive', async () => {
    mockGetMediaAccessStatus.mockReturnValue('restricted')

    const result = await checkScreenCapturePermission('unit-tcc-restricted-interactive', { interactive: true })

    expect(result).toBe(false)
    expect(mockGetScreenSources).not.toHaveBeenCalled()
  })

  test('TCC "restricted" short-circuits as denied', async () => {
    mockGetMediaAccessStatus.mockReturnValue('restricted')

    const result = await checkScreenCapturePermission('unit-tcc-restricted')

    expect(result).toBe(false)
    expect(mockGetScreenSources).not.toHaveBeenCalled()
  })

  test('TCC "not-determined" falls through to desktopCapturer probe', async () => {
    jest.useFakeTimers()
    mockGetMediaAccessStatus.mockReturnValue('not-determined')
    mockGetScreenSources.mockResolvedValueOnce([minimalScreenSource])

    const pending = checkScreenCapturePermission('unit-tcc-not-determined')
    await jest.advanceTimersByTimeAsync(0)
    const result = await pending

    expect(result).toBe(true)
    expect(mockGetScreenSources).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  test('TCC "unknown" falls through to desktopCapturer probe', async () => {
    jest.useFakeTimers()
    mockGetMediaAccessStatus.mockReturnValue('unknown')
    mockGetScreenSources.mockResolvedValueOnce([minimalScreenSource])

    const pending = checkScreenCapturePermission('unit-tcc-unknown')
    await jest.advanceTimersByTimeAsync(0)
    const result = await pending

    expect(result).toBe(true)
    jest.useRealTimers()
  })

  test('getMacScreenAccessStatus returns null on non-darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(getMacScreenAccessStatus()).toBeNull()
  })

  test('getMacScreenAccessStatus surfaces the TCC value on darwin', () => {
    mockGetMediaAccessStatus.mockReturnValue('granted')
    expect(getMacScreenAccessStatus()).toBe('granted')
  })
})
