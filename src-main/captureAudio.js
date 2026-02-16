const log = require('electron-log')
const { ipcMain, desktopCapturer, systemPreferences } = require('electron')
const audioSessionDetector = require('./audioSessionDetector')

// Variables to track audio capture
let isRecording = false
let mainWindow = null

// Permission state - check once, remember forever
let hasMicrophonePermission = null

// Periodic check and low audio detection
let periodicCheckInterval = null
let isPausedForCheck = false
const PERIODIC_CHECK_INTERVAL_MS = 15000

// Configuration state
let currentConfig = {
  systemAudio: false
};

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

  // Power management: stop audio on system suspend; no implicit resume
  try {
    const { powerMonitor } = require('electron');
    powerMonitor.on('suspend', async () => {
      try {
        await shutdownRecording();
      } catch (_) {}
    });
    powerMonitor.on('resume', () => {
      try {
        initializeSessionDetectionIfNeeded({});
      } catch (_) {}
    });
  } catch (_) {}
  
  // Listen for audio device changes from renderer
  ipcMain.on('audio-device-changed', (event, info) => {
    // Audio device changed
  });
  
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
  
  // Don't initialize session detection here - it will be initialized when audio is enabled
}

/**
 * Initialize audio session detection
 * @param {Object} config Configuration
 */
function initializeSessionDetection(config) {
  try {
    // Initialize the session detector
    const initialized = audioSessionDetector.initialize({ checkIntervalMs: 1000 });
    if (!initialized) {
      log.error('Failed to initialize audio session detector');
      return;
    }
    
    // Set up callbacks
    audioSessionDetector.onSessionStart(async (deviceId) => {
      // If our own recorder is already active, shut it down and do not start again
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const isOurRecorderActive = await mainWindow.webContents.executeJavaScript('window.isRecorderActive && window.isRecorderActive()');
          if (isOurRecorderActive) {
            await mainWindow.webContents.executeJavaScript('window.shutdownAudioRecording && window.shutdownAudioRecording()');
            isRecording = false;
            stopPeriodicChecks();
            // Verify shutdown actually took effect; retry once after short delay
            try {
              await new Promise(r => setTimeout(r, 200));
              const stillActive = await mainWindow.webContents.executeJavaScript('window.isRecorderActive && window.isRecorderActive()');
              if (stillActive) {
                await mainWindow.webContents.executeJavaScript('window.shutdownAudioRecording && window.shutdownAudioRecording()');
              }
            } catch (_) {}
            return;
          }
        }
      } catch (_) {}
      // Check permission before starting recording
      const hasPermission = await checkPermission();
      if (!hasPermission) {
        log.warn('No microphone permission, skipping recording start');
        return;
      }
      
      startRecordingInternal().catch(error => {
        log.error('Failed to start recording after session detection:', error);
      });
    });
    
    
    audioSessionDetector.onSessionEnd(() => {
      stopRecordingInternal().catch(error => {
        log.error('Failed to stop recording after session detection:', error);
        isRecording = false;
        stopPeriodicChecks();
      });
    });
    
    audioSessionDetector.onDeviceSwitch((deviceInfo) => {
      handleDeviceSwitch(deviceInfo).catch(error => {
        log.error('Failed to handle device switch:', error);
      });
    });
    
    // Set up callback for missing pactl on Linux
    audioSessionDetector.onPactlMissing(() => {
      log.warn('pactl not found on Linux - audio session detection will not work');
      // Send notification to renderer process
      if (mainWindow) {
        mainWindow.webContents.send('linux-pactl-missing-notice');
      }
    });
    
  } catch (error) {
    log.error('Failed to initialize audio session detection:', error);
    log.error('Error stack:', error.stack);
    // Continue without session detection - manual recording will still work
  }
}

/**
 * Initialize audio session detection when audio is enabled
 * @param {Object} config Configuration
 */
function initializeSessionDetectionIfNeeded(config) {
  // Only initialize if not already initialized
  if (!audioSessionDetector.getStatus || !audioSessionDetector.getStatus().initialized) {
    initializeSessionDetection(config);
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
    
    // Platform-specific delay for registry/audio state to settle
    // Windows registry updates are slower, so we need a longer delay
    const settleDelay = process.platform === 'win32' ? 3000 : 1200;
    await new Promise(resolve => setTimeout(resolve, settleDelay));
    
    // Check if other apps are still using the microphone
    const isOtherAppUsingMic = await checkIfOtherAppUsingMic();
    
    if (isOtherAppUsingMic) {
      await resumeRecording();
    } else {
      await stopRecordingInternal();
    }
    
  } catch (error) {
    log.error('Error during periodic check:', error);
    // Don't resume recording on error - stop it instead to be safe
    log.warn('Periodic check failed, stopping recording to prevent unwanted recording');
    try {
      await stopRecordingInternal();
    } catch (stopError) {
      log.error('Failed to stop recording after periodic check error:', stopError);
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
    
    // Platform-specific delay for registry/audio state to settle
    // Windows registry updates are slower, so we need a longer delay
    const settleDelay = process.platform === 'win32' ? 3000 : 1200;
    await new Promise(resolve => setTimeout(resolve, settleDelay));
    
    // Check if other apps are still using the microphone
    const isOtherAppUsingMic = await checkIfOtherAppUsingMic();
    
    if (isOtherAppUsingMic) {
      await resumeRecording();
    } else {
      await stopRecordingInternal();
    }
    
  } catch (error) {
    log.error('Error during low audio check:', error);
    // Don't resume recording on error - stop it instead to be safe
    log.warn('Low audio check failed, stopping recording to prevent unwanted recording');
    try {
      await stopRecordingInternal();
    } catch (stopError) {
      log.error('Failed to stop recording after low audio check error:', stopError);
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
 * Pause recording temporarily (preserves buffer for periodic check)
 */
async function pauseRecording() {
  if (!isRecording || !mainWindow) return;
  
  try {
    await mainWindow.webContents.executeJavaScript(
      'window.pauseAudioRecording && window.pauseAudioRecording()'
    );
  } catch (error) {
    log.error('Error pausing recording for check:', error);
  }
}

/**
 * Resume recording after pause
 */
async function resumeRecording() {
  if (!isRecording || !mainWindow) return;
  
  try {
    await mainWindow.webContents.executeJavaScript(
      'window.resumeAudioRecording && window.resumeAudioRecording()'
    );
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
 * Check microphone permission once
 * @returns {Promise<boolean>} Permission status
 */
async function checkPermission() {
  // We'll use the renderer to check permissions
  if (!mainWindow) return false;
  
  // If we already checked, return the result
  if (hasMicrophonePermission !== null) {
    return hasMicrophonePermission;
  }
  
  try {
    const hasPermission = await mainWindow.webContents.executeJavaScript(
      `new Promise(resolve => {
        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
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
    
    // Remember the result forever
    hasMicrophonePermission = hasPermission;
    
    // If missing, notify renderer via permission event for consistent handling
    if (!hasPermission && mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('audioPermission', false); } catch (_) {}
    }
    return hasPermission;
  } catch (error) {
    log.error('Error checking audio permission:', error);
    hasMicrophonePermission = false;
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audioPermission', false); } catch (_) {}
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
    let sourceIds = [];
    if (currentConfig.systemAudio) {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        
        if (process.platform === 'darwin') {
          // On macOS, system audio loopbacks can be tied to specific monitors.
          // We collect all of them to mix them in the renderer.
          sourceIds = sources.map(s => s.id);
        } else {
          // On Windows/Linux, typically one system loopback exists via the primary display capture.
          // Multiple captures might trigger multiple permission prompts or redundant streams.
          if (sources.length > 0) {
            // Try to find the primary display
            const primary = sources.find(s => 
              s.name.toLowerCase().includes('entire') || 
              s.name.toLowerCase().includes('screen 1') ||
              s.id.includes(':0:0')
            ) || sources[0];
            
            sourceIds = [primary.id];
          }
        }
        
        // Log details about each source
        sources.forEach((source, index) => {
        });
      } catch (err) {
        log.error('[AudioCapture] Error getting desktop sources for system audio:', err);
      }
    }

    // Ask renderer to start continuous recording
    const sourceIdsJson = JSON.stringify(sourceIds);
    const started = await mainWindow.webContents.executeJavaScript(
      `window.startAudioRecording && window.startAudioRecording({ 
        systemAudio: ${currentConfig.systemAudio},
        sourceIds: ${sourceIdsJson}
      });`
    );
    
    if (!started) {
      log.error('Failed to start audio recording in renderer');
      return false;
    }
    
    // Update recording state
    isRecording = true;

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
 * Start audio tracking with session detection
 * @param {Object} config Configuration
 * @returns {Promise<boolean>} Success status
 */
async function startAudioTracking(config) {
  // Update configuration
  if (config) {
    if (config.systemAudio !== undefined) {
      currentConfig.systemAudio = !!config.systemAudio;
    }
  }

  // Initialize session detection when audio tracking is started
  initializeSessionDetectionIfNeeded(config);
  
  // Check permission once
  const hasPermission = await checkPermission();
  if (!hasPermission) {
    log.warn('No microphone permission, cannot start audio tracking');
    return false;
  }
  
  return true;
}

/**
 * Get audio chunks with timestamps (for cloud or local API transcription)
 * @param {boolean} resetBuffers If true, cycle the MediaRecorder for fresh headers
 * @returns {Promise<{audioChunks: Array}|null>} Chunks with base64Data, mimeType, startMs, endMs
 */
async function stopRecording(resetBuffers = false) {
  try {
    if (isRecording && mainWindow && !mainWindow.isDestroyed()) {
      const audioChunks = await mainWindow.webContents.executeJavaScript(
        `window.getAudioChunksWithTimestamps && window.getAudioChunksWithTimestamps(${resetBuffers})`
      );
      if (audioChunks && Array.isArray(audioChunks) && audioChunks.length > 0) {
        return { audioChunks };
      }
    }
    return null;
  } catch (error) {
    log.error('Error retrieving audio chunks:', error);
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
    recording: isRecording
  };
}

module.exports = {
  initialize,
  checkPermission,
  startRecording,
  startAudioTracking,
  stopRecording,
  shutdownRecording,
  getStatus,
  checkLowAudioLevel, // Export for external audio level monitoring
} 