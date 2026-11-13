const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}

jest.mock('electron-log', () => mockLog)
jest.mock('get-windows', () => ({
  activeWindow: jest.fn(),
  openWindows: jest.fn()
}))
jest.mock('../telemetry', () => ({
  recordPermissionCheck: jest.fn(),
  recordActiveWindowProbeTimeout: jest.fn(),
  recordWindowHelperRun: jest.fn(),
  recordWindowHelperInFlight: jest.fn()
}))
jest.mock('electron', () => ({
  systemPreferences: {
    isTrustedAccessibilityClient: jest.fn(() => true)
  },
  ipcMain: {
    on: jest.fn()
  },
  shell: {
    openExternal: jest.fn()
  },
  app: {
    on: jest.fn(),
    removeListener: jest.fn()
  },
  screen: {
    screenToDipRect: jest.fn((_display, bounds) => bounds),
    getDisplayMatching: jest.fn(() => ({ id: 1, scaleFactor: 1 })),
    getAllDisplays: jest.fn(() => [{ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 } }])
  }
}))

const captureWindows = require('../captureWindows')

describe('captureWindows timeline sanitization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    captureWindows.__test__.resetState()
  })

  test('getTimelineBuffer strips displayId from returned activity entries', () => {
    captureWindows.__test__.setWindowTimeline([
      {
        timestamp: new Date().toISOString(),
        title: 'Window Title',
        app: 'Slack',
        executable: '/Applications/Slack.app',
        bounds: { x: 10, y: 20, width: 100, height: 80 },
        displayId: '123',
        screen: 1
      }
    ])
    captureWindows.__test__.setTrackingState(true)

    const result = captureWindows.getTimelineBuffer(5 * 60 * 1000, false)

    expect(result).toEqual([
      {
        timestamp: expect.any(String),
        title: 'Window Title',
        app: 'Slack',
        executable: '/Applications/Slack.app'
      }
    ])
    expect(result[0].displayId).toBeUndefined()
  })
})

describe('get-windows helper diagnostics', () => {
  const { activeWindow } = require('get-windows')
  const telemetry = require('../telemetry')
  const { classifyWindowHelperError, safeActiveWindow } = captureWindows.__test__

  test.each([
    [{ signal: 'SIGKILL', code: null }, 'signal:SIGKILL'],
    [{ code: 1, stdout: 'get-windows requires the screen recording permission in System Settings.\n' }, 'screen-recording'],
    [{ code: 1, stdout: 'get-windows requires the accessibility permission in System Settings.\n' }, 'accessibility'],
    [{ code: 1, stdout: '{"title":"Secret plan"}' }, 'exit:1'],
    [{ code: 'ENOENT' }, 'ENOENT'],
    [new Error('Error parsing window data'), 'parse']
  ])('classifies %o as %s without keeping helper output', (error, expected) => {
    expect(classifyWindowHelperError(error)).toBe(expected)
  })

  test('records a helper that outlives the probe timeout as late with its full run time', async () => {
    let finish
    activeWindow.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))

    await expect(safeActiveWindow(5)).resolves.not.toEqual(expect.objectContaining({ id: expect.anything() }))
    expect(telemetry.recordWindowHelperRun).toHaveBeenCalledWith('active', 'timeout', null, 5)
    expect(telemetry.recordWindowHelperInFlight).toHaveBeenCalledWith(1)

    await new Promise((resolve) => setTimeout(resolve, 20))
    finish({ id: 1 })
    await new Promise((resolve) => setImmediate(resolve))

    const late = telemetry.recordWindowHelperRun.mock.calls.find(([kind, outcome]) => kind === 'active' && outcome === 'late-ok')
    expect(late).toBeDefined()
    expect(late[3]).toBeGreaterThanOrEqual(20)
  })
})
