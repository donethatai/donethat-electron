/**
 * Covers how capture.js gates, collects and uploads UI text (accessibility).
 */

jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../imageDiff', () => ({ applyImageDiffBoundingBoxes: jest.fn() }))
jest.mock('../processLocal', () => ({
  isLocalProcessingAvailable: jest.fn(async () => false),
  getLocalProvider: jest.fn(async () => null),
  processDataLocally: jest.fn()
}))

jest.mock('../appExclusionMasking', () => ({
  applyAppExclusionsToDetailedScreenshots: jest.fn(async (screenshots) => screenshots)
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
  ipcMain: { on: jest.fn(), handle: jest.fn() },
  powerMonitor: { getSystemIdleTime: () => 0 },
  shell: { openExternal: jest.fn() },
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

jest.mock('../telemetry', () => ({
  recordPermissionCheck: jest.fn(),
  recordSignal: jest.fn(),
  recordLog: jest.fn(),
  recordAudioRestart: jest.fn(),
  recordAudioConversion: jest.fn(),
  recordCyclePhaseDuration: jest.fn(),
  recordActiveWindowProbeTimeout: jest.fn(),
  recordUiTextStats: jest.fn()
}))

jest.mock('../captureUiText', () => ({
  isUiTextSupported: jest.fn(() => true),
  startTracking: jest.fn(async () => true),
  stopTracking: jest.fn(),
  getUiTextBuffer: jest.fn(async () => null),
  getLastCycleStats: jest.fn(() => null),
  getStatus: jest.fn(() => ({ supported: true, tracking: true, permissionDenied: false, accessibilityTrusted: true, libraryUnavailable: false })),
  isTracking: jest.fn(() => false)
}))

const capture = require('../capture')
const uiTextCapture = require('../captureUiText')
const telemetry = require('../telemetry')
const { applyAppExclusionsToDetailedScreenshots } = require('../appExclusionMasking')

const HEALTHY_STATUS = { supported: true, tracking: true, permissionDenied: false, accessibilityTrusted: true, libraryUnavailable: false }

const UI_TEXT = {
  entries: [{ app: 'Mail', windowTitle: 'Inbox', text: 'Quarterly planning', capturedAtMs: 1 }],
  truncated: false
}

beforeAll(() => {
  capture.setCaptureInterval(5)
})

beforeEach(() => {
  jest.clearAllMocks()
  uiTextCapture.isUiTextSupported.mockReturnValue(true)
  uiTextCapture.getStatus.mockReturnValue(HEALTHY_STATUS)
  uiTextCapture.getUiTextBuffer.mockResolvedValue(null)
  capture.__test__.applyManagedInputDataOverrides(null)
  capture.__test__.updateInputDataSettings({ windows: false })
})

test('window text is part of Active applications and not collected while it is off', async () => {
  expect(capture.getInputDataSettings()).not.toHaveProperty('uiText')

  const inputData = await capture.collectInputData(true)

  expect(uiTextCapture.getUiTextBuffer).not.toHaveBeenCalled()
  expect(inputData).not.toHaveProperty('uiText')
  expect(inputData.captureErrors.uiText).toBe(false)
})

test('collects window text while Active applications is on', async () => {
  capture.__test__.updateInputDataSettings({ windows: true })
  uiTextCapture.getUiTextBuffer.mockResolvedValue(UI_TEXT)

  const inputData = await capture.collectInputData(true)

  expect(uiTextCapture.getUiTextBuffer).toHaveBeenCalledWith(true)
  expect(inputData.uiText).toEqual(UI_TEXT)
  expect(inputData.captureErrors.uiText).toBe(false)
})

test('flags a capture error when the accessibility library failed to load', async () => {
  capture.__test__.updateInputDataSettings({ windows: true })
  uiTextCapture.getStatus.mockReturnValue({ ...HEALTHY_STATUS, tracking: false, libraryUnavailable: true })

  const inputData = await capture.collectInputData(true)

  expect(inputData.captureErrors.uiText).toBe(true)
})

test('omits the key when nothing was captured', async () => {
  capture.__test__.updateInputDataSettings({ windows: true })

  const inputData = await capture.collectInputData(true)

  expect(inputData).not.toHaveProperty('uiText')
})

test('flags a capture error when Accessibility is denied', async () => {
  capture.__test__.updateInputDataSettings({ windows: true })
  uiTextCapture.getStatus.mockReturnValue({ ...HEALTHY_STATUS, tracking: false, permissionDenied: true, accessibilityTrusted: false })

  const inputData = await capture.collectInputData(true)

  expect(inputData.captureErrors.uiText).toBe(true)
})

test('a collection failure flags an error instead of throwing', async () => {
  capture.__test__.updateInputDataSettings({ windows: true })
  uiTextCapture.getUiTextBuffer.mockRejectedValue(new Error('boom'))

  const inputData = await capture.collectInputData(true)

  expect(inputData).not.toHaveProperty('uiText')
  expect(inputData.captureErrors.uiText).toBe(true)
})

test('skips collection on unsupported platforms', async () => {
  capture.__test__.updateInputDataSettings({ windows: true })
  uiTextCapture.isUiTextSupported.mockReturnValue(false)

  const inputData = await capture.collectInputData(true)

  expect(uiTextCapture.getUiTextBuffer).not.toHaveBeenCalled()
  expect(inputData).not.toHaveProperty('uiText')
})

test('turning Active applications off stops window text tracking', () => {
  capture.__test__.updateInputDataSettings({ windows: true })
  capture.__test__.updateInputDataSettings({ windows: false })

  expect(uiTextCapture.stopTracking).toHaveBeenCalled()
})

test('a managed Active applications setting also controls window text', async () => {
  capture.__test__.applyManagedInputDataOverrides({ windows: 'disabled' })
  capture.__test__.updateInputDataSettings({ windows: true })

  await capture.collectInputData(true)

  expect(uiTextCapture.getUiTextBuffer).not.toHaveBeenCalled()
})

test('cloud payload carries window text only while Active applications is on', () => {
  capture.__test__.updateInputDataSettings({ windows: true })
  const enabledPayload = capture.__test__.buildCloudPayload([], { uiText: UI_TEXT, activity: [] }, null, null)
  expect(enabledPayload.uiText).toEqual(UI_TEXT)

  capture.__test__.updateInputDataSettings({ windows: false })
  const disabledPayload = capture.__test__.buildCloudPayload([], { uiText: UI_TEXT, activity: [] }, null, null)
  expect(disabledPayload).not.toHaveProperty('uiText')

  const emptyPayload = capture.__test__.buildCloudPayload([], { activity: [] }, null, null)
  expect(emptyPayload).not.toHaveProperty('uiText')
})

function initWithRecordingWindow() {
  const sent = []
  const mainWindow = {
    isDestroyed: () => false,
    once: jest.fn(),
    removeListener: jest.fn(),
    webContents: {
      send: (channel, payload) => sent.push({ channel, payload }),
      executeJavaScript: jest.fn(async () => false)
    }
  }
  capture.initCapture(mainWindow, jest.fn(), () => 'token', () => true, null)
  return sent
}

function failUiTextUntilFlagged() {
  const { handleCaptureError } = capture.__test__
  for (let i = 0; i < 6; i++) {
    handleCaptureError(new Error('Capture module error detected'), 'module-specific', { uiText: true }, false)
  }
}

test('a runtime issue is raised for uiText after repeated failures', () => {
  const sent = initWithRecordingWindow()
  const { handleCaptureError } = capture.__test__

  for (let i = 0; i < 5; i++) {
    handleCaptureError(new Error('Capture module error detected'), 'module-specific', { uiText: true }, false)
  }
  expect(sent.filter((entry) => entry.channel === 'flag-permission-issues')).toHaveLength(0)

  handleCaptureError(new Error('Capture module error detected'), 'module-specific', { uiText: true }, false)
  const flagged = sent.filter((entry) => entry.channel === 'flag-permission-issues')
  expect(flagged).toHaveLength(1)
  expect(flagged[0].payload.runtimeIssues.uiText).toMatchObject({ status: 'degraded', threshold: 6 })
})

test.each([
  [{ accessibilityTrusted: false, permissionDenied: true }, 'accessibility'],
  [{ tracking: false, libraryUnavailable: true }, 'unavailable'],
  [{ permissionDenied: true }, 'app-refused'],
  [{}, 'read-failed']
])('the uiText runtime issue carries why it failed (%o -> %s)', (status, reason) => {
  uiTextCapture.getStatus.mockReturnValue({ ...HEALTHY_STATUS, ...status })
  const sent = initWithRecordingWindow()

  failUiTextUntilFlagged()

  const flagged = sent.filter((entry) => entry.channel === 'flag-permission-issues')
  expect(flagged[0].payload.runtimeIssues.uiText.reason).toBe(reason)
})

describe('screenshot masking per cycle', () => {
  const shots = [{ imageDataUrl: 'data:image/png;base64,UNMASKED', displayId: '1', merged: false }]
  const masked = [{ imageDataUrl: 'data:image/png;base64,MASKED', displayId: '1', merged: false }]

  test('returns the masked screenshots and asks the masker to fail closed on the on-device path', async () => {
    applyAppExclusionsToDetailedScreenshots.mockResolvedValueOnce(masked)

    await expect(capture.__test__.maskScreenshotsForCycle(shots, 'bundled')).resolves.toEqual(masked)
    expect(applyAppExclusionsToDetailedScreenshots).toHaveBeenCalledWith(shots, { throwOnError: true })
  })

  test('drops the screenshots when masking fails on the on-device path', async () => {
    applyAppExclusionsToDetailedScreenshots.mockRejectedValueOnce(new Error('mask failed'))

    await expect(capture.__test__.maskScreenshotsForCycle(shots, 'bundled')).resolves.toEqual([])
  })

  test.each([null, 'gemini', 'openai'])('keeps the existing fallback for provider %s', async (provider) => {
    applyAppExclusionsToDetailedScreenshots.mockRejectedValueOnce(new Error('mask failed'))

    await expect(capture.__test__.maskScreenshotsForCycle(shots, provider)).resolves.toBe(shots)
    expect(applyAppExclusionsToDetailedScreenshots).toHaveBeenCalledWith(shots, { throwOnError: false })
  })
})

test('records window text size counters for the cycle', async () => {
  const stats = { uniqueChars: 9100, sentChars: 7990 }
  capture.__test__.updateInputDataSettings({ windows: true })
  uiTextCapture.getUiTextBuffer.mockResolvedValue(UI_TEXT)
  uiTextCapture.getLastCycleStats.mockReturnValue(stats)

  await capture.collectInputData(true)

  expect(telemetry.recordUiTextStats).toHaveBeenLastCalledWith(stats)
})

test('a telemetry failure does not flag window text capture as failed', async () => {
  capture.__test__.updateInputDataSettings({ windows: true })
  uiTextCapture.getStatus.mockReturnValue(HEALTHY_STATUS)
  uiTextCapture.getUiTextBuffer.mockResolvedValue(UI_TEXT)
  telemetry.recordUiTextStats.mockImplementationOnce(() => { throw new Error('boom') })

  const inputData = await capture.collectInputData(true)

  expect(inputData.uiText).toEqual(UI_TEXT)
  expect(inputData.captureErrors.uiText).toBe(false)
})
