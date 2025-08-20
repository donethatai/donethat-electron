const log = require('electron-log')
const { ipcMain } = require('electron')
const voiceToText = require('./voiceToText')
const audioSessionDetector = require('./audioSessionDetector')

// Variables to track audio capture
let isRecording = false
let mainWindow = null

// Periodic check and low audio detection
let periodicCheckInterval = null
let isPausedForCheck = false
const PERIODIC_CHECK_INTERVAL_MS = 15000
const TRANSCRIPTION_INTERVAL_MS = 10000

// Periodic transcription ticker
let transcriptionInterval = null

/**
 * Initialize audio capture module
 * @param {BrowserWindow} window Main window
 * @param {Object} config Configuration
 * @param {number} config.bufferDurationMs Buffer duration in ms
 * @throws {Error} If parameters invalid
 */
function initialize(window, config = {}) {
  if (!window) {
    throw new Error('Audio capture initialization failed: window is required');
  }
  
  if (!config.bufferDurationMs || typeof config.bufferDurationMs !== 'number' || config.bufferDurationMs <= 0) {
    throw new Error('Audio capture initialization failed: bufferDurationMs is required and must be a positive number');
  }
  
  mainWindow = window;
  
  // Set up IPC handlers
  ipcMain.handle('audio-capture-result', async (event, audioData) => {
    return await processAudioFromRenderer(audioData);
  });
  
  // Listen for audio device changes from renderer
  ipcMain.on('audio-device-changed', (event, info) => {});
  
  // Low-audio IPC not needed; periodic checks suffice
  
  // Initialize the renderer-side audio recorder with configuration
  mainWindow.webContents.executeJavaScript(
    `window.initAudioRecorder && window.initAudioRecorder({
      bufferDurationMs: ${config.bufferDurationMs}
    });`
  ).catch(error => {
    log.error('Error initializing audio recorder in renderer:', error);
    throw error; // Re-throw to propagate the error
  });
  
  // Initialize session detection
  initializeSessionDetection(config);
}

/**
 * Initialize audio session detection
 * @param {Object} config Configuration
 */
function initializeSessionDetection(config) {
  try {
    // Initialize the session detector
    audioSessionDetector.initialize({ checkIntervalMs: 1000 });
    
    // Set up callbacks
    audioSessionDetector.onSessionStart(async (deviceId) => {
      
      // Check permission before starting recording
      const hasPermission = await checkPermission();
      if (!hasPermission) {
        return;
      }
      
      startRecordingInternal().catch(error => {
        log.error('Failed to start recording after session detection:', error);
      });
    });
    
    // Low audio detection removed (periodic checks suffice)
    
    // Lightweight periodic permission check during recording (less frequent)
    setInterval(async () => {
      if (!isRecording) return;
      const hasPermission = await checkPermission();
      if (!hasPermission) {
        log.warn('Microphone permission revoked during recording, stopping');
        stopRecordingInternal().catch(error => {
          log.error('Failed to stop recording after permission loss:', error);
        });
      }
    }, 30000);
    
    audioSessionDetector.onSessionEnd(() => {
      stopRecordingInternal().catch(error => {
        log.error('Failed to stop recording after session detection:', error);
      });
    });
    
    audioSessionDetector.onDeviceSwitch((deviceInfo) => {
      handleDeviceSwitch(deviceInfo).catch(error => {
        log.error('Failed to handle device switch:', error);
      });
    });
    
    
  } catch (error) {
    log.error('Failed to initialize audio session detection:', error);
    // Continue without session detection - manual recording will still work
  }
}

/**
 * Start periodic checks for microphone usage
 */
function startPeriodicChecks() {
  if (periodicCheckInterval) {
    clearInterval(periodicCheckInterval);
  }
  
  periodicCheckInterval = setInterval(async () => {
    if (isRecording && !isPausedForCheck) {
      
      await performPeriodicCheck();
    }
  }, PERIODIC_CHECK_INTERVAL_MS);
  
  
}

/**
 * Stop periodic checks
 */
function stopPeriodicChecks() {
  if (periodicCheckInterval) {
    clearInterval(periodicCheckInterval);
    periodicCheckInterval = null;
  }
  
  
  
}

/**
 * Perform periodic check - pause recording briefly to check if others are still using mic
 */
async function performPeriodicCheck() {
  if (isPausedForCheck) return;
  
  try {
    isPausedForCheck = true;
    
    // Pause recording
    await pauseRecording();
    
    // Wait a moment for CoreAudio/WebAudio state to settle
    await new Promise(resolve => setTimeout(resolve, 1200));
    
    // Check if other apps are still using the microphone
    const isOtherAppUsingMic = await checkIfOtherAppUsingMic();
    
    if (isOtherAppUsingMic) {
      
      await resumeRecording();
    } else {
      
      await stopRecordingInternal();
    }
    
  } catch (error) {
    log.error('Error during periodic check:', error);
    // Resume recording on error to be safe
    try {
      await resumeRecording();
    } catch (resumeError) {
      log.error('Failed to resume recording after periodic check error:', resumeError);
    }
  } finally {
    isPausedForCheck = false;
  }
}

/**
 * Perform check when low audio is detected
 */
async function performLowAudioCheck() {
  if (isPausedForCheck) return;
  
  try {
    isPausedForCheck = true;
    
    // Pause recording
    await pauseRecording();
    
    // Wait a moment for CoreAudio/WebAudio state to settle
    await new Promise(resolve => setTimeout(resolve, 1200));
    
    // Check if other apps are still using the microphone
    const isOtherAppUsingMic = await checkIfOtherAppUsingMic();
    
    if (isOtherAppUsingMic) {
      
      await resumeRecording();
    } else {
      
      await stopRecordingInternal();
    }
    
  } catch (error) {
    log.error('Error during low audio check:', error);
    // Resume recording on error to be safe
    try {
      await resumeRecording();
    } catch (resumeError) {
      log.error('Failed to resume recording after low audio check error:', resumeError);
    }
  } finally {
    isPausedForCheck = false;
  }
}

/**
 * Check if other apps are using the microphone
 * @returns {Promise<boolean>} True if other apps are using mic
 */
async function checkIfOtherAppUsingMic() {
  try {
    // Use the session detector to check for microphone usage
    const result = await audioSessionDetector.detectMicrophoneUsage();
    return result && result.isActive;
  } catch (error) {
    log.error('Error checking if other apps using mic:', error);
    return false; // Assume no usage on error
  }
}

/**
 * Pause recording temporarily
 */
async function pauseRecording() {
  if (!isRecording || !mainWindow) return;
  
  try {
    await mainWindow.webContents.executeJavaScript(`
      if (window.shutdownAudioRecording) {
        window.shutdownAudioRecording();
      } else if (window.audioRecorder && window.audioRecorder.pause) {
        window.audioRecorder.pause();
      }
    `);
    
  } catch (error) {
    log.error('Error stopping recording for check:', error);
  }
}

/**
 * Resume recording
 */
async function resumeRecording() {
  if (!isRecording || !mainWindow) return;
  
  try {
    await mainWindow.webContents.executeJavaScript(`
      if (window.startAudioRecording) {
        window.startAudioRecording();
      } else if (window.audioRecorder && window.audioRecorder.resume) {
        window.audioRecorder.resume();
      }
    `);
    
  } catch (error) {
    log.error('Error resuming recording:', error);
  }
}

/**
 * Check for low audio levels and trigger check if needed
 * @param {number} audioLevel Current audio level (0-1)
 */
function checkLowAudioLevel(audioLevel) {
  if (!isRecording || isPausedForCheck) return;
  
  lastAudioLevel = audioLevel;
  
  if (audioLevel < LOW_AUDIO_THRESHOLD) {
    if (!lowAudioStartTime) {
      lowAudioStartTime = Date.now();
      
    } else {
      const duration = Date.now() - lowAudioStartTime;
      if (duration >= LOW_AUDIO_DURATION_MS) {
        
        performLowAudioCheck().catch(error => {
          log.error('Error during low audio check:', error);
        });
        lowAudioStartTime = null;
      }
    }
  } else {
    // Reset low audio timer if audio level is normal
    lowAudioStartTime = null;
  }
}

/**
 * Handle audio device switching
 * @param {Object} deviceInfo Device switch information
 */
async function handleDeviceSwitch(deviceInfo) {
  if (isRecording) {
    
    
    try {
      // Stop current recording
      await stopRecordingInternal();
      
      // Wait for device switch to complete
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Start recording on new device
      await startRecordingInternal();
      
      
    } catch (error) {
      log.error('Error during audio device switch:', error);
      // Try to restart recording even if switch failed
      try {
        await startRecordingInternal();
      } catch (restartError) {
        log.error('Failed to restart recording after device switch:', restartError);
      }
    }
  }
}

/**
 * Process audio data from renderer
 * @param {Object} audioData Audio data
 * @returns {Promise<{transcript: string}>} Audio processing result
 */
async function processAudioFromRenderer(audioData) {
  try {
    // Convert base64 to buffer for transcription
    const audioBuffer = Buffer.from(audioData.base64Data.split(',')[1], 'base64');
    
    // Transcribe audio locally
    const transcript = await voiceToText.transcribeAudioBuffer(audioBuffer);
    
    return {
      transcript
    };
  } catch (error) {
    log.error('Error processing audio from renderer:', error);
    return null;
  }
}

/**
 * Check microphone permission
 * @returns {Promise<boolean>} Permission status
 */
async function checkPermission() {
  // We'll use the renderer to check permissions
  if (!mainWindow) return false;
  
  try {
    return await mainWindow.webContents.executeJavaScript(
      `new Promise(resolve => {
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then(stream => {
            // Immediately stop all tracks to release the microphone
            const tracks = stream.getTracks();
            tracks.forEach(track => {
              if (track.kind === 'audio') {
                track.stop();
              }
            });
            // Make sure all tracks are stopped before resolving
            setTimeout(() => resolve(true), 100);
          })
          .catch(err => {
            console.error("Microphone permission denied:", err);
            resolve(false);
          });
      })`
    );
  } catch (error) {
    log.error('Error checking audio permission:', error);
    return false;
  }
}

/**
 * Internal function to start recording (used by session detection)
 * @returns {Promise<boolean>} Success status
 */
async function startRecordingInternal() {
  if (isRecording) {
    return true;
  }
  
  if (!mainWindow || mainWindow.isDestroyed()) {
    log.error('Cannot start audio recording: main window not available');
    return false;
  }
  
  try {
    // Ask renderer to start continuous recording
    const started = await mainWindow.webContents.executeJavaScript(
      `window.startAudioRecording && window.startAudioRecording();`
    );
    
    if (!started) {
      log.error('Failed to start audio recording in renderer');
      return false;
    }
    
    // Update recording state
    isRecording = true;
    // Start periodic transcription pulls to ensure processing
    if (transcriptionInterval) clearInterval(transcriptionInterval)
    transcriptionInterval = setInterval(async () => {
      try {
        if (!isRecording || !mainWindow) return;
        const audioData = await mainWindow.webContents.executeJavaScript('window.stopAudioRecording && window.stopAudioRecording();')
        if (audioData) {
          await processAudioFromRenderer(audioData)
        }
      } catch (e) {}
    }, TRANSCRIPTION_INTERVAL_MS)
    
    // Start periodic checks when recording starts
    startPeriodicChecks();
    
    return true;
  } catch (error) {
    log.error('Error starting audio recording:', error);
    return false;
  }
}

/**
 * Internal function to stop recording (used by session detection)
 * @returns {Promise<boolean>} Success status
 */
async function stopRecordingInternal() {
  if (!isRecording) {
    return true;
  }
  
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      
      isRecording = false;
      return true;
    }
    
    // Ask renderer to completely stop recording
    await mainWindow.webContents.executeJavaScript(
      'window.shutdownAudioRecording && window.shutdownAudioRecording();'
    );
    
    isRecording = false;
    if (transcriptionInterval) { clearInterval(transcriptionInterval); transcriptionInterval = null }
    
    // Stop periodic checks when recording stops
    stopPeriodicChecks();
    
    return true;
  } catch (error) {
    log.error('Error stopping audio recording:', error);
    isRecording = false;
    return false;
  }
}

/**
 * Start continuous recording
 * @returns {Promise<boolean>} Success status
 */
async function startRecording() {
  return await startRecordingInternal();
}

/**
 * Get current buffer without stopping recording
 * @returns {Promise<{filePath: string, duration: number} | null>} Recording info
 */
async function stopRecording() {
  if (!isRecording) {
    
    return null;
  }
  
  try {
    if (!mainWindow) {
      log.error('Cannot get audio buffer: main window not initialized');
      return null;
    }
    
    // Ask renderer to provide the current buffer without stopping recording
    const audioData = await mainWindow.webContents.executeJavaScript(
      'window.stopAudioRecording && window.stopAudioRecording();'
    );
    
    if (!audioData) {
      
      return null;
    }
    
    // Process audio data for transcription
    const audioResult = audioData ? await processAudioFromRenderer(audioData) : null;
    
    if (!audioResult) {
      
      return null;
    }    
    // Return recording information
    return {
      transcript: audioResult.transcript,
      duration: audioData.timeMs
    };
  } catch (error) {
    log.error('Error retrieving audio buffer:', error);
    return null;
  }
}

/**
 * Stop recording completely when shutting down
 * @returns {Promise<boolean>} Success status
 */
async function shutdownRecording() {
  try {
    // Stop recording if active
    if (isRecording) {
      await stopRecordingInternal();
    }
    
    // Stop periodic checks
    stopPeriodicChecks();
    
    // Shutdown session detection
    audioSessionDetector.shutdown();
    
    
    return true;
  } catch (error) {
    log.error('Error during audio capture shutdown:', error);
    return false;
  }
}

/**
 * Get recording status
 * @returns {Object} Status object
 */
function getStatus() {
  return {
    recording: isRecording,
    voiceToTextAvailable: voiceToText.getStatus().available
  };
}

module.exports = {
  initialize,
  checkPermission,
  startRecording,
  stopRecording,
  shutdownRecording,
  getStatus,
  checkLowAudioLevel, // Export for external audio level monitoring
} 