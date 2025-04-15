const log = require('electron-log');
const { captureScreenshot } = require('./captureScreenshots');
const { ipcMain } = require('electron');

// Firebase URL constant
const FIREBASE_CAPTURE_URL = 'https://europe-west1-donethat.cloudfunctions.net/captureScreenshot';

// Import capture modules
const audioCapture = require('./captureAudio');
const keystrokesCapture = require('./captureKeystrokes');
const windowsCapture = require('./captureWindows');

// Variable to track the capture interval
let screenshotInterval = null;
let captureIntervalMinutes = 5; // Default interval
let reauthenticateCallback = null; // Store reauthenticate callback function

// Track input data settings
let inputDataSettings = {
  audio: false,
  keystrokes: false,
  windows: false
};

/**
 * Sets the interval for captures in minutes
 * @param {number} minutes The interval in minutes
 */
function setCaptureInterval(minutes) {
  captureIntervalMinutes = minutes;
  return captureIntervalMinutes;
}

/**
 * Updates input data settings
 * @param {Object} settings Settings object with audio, keystrokes, windows flags
 * @returns {Object} Updated settings
 */
function updateInputDataSettings(settings) {
  if (settings && typeof settings === 'object') {
    inputDataSettings = {
      audio: !!settings.audio,
      keystrokes: !!settings.keystrokes,
      windows: !!settings.windows
    };
  }
  return inputDataSettings;
}

/**
 * Initializes capture functionality and registers all IPC handlers
 * @param {BrowserWindow} mainWindow Reference to the main window for sending IPC messages
 * @param {Function} onAuthError Callback for when authentication errors are detected
 *                               Called with either {authError: true} for general auth failures
 *                               or {tokenExpired: true} for token expiration
 */
function initCapture(mainWindow, onAuthError) {
  // Store the reauthenticate callback
  reauthenticateCallback = onAuthError;
  
  // Handler for updating input data settings
  ipcMain.on('updateInputDataSettings', (event, settings) => {
    updateInputDataSettings(settings);
  });

  // Add other capture-related IPC handlers here as needed
  ipcMain.on('requestAudioPermission', async (event) => {
    const { shell } = require('electron');
    const { checkPermission } = require('./captureAudio');
    
    // First check if we already have permission
    const hasPermission = await checkPermission();
    
    if (hasPermission) {
      // Already have permission, inform renderer
      if (mainWindow) {
        mainWindow.webContents.send('audioPermission', true);
      }
      return;
    }
    
    // Open relevant system settings based on platform
    if (process.platform === 'darwin') {
      // macOS - Open microphone privacy settings
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    } else if (process.platform === 'win32') {
      // Windows - Open microphone privacy settings
      shell.openExternal('ms-settings:privacy-microphone');
    } else if (process.platform === 'linux') {
      // Linux - No standard way to open settings, notify user to check manually
      if (mainWindow) {
        mainWindow.webContents.send('linux-audio-permission-notice');
      }
    }
    
    // After opening settings, check permission again when app regains focus
    const app = require('electron').app;
    const focusListener = async () => {
      // Remove listener immediately to prevent multiple triggers
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
    const { checkPermission } = require('./captureKeystrokes');
    
    // First check if we already have permission
    const hasPermission = await checkPermission();
    
    if (hasPermission) {
      // Already have permission, inform renderer
      if (mainWindow) {
        mainWindow.webContents.send('keystrokesPermission', true);
      }
      return;
    }
    
    // Open relevant system settings based on platform
    if (process.platform === 'darwin') {
      // macOS - Open accessibility privacy settings
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    } else if (process.platform === 'win32') {
      // Windows - No direct settings for keyboard access, open general privacy
      shell.openExternal('ms-settings:privacy');
    } else if (process.platform === 'linux') {
      // Linux - No standard way to open settings
      if (mainWindow) {
        mainWindow.webContents.send('linux-keystrokes-permission-notice');
      }
    }
    
    // After opening settings, check permission again when app regains focus
    const app = require('electron').app;
    const focusListener = async () => {
      // Remove listener immediately to prevent multiple triggers
      app.removeListener('browser-window-focus', focusListener);
      
      const newHasPermission = await checkPermission();
      
      if (mainWindow) {
        mainWindow.webContents.send('keystrokesPermission', newHasPermission);
      }
    };
    
    app.on('browser-window-focus', focusListener);
  });

  ipcMain.on('requestWindowsPermission', async (event) => {
    const { shell } = require('electron');
    const { checkPermission } = require('./captureWindows');
    
    // First check if we already have permission
    const hasPermission = await checkPermission();
    
    if (hasPermission) {
      // Already have permission, inform renderer
      if (mainWindow) {
        mainWindow.webContents.send('windowsPermission', true);
      }
      return;
    }
    
    // Open relevant system settings based on platform
    if (process.platform === 'darwin') {
      // macOS - Open accessibility privacy settings (needed for window title access)
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    } else if (process.platform === 'win32') {
      // Windows - No direct settings for window access, open general privacy
      shell.openExternal('ms-settings:privacy');
    } else if (process.platform === 'linux') {
      // Linux - No standard way to open settings
      if (mainWindow) {
        mainWindow.webContents.send('linux-windows-permission-notice');
      }
    }
    
    // After opening settings, check permission again when app regains focus
    const app = require('electron').app;
    const focusListener = async () => {
      // Remove listener immediately to prevent multiple triggers
      app.removeListener('browser-window-focus', focusListener);
      
      const newHasPermission = await checkPermission();
      
      if (mainWindow) {
        mainWindow.webContents.send('windowsPermission', newHasPermission);
      }
    };
    
    app.on('browser-window-focus', focusListener);
  });
}

/**
 * Starts capturing all enabled input data types
 * @param {Object} options Options for capturing (maxDurationMs, etc.)
 */
function startInputDataCapture() {
  const maxDurationMs = captureIntervalMinutes * 60 * 1000;

  // Start audio recording if enabled
  if (inputDataSettings.audio) {
    audioCapture.startRecording({
      maxDurationMs: maxDurationMs
    }).catch(error => {
      log.error('Error starting audio recording:', error);
    });
  }
  
  // Start keystroke tracking if enabled
  if (inputDataSettings.keystrokes) {
    keystrokesCapture.startTracking({
      maxHistoryMs: maxDurationMs
    });
  }
  
  // Start window tracking if enabled
  if (inputDataSettings.windows) {
    windowsCapture.startTracking({
      maxHistory: maxDurationMs
    });
  }
}

/**
 * Stops capturing all input data types and returns the captured data
 * @returns {Promise<Object>} The captured input data
 */
async function stopInputDataCapture() {
  let inputData = {};
  
  // Get audio data if enabled
  if (inputDataSettings.audio) {
    try {
      const audioInfo = await audioCapture.stopRecording();
      if (audioInfo && audioInfo.filePath) {
        // Read audio file as base64
        const fs = require('fs');
        const audioBuffer = fs.readFileSync(audioInfo.filePath);
        inputData.audio = {
          base64Data: `data:audio/wav;base64,${audioBuffer.toString('base64')}`,
          mimeType: 'audio/wav',
          timeMs: audioInfo.duration || 0
        };
        // Delete file after reading
        fs.unlinkSync(audioInfo.filePath);
      }
    } catch (error) {
      log.error('Error capturing audio data:', error);
    }
  }
  
  // Get keystroke and window data for processing
  let keystrokeData = [];
  let windowData = [];
  
  // Get keystroke data if enabled
  if (inputDataSettings.keystrokes) {
    try {
      keystrokeData = keystrokesCapture.processTimelineData();
      keystrokesCapture.stopTracking();
    } catch (error) {
      log.error('Error capturing keystroke data:', error);
    }
  }
  
  // Get window data if enabled
  if (inputDataSettings.windows) {
    try {
      windowData = windowsCapture.processTimelineData(windowsCapture.getTimeline());
      windowsCapture.stopTracking();
    } catch (error) {
      log.error('Error capturing window data:', error);
    }
  }
  
  // Process activity data (keystrokes or windows+keystrokes)
  inputData.activity = [];
  
  // Process keystroke data based on window data
  if (inputDataSettings.keystrokes && keystrokeData.length > 0) {
    if (inputDataSettings.windows && windowData.length > 0) {
      // Attach keystrokes to each window period
      windowData.forEach(windowPeriod => {
        // Find keystrokes that happened during this window period
        const windowKeystrokes = keystrokeData.filter(ks => 
          ks.timestamp >= windowPeriod.startTime && 
          ks.timestamp <= windowPeriod.endTime
        );
        
        // Convert to string of keystrokes
        const keystrokeString = windowKeystrokes
          .map(ks => ks.key)
          .join('');
        
        // Add window activity with keystrokes
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
      // Process keystrokes on their own with breaks for gaps > 5 seconds
      let processedKeystrokes = '';
      let lastTimestamp = 0;
      let currentSegmentStart = 0;
      
      // Sort keystrokes by timestamp
      const sortedKeystrokes = [...keystrokeData].sort((a, b) => a.timestamp - b.timestamp);
      
      if (sortedKeystrokes.length > 0) {
        currentSegmentStart = sortedKeystrokes[0].timestamp;
      }
      
      for (let i = 0; i < sortedKeystrokes.length; i++) {
        const ks = sortedKeystrokes[i];
        
        // If this is the first keystroke or there's been a gap > 5 seconds
        if (lastTimestamp === 0 || (ks.timestamp - lastTimestamp > 5000)) {
          // Add the previous segment if not the first keystroke
          if (lastTimestamp > 0) {
            // Add the previous segment
            inputData.activity.push({
              type: 'keystrokes',
              startTime: currentSegmentStart,
              endTime: lastTimestamp,
              duration: lastTimestamp - currentSegmentStart,
              keystrokes: processedKeystrokes
            });
            
            // Reset for new segment
            processedKeystrokes = '';
            currentSegmentStart = ks.timestamp;
          }
        }
        
        // Add the key
        processedKeystrokes += ks.key;
        
        // Update last timestamp
        lastTimestamp = ks.timestamp;
        
        // Add the last segment if we've reached the end
        if (i === sortedKeystrokes.length - 1 && processedKeystrokes.length > 0) {
          inputData.activity.push({
            type: 'keystrokes',
            startTime: currentSegmentStart,
            endTime: lastTimestamp,
            duration: lastTimestamp - currentSegmentStart,
            keystrokes: processedKeystrokes
          });
        }
      }
    }
  } else if (inputDataSettings.windows && windowData.length > 0) {
    // Just include window data without keystrokes
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
  
  return inputData;
}

/**
 * Captures all input data and sends it to Firebase
 * @param {string} idToken The Firebase ID token
 * @param {Object} inputData Additional input data to send (audio, keystrokes, windows)
 * @returns {Promise<Object|boolean>} Response status
 */
async function captureAndSend(idToken, inputData = {}) {
  if (!idToken) {
    log.warn('Cannot send data: User not authenticated');
    // Call the reauthenticate callback if available
    if (reauthenticateCallback) {
      reauthenticateCallback({ authError: true });
    }
    return { authError: true };
  }

  try {
    // Capture screenshots
    const screenshots = await captureScreenshot();
    
    if (!screenshots || screenshots.length === 0) {
      log.warn('No screenshots captured, skipping upload');
      return false;
    }

    const fetch = await import('node-fetch').then(module => module.default);
    
    // Create payload with screenshots and timestamp
    const payload = {
      timestamp: Date.now(),
      screenshots: screenshots
    };
    
    // Add input data if provided
    if (inputData) {
      if (inputData.audio) {
        payload.audio = inputData.audio;
      }
      
      if (inputData.activity && inputData.activity.length > 0) {
        payload.activity = inputData.activity;
      }
    }
    
    // Log what's being sent to API (excluding large binary data)
    log.info('Sending data to API: ', {
      timestamp: payload.timestamp,
      screenshotsCount: screenshots.length,
      hasAudio: !!payload.audio,
      activity: payload.activity ? payload.activity.map(item => ({
        type: item.type,
        startTime: new Date(item.startTime).toISOString(),
        endTime: new Date(item.endTime).toISOString(),
        duration: item.duration,
        keystrokesLength: item.keystrokes ? item.keystrokes.length : 0,
        ...(item.type === 'window' ? { name: item.name, title: item.title } : {})
      })) : null
    });
    
    // Send data to Firebase
    const response = await fetch(FIREBASE_CAPTURE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      // If response is not ok, check the detailed error
      const errorData = await response.json().catch(() => ({}));
      
      // Check specifically for token expiration
      if (response.status === 401 && errorData.error === 'token_expired') {
        // Call the reauthenticate callback if available
        if (reauthenticateCallback) {
          reauthenticateCallback({ tokenExpired: true });
        }
        return { tokenExpired: true };
      }
      
      // Log other error details
      log.error('Data upload error:', errorData);
      
      // For unauthorized errors (not token expired), return auth error
      if (response.status === 401 || response.status === 403) {
        // Call the reauthenticate callback if available
        if (reauthenticateCallback) {
          reauthenticateCallback({ authError: true });
        }
        return { authError: true };
      }
      
      throw new Error(`Server error: ${response.status}`);
    }
    
    log.info('API response status:', response.status);
    return true;
  } catch (error) {
    log.error('Data capture and send error:', error.message, error.stack);
    console.error('Data upload failed:', error);
    return false;
  }
}

/**
 * Captures all enabled data types and sends them to the server
 * @param {string} idToken The Firebase ID token
 * @returns {Promise<Object|boolean>} Response status
 */
async function captureAndSendAllData(idToken) {
  // Get input data from previously started captures
  const inputData = await stopInputDataCapture();
  
  // Start new captures for the next interval
  startInputDataCapture();
  
  // Send all collected data to the server
  return await captureAndSend(idToken, inputData);
}

/**
 * Starts the capture interval
 * @param {string} idToken The Firebase ID token
 * @returns {number} The interval ID
 */
function startCaptureInterval(idToken) {
  // Clear any existing interval first
  stopCaptureInterval();
  
  // Start input data capture immediately
  startInputDataCapture();
  
  // Perform an immediate capture to validate authentication
  captureAndSendAllData(idToken).catch(error => {
    log.error('Error during initial capture:', error);
  });
  
  // Set up interval for regular captures
  screenshotInterval = setInterval(async () => {
    try {
      await captureAndSendAllData(idToken);
    } catch (error) {
      log.error('Error during scheduled capture:', error);
    }
  }, captureIntervalMinutes * 60 * 1000);
  
  return screenshotInterval;
}

/**
 * Stops the capture interval and any ongoing captures
 */
function stopCaptureInterval() {
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }
  
  // Stop ongoing captures
  if (inputDataSettings.audio) {
    audioCapture.stopRecording().catch(error => {
      log.error('Error stopping audio recording:', error);
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
  return screenshotInterval !== null;
}

module.exports = {
  captureAndSend,
  startInputDataCapture,
  stopInputDataCapture,
  captureAndSendAllData,
  startCaptureInterval,
  stopCaptureInterval,
  isCapturing,
  setCaptureInterval,
  initCapture
}; 