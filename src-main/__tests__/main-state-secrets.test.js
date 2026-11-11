require('./mocks');

jest.mock('../processLocal', () => ({
  resetLLMModels: jest.fn()
}));

const { resetMocks, mockStore, mockIpcMain, mockSafeStorage } = require('./mocks');

let mainStateModule;
let state;

function getIpcHandleHandler(channel) {
  const registration = mockIpcMain.handle.mock.calls.find((call) => call[0] === channel);
  return registration ? registration[1] : null;
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

beforeEach(async () => {
  resetMocks();

  if (state) {
    try {
      state.stopStateValidation?.();
      state.cleanupOnQuit?.();
    } catch (_) {}
    state = null;
  }

  if (!mainStateModule) {
    mainStateModule = require('../main-state');
  }
});

afterEach(() => {
  try {
    state?.stopStateValidation?.();
    state?.cleanupOnQuit?.();
  } catch (_) {}
});

describe('local processing secret storage', () => {
  test('returns local processing summary without decrypting stored secrets', async () => {
    mockStore.store = {
      geminiApiKey: 'safe:' + Buffer.from('enc:gemini-key', 'utf8').toString('base64'),
      geminiApiKeySource: 'user',
      openaiCompatibleConfig: {
        endpoint: 'https://local.example/v1',
        model: 'gpt-local',
        apiKey: 'safe:' + Buffer.from('enc:openai-key', 'utf8').toString('base64')
      },
      openaiCompatibleApiKeySource: 'managed'
    };

    await initState();

    const summary = await mainStateModule.getLocalProcessingState();

    expect(summary).toEqual({
      success: true,
      state: {
        gemini: {
          hasKey: true,
          keySource: 'user'
        },
        openAICompatible: {
          endpoint: 'https://local.example/v1',
          model: 'gpt-local',
          hasApiKey: true,
          keySource: 'managed'
        },
        bundled: {
          enabled: false
        }
      }
    });
    expect(mockSafeStorage.decryptString).not.toHaveBeenCalled();
  });

  test('preserves the existing encrypted OpenAI-compatible key without decrypting it', async () => {
    const encryptedKey = 'safe:' + Buffer.from('enc:openai-key', 'utf8').toString('base64');
    mockStore.store = {
      openaiCompatibleConfig: {
        endpoint: 'https://old.example/v1',
        model: 'old-model',
        apiKey: encryptedKey
      },
      openaiCompatibleApiKeySource: 'user'
    };

    await initState();

    const saveHandler = getIpcHandleHandler('save-openai-compatible-config');
    const result = await saveHandler({}, {
      endpoint: 'https://new.example/v1',
      model: 'new-model',
      preserveApiKey: true
    });

    expect(result).toEqual({ success: true });
    expect(mockStore.store.openaiCompatibleConfig).toEqual({
      endpoint: 'https://new.example/v1',
      model: 'new-model',
      apiKey: encryptedKey
    });
    expect(mockStore.store.openaiCompatibleApiKeySource).toBe('user');
    expect(mockSafeStorage.decryptString).not.toHaveBeenCalled();
  });

  test('migrates a legacy Gemini key when it is first decrypted', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
    const { encryptData } = require('../encryption');
    const legacyKey = encryptData('legacy-gemini-key');
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    mockStore.store = {
      geminiApiKey: legacyKey
    };

    await initState();

    const result = await mainStateModule.getGeminiApiKey();

    expect(result).toEqual({ success: true, apiKey: 'legacy-gemini-key' });
    expect(mockStore.store.geminiApiKey.startsWith('safe:')).toBe(true);
    expect(mockStore.store.geminiApiKey).not.toBe(legacyKey);
    expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('legacy-gemini-key');
  });

  test('migrates a legacy OpenAI-compatible key when it is first decrypted', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
    const { encryptData } = require('../encryption');
    const legacyKey = encryptData('legacy-openai-key');
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    mockStore.store = {
      openaiCompatibleConfig: {
        endpoint: 'https://local.example/v1',
        model: 'legacy-model',
        apiKey: legacyKey
      }
    };

    await initState();

    const result = await mainStateModule.getOpenAICompatibleConfig();

    expect(result).toEqual({
      success: true,
      config: {
        endpoint: 'https://local.example/v1',
        model: 'legacy-model',
        apiKey: 'legacy-openai-key'
      }
    });
    expect(mockStore.store.openaiCompatibleConfig.apiKey.startsWith('safe:')).toBe(true);
    expect(mockStore.store.openaiCompatibleConfig.apiKey).not.toBe(legacyKey);
    expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('legacy-openai-key');
  });
});
