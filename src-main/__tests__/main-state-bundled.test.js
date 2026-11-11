require('./mocks');

jest.mock('../processLocal', () => ({
  resetLLMModels: jest.fn(),
  getLocalProvider: jest.fn(),
  processDataLocally: jest.fn(),
  formatLocalProcessingErrorForUser: jest.fn((error) => error?.message || 'error')
}));

jest.mock('../capture', () => ({
  getInputDataSettings: jest.fn(() => ({ audio: false }))
}));

jest.mock('../captureAudio', () => ({
  getStatus: jest.fn(() => ({ recording: false })),
  startRecording: jest.fn(),
  stopRecording: jest.fn(),
  shutdownRecording: jest.fn()
}));

jest.mock('../captureScreenshots', () => ({
  captureScreenshotDetailed: jest.fn()
}));

jest.mock('../appExclusionMasking', () => ({
  applyAppExclusionsToDetailedScreenshots: jest.fn()
}));

jest.mock('../localModel', () => ({
  isBundledSupported: jest.fn(() => true),
  getBundledUnsupportedReason: jest.fn(() => 'memory'),
  getModelInfo: jest.fn(() => ({ id: 'model-id', name: 'Model Name', fileName: 'model.gguf', sizeBytes: 1000, sha256: 'abc' })),
  getModelStatus: jest.fn(() => ({ state: 'ready', receivedBytes: 1000, totalBytes: 1000, error: null })),
  downloadModel: jest.fn(() => Promise.resolve()),
  cancelDownload: jest.fn(),
  deleteModel: jest.fn(() => Promise.resolve())
}));

const { resetMocks, mockStore, mockIpcMain } = require('./mocks');
const processLocal = require('../processLocal');
const localModel = require('../localModel');
const { captureScreenshotDetailed } = require('../captureScreenshots');
const { applyAppExclusionsToDetailedScreenshots } = require('../appExclusionMasking');

const BUNDLED_STORE_KEY = 'localProcessing.bundled';

let mainStateModule;
let state;

function getIpcHandleHandler(channel) {
  const registration = mockIpcMain.handle.mock.calls.find((call) => call[0] === channel);
  return registration ? registration[1] : null;
}

function getIpcOnHandler(channel) {
  const registration = mockIpcMain.on.mock.calls.find((call) => call[0] === channel);
  return registration ? registration[1] : null;
}

function invoke(channel, payload) {
  return getIpcHandleHandler(channel)({}, payload);
}

async function initState() {
  state = await mainStateModule.initState({
    checkRecording: jest.fn(),
    navigateToView: jest.fn(),
    mainWindow: {
      webContents: { send: jest.fn() },
      show: jest.fn(),
      focus: jest.fn(),
      isDestroyed: () => false
    },
    overlayWindow: null
  });
}

function setModelState(modelState) {
  localModel.getModelStatus.mockReturnValue({ state: modelState, receivedBytes: 0, totalBytes: 1000, error: null });
}

beforeEach(async () => {
  resetMocks();
  jest.clearAllMocks();
  localModel.isBundledSupported.mockReturnValue(true);
  localModel.downloadModel.mockReset().mockResolvedValue();
  localModel.deleteModel.mockReset().mockResolvedValue();
  setModelState('ready');
  if (!mainStateModule) {
    mainStateModule = require('../main-state');
  }
  await initState();
  getIpcOnHandler('apply-managed-app-settings')({}, null);
  processLocal.resetLLMModels.mockClear();
});

afterEach(() => {
  try {
    state?.stopStateValidation?.();
    state?.cleanupOnQuit?.();
  } catch (_) {}
  state = null;
});

describe('on-device model setting', () => {
  test('is off by default', async () => {
    const summary = mainStateModule.getLocalProcessingState();
    expect(summary.state.bundled).toEqual({ enabled: false });

    const status = await invoke('localModel:get-status');
    expect(status).toMatchObject({
      success: true,
      supported: true,
      managed: false,
      unsupportedReason: null,
      enabled: false,
      model: { id: 'model-id', name: 'Model Name', fileName: 'model.gguf', sizeBytes: 1000 },
      status: { state: 'ready' }
    });
  });

  test('turns on when the model is ready, persists and resets the LLM models', async () => {
    const result = await invoke('localModel:set-enabled', { enabled: true });

    expect(result).toMatchObject({ success: true, enabled: true });
    expect(mockStore.store[BUNDLED_STORE_KEY]).toEqual({ enabled: true });
    expect(mainStateModule.getLocalProcessingState().state.bundled).toEqual({ enabled: true });
    expect(processLocal.resetLLMModels).toHaveBeenCalledTimes(1);

    const off = await invoke('localModel:set-enabled', { enabled: false });
    expect(off).toMatchObject({ success: true, enabled: false });
    expect(mockStore.store[BUNDLED_STORE_KEY]).toEqual({ enabled: false });
    expect(processLocal.resetLLMModels).toHaveBeenCalledTimes(2);
  });

  test.each([
    undefined,
    null,
    true,
    'yes',
    {},
    { enabled: 'true' },
    { enabled: 1 }
  ])('rejects the invalid payload %p', async (payload) => {
    const result = await invoke('localModel:set-enabled', payload);
    expect(result).toEqual({ success: false, error: 'Invalid on-device model setting' });
    expect(mockStore.store[BUNDLED_STORE_KEY]).toBeUndefined();
    expect(processLocal.resetLLMModels).not.toHaveBeenCalled();
  });

  test('cannot turn on while the model is being deleted', async () => {
    setModelState('deleting');
    const result = await invoke('localModel:set-enabled', { enabled: true });
    expect(result.success).toBe(false);
    expect(localModel.downloadModel).not.toHaveBeenCalled();
    expect(mockStore.store[BUNDLED_STORE_KEY]).toBeUndefined();
  });

  test.each(['absent', 'downloading', 'deleting', 'error'])('can always turn off, also while the model is %s', async (modelState) => {
    mockStore.store[BUNDLED_STORE_KEY] = { enabled: true };
    setModelState(modelState);
    const result = await invoke('localModel:set-enabled', { enabled: false });
    expect(result).toMatchObject({ success: true, enabled: false });
    expect(mockStore.store[BUNDLED_STORE_KEY]).toEqual({ enabled: false });
  });

  test('cannot turn on and is reported off on an unsupported device', async () => {
    mockStore.store[BUNDLED_STORE_KEY] = { enabled: true };
    localModel.isBundledSupported.mockReturnValue(false);

    const result = await invoke('localModel:set-enabled', { enabled: true });
    expect(result.success).toBe(false);
    expect(mainStateModule.getLocalProcessingState().state.bundled).toEqual({ enabled: false });

    const status = await invoke('localModel:get-status');
    expect(status).toMatchObject({ success: true, supported: false, unsupportedReason: 'memory', enabled: false, status: null });
    expect(localModel.getModelStatus).not.toHaveBeenCalled();
  });

  test('is locked and reported off while the LLM settings are managed', async () => {
    mockStore.store[BUNDLED_STORE_KEY] = { enabled: true };
    getIpcOnHandler('apply-managed-app-settings')({}, {
      localProcessing: { gemini: { enabled: false } }
    });

    expect(mainStateModule.getLocalProcessingState().state.bundled).toEqual({ enabled: false });
    expect(await invoke('localModel:set-enabled', { enabled: false })).toEqual({
      success: false,
      error: 'LLM settings are managed by your organization'
    });
    setModelState('absent');
    expect(await invoke('localModel:set-enabled', { enabled: true })).toEqual({
      success: false,
      error: 'LLM settings are managed by your organization'
    });
    expect(localModel.downloadModel).not.toHaveBeenCalled();
    expect(await invoke('localModel:get-status')).toMatchObject({ managed: true, enabled: false });

    getIpcOnHandler('apply-managed-app-settings')({}, null);
    expect(mainStateModule.getLocalProcessingState().state.bundled).toEqual({ enabled: true });
  });
});

describe('turning on without a downloaded model', () => {
  function deferredDownload() {
    const deferred = {};
    localModel.downloadModel.mockReturnValue(new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    }));
    return deferred;
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test.each(['absent', 'error', 'downloading', 'verifying'])('starts the download and stays off while the model is %s', async (modelState) => {
    setModelState(modelState);
    const download = deferredDownload();

    const result = await invoke('localModel:set-enabled', { enabled: true });

    expect(result).toMatchObject({ success: true, enabled: false, enablePending: true });
    expect(localModel.downloadModel).toHaveBeenCalledTimes(1);
    expect(mockStore.store[BUNDLED_STORE_KEY]).toBeUndefined();
    expect(mainStateModule.getLocalProcessingState().state.bundled).toEqual({ enabled: false });
    download.resolve();
    await flush();
  });

  test('turns on once the download is verified', async () => {
    setModelState('absent');
    const download = deferredDownload();
    await invoke('localModel:set-enabled', { enabled: true });

    setModelState('ready');
    download.resolve();
    await flush();

    expect(mockStore.store[BUNDLED_STORE_KEY]).toEqual({ enabled: true });
    expect(processLocal.resetLLMModels).toHaveBeenCalledTimes(1);
    expect(await invoke('localModel:get-status')).toMatchObject({ enabled: true, enablePending: false });
  });

  test('stays off when the download fails', async () => {
    setModelState('absent');
    const download = deferredDownload();
    await invoke('localModel:set-enabled', { enabled: true });

    setModelState('error');
    download.reject(new Error('HTTP 500'));
    await flush();

    expect(mockStore.store[BUNDLED_STORE_KEY]).toBeUndefined();
    expect(await invoke('localModel:get-status')).toMatchObject({ enabled: false, enablePending: false });
  });

  test('turning off cancels the download and keeps it off', async () => {
    setModelState('downloading');
    const download = deferredDownload();
    await invoke('localModel:set-enabled', { enabled: true });

    const result = await invoke('localModel:set-enabled', { enabled: false });
    expect(localModel.cancelDownload).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, enabled: false, enablePending: false });

    setModelState('absent');
    download.resolve();
    await flush();
    expect(mockStore.store[BUNDLED_STORE_KEY]).toEqual({ enabled: false });
  });

  test('turning off without a pending download does not cancel anything', async () => {
    await invoke('localModel:set-enabled', { enabled: false });
    expect(localModel.cancelDownload).not.toHaveBeenCalled();
  });

  test('does not turn on when the LLM settings became managed during the download', async () => {
    setModelState('absent');
    const download = deferredDownload();
    await invoke('localModel:set-enabled', { enabled: true });

    getIpcOnHandler('apply-managed-app-settings')({}, { localProcessing: { gemini: { enabled: false } } });
    setModelState('ready');
    download.resolve();
    await flush();

    expect(mockStore.store[BUNDLED_STORE_KEY]).toBeUndefined();
  });
});

describe('on-device model files', () => {
  test('deleting the model keeps the on-device model on, so cycles stay local', async () => {
    await invoke('localModel:set-enabled', { enabled: true });
    processLocal.resetLLMModels.mockClear();
    localModel.deleteModel.mockImplementation(async () => {
      setModelState('absent');
    });

    const result = await invoke('localModel:delete');

    expect(localModel.deleteModel).toHaveBeenCalledTimes(1);
    expect(processLocal.resetLLMModels).not.toHaveBeenCalled();
    expect(mockStore.store[BUNDLED_STORE_KEY]).toEqual({ enabled: true });
    expect(mainStateModule.getLocalProcessingState().state.bundled).toEqual({ enabled: true });
    expect(result).toMatchObject({ success: true, enabled: true, status: { state: 'absent' } });
  });

  test('deleting while off leaves the setting alone', async () => {
    const result = await invoke('localModel:delete');
    expect(result.success).toBe(true);
    expect(mockStore.store[BUNDLED_STORE_KEY]).toBeUndefined();
    expect(processLocal.resetLLMModels).not.toHaveBeenCalled();
  });

  test('reports a failed delete', async () => {
    localModel.deleteModel.mockRejectedValue(new Error('EBUSY'));
    expect(await invoke('localModel:delete')).toEqual({ success: false, error: 'EBUSY' });
  });
});

describe('LLM test with the on-device model', () => {
  const RAW = 'data:image/png;base64,UkFX';
  const MASKED = 'data:image/png;base64,TUFTSw==';

  beforeEach(() => {
    processLocal.getLocalProvider.mockResolvedValue('bundled');
    processLocal.processDataLocally.mockResolvedValue({ success: true, test: true });
    captureScreenshotDetailed.mockResolvedValue([{ imageDataUrl: RAW, displayId: '1', merged: false }]);
    applyAppExclusionsToDetailedScreenshots.mockResolvedValue([{ imageDataUrl: MASKED, displayId: '1', merged: false }]);
  });

  test('tests with app-exclusion-masked screenshots', async () => {
    const result = await invoke('test-local-processing');

    expect(result).toEqual({ success: true, message: 'On-device model test successful' });
    expect(applyAppExclusionsToDetailedScreenshots).toHaveBeenCalledWith(
      [{ imageDataUrl: RAW, displayId: '1', merged: false }],
      { throwOnError: true }
    );
    const [, screenshots, , testMode] = processLocal.processDataLocally.mock.calls[0];
    expect(screenshots).toEqual([MASKED]);
    expect(testMode).toBe(true);
  });

  test.each(['gemini', 'openai'])('keeps lenient masking for the %s provider', async (provider) => {
    processLocal.getLocalProvider.mockResolvedValue(provider);

    await invoke('test-local-processing');

    expect(applyAppExclusionsToDetailedScreenshots).toHaveBeenCalledWith([{ imageDataUrl: RAW, displayId: '1', merged: false }]);
    expect(processLocal.processDataLocally.mock.calls[0][1]).toEqual([MASKED]);
  });

  test('tests without screenshots when masking fails', async () => {
    applyAppExclusionsToDetailedScreenshots.mockRejectedValue(new Error('mask failed'));

    const result = await invoke('test-local-processing');

    expect(result.success).toBe(true);
    expect(processLocal.processDataLocally.mock.calls[0][1]).toEqual([]);
  });

  test('does not capture screenshots when no provider is configured', async () => {
    processLocal.getLocalProvider.mockResolvedValue(null);

    const result = await invoke('test-local-processing');

    expect(result.success).toBe(false);
    expect(captureScreenshotDetailed).not.toHaveBeenCalled();
    expect(processLocal.processDataLocally).not.toHaveBeenCalled();
  });
});
