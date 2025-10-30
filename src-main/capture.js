const log = require('electron-log');
const { captureScreenshot, getPreviousScreenshots } = require('./captureScreenshots');
const { ipcMain, powerMonitor } = require('electron');
const { isLocalProcessingAvailable, processDataLocally } = require('./processLocal');

// Firebase URL constant
const FIREBASE_CAPTURE_URL = 'https://europe-west1-donethat.cloudfunctions.net/captureScreenshot';

// Import capture modules
const audioCapture = require('./captureAudio');
const keystrokesCapture = require('./captureKeystrokes');
const windowsCapture = require('./captureWindows');

// Variable to track the capture interval
let screenshotInterval = null;
let captureIntervalMinutes; // Set in main
let reauthenticateCallback = null; // Store reauthenticate callback function
let mainWindowRef = null; // Store mainWindow reference
let getIdTokenFunction = null; // Store the getIdToken function reference


// Track input data settings
let inputDataSettings = {
  audio: false,
  keystrokes: false,
  windows: false
};

// Window tracking startup retry state (to avoid disabling on transient failures)
let windowStartRetryCount = 0;
const WINDOW_START_MAX_RETRIES = 5;
let windowStartRetryTimer = null;

// Track disable screenshots in meetings setting
let disableScreenshotsInMeetings = false;

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
        'audio', 
        { audio: true },
        false // Don't stop capturing, just disable this feature
      );
      return false;
    }
    
    // Start audio tracking with session detection (this will check permission once)
    const success = await audioCapture.startAudioTracking({
      bufferDurationMs: captureIntervalMinutes * 60 * 1000
    });
    
    if (!success) {
      handleCaptureError(
        new Error('Microphone permission not granted'),
        'audio-permission',
        { audio: true },
        false
      );
      return false;
    }
    
    return true;
    
  } catch (error) {
    log.error('Error starting audio tracking:', error);
    
    // Use handleCaptureError with specific audio error
    handleCaptureError(
      error, 
      'audio-error', 
      { audio: true },
      false // Don't stop capturing, just disable this feature
    );
    
    return false;
  }
}

/**
 * Helper function to start keystroke tracking
 * @returns {Promise<boolean>} Success status
 */
async function _startKeystrokeTracking() {
  try {
    const trackingStarted = await keystrokesCapture.startTracking();
    if (!trackingStarted) {
      const error = new Error('Keystroke tracking permission denied or failed to start');
      log.warn(error.message);
      
      // Use handleCaptureError with specific keystrokes error
      handleCaptureError(
        error, 
        'keystrokes-permission', 
        { keystrokes: true },
        false // Don't stop capturing, just disable this feature
      );
      
      return false;
    }
    
    return true;
  } catch (error) {
    log.error('Failed to start keystroke tracking:', error);
    
    // Use handleCaptureError with specific keystrokes error
    handleCaptureError(
      error, 
      'keystrokes-error', 
      { keystrokes: true },
      false // Don't stop capturing, just disable this feature
    );
    
    return false;
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
    return true;
  } catch (error) {
    log.error('Failed to start window tracking:', error);
    
    // Use handleCaptureError with specific windows error
    handleCaptureError(
      error, 
      'windows-error', 
      { windows: true },
      false // Don't stop capturing, just disable this feature
    );
    
    return false;
  }
}

/**
 * Updates input data settings
 * @param {Object} settings Settings with audio, keystrokes, windows flags
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
      ...(settings.keystrokes !== undefined ? { keystrokes: !!settings.keystrokes } : {}),
      ...(settings.windows !== undefined ? { windows: !!settings.windows } : {})
    };
    
    // Stop tracking for disabled options
    if (previousSettings.audio && !inputDataSettings.audio) {
      audioCapture.shutdownRecording().catch(error => {
        log.error('Error shutting down audio recording:', error);
      });
    }
    
    if (previousSettings.keystrokes && !inputDataSettings.keystrokes) {
      keystrokesCapture.stopTracking();
    }
    
    if (previousSettings.windows && !inputDataSettings.windows) {
      windowsCapture.stopTracking();
    }
    
    // Start tracking for newly enabled options
    if(isCapturing()) {
      if (!previousSettings.audio && inputDataSettings.audio) {
        _startAudioTracking();
      }
      
      if (!previousSettings.keystrokes && inputDataSettings.keystrokes) {
        _startKeystrokeTracking();
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
  
    settingsInitialized = true;
  }
  return inputDataSettings;
}

/**
 * Updates the disable screenshots in meetings setting
 * @param {boolean} enabled Whether to disable screenshots during meetings
 */
function updateDisableScreenshotsInMeetings(enabled) {
  disableScreenshotsInMeetings = !!enabled;
}

/**
 * Check if screenshots should be disabled during meetings
 * @returns {boolean} True if screenshots should be disabled
 */
function shouldDisableScreenshotsInMeetings() {
  // First check if user has the setting enabled
  if (!disableScreenshotsInMeetings) {
    return false;
  }
  
  // Only check audio state if the setting is enabled
  const audioCapture = require('./captureAudio');
  const audioStatus = audioCapture.getStatus();
  return audioStatus.recording;
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
  
  // Initialize keystrokes capture with main window
  keystrokesCapture.initialize(mainWindow);
  
  // Handler for updating input data settings
  ipcMain.on('updateInputDataSettings', (event, settings) => {
    updateInputDataSettings(settings);
  });

  // Pause capture interval temporarily due to permission events
  ipcMain.on('pause-capture-due-to-permission', (event, payload) => {
    try {
      const ms = Math.max(0, Math.min(60000, (payload && payload.ms) || 10000));
      stopCaptureInterval();
      setTimeout(() => {
        // Only resume if user still has capturing enabled (safety: windows may be off now)
        try {
          if (!screenshotInterval) {
            // Resume interval; feature flags will prevent window tracking if disabled
            startCaptureInterval();
          }
        } catch (_) {}
      }, ms);
    } catch (e) {}
  });

  // Handler for updating disable screenshots in meetings setting
  ipcMain.on('updateDisableScreenshotsInMeetings', (event, enabled) => {
    updateDisableScreenshotsInMeetings(enabled);
  });

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
  ipcMain.on('requestAudioPermission', async (event) => {
    const { shell } = require('electron');
    const { checkPermission } = require('./captureAudio');
    
    const hasPermission = await checkPermission();
    
    if (hasPermission) {
      if (mainWindow) {
        mainWindow.webContents.send('audioPermission', true);
      }
      return;
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
    }
    
    // Check permission on focus
    const app = require('electron').app;
    const focusListener = async () => {
      app.removeListener('browser-window-focus', focusListener);
      
      const newHasPermission = await checkPermission();
      
      if (mainWindow) {
        mainWindow.webContents.send('audioPermission', newHasPermission);
      }
    };
    
    app.on('browser-window-focus', focusListener);
  });

  ipcMain.on('requestKeystrokesPermission', async (event) => {
    const { shell } = require('electron');
    const { checkPermissions } = require('./captureKeystrokes');
    
    const hasPermission = await checkPermissions();
    
    if (hasPermission) {
      if (mainWindow) {
        mainWindow.webContents.send('keystrokesPermission', true);
      }
      return;
    }
    
    // Open system settings based on platform
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    } else if (process.platform === 'win32') {
      shell.openExternal('ms-settings:privacy');
    } else if (process.platform === 'linux') {
      if (mainWindow) {
        mainWindow.webContents.send('linux-keystrokes-permission-notice');
      }
    }
    
    // Check permission on focus
    const app = require('electron').app;
    const focusListener = async () => {
      app.removeListener('browser-window-focus', focusListener);
      
      const newHasPermission = await checkPermissions();
      
      if (mainWindow) {
        mainWindow.webContents.send('keystrokesPermission', newHasPermission);
      }
    };
    
    app.on('browser-window-focus', focusListener);
  });

  // Windows permission IPC is handled in captureWindows.js to centralize logic
}

/**
 * Process keystroke data into segments
 * @param {Array} keystrokeData Array of keystroke events
 * @returns {Array} Processed keystroke segments
 */
function processKeystrokeSegments(keystrokeData) {
  const segments = [];
  let processedKeystrokes = '';
  let lastTimestamp = 0;
  let currentSegmentStart = 0;
  
  // Sort by timestamp
  const sortedKeystrokes = [...keystrokeData].sort((a, b) => {
    const aTime = typeof a.timestamp === 'string' ? new Date(a.timestamp).getTime() : a.timestamp;
    const bTime = typeof b.timestamp === 'string' ? new Date(b.timestamp).getTime() : b.timestamp;
    return aTime - bTime;
  });
  
  if (sortedKeystrokes.length === 0) {
    return segments;
  }
  
  // Set initial segment start time
  const firstTime = typeof sortedKeystrokes[0].timestamp === 'string' 
    ? new Date(sortedKeystrokes[0].timestamp).getTime() 
    : sortedKeystrokes[0].timestamp;
  currentSegmentStart = firstTime;
  
  // Process keystroke segments with gaps > 5 seconds
  for (let i = 0; i < sortedKeystrokes.length; i++) {
    const ks = sortedKeystrokes[i];
    const ksTime = typeof ks.timestamp === 'string' 
      ? new Date(ks.timestamp).getTime() 
      : ks.timestamp;
    
    // Start a new segment if there's a significant gap
    if (lastTimestamp === 0 || (ksTime - lastTimestamp > 5000)) {
      if (lastTimestamp > 0 && processedKeystrokes.length > 0) {
        // Add the completed segment
        segments.push({
          type: 'keystrokes',
          startTime: currentSegmentStart,
          endTime: lastTimestamp,
          duration: lastTimestamp - currentSegmentStart,
          keystrokes: processedKeystrokes
        });
        
        // Reset for new segment
        processedKeystrokes = '';
        currentSegmentStart = ksTime;
      }
    }
    
    // Add the key to the current segment
    processedKeystrokes += ks.key;
    lastTimestamp = ksTime;
  }
  
  // Add the final segment if there's data
  if (processedKeystrokes.length > 0) {
    segments.push({
      type: 'keystrokes',
      startTime: currentSegmentStart,
      endTime: lastTimestamp,
      duration: lastTimestamp - currentSegmentStart,
      keystrokes: processedKeystrokes
    });
  }
  
  return segments;
}

/**
 * Collects all input data from the active capture modules without stopping tracking
 * @param {boolean} resetBuffers - Whether to reset data buffers after collection
 * @returns {Promise<Object>} The captured input data
 */
async function collectInputData(resetBuffers = true) {
  let inputData = {};
  let captureErrors = {
    audio: false,
    keystrokes: false,
    windows: false
  };
  
  // Get system idle time
  try {
    const idleTime = powerMonitor.getSystemIdleTime();
    inputData.idleTime = idleTime;
  } catch (error) {
    log.error('Error getting system idle time:', error);
    // Don't add to captureErrors as this is not a critical failure
  }
  
  // Get audio transcript
  if (inputDataSettings.audio) {
    try {
      const audioInfo = await audioCapture.stopRecording();
      if (audioInfo && audioInfo.transcript) {
        inputData.audioTranscript = audioInfo.transcript;
      }
    } catch (error) {
      captureErrors.audio = true;
      log.error('Error capturing audio transcript:', error);
    }
  }
  
  // Get keystroke and window data
  let keystrokeData = [];
  let windowData = [];
  
  // Get keystroke data
  if (inputDataSettings.keystrokes) {
    try {
      // Reset timeline after collection
      keystrokeData = keystrokesCapture.getKeystrokeTimeline(
        captureIntervalMinutes * 60 * 1000, 
        resetBuffers 
      );
      
      if (keystrokeData.length === 0 && keystrokesCapture.isTracking()) {        
        // Try to restart keystroke tracking
        try {
          await keystrokesCapture.stopTracking();
          await keystrokesCapture.startTracking();
        } catch (restartError) {
          log.error('Failed to restart keystroke tracking:', restartError);
        }
      }
    } catch (error) {
      captureErrors.keystrokes = true;
      log.error('Error capturing keystroke data:', error);
    }
  }
  
  // Get window data
  if (inputDataSettings.windows) {
    try {
      // Reset timeline after collection
      const windowTimelineBuffer = windowsCapture.getTimelineBuffer(
        captureIntervalMinutes * 60 * 1000, 
        resetBuffers
      );
      
      windowData = windowsCapture.processTimelineData(windowTimelineBuffer);
      
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
    } catch (error) {
      captureErrors.windows = true;
      log.error('Error capturing window data:', error);
    }
  }
  
  // Process activity data
  inputData.activity = [];
  
  try {
    if (inputDataSettings.keystrokes && keystrokeData.length > 0) {
      if (inputDataSettings.windows && windowData.length > 0) {
        // Attach keystrokes to window periods
        windowData.forEach(windowPeriod => {
          const windowKeystrokes = keystrokeData.filter(ks => {
            if (!ks.timestamp) return false;
            const ksTime = typeof ks.timestamp === 'string' 
              ? new Date(ks.timestamp).getTime() 
              : ks.timestamp;
            return ksTime >= windowPeriod.startTime && ksTime <= windowPeriod.endTime;
          });
          
          const keystrokeString = windowKeystrokes
            .map(ks => ks.key)
            .join('');
          
          inputData.activity.push({
            type: 'window',
            name: windowPeriod.name,
            title: windowPeriod.title,
            startTime: windowPeriod.startTime,
            endTime: windowPeriod.endTime,
            duration: windowPeriod.duration,
            keystrokes: keystrokeString
          });
        });
      } else {
        // Process keystrokes into segments
        const keystrokeSegments = processKeystrokeSegments(keystrokeData);
        inputData.activity = inputData.activity.concat(keystrokeSegments);
      }
    } else if (inputDataSettings.windows && windowData.length > 0) {
      // Just include window data
      windowData.forEach(window => {
        inputData.activity.push({
          type: 'window',
          name: window.name,
          title: window.title,
          startTime: window.startTime,
          endTime: window.endTime,
          duration: window.duration,
          keystrokes: ''
        });
      });
    }
  } catch (error) {
    log.error('Error processing activity data:', error);
    if (inputDataSettings.keystrokes) captureErrors.keystrokes = true;
    if (inputDataSettings.windows) captureErrors.windows = true;
  }
  
  inputData.captureErrors = captureErrors;
  return inputData;
}

/**
 * Captures all input data and sends it to Firebase
 * @param {string} idToken The Firebase ID token
 * @param {Object} inputData Additional input data to send (audio, keystrokes, windows)
 * @returns {Promise<Object|boolean>} Response status
 */
async function _sendToServer(idToken, screenshots, inputData = {}) {
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
      // Get the previous screenshots scaled down to the configured scale factor
      const previousScreenshotData = getPreviousScreenshots(captureIntervalMinutes);
      
      // Process data locally
      try {
        const result = await processDataLocally(
          idToken,
          screenshots,
          previousScreenshotData,
          inputData
        );
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
        
        // Non-auth errors: notify user and let outer flow handle failure
        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
          mainWindowRef.webContents.send('inapp:notify', {
            id: 'local-processing-error',
            title: 'Local processing error',
            message: (error && error.message) ? error.message : 'Unknown error',
            sticky: false
          });
        }
        // Re-throw for outer catch to handle (logging/return false)
        throw error;
      }
    } else {      
      // Fall back to cloud processing
      const fetch = await import('node-fetch').then(module => module.default);
      
      // Get the previous screenshots scaled down to the configured scale factor
      const previousScreenshotData = getPreviousScreenshots(captureIntervalMinutes);
      
      // Create payload with screenshots and timestamp
      const payload = {
        timestamp: Date.now(),
        screenshots: screenshots
      };
      
      // Add previous screenshot data if available
      if (previousScreenshotData) {
        payload.previousScreenshotData = previousScreenshotData;
      }
      
      // Add input data if provided
      if (inputData) {
        if (inputData.audioTranscript) {
          payload.audioTranscript = inputData.audioTranscript;
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
 * Captures all enabled data types and sends them to the server
 * @param {string} idToken The Firebase ID token
 * @returns {Promise<Object|boolean>} Response status
 */
async function captureAndSend(idToken) {
  try {
    // Check if screenshots should be disabled during meetings
    let screenshots = [];
    if (!shouldDisableScreenshotsInMeetings()) {
      // Capture screenshots
      screenshots = await captureScreenshot();
    }

    if (!screenshots || screenshots.length === 0) {
        // No screenshots captured, continuing with other data
    }

    // Get input data while resetting buffers
    const inputData = await collectInputData(true);

    // Check if any capture errors occurred
    const captureErrors = inputData.captureErrors;
    if (captureErrors && (captureErrors.audio || captureErrors.keystrokes || captureErrors.windows)) {
      // Pass the specific errors to the handler
      handleCaptureError(new Error('Capture module error detected'), 'module-specific', captureErrors);
      delete inputData.captureErrors; // Remove this property before sending
    }
    
    // Check if we have any data to upload
    const hasScreenshots = screenshots && screenshots.length > 0;
    const hasAudioTranscript = inputData && inputData.audioTranscript;
    const hasActivity = inputData && inputData.activity && inputData.activity.length > 0;
    
    if (!hasScreenshots && !hasAudioTranscript && !hasActivity) {
      return false;
    }
    
    // Send all collected data to the server
  const sendResult = await _sendToServer(idToken, screenshots, inputData);
    return sendResult;
  } catch (error) {
    // Handle errors specifically from captureScreenshot or collectInputData
    handleCaptureError(error, 'unknown');
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

  let updatedSettings = { ...inputDataSettings };
  let dialogOptions = null;
  
  // Map of feature types to their friendly names
  const featureNames = {
    audio: 'Audio recording',
    keystrokes: 'Keystroke tracking',
    windows: 'Window tracking'
  };
  
  if (captureErrors) {
    // Check which features need to be disabled
    Object.keys(captureErrors).forEach(feature => {
      if (captureErrors[feature] && featureNames[feature]) {
        // Disable the feature
        updatedSettings[feature] = false;
        
        // If context matches this feature, set dialog options
        if (context.includes(feature)) {
          const isPermissionError = context.includes('permission');
          
          dialogOptions = {
            type: 'warning',
            title: isPermissionError ? 'Permission Denied' : 'Capture Error',
            message: `${featureNames[feature]} ${isPermissionError ? 'permission denied' : 'failed'}`,
            detail: `${featureNames[feature]} has been disabled. ${
              isPermissionError 
                ? `Check ${feature === 'audio' ? 'microphone' : 'accessibility'} permissions in system settings.`
                : `Error: ${error.message}`
            }`
          };
        }
      }
    });
  } else {
    // Unknown source, disable all
    log.warn('Unknown capture error source - disabling all capture features');
    updatedSettings = {
      audio: false,
      keystrokes: false,
      windows: false
    };
    
    // Generic error dialog
    dialogOptions = {
      type: 'warning',
      title: 'Capture Error',
      message: 'Capture features disabled',
      detail: 'All capture features have been disabled due to an error: ' + error.message
    };
  }
  
  // Update settings
  inputDataSettings = updatedSettings;

  // Notify renderer (non-blocking; avoid repeated alert dialogs by not showing dialog here)
  if (mainWindowRef) {
    try { mainWindowRef.webContents.send('disable-capture-features', updatedSettings); } catch (e) {}
  } else {
    log.warn('mainWindowRef is not available, cannot send disable-capture-features event.');
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

// Internal function to run a single capture cycle
async function _runCaptureCycle() {
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
      return; // Exit the cycle
  }

  try {
    // Start audio capture if needed
    if (inputDataSettings.audio && !audioCapture.getStatus().recording) {
      await _startAudioTracking();
    }
    
    // Start keystroke tracking if needed
    if (inputDataSettings.keystrokes && !keystrokesCapture.isTracking()) {
      await _startKeystrokeTracking();
    }
    
    // Start window tracking if needed
    if (inputDataSettings.windows && !windowsCapture.isTracking()) {
      await _startWindowTracking();
    }

    // Capture and send data, passing the fetched token
    const result = await captureAndSend(currentIdToken); // Pass currentIdToken

  } catch (error) {
    // Handle errors from captureAndSend or other cycle errors
    log.error('Error during capture cycle:', error);
    handleCaptureError(error, 'capture-cycle'); 
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
  
  // Reset window start retry state on fresh interval start
  if (windowStartRetryTimer) {
    clearTimeout(windowStartRetryTimer);
    windowStartRetryTimer = null;
  }
  windowStartRetryCount = 0;

  // Run first cycle immediately
  _runCaptureCycle().catch(error => {
    log.error('Error during initial capture cycle run:', error);
    // handleCaptureError is called within _runCaptureCycle
  });

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
  // Cancel any pending window-tracking start retries
  if (windowStartRetryTimer) {
    clearTimeout(windowStartRetryTimer);
    windowStartRetryTimer = null;
  }
  windowStartRetryCount = 0;
  
  // Stop ongoing captures
  if (inputDataSettings.audio) {
    audioCapture.shutdownRecording().catch(error => {
      log.error('Error shutting down audio recording:', error);
    });
  }
  
  if (inputDataSettings.keystrokes) {
    keystrokesCapture.stopTracking();
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
  shouldDisableScreenshotsInMeetings
}; 