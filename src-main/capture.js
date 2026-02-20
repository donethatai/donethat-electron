const log = require('electron-log');
const { captureScreenshot, getPreviousScreenshots, saveCurrentScreenshot, scaleScreenshotToPreviousSize, checkScreenCapturePermission } = require('./captureScreenshots');
const { ipcMain, powerMonitor } = require('electron');
const { default: Store } = require('electron-store');
const { isLocalProcessingAvailable, processDataLocally } = require('./processLocal');
const { applyAppExclusions } = require('./appExclusionMasking');
const { applyImageDiffBoundingBoxes } = require('./imageDiff');
const { saveCaptureDump, appendCaptureDump } = require('./captureDump');
const {
  beginCycle,
  endCycle,
  recordCyclePhaseDuration,
  recordPermissionCheck,
  recordCaptureCycleSkippedOverlap
} = require('./telemetry');

// Firebase URL constant
const FIREBASE_CAPTURE_URL = 'https://europe-west1-donethat.cloudfunctions.net/captureScreenshot';

// Import capture modules
const audioCapture = require('./captureAudio');
const windowsCapture = require('./captureWindows');

// Variable to track the capture interval
let screenshotInterval = null;
let initialCaptureDelayTimer = null;
let captureIntervalMinutes; // Set in main
let reauthenticateCallback = null; // Store reauthenticate callback function
let mainWindowRef = null; // Store mainWindow reference
let getIdTokenFunction = null; // Store the getIdToken function reference
let captureCycleInFlight = false;
let microphonePermissionFocusListener = null;
let systemAudioPermissionFocusListener = null;
const PENDING_PERMISSION_POST_RESTART_FOCUS_KEY = 'pendingPermissionPostRestartFocus';

const WINDOW_CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let lastWindowCacheCleanupAt = 0;

function markPermissionFocusOnNextLaunch(reason = 'system-audio-permission') {
  try {
    const store = new Store({ name: 'donethat-config' });
    store.set(PENDING_PERMISSION_POST_RESTART_FOCUS_KEY, {
      reason,
      createdAt: Date.now()
    });
  } catch (error) {
    log.warn('Failed to persist post-restart focus marker:', error?.message || error);
  }
}

function isValidImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false;
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) return false;
  return dataUrl.slice(commaIndex + 1).trim().length > 0;
}


// Track input data settings
let inputDataSettings = {
  audio: false,
  windows: false,
  systemAudio: false,
  screen: true
};
let managedInputDataSettings = {
  audio: null,
  windows: null,
  systemAudio: null,
  screen: null
};

function isManagedValue(value) {
  return value !== null && value !== undefined;
}

function normalizeManagedInputState(value) {
  if (!isManagedValue(value)) return null;
  if (value === 'enabled' || value === 'optional' || value === 'disabled') {
    return value;
  }
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  return null;
}

function isManagedInputStateForced(value) {
  return value === 'enabled' || value === 'disabled';
}

function stateToBool(value) {
  if (value === 'enabled') return true;
  if (value === 'disabled') return false;
  return null;
}

function applyManagedInputDataOverrides(managedInputData) {
  if (!managedInputData || typeof managedInputData !== 'object') {
    managedInputDataSettings = {
      audio: null,
      windows: null,
      systemAudio: null,
      screen: null
    };
    return;
  }

  managedInputDataSettings = {
    audio: normalizeManagedInputState(managedInputData.audio),
    windows: normalizeManagedInputState(managedInputData.windows),
    systemAudio: normalizeManagedInputState(managedInputData.systemAudio),
    screen: normalizeManagedInputState(managedInputData.screen)
  };

  const enforced = {};
  if (isManagedInputStateForced(managedInputDataSettings.audio)) enforced.audio = stateToBool(managedInputDataSettings.audio);
  if (isManagedInputStateForced(managedInputDataSettings.windows)) enforced.windows = stateToBool(managedInputDataSettings.windows);
  if (isManagedInputStateForced(managedInputDataSettings.systemAudio)) enforced.systemAudio = stateToBool(managedInputDataSettings.systemAudio);
  if (isManagedInputStateForced(managedInputDataSettings.screen)) enforced.screen = stateToBool(managedInputDataSettings.screen);

  if (Object.keys(enforced).length > 0) {
    updateInputDataSettings(enforced);
  }
}

// Window tracking startup retry state (to avoid disabling on transient failures)
let windowStartRetryCount = 0;
const WINDOW_START_MAX_RETRIES = 5;
let windowStartRetryTimer = null;

const failureStreaks = {
  screen: 0,
  windows: 0,
  microphone: 0,
  systemAudio: 0
};

const RUNTIME_ISSUE_THRESHOLDS = {
  screen: 4,
  windows: 6,
  microphone: 4,
  systemAudio: 4
};

function resetFailureStreak(feature) {
  if (Object.prototype.hasOwnProperty.call(failureStreaks, feature)) {
    failureStreaks[feature] = 0;
  }
}

function incrementFailureStreak(feature) {
  if (!Object.prototype.hasOwnProperty.call(failureStreaks, feature)) {
    return 0;
  }
  failureStreaks[feature] += 1;
  return failureStreaks[feature];
}

// Track disable screenshots in meetings setting


/**
 * Sets capture interval in minutes
 * @param {number} minutes Interval in minutes
 * @throws {Error} If invalid
 */
function setCaptureInterval(minutes) {
  if (!minutes || typeof minutes !== 'number' || minutes <= 0) {
    throw new Error('Capture interval must be a positive number of minutes');
  }
  captureIntervalMinutes = minutes;
  
  // Update audio buffer duration if mainWindow exists
  if (mainWindowRef) {
    const bufferDurationMs = captureIntervalMinutes * 60 * 1000;
    mainWindowRef.webContents.executeJavaScript(
      `window.initAudioRecorder && window.initAudioRecorder({
        bufferDurationMs: ${bufferDurationMs}
      });`
    ).catch(error => {
      log.error('Error updating audio recorder buffer duration:', error);
      // Don't throw here as this is a post-initialization update
    });
  }
  
  return captureIntervalMinutes;
}

/**
 * Helper function to start audio tracking
 * @returns {Promise<boolean>} Success status
 */
async function _startAudioTracking() {
  try {
    if (!mainWindowRef) {
      log.warn('Cannot start audio recording: No main window reference');
      handleCaptureError(
        new Error('No main window reference'), 
        'microphone', 
        {
          microphone: true,
          ...(inputDataSettings.systemAudio ? { systemAudio: true } : {})
        },
        false // Don't stop capturing; keep reporting runtime issues and retrying
      );
      return false;
    }
    
    // Start audio tracking with session detection (this will check permission once)
    const success = await audioCapture.startAudioTracking({
      bufferDurationMs: captureIntervalMinutes * 60 * 1000,
      systemAudio: !!inputDataSettings.systemAudio
    });
    
    if (!success) {
      handleCaptureError(
        new Error('Microphone permission not granted'),
        'microphone-permission',
        {
          microphone: true,
          ...(inputDataSettings.systemAudio ? { systemAudio: true } : {})
        },
        false
      );
      return false;
    }
    
    resetFailureStreak('microphone');
    if (inputDataSettings.systemAudio) {
      resetFailureStreak('systemAudio');
    }
    return true;
    
  } catch (error) {
    log.error('Error starting audio tracking:', error);
    
    // Use handleCaptureError with specific audio error
    handleCaptureError(
      error, 
      'microphone-error', 
      {
        microphone: true,
        ...(inputDataSettings.systemAudio ? { systemAudio: true } : {})
      },
      false // Don't stop capturing; keep reporting runtime issues and retrying
    );
    
    return false;
  }
}

async function probePermission(type, source, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    let outcome = 'unknown';
    if (result === true) outcome = 'granted';
    else if (result === false) outcome = 'denied';
    else if (result === null || result === undefined) outcome = 'skipped_busy';
    recordPermissionCheck(type, source, outcome, Date.now() - startedAt);
    return result;
  } catch (error) {
    recordPermissionCheck(type, source, 'error', Date.now() - startedAt);
    throw error;
  }
}

/**
 * Helper function to start window tracking
 * @returns {Promise<boolean>} Success status
 */
async function _startWindowTracking() {
  try {
    const trackingStarted = await windowsCapture.startTracking();
    if (!trackingStarted) {
      // Transient or denied permission. Preserve user's setting and retry with bounded backoff.
      if (windowStartRetryTimer) {
        clearTimeout(windowStartRetryTimer);
        windowStartRetryTimer = null;
      }
      if (!isCapturing() || !inputDataSettings.windows) {
        // Do not retry if capture stopped or user disabled windows
        windowStartRetryCount = 0;
        return false;
      }
      windowStartRetryCount = Math.min(windowStartRetryCount + 1, WINDOW_START_MAX_RETRIES);
      const delayMs = Math.min(1000 * Math.pow(2, windowStartRetryCount - 1), 30000);
      log.warn(`Window tracking did not start (permission missing or transient). Retry #${windowStartRetryCount} in ${delayMs}ms`);
      windowStartRetryTimer = setTimeout(() => {
        // Only retry if still capturing and windows setting enabled
        try {
          if (isCapturing() && inputDataSettings.windows) {
            _startWindowTracking();
          } else {
            windowStartRetryCount = 0;
          }
        } catch (_) {
          windowStartRetryCount = 0;
        }
      }, delayMs);
      return false;
    }
    
    // Success: reset retry state
    windowStartRetryCount = 0;
    resetFailureStreak('windows');
    return true;
  } catch (error) {
    log.error('Failed to start window tracking:', error);
    
    // Use handleCaptureError with specific windows error
    handleCaptureError(
      error, 
      'windows-error', 
      { windows: true },
      false // Don't stop capturing; keep reporting runtime issues and retrying
    );
    
    return false;
  }
}

/**
 * Updates input data settings
 * @param {Object} settings Settings with audio, windows flags
 * @returns {Object} Updated settings
 */
function updateInputDataSettings(settings) {
  if (settings && typeof settings === 'object') {
    // Save previous settings for comparison
    const previousSettings = { ...inputDataSettings };
    
    // Update settings
    inputDataSettings = {
      ...inputDataSettings,
      ...(settings.audio !== undefined ? { audio: !!settings.audio } : {}),
      ...(settings.windows !== undefined ? { windows: !!settings.windows } : {}),
      ...(settings.systemAudio !== undefined ? { systemAudio: !!settings.systemAudio } : {}),
      ...(settings.screen !== undefined ? { screen: !!settings.screen } : {})
    };

    if (isManagedInputStateForced(managedInputDataSettings.audio)) {
      inputDataSettings.audio = stateToBool(managedInputDataSettings.audio);
    }
    if (isManagedInputStateForced(managedInputDataSettings.windows)) {
      inputDataSettings.windows = stateToBool(managedInputDataSettings.windows);
    }
    if (isManagedInputStateForced(managedInputDataSettings.systemAudio)) {
      inputDataSettings.systemAudio = stateToBool(managedInputDataSettings.systemAudio);
    }
    if (isManagedInputStateForced(managedInputDataSettings.screen)) {
      inputDataSettings.screen = stateToBool(managedInputDataSettings.screen);
    }

    // Keep dependency invariant: system audio cannot remain enabled when microphone is off.
    if (!inputDataSettings.audio && inputDataSettings.systemAudio) {
      inputDataSettings.systemAudio = false;
    }
    
    // Stop tracking for disabled options
    if (previousSettings.audio && !inputDataSettings.audio) {
      resetFailureStreak('microphone');
      resetFailureStreak('systemAudio');
      audioCapture.shutdownRecording().catch(error => {
        log.error('Error shutting down audio recording:', error);
      });
    }
    
    if (previousSettings.windows && !inputDataSettings.windows) {
      resetFailureStreak('windows');
      windowsCapture.stopTracking();
    }
    
    // Start tracking for newly enabled options or changed systemAudio preference
    if(isCapturing()) {
      // If audio was already on, but systemAudio changed, we need to restart/update tracking
      if (inputDataSettings.audio && (previousSettings.systemAudio !== inputDataSettings.systemAudio)) {
         // Re-trigger startAudioTracking which updates config and handles restart if internally needed 
         // (though currently startAudioTracking just updates config and checks permission, 
         // doesn't force restart of active recording unless we do it here).
         // The cleaner way is to restart.
         audioCapture.shutdownRecording().then(() => {
             _startAudioTracking();
         }).catch(err => log.error('Error restarting audio for system audio change:', err));
      } else if (!previousSettings.audio && inputDataSettings.audio) {
        _startAudioTracking();
      }
      
      if (!previousSettings.windows && inputDataSettings.windows) {
        // Reset window start retry state on fresh enable
        if (windowStartRetryTimer) {
          clearTimeout(windowStartRetryTimer);
          windowStartRetryTimer = null;
        }
        windowStartRetryCount = 0;
        _startWindowTracking();
      }
    }
  }
  return inputDataSettings;
}





/**
 * Initializes capture functionality and registers all IPC handlers
 * @param {BrowserWindow} mainWindow Reference to the main window for sending IPC messages
 * @param {Function} onAuthError Callback for when authentication errors are detected
 *                               Called with either {authError: true} for general auth failures
 *                               or {tokenExpired: true} for token expiration
 * @param {Function} getIdToken Function to get the current ID token
 * @throws {Error} If mainWindow is not provided or capture interval is not set
 */
function initCapture(mainWindow, onAuthError, getIdToken) {
  if (!mainWindow) {
    throw new Error('Main window must be provided to initialize capture');
  }
  
  if (!captureIntervalMinutes || captureIntervalMinutes <= 0) {
    throw new Error('Capture interval must be set before initializing capture');
  }
  
  // Store the reauthenticate callback
  reauthenticateCallback = onAuthError;
  // Store getIdToken function
  if (typeof getIdToken !== 'function') {
      throw new Error('getIdToken function must be provided to initialize capture');
  }
  getIdTokenFunction = getIdToken;

  // Store mainWindow reference
  mainWindowRef = mainWindow;
  
  // Initialize audio capture with main window and buffer duration matching the capture interval
  audioCapture.initialize(mainWindow, {
    bufferDurationMs: captureIntervalMinutes * 60 * 1000
  });
  
  // Handler for updating input data settings
  ipcMain.on('updateInputDataSettings', (event, settings) => {
    updateInputDataSettings(settings);
  });

  ipcMain.on('apply-managed-app-settings', (_event, payload) => {
    applyManagedInputDataOverrides(payload?.capture?.inputData || null);
  });

  // Handler for updating disable screenshots in meetings setting


  // Handler for getting audio capture status
  ipcMain.handle('getAudioCaptureStatus', async (event) => {
    try {
      return audioCapture.getStatus();
    } catch (error) {
      log.error('Error getting audio capture status:', error);
      return { error: error.message };
    }
  });

  // Add other capture-related IPC handlers here as needed
  ipcMain.on('requestMicrophonePermission', async (_event, shouldOpenSettings = true) => {
    const { shell } = require('electron');
    const { checkMicrophonePermission } = require('./captureAudio');
    
    const hasPermission = await probePermission('microphone', 'request', () => checkMicrophonePermission(true));
    
    if (hasPermission) {
      if (mainWindow) {
        mainWindow.webContents.send('microphonePermission', { hasPermission: true, source: 'request' });
      }
      return;
    }
    
    if (shouldOpenSettings !== true) {
      if (mainWindow) {
        mainWindow.webContents.send('microphonePermission', { hasPermission: false, source: 'request' });
      }
      return;
    }

    if (mainWindow) {
      mainWindow.webContents.send('microphonePermission', { hasPermission: false, source: 'request' });
    }

    // Open system settings based on platform
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    } else if (process.platform === 'win32') {
      shell.openExternal('ms-settings:privacy-microphone');
    } else if (process.platform === 'linux') {
      if (mainWindow) {
        mainWindow.webContents.send('linux-audio-permission-notice');
      }
      return;
    } else {
      if (mainWindow) {
        mainWindow.webContents.send('microphonePermission', { hasPermission: false, source: 'request' });
      }
      return;
    }
    
    // Check permission on focus
    const app = require('electron').app;
    if (microphonePermissionFocusListener) {
      app.removeListener('browser-window-focus', microphonePermissionFocusListener);
      microphonePermissionFocusListener = null;
    }

    const focusListener = async () => {
      if (microphonePermissionFocusListener === focusListener) {
        microphonePermissionFocusListener = null;
      }
      app.removeListener('browser-window-focus', focusListener);
      
      const newHasPermission = await probePermission('microphone', 'focus-recheck', () => checkMicrophonePermission(true));
      
      if (mainWindow) {
        mainWindow.webContents.send('microphonePermission', { hasPermission: !!newHasPermission, source: 'request' });
      }
    };
    
    microphonePermissionFocusListener = focusListener;
    app.on('browser-window-focus', focusListener);
  });

  // System Audio Permission Request Handler
  ipcMain.on('requestSystemAudioPermission', async (_event, shouldOpenSettings = true) => {
    const { shell } = require('electron');
    const { checkSystemAudioPermission } = require('./captureAudio');
    
    // System audio is part of screen recording permission on macOS
    if (process.platform === 'darwin') {
      const hasSystemAudioPermission = await probePermission(
        'systemAudio',
        'request',
        () => checkSystemAudioPermission({ activeProbe: shouldOpenSettings === true })
      );
      if (hasSystemAudioPermission === null) {
        // Permission check was skipped/in-progress; keep current UI state.
        return;
      }
      if (hasSystemAudioPermission) {
        if (mainWindow) {
          mainWindow.webContents.send('systemAudioPermission', { hasPermission: true, source: 'request' });
        }
        return;
      }
      if (shouldOpenSettings !== true) {
        if (mainWindow) {
          mainWindow.webContents.send('systemAudioPermission', { hasPermission: false, source: 'request' });
        }
        return;
      }
      if (mainWindow) {
        mainWindow.webContents.send('systemAudioPermission', { hasPermission: false, source: 'request' });
      }
      markPermissionFocusOnNextLaunch('system-audio-permission');
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    } else if (process.platform === 'win32') {
      // Windows system audio capture does not use a dedicated OS permission dialog.
      if (mainWindow) {
        mainWindow.webContents.send('systemAudioPermission', { hasPermission: true, source: 'request' });
      }
      return;
    } else if (process.platform === 'linux') {
      // Linux - no specific permission needed for system audio
      if (mainWindow) {
        mainWindow.webContents.send('systemAudioPermission', { hasPermission: true, source: 'request' });
      }
      return;
    }
    
    // Check permission on focus (for macOS/Windows)
    const app = require('electron').app;
    if (systemAudioPermissionFocusListener) {
      app.removeListener('browser-window-focus', systemAudioPermissionFocusListener);
      systemAudioPermissionFocusListener = null;
    }

    const focusListener = async () => {
      if (systemAudioPermissionFocusListener === focusListener) {
        systemAudioPermissionFocusListener = null;
      }
      app.removeListener('browser-window-focus', focusListener);
      
      if (!mainWindow) return;
      const hasSystemAudioPermission = await probePermission(
        'systemAudio',
        'focus-recheck',
        () => checkSystemAudioPermission({ activeProbe: true })
      );
      if (hasSystemAudioPermission === null) return;
      mainWindow.webContents.send('systemAudioPermission', { hasPermission: !!hasSystemAudioPermission, source: 'request' });
    };
    
    systemAudioPermissionFocusListener = focusListener;
    app.on('browser-window-focus', focusListener);
  });

  // Windows permission IPC is handled in captureWindows.js to centralize logic
}

/**
 * Collects all input data from the active capture modules without stopping tracking
 * @param {boolean} resetBuffers - Whether to reset data buffers after collection
 * @returns {Promise<Object>} The captured input data
 */
async function collectInputData(resetBuffers = true) {
  let inputData = {};
  let captureErrors = {
    screen: false,
    windows: false,
    microphone: false,
    systemAudio: false
  };
  
  // Get system idle time
  try {
    const idleTime = powerMonitor.getSystemIdleTime();
    inputData.idleTime = idleTime;
  } catch (error) {
    log.error('Error getting system idle time:', error);
    // Don't add to captureErrors as this is not a critical failure
  }
  
  // Get audio chunks (for cloud or local API transcription)
  if (inputDataSettings.audio) {
    try {
      const audioInfo = await audioCapture.stopRecording(resetBuffers);
      if (audioInfo && audioInfo.audioChunks && audioInfo.audioChunks.length > 0) {
        inputData.audioChunks = audioInfo.audioChunks;
      }
      resetFailureStreak('microphone');
      if (inputDataSettings.systemAudio) {
        resetFailureStreak('systemAudio');
      }
    } catch (error) {
      captureErrors.microphone = true;
      if (inputDataSettings.systemAudio) {
        captureErrors.systemAudio = true;
      }
      log.error('Error capturing audio chunks:', error);
    }
  }
  
  // Get window data
  let windowData = [];
  let hadWindowDataBeforeFiltering = false;
  if (inputDataSettings.windows) {
    try {
      // Reset timeline after collection
      let windowTimelineBuffer = windowsCapture.getTimelineBuffer(
        captureIntervalMinutes * 60 * 1000, 
        resetBuffers
      );
      
      // Filter out "Unknown Window" entries before checking if we had data
      windowTimelineBuffer = windowTimelineBuffer.filter(entry => {
        const appName = (entry.app || '').trim().toLowerCase();
        const title = (entry.title || '').trim().toLowerCase();
        const isUnknown = appName === 'unknown' && (title === 'unknown window' || title === 'error tracking window');
        return !isUnknown;
      });
      
      // Track if we had real window data before filtering (excluding Unknown entries)
      hadWindowDataBeforeFiltering = windowTimelineBuffer.length > 0;
      
      windowData = await windowsCapture.processTimelineData(windowTimelineBuffer);
      
      if (windowTimelineBuffer.length === 0 && windowsCapture.isTracking()) {
        log.warn('Window tracking is active but no data collected - possible issue with tracking');
        
        // Try to restart window tracking
        try {
          await windowsCapture.stopTracking();
          await windowsCapture.startTracking();
        } catch (restartError) {
          log.error('Failed to restart window tracking:', restartError);
        }
      }
      resetFailureStreak('windows');
    } catch (error) {
      captureErrors.windows = true;
      log.error('Error capturing window data:', error);
    }
  }
  
  // Process activity data
  inputData.activity = [];
  
  try {
    if (inputDataSettings.windows && windowData.length > 0) {
      windowData.forEach(window => {
        inputData.activity.push({
          type: 'window',
          name: window.name,
          title: window.title,
          startTime: window.startTime,
          endTime: window.endTime,
          duration: window.duration
        });
      });
    }
  } catch (error) {
    log.error('Error processing activity data:', error);
    if (inputDataSettings.windows) captureErrors.windows = true;
  }
  
  // Track if activity was filtered out completely (had data before but empty after)
  const noAllowedActivity = hadWindowDataBeforeFiltering && 
                           inputDataSettings.windows && 
                           (!inputData.activity || inputData.activity.length === 0);
  inputData.noAllowedActivity = noAllowedActivity;
  
  inputData.captureErrors = captureErrors;
  return inputData;
}

/**
 * Captures all input data and sends it to Firebase
 * @param {string} idToken The Firebase ID token
 * @param {Object} inputData Additional input data to send (audio, windows)
 * @returns {Promise<Object|boolean>} Response status
 */
async function _sendToServer(idToken, screenshots, inputData = {}, previousScreenshotData = null, clientTelemetry = null) {
  if (!idToken) {
    if (reauthenticateCallback) {
      log.warn('_sendToServer: Calling reauthenticate callback with authError (no token).'); // Keep specific warning
      reauthenticateCallback({ authError: true });
    }
    return { authError: true };
  }

  try {
    // Check if local processing is available
    const localProcessingAvailable = await isLocalProcessingAvailable();
    
    if (localProcessingAvailable) {
      try {
        const result = await processDataLocally(idToken, screenshots, { ...inputData, previousScreenshotData, clientTelemetry });
        return result;
      } catch (error) {
        // Handle local processing auth errors consistently with cloud path
        const isTokenExpired = error && error.code === 'TOKEN_EXPIRED';
        const isAuthError = error && (error.code === 'AUTH_ERROR' || error.status === 401 || error.status === 403);
        
        if (isTokenExpired) {
          if (reauthenticateCallback) {
            log.warn('_sendToServer(local): Calling reauthenticate callback with tokenExpired.');
            reauthenticateCallback({ tokenExpired: true });
          }
          return { tokenExpired: true };
        }
        
        if (isAuthError) {
          if (reauthenticateCallback) {
            log.warn('_sendToServer(local): Calling reauthenticate callback with authError.');
            reauthenticateCallback({ authError: true });
          }
          return { authError: true };
        }
        
        // Non-auth errors in local path: already notified inside processLocal
        // Just propagate
        throw error;
      }
    } else {
      const fetch = await import('node-fetch').then(module => module.default);
      
      const payload = {
        timestamp: Date.now(),
        screenshots: screenshots,
        previousScreenshotData: previousScreenshotData || null
      };
      if (clientTelemetry) {
        payload.clientTelemetry = clientTelemetry;
      }
      
      if (inputData) {
        if (inputData.audioChunks && inputData.audioChunks.length > 0) {
          payload.audioChunks = inputData.audioChunks;
        }
        if (inputData.idleTime !== undefined) {
          payload.idleTime = inputData.idleTime;
        }
        
        if (inputData.activity && inputData.activity.length > 0) {
          // Format all timestamps to local time in activity data
          payload.activity = inputData.activity.map(item => {
            // Create a new object without start/end times for the API
            const apiItem = {
              ...item,
              formattedDuration: `${Math.round(item.duration / 1000)}s`  // Duration in seconds
            };
            
            // Remove start/end times from the API payload
            delete apiItem.startTime;
            delete apiItem.endTime;
            delete apiItem.duration;
            
            return apiItem;
          });
        }
      }
      // Send data to Firebase
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      };

      const response = await fetch(FIREBASE_CAPTURE_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        // If response is not ok, check the detailed error
        const errorData = await response.json().catch(() => ({}));

        // Check specifically for token expiration
        if (response.status === 401 && errorData.error === 'token_expired') {
          if (reauthenticateCallback) {
            log.warn('_sendToServer: Calling reauthenticate callback with tokenExpired.');
            reauthenticateCallback({ tokenExpired: true });
          }
          return { tokenExpired: true };
        }
        
        // Log other error details
        log.error(`_sendToServer: Data upload failed with status ${response.status}`, errorData);

        // For unauthorized errors (not token expired), return auth error
        if (response.status === 401 || response.status === 403) {
          if (reauthenticateCallback) {
            log.warn('_sendToServer: Calling reauthenticate callback with authError.');
            reauthenticateCallback({ authError: true });
          }
          return { authError: true };
        }
        
        throw new Error(`Server error: ${response.status}`);
      }
      
      return true;
    }
  } catch (error) {
    log.error('_sendToServer: Error during data sending:', error.message, error.stack);
    console.error('Data upload failed:', error);
    return false;
  }
}

/**
 * Captures screenshots and sends them for processing
 * @param {string} idToken The Firebase ID token
 * @returns {Promise<Object|boolean>} Response status
 */
async function captureAndSend(idToken) {
  try {
    // Get previous screenshots BEFORE capturing new ones (they represent the ~5min-ago snapshot)
    const previousScreenshotData = getPreviousScreenshots(captureIntervalMinutes);

    const captureErrors = {
      screen: false,
      windows: false,
      microphone: false,
      systemAudio: false
    };

    // Capture screenshots only if enabled
    let screenshots = [];
    const screenshotPhaseStartedAt = Date.now();
    if (inputDataSettings.screen !== false) {
      try {
        screenshots = await captureScreenshot({ caller: 'periodic' });
        resetFailureStreak('screen');
      } catch (error) {
        captureErrors.screen = true;
        log.error('Error capturing screenshots:', error);
        screenshots = [];
      }
    }
    
    // Apply app exclusions if configured
    try {
      screenshots = await applyAppExclusions(screenshots);
    } catch (error) {
      // Non-critical: if masking fails, continue with unmasked screenshots
      log.warn('Error applying app exclusions to screenshots:', error);
    }

    const validScreenshots = screenshots.filter((shot) => isValidImageDataUrl(shot));
    if (validScreenshots.length !== screenshots.length) {
      log.warn(`[capture] Dropped ${screenshots.length - validScreenshots.length} invalid screenshot(s) before diff`);
    }
    screenshots = validScreenshots;

    // Save for next cycle's diff comparison (must be after exclusions, before bounding boxes)
    saveCurrentScreenshot(screenshots);

    // Apply image diff bounding boxes (compare with previous, draw red boxes on changes)
    try {
      screenshots = await applyImageDiffBoundingBoxes(screenshots, previousScreenshotData);
    } catch (error) {
      log.warn('Error applying image diff bounding boxes:', error);
    }
    recordCyclePhaseDuration('screenshot', Date.now() - screenshotPhaseStartedAt);

    if (!screenshots || screenshots.length === 0) {
        // No screenshots captured, continuing with other data
    }

    if (inputDataSettings.screen !== false && (!screenshots || screenshots.length === 0)) {
      try {
        const hasScreenPermission = await checkScreenCapturePermission('capture-cycle');
        if (hasScreenPermission === false) {
          captureErrors.screen = true;
        }
      } catch (_) {}
    }

    // Get input data while resetting buffers
    const inputCollectionStartedAt = Date.now();
    const inputData = await collectInputData(true);
    recordCyclePhaseDuration('input_collection', Date.now() - inputCollectionStartedAt);
    const moduleErrors = inputData.captureErrors || {};
    captureErrors.windows = !!moduleErrors.windows;
    captureErrors.microphone = !!moduleErrors.microphone;
    captureErrors.systemAudio = !!moduleErrors.systemAudio;


    // Check if any capture errors occurred
    if (captureErrors.screen || captureErrors.windows || captureErrors.microphone || captureErrors.systemAudio) {
      // Pass the specific errors to the handler
      handleCaptureError(new Error('Capture module error detected'), 'module-specific', captureErrors, false);
    }
    delete inputData.captureErrors; // Remove this property before sending
    
    // Remove internal-only flag before sending.
    // We still upload each cycle even when no activity is allowed.
    delete inputData.noAllowedActivity;

    // Check if we have any data to upload
    const hasScreenshots = screenshots && screenshots.length > 0;
    const hasAudioChunks = inputData && inputData.audioChunks && inputData.audioChunks.length > 0;
    const hasActivity = inputData && inputData.activity && inputData.activity.length > 0;
    const hasAnyPayloadData = !!(hasScreenshots || hasAudioChunks || hasActivity);
    if (!hasAnyPayloadData) {
      log.debug('[capture] Uploading empty capture payload (no screenshots/audio/activity this cycle)');
    }
    
    const timestamp = Date.now()
    let dumpDir = null
    const localProcessingAvailable = await isLocalProcessingAvailable()
    const pathType = localProcessingAvailable ? 'local' : 'cloud'
    const scaledPreviousScreenshotData = previousScreenshotData?.images?.length
      ? {
          timestamp: previousScreenshotData.timestamp,
          images: previousScreenshotData.images.map((img) => {
            const dataUrl = img?.base64Data ?? img
            if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return { ...img }
            try {
              return { ...img, base64Data: scaleScreenshotToPreviousSize(dataUrl) }
            } catch {
              return { ...img }
            }
          })
        }
      : previousScreenshotData
    const previousForUpload = hasScreenshots ? scaledPreviousScreenshotData : null
    try {
      dumpDir = await saveCaptureDump(
        screenshots,
        inputData,
        timestamp,
        pathType,
        previousForUpload,
        !hasAnyPayloadData
      )
    } catch (e) {
      log.warn('[capture] Capture dump save failed:', e?.message)
    }

    const sendStartedAt = Date.now();
    const sendResult = await _sendToServer(idToken, screenshots, inputData, previousForUpload, null)
    recordCyclePhaseDuration('send', Date.now() - sendStartedAt);

    return {
      sendResult,
      dumpDir
    }
  } catch (error) {
    // Handle errors specifically from captureScreenshot or collectInputData
    handleCaptureError(error, 'unknown', null, false);
    return false;
  }
}

// Helper function to handle errors during capture interval
function handleCaptureError(error, context, captureErrors = null, stopCapture = true) {
  log.error(`handleCaptureError: Error details (Context: ${context}):`, error); // Keep error log
  
  // Only stop the capture interval if requested
  if (stopCapture) {
    stopCaptureInterval();
  }

  const runtimeIssues = {};
  let dialogOptions = null;
  
  // Map of feature types to their friendly names
  const featureNames = {
    screen: 'Screenshare capture',
    windows: 'Window tracking',
    microphone: 'Microphone capture',
    systemAudio: 'System audio capture'
  };
  
  if (captureErrors) {
    let shouldNotifyRenderer = false;
    // Track persistent runtime issues without mutating user settings
    Object.keys(captureErrors).forEach(feature => {
      if (captureErrors[feature] && featureNames[feature]) {
        const streak = incrementFailureStreak(feature);
        const threshold = RUNTIME_ISSUE_THRESHOLDS[feature] || 4;

        if (streak >= threshold) {
          runtimeIssues[feature] = {
            status: 'degraded',
            threshold,
            streak
          };
          resetFailureStreak(feature);
          shouldNotifyRenderer = true;

          // If context matches this feature, set dialog options
          if (context.includes(feature)) {
            const isPermissionError = context.includes('permission');

            dialogOptions = {
              type: 'warning',
              title: isPermissionError ? 'Permission Denied' : 'Capture Error',
              message: `${featureNames[feature]} ${isPermissionError ? 'permission denied' : 'failed'}`,
              detail: `${featureNames[feature]} is currently unavailable after repeated failures. ${
                isPermissionError
                  ? `Check ${
                    feature === 'screen'
                      ? 'screen recording'
                      : (feature === 'windows'
                        ? 'accessibility'
                        : (feature === 'microphone'
                          ? 'microphone'
                          : 'system audio'))
                  } permissions in system settings.`
                  : `Error: ${error.message}`
              }`
            };
          }
        } else {
          log.warn(`[capture] ${feature} failure ${streak}/${threshold}; keeping toggle enabled`);
        }
      }
    });

    if (!shouldNotifyRenderer) {
      return;
    }
  } else {
    // Unknown source: keep user toggles unchanged and retry next cycle.
    log.warn('Unknown capture error source - preserving capture settings');
    dialogOptions = {
      type: 'warning',
      title: 'Capture Error',
      message: 'Capture issue detected',
      detail: 'Capture will retry automatically. Error: ' + error.message
    };
  }
  
  // Notify renderer to flag potential permission issues inferred from repeated failures.
  if (mainWindowRef) {
    try { mainWindowRef.webContents.send('flag-permission-issues', { runtimeIssues }); } catch (e) {}
  } else {
    log.warn('mainWindowRef is not available, cannot send flag-permission-issues event.');
  }
  
  // Suppress system dialogs for permission-denied cases to avoid alert noise during revocation
  if (dialogOptions && mainWindowRef) {
    const isPermissionCase = /permission denied/i.test(dialogOptions.message || '')
    if (!isPermissionCase) {
      const { dialog } = require('electron');
      dialog.showMessageBox(mainWindowRef, dialogOptions);
    }
  }
}

async function maybeCleanupWindowCache() {
  if (!inputDataSettings.windows) {
    return;
  }

  const now = Date.now();
  if ((now - lastWindowCacheCleanupAt) < WINDOW_CACHE_CLEANUP_INTERVAL_MS) {
    return;
  }

  lastWindowCacheCleanupAt = now;
  try {
    await windowsCapture.getAllVisibleWindows();
  } catch (error) {
    log.warn('[windows] Periodic cache cleanup failed:', error?.message || error);
  }
}

// Internal function to run a single capture cycle
async function _runCaptureCycle() {
  if (captureCycleInFlight) {
    log.warn('_runCaptureCycle: Previous cycle still running; skipping overlap.');
    recordCaptureCycleSkippedOverlap();
    return;
  }

  captureCycleInFlight = true;
  beginCycle({ captureIntervalMin: captureIntervalMinutes });
  let cycleStatus = 'success';
  let cycleAuthError = false;
  let cycleTokenExpired = false;
  let cycleCaptureResult = null;
  try {
    // Fetch the current token *inside* the cycle
    const currentIdToken = getIdTokenFunction ? getIdTokenFunction() : null;

    // Check if token exists before proceeding
    if (!currentIdToken) {
      log.warn('_runCaptureCycle: No ID token available. Skipping capture cycle.');
      // Optionally, trigger re-authentication or stop interval if needed
      // For now, just skip this cycle
      // Re-evaluate if stopping is better - currently relies on _sendToServer detecting lack of token
      if (reauthenticateCallback) {
        reauthenticateCallback({ authError: true }); // Signal general auth error if no token
      }
      cycleStatus = 'auth_error';
      cycleAuthError = true;
      return; // Exit the cycle
    }

    // Start audio capture if needed
    if (inputDataSettings.audio && !audioCapture.getStatus().tracking) {
      await _startAudioTracking();
    }
    
    // Start window tracking if needed
    if (inputDataSettings.windows && !windowsCapture.isTracking()) {
      await _startWindowTracking();
    }

    // Capture and send data, passing the fetched token
    cycleCaptureResult = await captureAndSend(currentIdToken); // Pass currentIdToken
    const sendResult = cycleCaptureResult && Object.prototype.hasOwnProperty.call(cycleCaptureResult, 'sendResult')
      ? cycleCaptureResult.sendResult
      : cycleCaptureResult
    if (sendResult && typeof sendResult === 'object') {
      if (sendResult.authError) {
        cycleStatus = 'auth_error';
        cycleAuthError = true;
      } else if (sendResult.tokenExpired) {
        cycleStatus = 'token_expired';
        cycleTokenExpired = true;
      } else if (sendResult.success === false) {
        cycleStatus = 'send_failed';
      }
    } else if (sendResult === false) {
      cycleStatus = 'send_failed';
    }
    await maybeCleanupWindowCache();
  } catch (error) {
    // Handle errors from captureAndSend or other cycle errors
    log.error('Error during capture cycle:', error);
    handleCaptureError(error, 'capture-cycle', null, false); 
    cycleStatus = 'error';
  } finally {
    const cycleTelemetry = endCycle({
      status: cycleStatus,
      authError: cycleAuthError,
      tokenExpired: cycleTokenExpired
    });
    if (cycleCaptureResult?.dumpDir && (cycleCaptureResult?.sendResult?.structured || cycleCaptureResult?.sendResult?.parameters || cycleTelemetry)) {
      try {
        appendCaptureDump(cycleCaptureResult.dumpDir, cycleCaptureResult?.sendResult?.structured, cycleCaptureResult?.sendResult?.parameters, cycleTelemetry)
      } catch (e) {
        log.warn('Capture dump append failed:', e?.message)
      }
    }
    captureCycleInFlight = false;
  }
}

/**
 * Starts the capture interval
 * @returns {number} The interval ID
 */
function startCaptureInterval() {
  // Token is now fetched inside _runCaptureCycle
  // Clear existing interval and stop tracking
  stopCaptureInterval(); // Ensure clean state
  captureCycleInFlight = false;
  lastWindowCacheCleanupAt = 0;
  
  // Reset window start retry state on fresh interval start
  if (windowStartRetryTimer) {
    clearTimeout(windowStartRetryTimer);
    windowStartRetryTimer = null;
  }
  windowStartRetryCount = 0;

  // Start window tracking immediately if enabled (don't wait for first capture cycle)
  // This is needed for app exclusions to work immediately
  if (inputDataSettings.windows && !windowsCapture.isTracking()) {
    _startWindowTracking();
  }

  // Wait 1 minute before first capture
  initialCaptureDelayTimer = setTimeout(() => {
    initialCaptureDelayTimer = null;
    _runCaptureCycle().catch(error => {
      log.error('Error during initial capture cycle run:', error);
      // handleCaptureError is called within _runCaptureCycle
    });
  }, 60000);

  // Set up interval for subsequent cycles
  screenshotInterval = setInterval(() => {
    _runCaptureCycle().catch(error => {
      log.error('startCaptureInterval: Error during scheduled _runCaptureCycle execution:', error);
       // handleCaptureError should be called within _runCaptureCycle itself
    });
  }, captureIntervalMinutes * 60 * 1000);
  
  return screenshotInterval;
}

/**
 * Stops the capture interval and all tracking completely.
 * This is the MAIN function to call when you want to fully stop all capturing activities.
 */
function stopCaptureInterval() {  
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }
  // Cancel initial capture delay
  if (initialCaptureDelayTimer) {
    clearTimeout(initialCaptureDelayTimer);
    initialCaptureDelayTimer = null;
  }
  // Cancel any pending window-tracking start retries
  if (windowStartRetryTimer) {
    clearTimeout(windowStartRetryTimer);
    windowStartRetryTimer = null;
  }
  windowStartRetryCount = 0;
  captureCycleInFlight = false;
  
  // Stop ongoing captures
  if (inputDataSettings.audio) {
    audioCapture.shutdownRecording().catch(error => {
      log.error('Error shutting down audio recording:', error);
    });
  }
  
  if (inputDataSettings.windows) {
    windowsCapture.stopTracking();
  }
}

/**
 * Checks if capture interval is currently active
 * @returns {boolean} True if capturing is active
 */
function isCapturing() {
  const isActive = screenshotInterval !== null;
  return isActive;
}

module.exports = {
  captureAndSend,
  startCaptureInterval,
  stopCaptureInterval,
  isCapturing,
  setCaptureInterval,
  initCapture,

  collectInputData
}; 
