const { ipcMain, app, dialog, BrowserWindow } = require('electron');
const log = require('electron-log');
const path = require('path');
const { encryptData, decryptData, decryptDataWithRetry, isLegacyEncryptedData } = require('./encryption');
const { default: Store } = require('electron-store');
const linuxAutostart = require('./linuxAutostart');

// State variables
let store = null;
let pauseState = {
  endTime: null,     // If non-null and in future, app is paused
  timeoutId: null,    // Reference to the auto-resume timer
  reason: null        // Reason for pausing (workday-start, pause-today, manual, etc.)
};
const PAUSE_REASON_PAUSE_TODAY = 'pause-today';
let userWorkdays = [1, 2, 3, 4, 5]; // Default Mon-Fri (0=Sun, 6=Sat)
let userWorkhours = { start: "09:00", end: "17:00" }; // Default 9 AM to 5 PM
let lastSummaryTimestamp = null;
let hasScreenCapturePermission = false;
let idToken = null; // User authentication token
let workPeriodCheckTimeoutId = null; // For scheduling next workday/workhours check
let autoSubmit = false;
let hasShownStorageError = false; // Flag to prevent multiple error alerts
let userStatus = 'active'; // User status - 'active' or 'inactive'

// Function references that will be set by main.js
let checkAndAdjustRecording = null;
let navigateToView = null;
let mainWindow = null;
let overlayWindow = null;

// State validation heartbeat
let stateValidationIntervalId = null;

// Last known system timezone (for detecting TZ change and rescheduling work-hours)
let lastKnownSystemTimezone = null;

// Track manual resume override for work hours
let manualOverrideWorkHours = false;

// Track system lock/suspend state
let isScreenLocked = false;
let isSystemSuspended = false;

// Cache decrypted API keys/configs in memory to avoid decryption issues during hibernation
let cachedGeminiApiKey = null;
let cachedOpenAICompatibleConfig = null;
const GEMINI_KEY_SOURCE_STORE_KEY = 'geminiApiKeySource';
const OPENAI_KEY_SOURCE_STORE_KEY = 'openaiCompatibleApiKeySource';
const API_KEY_SOURCE_MANAGED = 'managed';
const API_KEY_SOURCE_USER = 'user';
let managedAppSettings = {
  recording: {
    manualPauseEnabled: null
  },
  capture: {
    appExclusions: null,
    contextCapture: null,
    saveCaptureData: null
  },
  localProcessing: {
    gemini: null,
    openAICompatible: null
  }
};

function isManagedValue(value) {
  return value !== null && value !== undefined;
}

function normalizeManagedAppExclusions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const appName = typeof item.appName === 'string' ? item.appName.trim() : '';
      if (!appName) return null;
      const titlePatterns = Array.isArray(item.titlePatterns)
        ? item.titlePatterns
          .filter((entry) => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => !!entry)
        : [];
      return {
        appName,
        titlePatterns,
        ignoreActivity: !!item.ignoreActivity
      };
    })
    .filter(Boolean);
}

function normalizeManagedContextApps(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const appName = typeof item.appName === 'string' ? item.appName.trim() : '';
      if (!appName) return null;
      const titlePatterns = Array.isArray(item.titlePatterns)
        ? item.titlePatterns
          .filter((entry) => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => !!entry)
        : [];
      return { appName, titlePatterns };
    })
    .filter(Boolean);
}

function normalizeManagedListMode(value, fallback = 'fixed') {
  if (value === 'minimum') return 'minimum';
  if (value === 'fixed') return 'fixed';
  return fallback;
}

function normalizeManagedAppExclusionsConfig(value) {
  if (!isManagedValue(value)) return null;
  if (Array.isArray(value)) {
    return {
      mode: 'fixed',
      entries: normalizeManagedAppExclusions(value)
    };
  }
  if (!value || typeof value !== 'object') return null;
  const hasExplicitConfig =
    isManagedValue(value.mode) ||
    isManagedValue(value.entries) ||
    isManagedValue(value.list) ||
    isManagedValue(value.apps);
  if (!hasExplicitConfig) return null;

  return {
    mode: normalizeManagedListMode(value.mode, 'fixed'),
    entries: normalizeManagedAppExclusions(value.entries ?? value.list ?? value.apps ?? [])
  };
}

function normalizeManagedContextCaptureConfig(value) {
  if (!isManagedValue(value) || !value || typeof value !== 'object') return null;
  const hasExplicitConfig =
    isManagedValue(value.enabled) ||
    isManagedValue(value.mode) ||
    isManagedValue(value.apps) ||
    isManagedValue(value.entries) ||
    isManagedValue(value.list);
  if (!hasExplicitConfig) return null;

  return {
    enabled: isManagedValue(value.enabled) ? !!value.enabled : null,
    mode: normalizeManagedListMode(value.mode, 'fixed'),
    apps: normalizeManagedContextApps(value.apps ?? value.entries ?? value.list ?? [])
  };
}

function normalizeManagedSaveCaptureDataConfig(value) {
  if (!isManagedValue(value) || !value || typeof value !== 'object') return null;
  const hasExplicitConfig = isManagedValue(value.enabled) || isManagedValue(value.path);
  if (!hasExplicitConfig) return null;

  return {
    enabled: isManagedValue(value.enabled) ? !!value.enabled : null,
    path: typeof value.path === 'string' ? value.path.trim() : null
  };
}

function normalizeManagedGeminiConfig(value) {
  if (!isManagedValue(value) || !value || typeof value !== 'object') return null;
  const hasExplicitConfig = isManagedValue(value.enabled) || isManagedValue(value.apiKey);
  if (!hasExplicitConfig) return null;

  return {
    enabled: isManagedValue(value.enabled) ? !!value.enabled : null,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : null
  };
}

function normalizeManagedOpenAICompatibleConfig(value) {
  if (!isManagedValue(value) || !value || typeof value !== 'object') return null;
  const hasExplicitConfig =
    isManagedValue(value.enabled) || isManagedValue(value.endpoint) || isManagedValue(value.model) || isManagedValue(value.apiKey);
  if (!hasExplicitConfig) return null;

  return {
    enabled: isManagedValue(value.enabled) ? !!value.enabled : null,
    endpoint: typeof value.endpoint === 'string' ? value.endpoint.trim() : null,
    model: typeof value.model === 'string' ? value.model.trim() : null,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : null
  };
}

function buildManagedExclusionKey(item) {
  const appName = String(item?.appName || '').trim().toLowerCase();
  const patterns = Array.isArray(item?.titlePatterns)
    ? [...item.titlePatterns].map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean).sort()
    : [];
  return `${appName}::${patterns.join('|')}`;
}

function mergeMinimumAppExclusions(userEntries, requiredEntries) {
  const requiredMap = new Map();
  for (const entry of requiredEntries) {
    requiredMap.set(buildManagedExclusionKey(entry), entry);
  }

  const merged = [];
  const consumed = new Set();
  for (const entry of userEntries) {
    const key = buildManagedExclusionKey(entry);
    if (requiredMap.has(key)) {
      merged.push(requiredMap.get(key));
      consumed.add(key);
    } else {
      merged.push(entry);
    }
  }

  for (const [key, entry] of requiredMap.entries()) {
    if (!consumed.has(key)) {
      merged.push(entry);
    }
  }

  return normalizeManagedAppExclusions(merged);
}

function buildManagedContextAppKey(item) {
  const appName = String(item?.appName || '').trim().toLowerCase();
  const patterns = Array.isArray(item?.titlePatterns)
    ? [...item.titlePatterns].map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean).sort()
    : [];
  return `${appName}::${patterns.join('|')}`;
}

function mergeMinimumContextApps(userEntries, requiredEntries) {
  const requiredMap = new Map();
  for (const entry of requiredEntries) {
    requiredMap.set(buildManagedContextAppKey(entry), entry);
  }

  const merged = [];
  const consumed = new Set();
  for (const entry of userEntries) {
    const key = buildManagedContextAppKey(entry);
    if (requiredMap.has(key)) {
      merged.push(requiredMap.get(key));
      consumed.add(key);
    } else {
      merged.push(entry);
    }
  }

  for (const [key, entry] of requiredMap.entries()) {
    if (!consumed.has(key)) {
      merged.push(entry);
    }
  }

  return normalizeManagedContextApps(merged);
}

function normalizeManagedAppSettings(raw) {
  const captureRaw = raw?.capture || {};
  const localRaw = raw?.localProcessing || {};

  return {
    recording: {
      manualPauseEnabled: isManagedValue(raw?.recording?.manualPauseEnabled)
        ? !!raw.recording.manualPauseEnabled
        : null
    },
    capture: {
      appExclusions: normalizeManagedAppExclusionsConfig(captureRaw.appExclusions),
      contextCapture: normalizeManagedContextCaptureConfig(captureRaw.contextCapture),
      saveCaptureData: normalizeManagedSaveCaptureDataConfig(captureRaw.saveCaptureData)
    },
    localProcessing: {
      gemini: normalizeManagedGeminiConfig(localRaw.gemini),
      openAICompatible: normalizeManagedOpenAICompatibleConfig(localRaw.openAICompatible)
    }
  };
}

/**
 * Periodic state validator that ensures consistency after sleep/wake cycles.
 * Runs every minute to catch timer failures and state drift.
 * Reuses existing logic - no duplication.
 */
function _validateState() {
  try {
    // Detect system timezone change (e.g. user traveled) and reschedule work-hours
    try {
      const currentTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (lastKnownSystemTimezone !== null && currentTz !== lastKnownSystemTimezone) {
        log.info('System timezone changed, rescheduling work-hours', { from: lastKnownSystemTimezone, to: currentTz });
        lastKnownSystemTimezone = currentTz;
        _scheduleNextWorkEndCheck();
      } else if (lastKnownSystemTimezone === null) {
        lastKnownSystemTimezone = currentTz;
      }
    } catch (e) {
      log.warn('Could not detect system timezone for change check:', e);
    }

    // Safety check: detect user activity to clear potentially stuck suspend flag
    // Note: We can't use idle time for lock screen (user can move mouse on lock screen)
    // but we CAN use it for suspend (system activity = not suspended)
    if (isSystemSuspended) {
      try {
        const { powerMonitor } = require('electron');
        const idleTime = powerMonitor.getSystemIdleTime();
        
        // If system has been active in the last 60 seconds, it can't be suspended
        // Also require idle time > 0 to avoid broken platforms that always return 0
        if (idleTime > 0 && idleTime < 60) {
          log.info('Detected system activity while suspended flag was set - clearing flag');
          isSystemSuspended = false;
        }
      } catch (e) {
        log.warn('Could not check system idle time for suspend detection:', e);
      }
    }
    
    const now = new Date();
    const isActive = isActiveWorkPeriod(now);
    const paused = isPaused();
    const pauseReason = pauseState.reason;
    const pauseExpired = pauseState.endTime && pauseState.endTime < now;
    
    // Integrated pause expiry and work hours logic
    if (pauseExpired) {
      // Pause expired - only clear it if we should be recording
      if (isActive || manualOverrideWorkHours) {
        // Either in work hours OR user manually overrode - resume recording
        _clearPauseStateAndCheckRecording();
      } else {
        // Outside work hours and no override - replace with work-hours pause
        pauseUntilNextWorkPeriod(mainWindow, true); // silent=true
      }
    } else if (!isActive && !paused && !manualOverrideWorkHours) {
      // Outside work hours but not paused (and no manual override) - should be paused
      pauseUntilNextWorkPeriod(mainWindow, true); // silent=true
    } else if (isActive && paused && pauseReason === 'workday-start') {
      // In work hours but paused due to work-hours - check if pause extends beyond current work period
      // Only clear if pause ends within the current work period (automatic pause scenario)
      // Don't clear if pause extends beyond current work period (manual "pause until tomorrow" scenario)
      const startParts = userWorkhours.start.split(':');
      const endParts = userWorkhours.end.split(':');
      let shouldClearPause = true;
      
      if (pauseState.endTime && startParts.length >= 2 && endParts.length >= 2) {
        const startHour = parseInt(startParts[0], 10);
        const startMinute = parseInt(startParts[1], 10);
        const endHour = parseInt(endParts[0], 10);
        const endMinute = parseInt(endParts[1], 10);
        
        if (!isNaN(startHour) && !isNaN(startMinute) && !isNaN(endHour) && !isNaN(endMinute)) {
          // Use helper to get the end of the current work period
          const currentPeriodEnd = _getCurrentPeriodEnd(now, startHour, startMinute, endHour, endMinute);
          
          // Only clear pause if it ends within the current work period
          // If pause ends beyond current work period, it's a manual "pause until tomorrow"
          shouldClearPause = pauseState.endTime <= currentPeriodEnd;
        }
      }
      
      if (shouldClearPause) {
        // In work hours but paused due to work-hours - should be active
        _clearPauseStateAndCheckRecording();
        // Clear manual override when work hours naturally start
        setManualOverrideWorkHours(false);
      }
    } else if (isActive && !paused && manualOverrideWorkHours) {
      // Work hours started naturally while user had manual override - clear it
      setManualOverrideWorkHours(false);
    }
    
    // Ensure recording state matches all conditions
    // This catches any other state drift (permissions, auth, etc.)
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  } catch (error) {
    log.error('Error in state validation heartbeat:', error);
  }
}

/**
 * Starts the periodic state validation heartbeat
 */
function startStateValidation() {
  if (stateValidationIntervalId) {
    clearInterval(stateValidationIntervalId);
    stateValidationIntervalId = null;
  }
  // Run every 60 seconds to catch timer failures after sleep/wake
  stateValidationIntervalId = setInterval(_validateState, 60000);
}

/**
 * Stops the periodic state validation heartbeat
 */
function stopStateValidation() {
  if (stateValidationIntervalId) {
    clearInterval(stateValidationIntervalId);
    stateValidationIntervalId = null;
  }
}

/**
 * Show storage error message to the user
 * @param {Error} error The error that occurred
 */
function showStorageError(error) {
  if (hasShownStorageError) return; // Prevent multiple alerts
  
  log.error('Storage operation failed:', error);
  
  // Only show for permission errors
  if (error.code === 'EPERM' || error.message.includes('permission') || 
      error.message.includes('access') || error.message.includes('denied')) {
    
    hasShownStorageError = true;
    
    try {
      dialog.showErrorBox(
        'Storage Permission Error',
        'Could not store configuration. This may be caused by antivirus software or permission settings. Please check your security software and ensure DoneThat has permission to write files.'
      );
    } catch (dialogError) {
      // Fallback to notification if dialog fails
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('request-notification', {
          id: 'storage-permission-error',
          title: 'Storage Permission Error',
          message: 'Could not store configuration. Please check your antivirus software.',
          sticky: true
        });
      }
    } catch (notificationError) {
        log.error('Failed to send in-app storage error notification:', notificationError);
      }
    }
  }
}

/**
 * Safely perform store operations with error handling
 * @param {Function} operation Function that performs store operation
 * @param {string} errorContext Context description for logging
 * @returns {any} Result of the operation or undefined on error
 */
function safeStoreOperation(operation, errorContext) {
  if (!store) {
    return undefined;
  }
  
  try {
    return operation();
  } catch (error) {
    log.error(`Store operation failed (${errorContext}):`, error);
    showStorageError(error);
    return undefined;
  }
}

function isManualPauseAllowed() {
  return managedAppSettings.recording.manualPauseEnabled !== false;
}

function isLocalProcessingManaged() {
  return isManagedValue(managedAppSettings.localProcessing.gemini) ||
    isManagedValue(managedAppSettings.localProcessing.openAICompatible);
}

function applyManagedAppSettings(rawSettings = null) {
  managedAppSettings = normalizeManagedAppSettings(rawSettings || {});

  if (isManagedValue(managedAppSettings.capture.appExclusions)) {
    const exclusionConfig = managedAppSettings.capture.appExclusions;
    safeStoreOperation(() => {
      if (!store) return;
      const existing = normalizeManagedAppExclusions(store.get('appExclusions') || []);
      const nextExclusions = exclusionConfig.mode === 'minimum'
        ? mergeMinimumAppExclusions(existing, exclusionConfig.entries)
        : exclusionConfig.entries;
      store.set('appExclusions', nextExclusions);
    }, 'apply managed app exclusions');
  }

  if (isManagedValue(managedAppSettings.capture.contextCapture)) {
    const contextCaptureConfig = managedAppSettings.capture.contextCapture;
    safeStoreOperation(() => {
      if (!store) return;
      const existingApps = normalizeManagedContextApps(store.get('contextApps') || []);
      const nextApps = contextCaptureConfig.enabled === false
        ? []
        : contextCaptureConfig.mode === 'minimum'
          ? mergeMinimumContextApps(existingApps, contextCaptureConfig.apps)
          : contextCaptureConfig.apps;
      store.set('contextApps', nextApps);
    }, 'apply managed context capture');
  }

  if (isManagedValue(managedAppSettings.capture.saveCaptureData)) {
    const saveCaptureConfig = managedAppSettings.capture.saveCaptureData;
    safeStoreOperation(() => {
      if (!store) return;
      if (isManagedValue(saveCaptureConfig.enabled)) {
        store.set('saveCaptureDataToFolder', !!saveCaptureConfig.enabled);
      }
      if (isManagedValue(saveCaptureConfig.path) && saveCaptureConfig.path) {
        store.set('saveCaptureDataPath', saveCaptureConfig.path);
      }
    }, 'apply managed save capture data');
  }

  if (isManagedValue(managedAppSettings.localProcessing.gemini)) {
    const geminiConfig = managedAppSettings.localProcessing.gemini;
    const geminiEnabled = geminiConfig.enabled;
    const geminiApiKeyManaged = isManagedValue(geminiConfig.apiKey);
    if (geminiEnabled === false) {
      safeStoreOperation(() => {
        if (store) {
          store.delete('geminiApiKey');
          store.delete(GEMINI_KEY_SOURCE_STORE_KEY);
        }
      }, 'clear managed Gemini key');
      cachedGeminiApiKey = null;
    } else if (geminiApiKeyManaged && geminiConfig.apiKey) {
      safeStoreOperation(() => {
        if (store) {
          store.set('geminiApiKey', encryptData(geminiConfig.apiKey));
          store.set(GEMINI_KEY_SOURCE_STORE_KEY, API_KEY_SOURCE_MANAGED);
        }
      }, 'apply managed Gemini key');
      cachedGeminiApiKey = geminiConfig.apiKey;
    } else if (geminiApiKeyManaged && !geminiConfig.apiKey) {
      safeStoreOperation(() => {
        if (store) {
          store.delete('geminiApiKey');
          store.delete(GEMINI_KEY_SOURCE_STORE_KEY);
        }
      }, 'clear managed Gemini key');
      cachedGeminiApiKey = null;
    }
  } else {
    safeStoreOperation(() => {
      if (!store) return;
      const keySource = store.get(GEMINI_KEY_SOURCE_STORE_KEY);
      if (keySource === API_KEY_SOURCE_MANAGED) {
        store.delete('geminiApiKey');
        store.delete(GEMINI_KEY_SOURCE_STORE_KEY);
        cachedGeminiApiKey = null;
      }
    }, 'clear removed managed Gemini key');
  }

  if (isManagedValue(managedAppSettings.localProcessing.openAICompatible)) {
    const openAiConfig = managedAppSettings.localProcessing.openAICompatible;
    const openAiEnabled = openAiConfig.enabled;
    const hasManagedEndpoint = isManagedValue(openAiConfig.endpoint);
    const hasManagedModel = isManagedValue(openAiConfig.model);
    const hasManagedApiKey = isManagedValue(openAiConfig.apiKey);
    const hasManagedField = hasManagedEndpoint || hasManagedModel || hasManagedApiKey;
    if (openAiEnabled === false) {
      safeStoreOperation(() => {
        if (store) {
          store.delete('openaiCompatibleConfig');
          store.delete(OPENAI_KEY_SOURCE_STORE_KEY);
        }
      }, 'clear managed OpenAI-compatible config');
      cachedOpenAICompatibleConfig = null;
    } else if (openAiEnabled === true || hasManagedField) {
      const storedConfig = safeStoreOperation(() => store?.get('openaiCompatibleConfig') || {}, 'read OpenAI-compatible config for managed merge') || {};
      const storedApiKeyBlob = storedConfig.apiKey || null;
      const existingKeySource = safeStoreOperation(() => store?.get(OPENAI_KEY_SOURCE_STORE_KEY), 'read OpenAI-compatible API key source');
      const nextConfig = {
        endpoint: hasManagedEndpoint ? (openAiConfig.endpoint || null) : (cachedOpenAICompatibleConfig?.endpoint || storedConfig.endpoint || null),
        model: hasManagedModel ? (openAiConfig.model || null) : (cachedOpenAICompatibleConfig?.model || storedConfig.model || null)
      };
      safeStoreOperation(() => {
        if (store) {
          let nextStoredApiKey = null;
          if (hasManagedApiKey) {
            nextStoredApiKey = openAiConfig.apiKey ? encryptData(openAiConfig.apiKey) : null;
          } else if (existingKeySource !== API_KEY_SOURCE_MANAGED) {
            nextStoredApiKey = storedApiKeyBlob;
          }

          store.set('openaiCompatibleConfig', {
            endpoint: nextConfig.endpoint,
            model: nextConfig.model,
            apiKey: nextStoredApiKey
          });
          if (hasManagedApiKey && openAiConfig.apiKey) {
            store.set(OPENAI_KEY_SOURCE_STORE_KEY, API_KEY_SOURCE_MANAGED);
          } else if (hasManagedApiKey && !openAiConfig.apiKey) {
            store.delete(OPENAI_KEY_SOURCE_STORE_KEY);
          } else if (!nextStoredApiKey) {
            store.delete(OPENAI_KEY_SOURCE_STORE_KEY);
          }
        }
      }, 'apply managed OpenAI-compatible config');
      if (hasManagedApiKey) {
        cachedOpenAICompatibleConfig = {
          ...nextConfig,
          apiKey: openAiConfig.apiKey || null
        };
      } else if (storedApiKeyBlob) {
        cachedOpenAICompatibleConfig = null;
      } else {
        cachedOpenAICompatibleConfig = {
          ...nextConfig,
          apiKey: null
        };
      }
    }
  } else {
    safeStoreOperation(() => {
      if (!store) return;
      const keySource = store.get(OPENAI_KEY_SOURCE_STORE_KEY);
      if (keySource === API_KEY_SOURCE_MANAGED) {
        const rawConfig = store.get('openaiCompatibleConfig') || {};
        store.set('openaiCompatibleConfig', {
          endpoint: rawConfig.endpoint || null,
          model: rawConfig.model || null,
          apiKey: null
        });
        store.delete(OPENAI_KEY_SOURCE_STORE_KEY);
        if (cachedOpenAICompatibleConfig) {
          cachedOpenAICompatibleConfig = {
            endpoint: cachedOpenAICompatibleConfig.endpoint || null,
            model: cachedOpenAICompatibleConfig.model || null,
            apiKey: null
          };
        }
      }
    }, 'clear removed managed OpenAI-compatible key');
  }

  try { require('./processLocal').resetLLMModels(); } catch (_) {}

  if (checkAndAdjustRecording) {
    checkAndAdjustRecording();
  }
}

/**
 * Initialize the state manager
 * @param {Object} options Configuration options
 * @param {Function} options.checkRecording Function to check and adjust recording
 */
async function initState(options = {}) {
  // Store callback functions
  checkAndAdjustRecording = options.checkRecording;
  navigateToView = options.navigateToView;
  mainWindow = options.mainWindow;
  overlayWindow = options.overlayWindow;
  try {
    // Set AppUserModelId for Windows notifications
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.donethat.app');
    }

    // Initialize store with fallback mechanism
    await initializeStore();

    // Load saved states
    loadWorkSettings();
    loadSummaryTimestamp();

    resume();
    
    // Set up IPC handlers
    setupIPCHandlers();
    
    // Set up power monitor handlers
    setupPowerMonitorHandlers();

    return {
      store,
      isPaused,
      isWorkday,
      isWithinWorkHours,
      isActiveWorkPeriod,
      pauseRecording,
      pauseForToday,
      recordingStarted,
      pauseUntilNextWorkPeriod,
      updateScreenCapturePermission,
      updateWindowsPermission,
      hasWindowsPermission: getWindowsPermission,
      updateUserStatus,
      getUserWorkdays: () => userWorkdays,
      getUserWorkhours: () => userWorkhours,
      hasScreenCapturePermission: () => hasScreenCapturePermission,
      isAuthenticated: () => Boolean(idToken),
      hasValidAccess: () => userStatus === 'active',
      isManualPauseAllowed,
      getClientTelemetryEnabled,
      getIdToken: () => {
        return idToken;
      },
      setIdToken,
      clearIdToken,
      cleanupOnQuit,
      stopStateValidation,
      resume,
      isSystemIdle,
      clearSystemIdleFlags
    };
  } catch (error) {
    log.error('Failed to initialize state:', error);
    return null;
  }
}

function getClientTelemetryEnabled() {
  const enabled = safeStoreOperation(() => {
    if (!store) return true;
    const storedValue = store.get('clientTelemetryEnabled');
    return typeof storedValue === 'boolean' ? storedValue : true;
  }, 'get clientTelemetryEnabled');

  return typeof enabled === 'boolean' ? enabled : true;
}

/**
 * Initialize electron-store with fallback locations
 */
async function initializeStore() {
  const locations = [
    { name: 'default', cwd: app.getPath('userData') },
    { name: 'documents', cwd: path.join(app.getPath('documents'), '.donethat-config') },
    { name: 'temp', cwd: app.getPath('temp') }
  ];

  function logSelectedStore(storeInstance, location, source) {
    const resolvedPath = (storeInstance && typeof storeInstance.path === 'string')
      ? storeInstance.path
      : path.join(location.cwd, 'donethat-config.json');
    log.info(`Using config store (${source}) in ${location.name}: ${resolvedPath}`);
    if (location.name === 'temp') {
      log.warn(`Config store fallback is using temp directory (non-persistent): ${resolvedPath}`);
    }
  }
  
  // Check all locations for existing data
  let dataFound = false;
  
  for (const location of locations) {
    try {
      // Create a test store to check if data exists
      const testStore = new Store({
        name: 'donethat-config',
        cwd: location.cwd,
        clearInvalidConfig: true
      });
      
      // If we get here, we could access this location
      // Check if there's existing data
      const hasData = Object.keys(testStore.store).length > 0;
      
      if (hasData) {
        // Found data, use this location
        store = testStore;
        logSelectedStore(store, location, 'existing data');
        dataFound = true;
        break;
      }
    } catch (err) {
      log.warn(`Unable to access ${location.name} location:`, err.message);
      
      // Check if this is a permission error
      if (err.code === 'EPERM' || err.message.includes('permission') || 
          err.message.includes('access') || err.message.includes('denied')) {
        showStorageError(err);
      }
      
      // Continue to next location
    }
  }
  
  // If no data was found, create a new store in the first available location
  if (!dataFound) {
    for (const location of locations) {
      try {
        store = new Store({
          name: 'donethat-config',
          cwd: location.cwd,
          clearInvalidConfig: true
        });
        log.info(`Created new store in ${location.name} location: ${location.cwd}`);
        logSelectedStore(store, location, 'new store');
        break;
      } catch (err) {
        log.warn(`Failed to create store in ${location.name} location:`, err.message);
        
        // Check if this is a permission error
        if (err.code === 'EPERM' || err.message.includes('permission') || 
            err.message.includes('access') || err.message.includes('denied')) {
          showStorageError(err);
        }
        
        // Continue to next location
      }
    }
  }
  
  // If we still don't have a store, throw an error
  if (!store) {
    const error = new Error('Unable to initialize configuration storage in any location');
    showStorageError(error);
    throw error;
  }
}

/**
 * Reset timers when starting or power back
 */
function resume() {
  if (workPeriodCheckTimeoutId) {
    clearTimeout(workPeriodCheckTimeoutId);
    workPeriodCheckTimeoutId = null;
  }
  _scheduleNextWorkEndCheck();
  loadPauseState();
  loadManualOverrideWorkHours(); // Load persisted manual override flag
  
  // Check if we should be paused based on work hours when app starts
  // This handles the case where user is already authenticated and it's past work hours
  const now = new Date();
  const isActive = isActiveWorkPeriod(now);
  
  // If we're in an active work period, clear any work-hours-related pause
  // This handles the case where work settings changed and we're now in work hours
  if (isActive && isPaused() && pauseState.reason === 'workday-start') {
    _clearPauseStateAndCheckRecording();
  }
  
  // Respect manual override: do not auto-pause outside work hours if user manually resumed
  if (!isActive && !isPaused() && !manualOverrideWorkHours) {
    pauseUntilNextWorkPeriod(mainWindow, true); // silent=true to avoid notification on startup
  }
  
  // Start periodic state validation heartbeat to catch timer failures
  startStateValidation();
  
  // Ensure all state is synchronized after initialization
  if (checkAndAdjustRecording) {
    checkAndAdjustRecording();
  }
}

// Helper function to check if currently paused
function isPaused() {
  return pauseState.endTime !== null && (pauseState.endTime > new Date());
}

// Helper function to check if today is a configured workday
function isWorkday(date = new Date()) {
  const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
  // Ensure userWorkdays is an array before checking
  return Array.isArray(userWorkdays) && userWorkdays.includes(dayOfWeek);
}

// Helper function to check if current time is within configured work hours
function isWithinWorkHours(date = new Date()) {
  // Parse the start and end hours from the format "HH:MM"
  const startParts = userWorkhours.start.split(':');
  const endParts = userWorkhours.end.split(':');
  
  if (startParts.length < 2 || endParts.length < 2) {
    // Invalid format, default to true to avoid disrupting the app
    log.error('Invalid work hours format');
    return true;
  }
  
  const startHour = parseInt(startParts[0], 10);
  const startMinute = parseInt(startParts[1], 10);
  const endHour = parseInt(endParts[0], 10);
  const endMinute = parseInt(endParts[1], 10);

  if (isNaN(startHour) || isNaN(startMinute) || isNaN(endHour) || isNaN(endMinute)) {
    // Invalid numbers, default to true to avoid disrupting the app
    log.error('Invalid work hours numbers');
    return true;
  }
  
  // Create date objects for today's start and end times
  const startTime = new Date(date);
  startTime.setHours(startHour, startMinute, 0, 0);
  
  const endTime = new Date(date);
  endTime.setHours(endHour, endMinute, 0, 0);
  
  // Handle work hours that span midnight (e.g., 18:00 to 01:00, or 09:00 to 09:00)
  // If end time is before or equal to start time, the period spans midnight
  const spansMidnight = endTime <= startTime;
  
  if (spansMidnight) {
    // Period spans midnight: work hours go from start time today to end time tomorrow
    // Check if we're after start time today OR before end time today (which represents tomorrow)
    if (date >= startTime) {
      // We're after start time today - definitely in work hours
      return true;
    } else {
      // We're before start time today - check if we're before end time
      // Since endTime is earlier in the day than startTime, if we're before startTime,
      // we might be in the tail end of yesterday's work period (which ends today at endTime)
      return date < endTime;
    }
  } else {
    // Normal case: start and end on same day
    return date >= startTime && date < endTime;
  }
}

// Helper function to check if it's currently an active work period
function isActiveWorkPeriod(date = new Date()) {
  return isWorkday(date) && isWithinWorkHours(date);
}

function _checkWorkdayEndNotification() {
  const threeHoursInMillis = 3 * 60 * 60 * 1000;

  // Only show notification if:
  // 1. We have a last summary timestamp
  // 2. 3+ hours have passed since last summary
  // 3. The app was NOT already paused (to avoid showing notification when user manually paused)
  if (lastSummaryTimestamp && 
      (Date.now() - lastSummaryTimestamp > threeHoursInMillis) && 
      !isPaused()) {
    // Create notification with same options structure as start notification
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('request-notification', {
          id: 'workday-ended',
          title: 'Workday Ended',
          message: 'DoneThat is paused for the day. You can change your work hours in settings.',
          sticky: false,
          action: { label: 'Resume', channel: 'resumeRecording', payload: null }
        });
      }
    } catch (e) {}
  }
}

function _clearPauseStateAndCheckRecording() {
  // Clear pause state to avoid issues
  pauseState = { endTime: null, timeoutId: null, reason: null };

  if (checkAndAdjustRecording) {
    checkAndAdjustRecording();
  }
}

function _handlePauseTimeout(reason) {
  if (reason === PAUSE_REASON_PAUSE_TODAY) {
    _validateState();
    return;
  }
  _clearPauseStateAndCheckRecording();
}

// Function to pause recording for a specified duration
function pauseRecording(duration, mainWindow, reason = null) {
  if (pauseState.timeoutId) {
    clearTimeout(pauseState.timeoutId);
    pauseState.timeoutId = null;
  }

  // Calculate end time
  const endTime = new Date(Date.now() + duration);
  
  // Set pause state
  pauseState = {
    endTime: endTime,
    timeoutId: setTimeout(() => _handlePauseTimeout(reason), duration),
    reason: reason
  };

  savePauseState();
  
  // Make sure recording is stopped
  if (checkAndAdjustRecording) {
    checkAndAdjustRecording();
  }

  // Send analytics event to renderer
  if (mainWindow) {
    mainWindow.webContents.send('analytics-event', {
      eventName: 'recording_state_changed',
      eventParams: {
        status: 'paused',
        duration_minutes: Math.round(duration / (60 * 1000))
      }
    });
  }
}

function pauseForToday(mainWindow) {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const duration = midnight.getTime() - now.getTime();

  setManualOverrideWorkHours(false);

  if (duration > 0) {
    pauseRecording(duration, mainWindow, PAUSE_REASON_PAUSE_TODAY);
    return;
  }

  _validateState();
}

// Function to pause until the start of the next active work period (either today or next workday)
function pauseUntilNextWorkPeriod(mainWindow, silent=false) {
  const now = new Date();
  
  // Clear manual override flag when applying work-hours pause
  setManualOverrideWorkHours(false);
  
  if (!silent) {
    _checkWorkdayEndNotification();
  }
  
  // Parse work hours
  const startParts = userWorkhours.start.split(':');
  const endParts = userWorkhours.end.split(':');
  
  if (startParts.length < 2 || endParts.length < 2) {
    // Invalid format, fall back to pausing for a day
    log.error('Invalid work hours format when trying to pause until next period');
    pauseRecording(24 * 60 * 60 * 1000, mainWindow, 'workday-start');
    return;
  }
  
  const startHour = parseInt(startParts[0], 10);
  const startMinute = parseInt(startParts[1], 10);

  // Today's start time
  const todayStartTime = new Date(now);
  todayStartTime.setHours(startHour, startMinute, 0, 0);
  
  // Check if we're before today's start time on a workday
  if (isWorkday(now) && now < todayStartTime) {
    const duration = todayStartTime.getTime() - now.getTime();
    if (duration > 0) {
      pauseRecording(duration, mainWindow, 'workday-start');
      // Schedule next check after this pause ends
      return;
    }
  }
  
  // Find the next workday
  const nextWorkday = _findNextWorkday(now);
  
  // If no workday found in the next week, just pause for a day
  if (!nextWorkday) {
    log.warn('No workday found in the next week, pausing for 24 hours');
    pauseRecording(24 * 60 * 60 * 1000, mainWindow, 'workday-start');
    return;
  }
  
  // Set the time to the start of work hours on that workday
  const nextWorkdayDate = new Date(nextWorkday);
  nextWorkdayDate.setHours(startHour, startMinute, 0, 0);
  
  const duration = nextWorkdayDate.getTime() - now.getTime();
  
  // If the duration is less than 5 minutes, don't pause at all
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  if (duration > 0 && duration < FIVE_MINUTES_MS) {
    log.info(`Time until next workday start is only ${Math.round(duration / 1000 / 60)} minutes, skipping pause`);
    // Don't pause, just schedule the next work end check
    _scheduleNextWorkEndCheck();
    return;
  }
  
  // Ensure duration is positive
  if (duration > 0) {
    pauseRecording(duration, mainWindow, 'workday-start');
  } else {
    log.error('Calculated pause duration was not positive');
    // Fallback: Pause for 1 hour
    pauseRecording(60 * 60 * 1000, mainWindow, 'workday-start');
  }
}

// Function to resume recording (called manually or by timer)
function recordingStarted(mainWindow) {
  if (pauseState.timeoutId) {
    clearTimeout(pauseState.timeoutId);
  }

  // Reset pause state
  const wasPaused = isPaused(); // Check if we were paused
  pauseState = { endTime: null, timeoutId: null };
  
  // Clear the saved pause state
  safeStoreOperation(() => store.delete('pauseState'), 'clear pause state');

  // If user manually resumes outside work hours, set override flag
  const now = new Date();
  if (!isActiveWorkPeriod(now)) {
    setManualOverrideWorkHours(true);
  }

  _scheduleNextWorkEndCheck();

  // Common operations for all resume cases
  if (mainWindow && wasPaused) {
    mainWindow.webContents.send('pauseStateChanged', false);
    mainWindow.webContents.send('analytics-event', { 
        eventName: 'recording_state_changed',
        eventParams: { status: 'resumed' } 
    });
  }
}

// Function to set manual override work hours flag (sets variable and persists to store)
function setManualOverrideWorkHours(value) {
  manualOverrideWorkHours = value;
  if (!store) {
    if (value) {
      log.warn('Store not initialized when saving manual override work hours');
    }
    return;
  }
  
  if (value) {
    safeStoreOperation(() => store.set('manualOverrideWorkHours', true), 'save manual override work hours');
  } else {
    safeStoreOperation(() => store.delete('manualOverrideWorkHours'), 'clear manual override work hours');
  }
}

// Function to load manual override work hours flag from store
function loadManualOverrideWorkHours() {
  if (!store) {
    log.warn('Store not initialized when loading manual override work hours');
    return;
  }
  
  const savedOverride = safeStoreOperation(() => store.get('manualOverrideWorkHours'), 'load manual override work hours');
  if (typeof savedOverride === 'boolean') {
    manualOverrideWorkHours = savedOverride;
  } else {
    // Explicitly set to false if not found (to clear any stale in-memory state)
    manualOverrideWorkHours = false;
  }
}

// Function to save pause state using electron-store
function savePauseState() {
  // Skip if store is not initialized
  if (!store) {
    log.warn('Store not initialized');
    return;
  }

  const stateToSave = {
    endTime: pauseState.endTime ? pauseState.endTime.getTime() : null,
    reason: pauseState.reason
  };
  
  safeStoreOperation(() => store.set('pauseState', stateToSave), 'save pause state');
}

// Function to load pause state using electron-store
function loadPauseState() {
  // Skip if store is not initialized
  if (!store) {
    log.warn('Store not initialized when loading pause state');
    return false;
  }

  const savedState = safeStoreOperation(() => store.get('pauseState'), 'load pause state');
  
  if (savedState && savedState.endTime) {
    const endTime = new Date(savedState.endTime);
    const now = new Date();
    
    // If pause end time is in the future, restore the pause
    if (endTime > now) {
      const remainingDuration = endTime.getTime() - now.getTime();
      
      pauseState = {
        endTime: endTime,
        timeoutId: setTimeout(() => _handlePauseTimeout(savedState.reason), remainingDuration),
        reason: savedState.reason
      };
      
      return true;
    } else {
      // Pause period has already expired - clear both storage and in-memory state
      safeStoreOperation(() => store.delete('pauseState'), 'delete expired pause state');
      // Clear in-memory pause state to prevent stale state
      if (pauseState.timeoutId) {
        clearTimeout(pauseState.timeoutId);
      }
      pauseState = { endTime: null, timeoutId: null, reason: null };
    }
  }
  
  return false;
}

// Load work settings (days and hours) from store
function loadWorkSettings() {
  if (!store) {
    log.warn('Store not initialized when loading work settings');
    return;
  }

  // Load userWorkdays from store, with validation and default fallback
  const savedWorkdays = safeStoreOperation(() => store.get('userWorkdays'), 'load workdays');
  if (Array.isArray(savedWorkdays) && savedWorkdays.every(d => typeof d === 'number' && d >= 0 && d <= 6)) {
    userWorkdays = [...new Set(savedWorkdays)].sort((a, b) => a - b); // Ensure unique & sorted
  } else {
    // Default is already set, but save it initially if not present
    if (!savedWorkdays) {
      safeStoreOperation(() => store.set('userWorkdays', userWorkdays), 'save default workdays');
    }
  }

  // Load userWorkhours from store, with validation and default fallback
  const savedWorkhours = safeStoreOperation(() => store.get('userWorkhours'), 'load workhours');
  if (savedWorkhours && typeof savedWorkhours === 'object' && savedWorkhours.start && savedWorkhours.end) {
    userWorkhours = {
      start: savedWorkhours.start,
      end: savedWorkhours.end
    };
  } else {
    // Default is already set, but save it initially if not present
    if (!savedWorkhours) {
      safeStoreOperation(() => store.set('userWorkhours', userWorkhours), 'save default workhours');
    }
  }

  // Load autoSubmit setting from store
  const storedAutoSubmit = safeStoreOperation(() => store.get('autoSubmit'), 'load autoSubmit');
  if (typeof storedAutoSubmit === 'boolean') {
    autoSubmit = storedAutoSubmit;
  }
}

// Load last summary timestamp from store
function loadSummaryTimestamp() {
  if (!store) {
    log.warn('Store not initialized when loading summary timestamp');
    return;
  }
  
  let loadedTimestamp = safeStoreOperation(() => store.get('lastSummaryPeriodEnd'), 'load summary timestamp');

  // Directly try to use the loaded value, assuming it's milliseconds (number)
  if (loadedTimestamp !== null && loadedTimestamp !== undefined) {
    try {
      const dateObject = new Date(loadedTimestamp);
      // Validate the date created from the loaded number
      if (!isNaN(dateObject.getTime())) {
        lastSummaryTimestamp = loadedTimestamp; // Store as milliseconds
      } else {
        // If the loaded number results in an invalid date, log error and delete the stored value
        log.error('Invalid period end format received:', loadedTimestamp, 
                  'Type:', typeof loadedTimestamp, 
                  'Resulting date object:', dateObject);
        safeStoreOperation(() => store.delete('lastSummaryPeriodEnd'), 'delete invalid summary timestamp');
        lastSummaryTimestamp = null;
      }
    } catch (error) {
      log.error('Error processing period end:', error, 
               'Raw value:', loadedTimestamp, 
               'Type:', typeof loadedTimestamp);
      safeStoreOperation(() => store.delete('lastSummaryPeriodEnd'), 'delete invalid summary timestamp');
      lastSummaryTimestamp = null;
    }
  } else {
    // If no timestamp in store, initialize to null
    lastSummaryTimestamp = null;
  }
}

// Update screen capture permission status
function updateScreenCapturePermission(permission) {
  hasScreenCapturePermission = permission;
}

// Windows permission state
let hasWindowsPermission = false;

// Update Windows permission status
function updateWindowsPermission(permission) {
  hasWindowsPermission = permission;
}

// Get Windows permission status
function getWindowsPermission() {
  return hasWindowsPermission;
}

// Update user status
function updateUserStatus(status) {
  userStatus = status;
  
  // Trigger recording state check when status changes
  if (checkAndAdjustRecording) {
    checkAndAdjustRecording();
  }
}

// Set up IPC handlers for state management
function setupIPCHandlers() {
  // Auth handlers - single source of truth for login/logout events
  ipcMain.on('login', (event, token) => {
    const mainWindow = event.sender.getOwnerBrowserWindow();
    
    if (setIdToken(token)) {
      // Check if we're outside of work hours and should pause
      // Respect manual override: do not auto-pause if user manually resumed
      const now = new Date();
      if (!isActiveWorkPeriod(now) && !manualOverrideWorkHours) {
        pauseUntilNextWorkPeriod(mainWindow, true); // silent=true to avoid notification
      } 

      // Only start recording if we're in work hours
      if (checkAndAdjustRecording) {
        checkAndAdjustRecording();
      }
      
      // Send permission status to renderer
      if (mainWindow) {
        mainWindow.webContents.send('screenCapturePermission', {
          hasPermission: hasScreenCapturePermission,
          source: 'login'
        });
      }
    }
  });
  
  ipcMain.on('logout', (event) => {
    resetSessionState();
    
    // Stop recording on logout
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  });
  
  // Token refresh handling
  ipcMain.on('token-refreshed', (event, newToken) => {
    const mainWindow = event.sender.getOwnerBrowserWindow();

    if (setIdToken(newToken)) {
      // Token updated successfully
    } else {
      log.warn('Token refresh failed - no valid token received');
      if (mainWindow) {
        mainWindow.webContents.send('auth-error', {
          code: 'auth/token-refresh-failed',
          message: 'Failed to refresh authentication token'
        });
      }
    }
  });

  // Listen for workday updates from renderer
  ipcMain.on('updateWorkdays', (event, days) => {
    if (Array.isArray(days) && days.every(d => typeof d === 'number' && d >= 0 && d <= 6)) {
      userWorkdays = [...new Set(days)].sort((a, b) => a - b); // Update state, ensure unique & sorted
      
      // Save the updated workdays to the store
      safeStoreOperation(() => {
        if (store) {
          store.set('userWorkdays', userWorkdays);
        } else {
          log.warn('Store not initialized, cannot save userWorkdays.');
        }
      }, 'save updated workdays');
      
      if (isPaused() && pauseState.reason === 'workday-start') {
        pauseUntilNextWorkPeriod(event.sender.getOwnerBrowserWindow(), silent=true);
      } else {
        _scheduleNextWorkEndCheck();
      }

    } else {
      log.error('Received invalid workdays data:', days);
    }
  });

  // Listen for workhours updates from renderer
  ipcMain.on('updateWorkhours', (event, hours) => {
    if (hours && typeof hours === 'object' && hours.start && hours.end) {
      userWorkhours = {
        start: hours.start,
        end: hours.end
      };
      
      // Save the updated workhours to the store
      safeStoreOperation(() => {
        if (store) {
          store.set('userWorkhours', userWorkhours);
        } else {
          log.warn('Store not initialized, cannot save userWorkhours.');
        }
      }, 'save updated workhours');
      
      // Check if we should adjust recording based on the new hours
      if (isPaused() && pauseState.reason === 'workday-start') {
        pauseUntilNextWorkPeriod(event.sender.getOwnerBrowserWindow(), silent=true);
      } else {
        _scheduleNextWorkEndCheck();
      }

    } else {
      log.error('Received invalid workhours data:', hours);
    }
  });

  // Add handler to get initial pause state
  ipcMain.handle('getInitialPauseState', () => {
    return isPaused();
  });

  // From dashboard
  ipcMain.on('pauseUntilTomorrow', (event) => {
    if (!isManualPauseAllowed()) {
      return;
    }
    const mainWindow = event.sender.getOwnerBrowserWindow();
    pauseForToday(mainWindow);
  });

  // Add IPC handler for pause state updates
  ipcMain.on('pauseStateChanged', (event, isPaused) => {
    const mainWindow = event.sender.getOwnerBrowserWindow();
    if (mainWindow) {
      mainWindow.webContents.send('pauseStateChanged', isPaused);
    }
  });

  // Listen for summary submission events
  ipcMain.on('summarySubmitted', (event, data) => {
    // Check if we received the period end time
    if (data && data.lastSummaryPeriodEnd) {
      // Store the period end time
      const lastSummaryPeriodEnd = data.lastSummaryPeriodEnd;
      
      // Update the local timestamp variable with the period end time
      lastSummaryTimestamp = lastSummaryPeriodEnd;
      
      // Save to persistent store
      safeStoreOperation(() => {
        if (store) {
          store.set('lastSummaryPeriodEnd', lastSummaryPeriodEnd);
        } else {
          log.warn('Store not initialized, cannot save lastSummaryPeriodEnd on summary submission');
        }
      }, 'save summary period end');
    } else {
      log.warn('No period end time received with summary submission');
    }
  });

  // Add IPC handler for user status updates
  ipcMain.on('updateUserStatus', (event, status) => {
    updateUserStatus(status);
  });

  // Add IPC handler for auto submit setting
  ipcMain.on('updateAutoSubmit', (event, value) => {
    if (typeof value === 'boolean') {
      autoSubmit = value;
      
      // Save to persistent store
      safeStoreOperation(() => {
        if (store) {
          store.set('autoSubmit', value);
        } else {
          log.warn('Store not initialized, cannot save autoSubmit setting');
        }
      }, 'save autoSubmit setting');
    } else {
      log.error('Received invalid autoSubmit value:', value);
    }
  });

  ipcMain.handle('get-client-telemetry', async () => {
    return { enabled: getClientTelemetryEnabled() };
  });

  ipcMain.on('updateClientTelemetry', (_event, enabled) => {
    if (typeof enabled !== 'boolean') {
      log.error('Received invalid clientTelemetryEnabled value:', enabled);
      return;
    }

    safeStoreOperation(() => {
      if (store) {
        store.set('clientTelemetryEnabled', enabled);
      } else {
        log.warn('Store not initialized, cannot save clientTelemetryEnabled.');
      }
    }, 'save clientTelemetryEnabled');
  });

  ipcMain.on('apply-managed-app-settings', (_event, payload) => {
    try {
      applyManagedAppSettings(payload || null);
    } catch (error) {
      log.error('Failed to apply managed app settings:', error);
    }
  });

  // Linux screenshot command handlers
  ipcMain.handle('save-linux-screenshot-command', async (event, command) => {
    try {
      if (command && typeof command !== 'string') {
        throw new Error('Invalid command provided');
      }

      // Save command to store (no encryption needed for commands)
      safeStoreOperation(() => {
        if (store) {
          if (command && command.trim()) {
            store.set('linuxScreenshotCommand', command.trim());
          } else {
            store.delete('linuxScreenshotCommand');
          }
        } else {
          throw new Error('Store not initialized');
        }
      }, 'save Linux screenshot command');

      log.info('Linux screenshot command saved successfully');
      return { success: true };
    } catch (error) {
      log.error('Error saving Linux screenshot command:', error);
      throw error;
    }
  });

  ipcMain.handle('get-linux-screenshot-command', async (event) => {
    try {
      const command = safeStoreOperation(() => {
        if (store) {
          return store.get('linuxScreenshotCommand');
        } else {
          return null;
        }
      }, 'get Linux screenshot command');

      return { success: true, command: command || null };
    } catch (error) {
      log.error('Error retrieving Linux screenshot command:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-linux-autostart', async () => {
    try {
      if (process.platform !== 'linux') {
        return { success: true, enabled: false, filePath: null, execPath: null, exists: false, isCurrent: false };
      }
      const storedValue = safeStoreOperation(() => store?.get('linuxAutostartEnabled'), 'get linux autostart enabled');
      const enabled = typeof storedValue === 'boolean' ? storedValue : true;
      const state = linuxAutostart.getState(enabled);
      return { success: true, ...state };
    } catch (error) {
      log.error('Error retrieving Linux autostart state:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-linux-autostart', async (_event, enabled) => {
    try {
      if (process.platform !== 'linux') {
        return { success: true, enabled: false, filePath: null, execPath: null, exists: false, isCurrent: false };
      }
      if (typeof enabled !== 'boolean') {
        throw new Error('Invalid linux autostart value');
      }

      safeStoreOperation(() => {
        if (!store) throw new Error('Store not initialized');
        store.set('linuxAutostartEnabled', enabled);
      }, 'save linux autostart enabled');

      const state = linuxAutostart.setEnabled(enabled);
      return { success: true, ...state };
    } catch (error) {
      log.error('Error updating Linux autostart state:', error);
      return { success: false, error: error.message };
    }
  });


  // Gemini API key handlers
  ipcMain.handle('save-gemini-api-key', async (event, apiKey) => {
    try {
      if (isLocalProcessingManaged()) {
        throw new Error('LLM settings are managed by your organization');
      }
      if (!apiKey || typeof apiKey !== 'string') {
        throw new Error('Invalid API key provided');
      }

      // Encrypt the API key
      const encryptedKey = encryptData(apiKey);
      
      // Save encrypted key to store
      safeStoreOperation(() => {
        if (store) {
          store.set('geminiApiKey', encryptedKey);
          store.set(GEMINI_KEY_SOURCE_STORE_KEY, API_KEY_SOURCE_USER);
        } else {
          throw new Error('Store not initialized');
        }
      }, 'save encrypted Gemini API key');

      // Cache the decrypted key in memory
      cachedGeminiApiKey = apiKey;

      try { require('./processLocal').resetLLMModels(); } catch (_) {}
      return { success: true };
    } catch (error) {
      log.error('Error saving Gemini API key:', error);
      throw error;
    }
  });

  ipcMain.handle('get-gemini-api-key', async (event) => {
    // Delegate to the internal getter to ensure consistent error handling
    try {
      const result = await getGeminiApiKey();
      return result;
    } catch (error) {
      log.error('Error retrieving Gemini API key (ipc):', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-local-processing-state', async () => {
    return getLocalProcessingState();
  });

  ipcMain.handle('clear-gemini-api-key', async (event) => {
    try {
      if (isLocalProcessingManaged()) {
        throw new Error('LLM settings are managed by your organization');
      }
      safeStoreOperation(() => {
        if (store) {
          store.delete('geminiApiKey');
          store.delete(GEMINI_KEY_SOURCE_STORE_KEY);
        } else {
          throw new Error('Store not initialized');
        }
      }, 'delete Gemini API key');

      // Clear cached key
      cachedGeminiApiKey = null;

      try { require('./processLocal').resetLLMModels(); } catch (_) {}
      log.info('Gemini API key cleared successfully');
      return { success: true };
    } catch (error) {
      log.error('Error clearing Gemini API key:', error);
      throw error;
    }
  });

  // OpenAI-compatible config handlers
  ipcMain.handle('save-openai-compatible-config', async (event, config) => {
    try {
      if (isLocalProcessingManaged()) {
        throw new Error('LLM settings are managed by your organization');
      }
      if (!config || typeof config !== 'object') {
        throw new Error('Invalid config provided');
      }

      const { endpoint, apiKey } = config;
      const preserveApiKey = !!config.preserveApiKey;

      if (endpoint && typeof endpoint !== 'string') {
        throw new Error('Invalid endpoint provided');
      }

      if (apiKey && typeof apiKey !== 'string') {
        throw new Error('Invalid API key provided');
      }

      if (preserveApiKey && apiKey) {
        throw new Error('Cannot preserve and replace OpenAI-compatible API key at the same time');
      }

      const existingConfig = safeStoreOperation(() => {
        if (!store) return {};
        return store.get('openaiCompatibleConfig') || {};
      }, 'read existing OpenAI-compatible config before save') || {};
      const existingKeySource = safeStoreOperation(() => {
        if (!store) return null;
        return store.get(OPENAI_KEY_SOURCE_STORE_KEY) || null;
      }, 'read existing OpenAI-compatible API key source before save');

      // Encrypt the API key if provided
      let encryptedKey = null;
      if (apiKey) {
        encryptedKey = encryptData(apiKey);
      } else if (preserveApiKey) {
        encryptedKey = existingConfig.apiKey || null;
      }

      // Save config to store
      safeStoreOperation(() => {
        if (store) {
          store.set('openaiCompatibleConfig', {
            endpoint: endpoint || null,
            model: config.model || null,
            apiKey: encryptedKey
          });
          if (apiKey) {
            store.set(OPENAI_KEY_SOURCE_STORE_KEY, API_KEY_SOURCE_USER);
          } else if (preserveApiKey && existingKeySource && encryptedKey) {
            store.set(OPENAI_KEY_SOURCE_STORE_KEY, existingKeySource);
          } else {
            store.delete(OPENAI_KEY_SOURCE_STORE_KEY);
          }
        } else {
          throw new Error('Store not initialized');
        }
      }, 'save OpenAI-compatible config');

      // Cache the decrypted config in memory
      if (preserveApiKey && encryptedKey) {
        cachedOpenAICompatibleConfig = null;
      } else {
        cachedOpenAICompatibleConfig = {
          endpoint: endpoint || null,
          model: config.model || null,
          apiKey: apiKey || null
        };
      }

      try { require('./processLocal').resetLLMModels(); } catch (_) {}
      log.info('OpenAI-compatible config saved successfully');
      return { success: true };
    } catch (error) {
      log.error('Error saving OpenAI-compatible config:', error);
      throw error;
    }
  });

  ipcMain.handle('get-openai-compatible-config', async (event) => {
    try {
      const result = await getOpenAICompatibleConfig();
      return result;
    } catch (error) {
      log.error('Error retrieving OpenAI-compatible config (ipc):', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('clear-openai-compatible-config', async (event) => {
    try {
      if (isLocalProcessingManaged()) {
        throw new Error('LLM settings are managed by your organization');
      }
      safeStoreOperation(() => {
        if (store) {
          store.delete('openaiCompatibleConfig');
          store.delete(OPENAI_KEY_SOURCE_STORE_KEY);
        } else {
          throw new Error('Store not initialized');
        }
      }, 'delete OpenAI-compatible config');

      // Clear cached config
      cachedOpenAICompatibleConfig = null;

      try { require('./processLocal').resetLLMModels(); } catch (_) {}
      log.info('OpenAI-compatible config cleared successfully');
      return { success: true };
    } catch (error) {
      log.error('Error clearing OpenAI-compatible config:', error);
      throw error;
    }
  });

  // Test local processing handler
  ipcMain.handle('test-local-processing', async (event) => {
    const { processDataLocally, isLocalProcessingAvailable, formatLocalProcessingErrorForUser } = require('./processLocal');
    try {
      const { getInputDataSettings } = require('./capture');
      const audioCapture = require('./captureAudio');

      // Use minimal dummy input data for testing - avoids complex collection that might hang
      const inputData = {
        activity: [],
        idleTime: 0
      };

      const screenshots = await require('./captureScreenshots').captureScreenshot({ caller: 'test-local-processing' });

      // Check if we have local processing available and determine which provider
      if (!await isLocalProcessingAvailable()) {
        return { success: false, message: 'No local processing configuration found. Set up Gemini API key or OpenAI-compatible endpoint first.' };
      }

      // Determine which provider is configured (Gemini takes precedence)
      const geminiResult = await getGeminiApiKey();
      const openaiResult = await getOpenAICompatibleConfig();
      const isGemini = geminiResult.success && geminiResult.apiKey;
      const isOpenAI = !isGemini && openaiResult.success && openaiResult.config && openaiResult.config.endpoint;
      const providerName = isGemini ? 'Gemini' : (isOpenAI ? 'OpenAI-Compatible' : 'Local');
      const captureSettings = getInputDataSettings();
      const shouldTestAudio = !!captureSettings?.audio;
      let audioIncludedInTest = false;

      if (shouldTestAudio) {
        let startedForTest = false;
        try {
          const statusBefore = audioCapture.getStatus();
          if (!statusBefore?.recording) {
            startedForTest = await audioCapture.startRecording();
          }
          if (startedForTest) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }

          const audioInfo = await audioCapture.stopRecording(false, { includeOpenAIWav: true });
          if (audioInfo && audioInfo.audioCycle && audioInfo.audioCycle.base64Data) {
            inputData.audioCycle = audioInfo.audioCycle;
            audioIncludedInTest = true;
          }
        } catch (audioError) {
          log.warn('Local processing test: unable to include test audio:', audioError?.message || audioError);
        } finally {
          if (startedForTest) {
            try {
              await audioCapture.shutdownRecording();
            } catch (_) {}
          }
        }
      }

      // Attempt with current token; on FIREBASE auth error, request refresh and retry once
      let token = idToken || null;
      try {
        await processDataLocally(token, screenshots, inputData, true);
        return {
          success: true,
          message: `${providerName} test successful${shouldTestAudio ? (audioIncludedInTest ? ' (audio included)' : ' (audio unavailable)') : ''}`
        };
      } catch (err) {
        const isFirebase = err && err.source === 'FIREBASE';
        const isAuth = isFirebase && (err.code === 'TOKEN_EXPIRED' || err.code === 'AUTH_ERROR' || err.status === 401 || err.status === 403);
        if (!isAuth) {
          throw err;
        }
        // Ask renderer to refresh token and wait for response
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('refresh-token');
          }
        } catch (_) {}

        // Wait for token-refreshed event (max 10s)
        token = await new Promise((resolve) => {
          let done = false;
          const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 10000);
          const handler = (_e, newToken) => {
            if (done) return;
            done = true;
            try { clearTimeout(timer); } catch (_) {}
            resolve(newToken || null);
          };
          try { ipcMain.once('token-refreshed', handler); } catch (_) { resolve(null); }
        });

        if (!token) {
          return { success: false, message: 'Token refresh failed. Please sign in again.' };
        }

        // Retry once with refreshed token
        await processDataLocally(token, screenshots, inputData, true);
        return {
          success: true,
          message: `${providerName} test successful${shouldTestAudio ? (audioIncludedInTest ? ' (audio included)' : ' (audio unavailable)') : ''}`
        };
      }
    } catch (error) {
      log.error('Error in local processing test:', error);
      return { success: false, message: formatLocalProcessingErrorForUser(error) };
    }
  });


  // App exclusions handlers
  ipcMain.handle('get-app-exclusions', async (event) => {
    try {
      const exclusions = safeStoreOperation(() => {
        if (store) {
          return store.get('appExclusions') || [];
        } else {
          return [];
        }
      }, 'get app exclusions');
      return { success: true, exclusions };
    } catch (error) {
      log.error('Error getting app exclusions:', error);
      return { success: false, error: error.message, exclusions: [] };
    }
  });

  ipcMain.handle('save-app-exclusions', async (event, exclusions) => {
    try {
      const managedExclusionConfig = managedAppSettings.capture.appExclusions;
      if (isManagedValue(managedExclusionConfig) && managedExclusionConfig.mode === 'fixed') {
        throw new Error('App exclusions are managed by your organization');
      }
      if (!Array.isArray(exclusions)) {
        throw new Error('Exclusions must be an array');
      }
      const normalizedExclusions = normalizeManagedAppExclusions(exclusions);
      const mergedExclusions = (isManagedValue(managedExclusionConfig) && managedExclusionConfig.mode === 'minimum')
        ? mergeMinimumAppExclusions(normalizedExclusions, managedExclusionConfig.entries)
        : normalizedExclusions;
      safeStoreOperation(() => {
        if (store) {
          store.set('appExclusions', mergedExclusions);
        } else {
          throw new Error('Store not initialized');
        }
      }, 'save app exclusions');
      return { success: true, exclusions: mergedExclusions };
    } catch (error) {
      log.error('Error saving app exclusions:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('test-app-exclusions', async (event) => {
    try {
      const { applyAppExclusionsToDetailedScreenshots } = require('./appExclusionMasking');
      const windowsCapture = require('./captureWindows');
      const { captureScreenshotDetailed } = require('./captureScreenshots');

      // Check if exclusions are configured
      const exclusions = safeStoreOperation(() => {
        if (store) {
          return store.get('appExclusions') || [];
        } else {
          return [];
        }
      }, 'get app exclusions for test');

      if (!exclusions || exclusions.length === 0) {
        return { success: false, message: 'No app exclusions configured' };
      }

      // Capture fresh screenshots
      const screenshots = await captureScreenshotDetailed({ caller: 'test-app-exclusions' });
      if (!screenshots || screenshots.length === 0) {
        return { success: false, message: 'Failed to capture screenshots' };
      }

      // Check if we have permission to access windows
      const hasPermission = await windowsCapture.checkPermissions('test-app-exclusions');
      if (!hasPermission) {
        return { success: false, message: 'Window tracking permission is not granted. Please enable "Active applications" in Required permissions and grant system permission.' };
      }

      // Apply masking (this will load exclusions from store and gather all needed data, including window enumeration)
      const maskedEntries = await applyAppExclusionsToDetailedScreenshots(screenshots);
      const maskedScreenshots = maskedEntries.map((entry) => entry.imageDataUrl);

      // Scale down to thumbnails (max 200px width)
      const { Jimp } = require('jimp');
      const thumbnails = await Promise.all(maskedScreenshots.map(async (screenshot) => {
        try {
          const img = await Jimp.read(screenshot);
          if (img.bitmap.width > 200) {
            const h = Math.round(200 * img.bitmap.height / img.bitmap.width);
            img.resize({ w: 200, h });
          }
          const thumbnailBuffer = await img.getBuffer('image/jpeg', { quality: 70 });
          return `data:image/jpeg;base64,${thumbnailBuffer.toString('base64')}`;
        } catch (error) {
          log.error('Error creating thumbnail:', error);
          return screenshot;
        }
      }));

      return { success: true, screenshots: thumbnails };
    } catch (error) {
      log.error('Error testing app exclusions:', error);
      return { success: false, message: error.message };
    }
  });

  // Context capture (experimental) handlers
  ipcMain.handle('get-context-capture-enabled', async () => {
    try {
      const apps = safeStoreOperation(() => normalizeManagedContextApps(store?.get('contextApps') || []), 'get contextApps for context capture enabled');
      const enabled = Array.isArray(apps) && apps.length > 0;
      return { success: true, enabled };
    } catch (error) {
      return { success: false, enabled: false };
    }
  });

  ipcMain.on('update-context-capture-enabled', (event, enabled) => {
    const managedContextConfig = managedAppSettings.capture.contextCapture;
    if (isManagedValue(managedContextConfig?.enabled)) {
      return;
    }
    if (enabled) {
      return;
    }
    safeStoreOperation(() => {
      if (store) store.set('contextApps', []);
    }, 'clear contextApps when disabling context capture');
  });

  ipcMain.handle('get-context-apps', async () => {
    try {
      const apps = safeStoreOperation(() => store?.get('contextApps') || [], 'get contextApps');
      return { success: true, apps: Array.isArray(apps) ? apps : [] };
    } catch (error) {
      return { success: false, apps: [] };
    }
  });

  ipcMain.handle('save-context-apps', async (event, apps) => {
    try {
      const managedContextConfig = managedAppSettings.capture.contextCapture;
      if (isManagedValue(managedContextConfig) && managedContextConfig.mode === 'fixed') {
        throw new Error('Context capture settings are managed by your organization');
      }
      if (!Array.isArray(apps)) {
        throw new Error('Context apps must be an array');
      }
      const normalizedApps = normalizeManagedContextApps(apps);
      const mergedApps = (isManagedValue(managedContextConfig) && managedContextConfig.mode === 'minimum')
        ? mergeMinimumContextApps(normalizedApps, managedContextConfig.apps)
        : normalizedApps;
      safeStoreOperation(() => {
        if (store) store.set('contextApps', mergedApps);
        else throw new Error('Store not initialized');
      }, 'save contextApps');
      return { success: true, apps: mergedApps };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Capture dump (save data to folder)
  ipcMain.handle('get-save-capture-data', async () => {
    try {
      const { getBasePath } = require('./captureDump');
      const enabled = safeStoreOperation(() => store?.get('saveCaptureDataToFolder') || false, 'get saveCaptureDataToFolder');
      let dumpPath = await getBasePath();
      if (!dumpPath || typeof dumpPath !== 'string') {
        dumpPath = path.join(app.getPath('userData'), 'donethat');
      }
      return { enabled: !!enabled, path: dumpPath };
    } catch (error) {
      log.error('Error getting save capture data:', error);
      const fallback = path.join(app.getPath('userData'), 'donethat');
      return { enabled: false, path: fallback };
    }
  });

  ipcMain.on('updateSaveCaptureData', (event, enabled) => {
    if (isManagedValue(managedAppSettings.capture.saveCaptureData)) {
      return;
    }
    safeStoreOperation(() => {
      if (store) store.set('saveCaptureDataToFolder', !!enabled);
    }, 'save saveCaptureDataToFolder');
  });

  ipcMain.on('updateSaveCaptureDataPath', (event, dumpPath) => {
    if (isManagedValue(managedAppSettings.capture.saveCaptureData)) {
      return;
    }
    safeStoreOperation(() => {
      if (store && typeof dumpPath === 'string') store.set('saveCaptureDataPath', dumpPath.trim());
    }, 'save saveCaptureDataPath');
  });

  ipcMain.handle('choose-capture-dump-folder', async (event) => {
    if (isManagedValue(managedAppSettings.capture.saveCaptureData)) {
      return null;
    }
    try {
      const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
      const bw = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(bw || null, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select folder for capture dumps'
      });
      if (result.canceled || !result.filePaths?.length) return null;
      return result.filePaths[0];
    } catch (error) {
      log.error('Error choosing capture dump folder:', error);
      return null;
    }
  });
}

/**
 * Helper: Finds the next workday starting from a given date
 * @param {Date} fromDate - Starting date
 * @returns {Date|null} - Next workday date or null if not found within 7 days
 */
function _findNextWorkday(fromDate) {
  let nextWorkday = new Date(fromDate);
  nextWorkday.setDate(nextWorkday.getDate() + 1);
  
  let daysAhead = 0;
  while (!isWorkday(nextWorkday) && daysAhead < 7) {
    nextWorkday.setDate(nextWorkday.getDate() + 1);
    daysAhead++;
  }
  
  return daysAhead < 7 ? nextWorkday : null;
}

/**
 * Helper: Calculates the end time of a work period that starts on a given date
 * @param {Date} periodStartDate - The date when the work period starts
 * @param {number} startHour - Start hour
 * @param {number} startMinute - Start minute
 * @param {number} endHour - End hour
 * @param {number} endMinute - End minute
 * @returns {Date} - The end time of the work period
 */
function _calculatePeriodEndTime(periodStartDate, startHour, startMinute, endHour, endMinute) {
  const periodStart = new Date(periodStartDate);
  periodStart.setHours(startHour, startMinute, 0, 0);
  
  const periodEnd = new Date(periodStartDate);
  periodEnd.setHours(endHour, endMinute, 0, 0);
  
  // If work hours span midnight, end time is the next day
  if (periodEnd < periodStart) {
    periodEnd.setDate(periodEnd.getDate() + 1);
  }
  
  return periodEnd;
}

/**
 * Helper: Gets the end time of the current work period
 * @param {Date} now - Current date/time
 * @param {number} startHour - Start hour
 * @param {number} startMinute - Start minute
 * @param {number} endHour - End hour
 * @param {number} endMinute - End minute
 * @returns {Date} - End time of current work period
 */
function _getCurrentPeriodEnd(now, startHour, startMinute, endHour, endMinute) {
  const todayStartTime = new Date(now);
  todayStartTime.setHours(startHour, startMinute, 0, 0);
  
  const todayEndTime = new Date(now);
  todayEndTime.setHours(endHour, endMinute, 0, 0);
  
  const spansMidnight = todayEndTime <= todayStartTime;
  
  if (spansMidnight) {
    // Determine which period we're in
    if (now >= todayStartTime) {
      // Period that started today ends tomorrow
      const end = new Date(todayEndTime);
      end.setDate(end.getDate() + 1);
      return end;
    } else {
      // Period that started yesterday ends today
      return todayEndTime;
    }
  } else {
    // Normal case: ends today
    return todayEndTime;
  }
}

/**
 * Schedules a check for the next workday end
 * Returns the time until the next check in milliseconds
 */
function _scheduleNextWorkEndCheck() {
  // Clear any existing timeout
  if (workPeriodCheckTimeoutId) {
    clearTimeout(workPeriodCheckTimeoutId);
    workPeriodCheckTimeoutId = null;
  }

  const now = new Date();
  let nextWorkEndTime = null;
  
  // Parse work hours
  const startParts = userWorkhours.start.split(':');
  const endParts = userWorkhours.end.split(':');
  
  if (startParts.length >= 2 && endParts.length >= 2) {
    const startHour = parseInt(startParts[0], 10);
    const startMinute = parseInt(startParts[1], 10);
    const endHour = parseInt(endParts[0], 10);
    const endMinute = parseInt(endParts[1], 10);
    
    if (!isNaN(startHour) && !isNaN(startMinute) && !isNaN(endHour) && !isNaN(endMinute)) {
      // Check if we're currently in work hours (could be today's period or yesterday's period spanning midnight)
      let inWorkHours = false;
      let periodEnd = null;
      
      // First check if we're in today's work period
      if (isWorkday(now) && isWithinWorkHours(now)) {
        inWorkHours = true;
        periodEnd = _getCurrentPeriodEnd(now, startHour, startMinute, endHour, endMinute);
      } else {
        // Check if we're in the tail end of yesterday's work period (for periods spanning midnight)
        const todayEndTime = new Date(now);
        todayEndTime.setHours(endHour, endMinute, 0, 0);
        const todayStartTime = new Date(now);
        todayStartTime.setHours(startHour, startMinute, 0, 0);
        const spansMidnight = todayEndTime < todayStartTime;
        
        if (spansMidnight && now < todayEndTime) {
          // Check if yesterday was a workday
          const yesterday = new Date(now);
          yesterday.setDate(yesterday.getDate() - 1);
          if (isWorkday(yesterday)) {
            // We're in the tail end of yesterday's work period
            inWorkHours = true;
            periodEnd = todayEndTime;
          }
        }
      }
      
      if (inWorkHours && periodEnd) {
        // We're in work hours - check at the current period's end time
        nextWorkEndTime = periodEnd;
      } else {
        // We're outside work hours - find next workday's period end
        const todayStartTime = new Date(now);
        todayStartTime.setHours(startHour, startMinute, 0, 0);
        
        let nextWorkday = null;
        if (isWorkday(now) && now < todayStartTime) {
          // Today is a workday and start time is in the future - use today
          nextWorkday = new Date(now);
          nextWorkday.setHours(startHour, startMinute, 0, 0);
        } else {
          // Find the next workday starting from tomorrow
          nextWorkday = _findNextWorkday(now);
          if (nextWorkday) {
            nextWorkday.setHours(startHour, startMinute, 0, 0);
          }
        }
        
        if (nextWorkday) {
          nextWorkEndTime = _calculatePeriodEndTime(nextWorkday, startHour, startMinute, endHour, endMinute);
        }
      }
    }
  }
  
  // If we couldn't determine next work end time (invalid format or no workdays found), 
  // default to checking at 5:00 PM today or tomorrow
  if (!nextWorkEndTime) {
    nextWorkEndTime = new Date(now);
    if (now.getHours() >= 17) {
      nextWorkEndTime.setDate(nextWorkEndTime.getDate() + 1);
    }
    nextWorkEndTime.setHours(17, 0, 0, 0);
  }
  
  // Calculate milliseconds until next check
  const msUntilCheck = nextWorkEndTime.getTime() - now.getTime();
  
  // Ensure msUntilCheck is positive
  const positiveMsUntilCheck = Math.max(msUntilCheck, 60000); // Minimum 1 minute wait
    
  // Capture the intended fire time to avoid late (post-sleep) notifications
  const intendedFireTs = nextWorkEndTime.getTime();

  // Set timeout for next check - when work period ends, pause until next work period
  workPeriodCheckTimeoutId = setTimeout(() => {
    // Use the stored mainWindow reference
    
    // If this timer fires significantly late (e.g., device resumed next day),
    // avoid showing a stale end-of-day notification
    const now = Date.now();
    const LATE_GRACE_MS = 30 * 60 * 1000; // 30 minutes
    const firedLate = now - intendedFireTs > LATE_GRACE_MS;

    // Check if user is away (screen locked or system suspended) to avoid notifications
    const isUserAway = isSystemIdle();

    // When work period ends, pause until next work period
    // Use silent=true when firing late OR when user is away to suppress the banner
    const shouldBeSilent = firedLate === true || isUserAway;
    pauseUntilNextWorkPeriod(mainWindow, shouldBeSilent);
  }, positiveMsUntilCheck);
  
  return positiveMsUntilCheck;
}

/**
 * Cleanup function for app quit
 * Clears any timeouts and saves pause state if needed
 */
function cleanupOnQuit() {
  try {
    // Stop state validation heartbeat
    stopStateValidation();
    
    // Clear pause timeout if active
    if (pauseState.timeoutId) {
      clearTimeout(pauseState.timeoutId);
      pauseState.timeoutId = null;
    }
    
    // Clear work period check timeout if active
    if (workPeriodCheckTimeoutId) {
      clearTimeout(workPeriodCheckTimeoutId);
      workPeriodCheckTimeoutId = null;
    }
    
    // Save pause state to persist after restart if paused
    if (isPaused()) {
      savePauseState();
    }
  } catch (error) {
    log.error('Error during cleanup on quit:', error);
  }
}

/**
 * Set the user's authentication token
 * @param {string} token ID token from authentication provider
 */
function setIdToken(token) {
  if (token && typeof token === 'string') {
    idToken = token;
    return true;
  } else {
    return false;
  }
}

/**
 * Clear the authentication token only
 */
function clearIdToken() {
  idToken = null;
}

/**
 * Reset all session-specific state on logout
 * Keeps user preferences (work hours, settings) but clears session data
 */
function resetSessionState() {
  // Clear token
  clearIdToken();
  
  // Clear pause state and timers
  if (pauseState.timeoutId) {
    clearTimeout(pauseState.timeoutId);
  }
  pauseState = {
    endTime: null,
    timeoutId: null,
    reason: null
  };
  
  // Clear saved pause state from store
  safeStoreOperation(() => {
    if (store) {
      store.delete('pauseState');
    }
  }, 'clear pause state on logout');
  
  // Clear work period check timeout
  if (workPeriodCheckTimeoutId) {
    clearTimeout(workPeriodCheckTimeoutId);
    workPeriodCheckTimeoutId = null;
  }
  
  // Clear manual override flag
  setManualOverrideWorkHours(false);
  
  // Clear system state flags
  isScreenLocked = false;
  isSystemSuspended = false;
  
  // Reset user status to default (avoid showing inactive when logged out)
  userStatus = 'active';

  managedAppSettings = normalizeManagedAppSettings(null);
}

/**
 * Check if system is idle (locked or suspended)
 */
function isSystemIdle() {
  return isScreenLocked || isSystemSuspended;
}

/**
 * Clear lock/suspend flags when we detect user activity
 * Called as a worst-case fallback when user interacts with the app
 */
function clearSystemIdleFlags() {
  if (isScreenLocked || isSystemSuspended) {
    log.info('Clearing lock/suspend flags due to app interaction (fallback)');
    isScreenLocked = false;
    isSystemSuspended = false;
  }
}

/**
 * Setup power monitor event handlers
 * Called automatically during initState()
 */
function setupPowerMonitorHandlers() {
  const { powerMonitor } = require('electron');
  
  powerMonitor.on('resume', () => {
    isSystemSuspended = false;
    // Rebase timers after system resume
    resume();
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  });
  
  powerMonitor.on('unlock-screen', () => {
    isScreenLocked = false;
    // Rebase timers after unlock as some Windows devices may not emit 'resume'
    // and existing setTimeouts would otherwise extend pauses by sleep duration
    resume();
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  });
  
  powerMonitor.on('suspend', () => {
    isSystemSuspended = true;
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  });
  
  powerMonitor.on('lock-screen', () => {
    isScreenLocked = true;
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  });
}

/**
 * Get Gemini API key (for internal use)
 */
async function getGeminiApiKey() {
  // Return cached key if available
  if (cachedGeminiApiKey !== null) {
    return { success: true, apiKey: cachedGeminiApiKey };
  }

  try {
    const encryptedKey = safeStoreOperation(() => {
      if (store) {
        return store.get('geminiApiKey');
      } else {
        return null;
      }
    }, 'get encrypted Gemini API key');

    if (!encryptedKey) {
      return { success: true, apiKey: null };
    }

    // Decrypt the API key
    const decryptedKey = await decryptDataWithRetry(encryptedKey);

    if (isLegacyEncryptedData(encryptedKey)) {
      try {
        const migratedKey = encryptData(decryptedKey);
        safeStoreOperation(() => {
          if (store) {
            store.set('geminiApiKey', migratedKey);
          }
        }, 'migrate Gemini API key to safe storage');
      } catch (migrationError) {
        log.warn('Failed to migrate Gemini API key to safeStorage:', migrationError);
      }
    }

    // Cache the decrypted key
    cachedGeminiApiKey = decryptedKey;

    return { success: true, apiKey: decryptedKey };
  } catch (error) {
    log.error('Error retrieving Gemini API key:', error);
    if (error && typeof error.message === 'string' && error.message.includes('Failed to decrypt data')) {
      cachedGeminiApiKey = null;
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('request-notification', {
            id: 'gemini-key-decrypt-failed',
            title: 'Settings',
            message: "We couldn't read your Gemini API key right now. We'll use cloud processing for now and keep your saved key unchanged.",
            sticky: true
          });
        }
      } catch (notifyErr) {
        log.warn('Failed to send in-app notification for Gemini key read failure:', notifyErr);
      }
      return { success: true, apiKey: null };
    }
    return { success: false, error: error.message };
  }
}

function getLocalProcessingState() {
  try {
    const geminiStoredKey = safeStoreOperation(() => {
      if (!store) return null;
      return store.get('geminiApiKey');
    }, 'get Gemini API key presence');

    const openaiStoredConfig = safeStoreOperation(() => {
      if (!store) return null;
      return store.get('openaiCompatibleConfig');
    }, 'get OpenAI-compatible config summary');

    const geminiKeySource = safeStoreOperation(() => {
      if (!store) return null;
      return store.get(GEMINI_KEY_SOURCE_STORE_KEY) || null;
    }, 'get Gemini API key source');

    const openaiKeySource = safeStoreOperation(() => {
      if (!store) return null;
      return store.get(OPENAI_KEY_SOURCE_STORE_KEY) || null;
    }, 'get OpenAI-compatible API key source');

    return {
      success: true,
      state: {
        gemini: {
          hasKey: !!geminiStoredKey,
          keySource: geminiKeySource || null
        },
        openAICompatible: {
          endpoint: openaiStoredConfig?.endpoint || null,
          model: openaiStoredConfig?.model || null,
          hasApiKey: !!openaiStoredConfig?.apiKey,
          keySource: openaiKeySource || null
        }
      }
    };
  } catch (error) {
    log.error('Error retrieving local processing state:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get OpenAI-compatible config (for internal use)
 */
async function getOpenAICompatibleConfig() {
  // Return cached config if available
  if (cachedOpenAICompatibleConfig !== null) {
    return {
      success: true,
      config: cachedOpenAICompatibleConfig
    };
  }

  try {
    const storedConfig = safeStoreOperation(() => {
      if (store) {
        return store.get('openaiCompatibleConfig');
      } else {
        return null;
      }
    }, 'get OpenAI-compatible config');

    if (!storedConfig) {
      return { success: true, config: null };
    }

    // Decrypt the API key if present
    let apiKey = null;
    if (storedConfig.apiKey) {
      try {
        apiKey = await decryptDataWithRetry(storedConfig.apiKey);
        if (isLegacyEncryptedData(storedConfig.apiKey)) {
          try {
            const migratedApiKey = encryptData(apiKey);
            safeStoreOperation(() => {
              if (store) {
                store.set('openaiCompatibleConfig', {
                  ...storedConfig,
                  apiKey: migratedApiKey
                });
              }
            }, 'migrate OpenAI-compatible API key to safe storage');
          } catch (migrationError) {
            log.warn('Failed to migrate OpenAI-compatible API key to safeStorage:', migrationError);
          }
        }
      } catch (error) {
        log.error('Error decrypting OpenAI-compatible API key:', error);
        if (error && typeof error.message === 'string' && error.message.includes('Failed to decrypt data')) {
          cachedOpenAICompatibleConfig = null;
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('request-notification', {
                id: 'openai-key-decrypt-failed',
                title: 'Settings',
                message: "We couldn't read your OpenAI-compatible API key right now. We'll use cloud processing for now and keep your saved key unchanged.",
                sticky: true
              });
            }
          } catch (notifyErr) {
            log.warn('Failed to send in-app notification for OpenAI-compatible key read failure:', notifyErr);
          }
          return { success: true, config: null };
        }
        return { success: false, error: error.message };
      }
    }

    const config = {
      endpoint: storedConfig.endpoint,
      model: storedConfig.model,
      apiKey: apiKey
    };

    // Cache the decrypted config
    cachedOpenAICompatibleConfig = config;

    return {
      success: true,
      config: config
    };
  } catch (error) {
    log.error('Error retrieving OpenAI-compatible config:', error);
    return { success: false, error: error.message };
  }
}

function getMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  return null;
}

module.exports = {
  initState,
  getMainWindow,
  resume,
  isPaused,
  isWorkday,
  isWithinWorkHours,
  isActiveWorkPeriod,
  pauseRecording,
  pauseForToday,
  pauseUntilNextWorkPeriod,
  recordingStarted,
  loadWorkSettings,
  loadSummaryTimestamp,
  updateScreenCapturePermission,
  updateWindowsPermission,
  hasWindowsPermission: getWindowsPermission,
  setupIPCHandlers,
  cleanupOnQuit,
  stopStateValidation,
  setIdToken,
  clearIdToken,
  resetSessionState,
  isSystemIdle,
  clearSystemIdleFlags,
  isManualPauseAllowed,
  getClientTelemetryEnabled,
  getGeminiApiKey,
  getLocalProcessingState,
  getOpenAICompatibleConfig,
  getAutoSubmit: () => autoSubmit
}
