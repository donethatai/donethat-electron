/**
 * Covers the location permission IPC surface: which results reach the renderer,
 * which reach the state manager, and when System Settings is opened.
 */

const mockIpcHandlers = { on: new Map(), handle: new Map() }
const mockOpenExternal = jest.fn()

jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

// capture.js pulls in the whole capture graph; these are the ESM-only leaves
// that jest cannot load, and none of them are on the location path.
jest.mock('../imageDiff', () => ({ applyImageDiffBoundingBoxes: jest.fn() }))
jest.mock('../processLocal', () => ({
  isLocalProcessingAvailable: jest.fn(async () => false),
  getLocalProvider: jest.fn(async () => null),
  processDataLocally: jest.fn()
}))

jest.mock('get-windows', () => ({
  activeWindow: jest.fn(async () => null),
  openWindows: jest.fn(async () => [])
}))

jest.mock('electron-store', () => ({
  __esModule: true,
  default: jest.fn(() => ({ get: jest.fn(), set: jest.fn(), delete: jest.fn() }))
}))

jest.mock('electron', () => ({
  ipcMain: {
    on: (channel, fn) => mockIpcHandlers.on.set(channel, fn),
    handle: (channel, fn) => mockIpcHandlers.handle.set(channel, fn)
  },
  powerMonitor: { getSystemIdleTime: () => 0 },
  shell: { openExternal: (...args) => mockOpenExternal(...args) },
  app: { on: jest.fn(), removeListener: jest.fn(), getPath: () => '/tmp' },
  dialog: { showMessageBox: jest.fn() },
  systemPreferences: {
    getMediaAccessStatus: jest.fn(() => 'granted'),
    isTrustedAccessibilityClient: jest.fn(() => true)
  },
  nativeImage: { createFromDataURL: jest.fn(() => ({})) },
  desktopCapturer: { getSources: jest.fn(async () => []) },
  screen: { getAllDisplays: jest.fn(() => []) }
}))

jest.mock('../captureNetworks', () => ({
  collectNetworkFingerprint: jest.fn(),
  requestLocationPermission: jest.fn(),
  checkLocationPermission: jest.fn(),
  getLastAuthorization: jest.fn(() => 'unknown')
}))

jest.mock('../telemetry', () => ({
  recordPermissionCheck: jest.fn(),
  recordSignal: jest.fn(),
  recordLog: jest.fn(),
  recordAudioRestart: jest.fn(),
  recordAudioConversion: jest.fn(),
  recordCyclePhaseDuration: jest.fn(),
  recordActiveWindowProbeTimeout: jest.fn()
}))

const capture = require('../capture')
const networks = require('../captureNetworks')
const { recordPermissionCheck } = require('../telemetry')

const GRANTED = {
  hasPermission: true,
  authorization: 'authorized',
  dataAvailable: true,
  ssidCount: 3,
  reason: null
}

const GRANTED_BUT_EMPTY = {
  hasPermission: true,
  authorization: 'authorized',
  dataAvailable: false,
  ssidCount: 0,
  reason: 'noNetworks'
}

const DENIED = {
  hasPermission: false,
  authorization: 'denied',
  dataAvailable: false,
  ssidCount: 0,
  reason: 'denied'
}

let sent
let stateManager
let mainWindow

function makeWindow() {
  return {
    isDestroyed: () => false,
    once: jest.fn(),
    removeListener: jest.fn(),
    webContents: {
      send: (channel, payload) => sent.push({ channel, payload }),
      executeJavaScript: jest.fn(async () => false)
    }
  }
}

function locationPayloads() {
  return sent.filter((entry) => entry.channel === 'locationPermission').map((entry) => entry.payload)
}

async function requestLocation() {
  await mockIpcHandlers.on.get('requestLocationPermission')()
}

beforeAll(() => {
  capture.setCaptureInterval(5)
})

beforeEach(() => {
  sent = []
  mockOpenExternal.mockClear()
  recordPermissionCheck.mockClear()
  networks.requestLocationPermission.mockReset()
  networks.checkLocationPermission.mockReset()

  stateManager = { updateLocationPermission: jest.fn() }
  mainWindow = makeWindow()

  capture.initCapture(mainWindow, jest.fn(), () => 'token', () => true, stateManager)
  mockIpcHandlers.on.get('updateLocationFeatureEnabled')(null, true)
})

describe('requestLocationPermission', () => {
  it('forwards a grant to both the renderer and the state manager', async () => {
    networks.requestLocationPermission.mockResolvedValue(GRANTED)

    await requestLocation()

    expect(locationPayloads()).toEqual([{ ...GRANTED, source: 'request' }])
    expect(stateManager.updateLocationPermission).toHaveBeenCalledWith(true, 'authorized')
  })

  it('records a probe outcome for telemetry', async () => {
    networks.requestLocationPermission.mockResolvedValue(GRANTED)

    await requestLocation()

    expect(recordPermissionCheck).toHaveBeenCalledWith(
      'location',
      'request',
      'granted',
      expect.any(Number)
    )
  })

  it('classifies a refusal as denied rather than unknown', async () => {
    networks.requestLocationPermission.mockResolvedValue(DENIED)

    await requestLocation()

    expect(recordPermissionCheck).toHaveBeenCalledWith(
      'location',
      'request',
      'denied',
      expect.any(Number)
    )
  })

  it('never opens System Settings when the grant is fine but no networks are in range', async () => {
    networks.requestLocationPermission.mockResolvedValue(GRANTED_BUT_EMPTY)

    await requestLocation()
    await requestLocation()

    expect(mockOpenExternal).not.toHaveBeenCalled()
    expect(stateManager.updateLocationPermission).toHaveBeenCalledWith(true, 'authorized')
  })

  it('holds the first denial back and opens Settings only when asked again', async () => {
    networks.requestLocationPermission.mockResolvedValue(DENIED)

    await requestLocation()
    expect(mockOpenExternal).not.toHaveBeenCalled()

    await requestLocation()
    expect(mockOpenExternal).toHaveBeenCalledWith(
      expect.stringContaining('Privacy_LocationServices')
    )
  })

  it('does not send anyone to Settings over an MDM restriction', async () => {
    networks.requestLocationPermission.mockResolvedValue({
      ...DENIED,
      authorization: 'restricted',
      reason: 'restricted'
    })

    await requestLocation()
    await requestLocation()

    expect(mockOpenExternal).not.toHaveBeenCalled()
  })

  it('reports disabled without touching the helper when the feature is off', async () => {
    mockIpcHandlers.on.get('updateLocationFeatureEnabled')(null, false)

    await requestLocation()

    expect(networks.requestLocationPermission).not.toHaveBeenCalled()
    expect(locationPayloads()).toEqual([
      {
        hasPermission: false,
        authorization: 'disabled',
        dataAvailable: false,
        ssidCount: 0,
        reason: 'disabled',
        source: 'request'
      }
    ])
  })

  it('survives a helper that throws', async () => {
    networks.requestLocationPermission.mockRejectedValue(new Error('helper died'))

    await requestLocation()

    expect(locationPayloads()[0]).toMatchObject({ hasPermission: false, reason: 'unavailable' })
  })
})

describe('checkLocationPermission', () => {
  it('answers disabled without spawning the helper before the flag arrives', async () => {
    mockIpcHandlers.on.get('updateLocationFeatureEnabled')(null, false)

    const result = await mockIpcHandlers.handle.get('checkLocationPermission')()

    expect(networks.checkLocationPermission).not.toHaveBeenCalled()
    expect(result).toMatchObject({ authorization: 'disabled', reason: 'disabled' })
  })

  it('caches the grant on the state manager', async () => {
    networks.checkLocationPermission.mockResolvedValue(GRANTED)

    const result = await mockIpcHandlers.handle.get('checkLocationPermission')()

    expect(result).toEqual(GRANTED)
    expect(stateManager.updateLocationPermission).toHaveBeenCalledWith(true, 'authorized')
  })

  it('raises no prompt, so it never opens System Settings', async () => {
    networks.checkLocationPermission.mockResolvedValue(DENIED)

    await mockIpcHandlers.handle.get('checkLocationPermission')()

    expect(mockOpenExternal).not.toHaveBeenCalled()
  })
})

describe('runtime issue reporting', () => {
  it('tells the renderer which refusal it was, so restricted is not relabelled', () => {
    // The renderer cannot re-derive this, and it decides both the wording and
    // whether a Settings button would lead anywhere.
    networks.getLastAuthorization.mockReturnValue('restricted')

    const flagged = []
    mainWindow.webContents.send = (channel, payload) => {
      sent.push({ channel, payload })
      if (channel === 'flag-permission-issues') flagged.push(payload)
    }

    // Six consecutive refusals is the location threshold.
    for (let i = 0; i < 6; i += 1) {
      capture.__test__.handleCaptureError(
        new Error('no fingerprint'),
        'module-specific',
        { location: true },
        false
      )
    }

    const issue = flagged.at(-1)?.runtimeIssues?.location
    expect(issue).toBeDefined()
    expect(issue.authorization).toBe('restricted')
  })
})

describe('isLocationDenial', () => {
  const { isLocationDenial } = capture.__test__

  it.each(['denied', 'restricted'])('treats %s as the user being refused', (value) => {
    expect(isLocationDenial(value)).toBe(true)
  })

  it.each(['authorized', 'notDetermined', 'unknown', 'unavailable', undefined])(
    'does not treat %s as a refusal',
    (value) => {
      // Anything else is a hardware state or an unanswered question, and
      // flagging those would tell the user to fix a permission that is fine.
      expect(isLocationDenial(value)).toBe(false)
    }
  )
})
