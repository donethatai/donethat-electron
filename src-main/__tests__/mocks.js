// Reusable mocks for Electron main process testing

// Create a mock store instance
function createMockStore() {
  return {
    store: {},
    get: jest.fn(function(key) { return this.store[key]; }),
    set: jest.fn(function(key, value) { this.store[key] = value; }),
    delete: jest.fn(function(key) { delete this.store[key]; }),
    clear: jest.fn(function() { this.store = {}; })
  };
}

// Global mock store instance
const mockStore = createMockStore();

// Mock Store constructor that returns the mock store
const MockStore = jest.fn((options) => {
  // Always return the same mock store instance
  return mockStore;
});

// Mock for both require and dynamic import
jest.mock('electron-store', () => {
  return {
    __esModule: true,
    default: MockStore
  };
}, { virtual: false });

// Mock electron-log
const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

jest.mock('electron-log', () => mockLog);

// Mock electron IPC
const mockIpcMain = {
  on: jest.fn(),
  handle: jest.fn(),
  once: jest.fn(),
  removeAllListeners: jest.fn()
};

// Mock electron app
const mockApp = {
  getPath: jest.fn((name) => {
    const paths = {
      userData: '/tmp/test-user-data',
      documents: '/tmp/test-documents',
      temp: '/tmp'
    };
    return paths[name] || '/tmp';
  }),
  setAppUserModelId: jest.fn()
};

// Mock electron BrowserWindow
const mockBrowserWindow = {
  webContents: {
    send: jest.fn()
  },
  show: jest.fn(),
  focus: jest.fn(),
  isDestroyed: jest.fn(() => false)
};

// Mock electron powerMonitor
const mockPowerMonitor = {
  getSystemIdleTime: jest.fn(() => 0),
  on: jest.fn()
};

const mockSafeStorage = {
  isEncryptionAvailable: jest.fn(() => true),
  encryptString: jest.fn((value) => Buffer.from(`enc:${value}`, 'utf8')),
  decryptString: jest.fn((buffer) => {
    const value = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    return value.startsWith('enc:') ? value.slice(4) : value;
  }),
  getSelectedStorageBackend: jest.fn(() => 'mock'),
  setUsePlainTextEncryption: jest.fn()
};

// Mock electron Notification
const mockNotification = {
  isSupported: jest.fn(() => true)
};

jest.mock('electron', () => ({
  ipcMain: mockIpcMain,
  app: mockApp,
  safeStorage: mockSafeStorage,
  BrowserWindow: jest.fn(() => mockBrowserWindow),
  powerMonitor: mockPowerMonitor,
  Notification: mockNotification,
  dialog: {
    showErrorBox: jest.fn()
  }
}));

// Export mocks for use in tests
module.exports = {
  mockStore,
  mockLog,
  mockIpcMain,
  mockApp,
  mockBrowserWindow,
  mockPowerMonitor,
  mockNotification,
  mockSafeStorage,
  resetMocks: () => {
    mockStore.store = {};
    mockStore.get.mockClear();
    mockStore.set.mockClear();
    mockStore.delete.mockClear();
    mockStore.clear.mockClear();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockIpcMain.on.mockClear();
    mockIpcMain.handle.mockClear();
    mockIpcMain.once.mockClear();
    mockIpcMain.removeAllListeners.mockClear();
    mockApp.getPath.mockClear();
    mockApp.setAppUserModelId.mockClear();
    mockBrowserWindow.webContents.send.mockClear();
    mockBrowserWindow.show.mockClear();
    mockBrowserWindow.focus.mockClear();
    mockPowerMonitor.getSystemIdleTime.mockClear();
    mockPowerMonitor.on.mockClear();
    mockSafeStorage.isEncryptionAvailable.mockClear();
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockSafeStorage.encryptString.mockClear();
    mockSafeStorage.encryptString.mockImplementation((value) => Buffer.from(`enc:${value}`, 'utf8'));
    mockSafeStorage.decryptString.mockClear();
    mockSafeStorage.decryptString.mockImplementation((buffer) => {
      const value = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
      return value.startsWith('enc:') ? value.slice(4) : value;
    });
    mockSafeStorage.getSelectedStorageBackend.mockClear();
    mockSafeStorage.setUsePlainTextEncryption.mockClear();
  }
};
