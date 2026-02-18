const log = require('electron-log')
const { ipcMain } = require('electron')
const audioSessionDetector = require('./audioSessionDetector')

// Variables to track audio capture
let isRecording = false
let mainWindow = null
let isAudioTrackingActive = false
let startRecordingPromise = null

// Permission state - check once, remember forever
let hasMicrophonePermission = null

// Configuration state
let currentConfig = {
  systemAudio: false
}

/**
 * Initialize audio capture module
 * @param {BrowserWindow} window Main window
 * @param {Object} config Configuration
 * @param {number} config.bufferDurationMs Buffer duration in ms
 * @throws {Error} If parameters invalid
 */
function initialize(window, config = {}) {
  if (!window) {
    throw new Error('Audio capture initialization failed: window is required')
  }

  if (!config.bufferDurationMs || typeof config.bufferDurationMs !== 'number' || config.bufferDurationMs <= 0) {
    throw new Error('Audio capture initialization failed: bufferDurationMs is required and must be a positive number')
  }

  mainWindow = window

  // Power management: stop audio on system suspend; no implicit resume
  try {
    const { powerMonitor } = require('electron')
    powerMonitor.on('suspend', async () => {
      try {
        await shutdownRecording()
      } catch (_) {}
    })
    powerMonitor.on('resume', () => {
      try {
        if (isAudioTrackingActive) {
          initializeSessionDetectionIfNeeded({})
          syncRecordingState('resume').catch(() => {})
        }
      } catch (_) {}
    })
  } catch (_) {}

  ipcMain.on('audio-device-changed', (_event, info) => {
    handleDeviceSwitch(info).catch((error) => {
      log.error('Failed to handle audio-device-changed event:', error)
    })
  })

  mainWindow.webContents.executeJavaScript(
    `window.initAudioRecorder && window.initAudioRecorder({
      bufferDurationMs: ${config.bufferDurationMs}
    });`
  ).catch(error => {
    log.error('Error initializing audio recorder in renderer:', error)
    throw error
  })
}

/**
 * Initialize audio session detection
 * @param {Object} _config Configuration
 */
function initializeSessionDetection(_config) {
  try {
    const initialized = audioSessionDetector.initialize({ checkIntervalMs: 1000 })
    if (!initialized) {
      log.error('Failed to initialize audio session detector')
      return
    }

    audioSessionDetector.onSessionStart(async (detectorDevice) => {
      await applyExternalMicState({
        externalMicActive: true,
        detectorDevice,
        reason: 'session-start'
      })
    })

    audioSessionDetector.onSessionEnd(async () => {
      await applyExternalMicState({
        externalMicActive: false,
        detectorDevice: null,
        reason: 'session-end'
      })
    })

    audioSessionDetector.onDeviceSwitch(async (detectorDevice) => {
      await applyExternalMicState({
        externalMicActive: true,
        detectorDevice,
        reason: 'device-switch'
      })
    })

    audioSessionDetector.onPactlMissing(() => {
      log.warn('pactl not found on Linux - audio session detection will not work')
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('linux-pactl-missing-notice')
      }
    })

  } catch (error) {
    log.error('Failed to initialize audio session detection:', error)
    log.error('Error stack:', error.stack)
  }
}

/**
 * Initialize audio session detection when audio is enabled
 * @param {Object} config Configuration
 */
function initializeSessionDetectionIfNeeded(config) {
  if (!isAudioTrackingActive) {
    return
  }

  const status = audioSessionDetector.getStatus ? audioSessionDetector.getStatus() : null
  if (!status || !status.initialized) {
    initializeSessionDetection(config)
  }
}


async function applyExternalMicState({ externalMicActive, detectorDevice = null, reason = 'unknown' }) {
  if (!isAudioTrackingActive) {
    return
  }
  if (externalMicActive && !isRecording) {
    await startRecordingInternal()
    return
  }

  if (!externalMicActive && isRecording) {
    await stopRecordingInternal()
    return
  }
}

async function syncRecordingState(reason = 'unknown') {
  if (!isAudioTrackingActive) {
    return
  }

  const detectorStatus = await audioSessionDetector.detectMicrophoneUsage()
  await applyExternalMicState({
    externalMicActive: !!(detectorStatus && detectorStatus.isActive),
    detectorDevice: detectorStatus ? detectorStatus.deviceId : null,
    reason
  })
}

/**
 * Handle audio device switching
 * @param {Object} _deviceInfo Device switch information
 */
async function handleDeviceSwitch(_deviceInfo) {
  await syncRecordingState('audio-device-changed')
}

/**
 * Check microphone permission once
 * @returns {Promise<boolean>} Permission status
 */
async function checkMicrophonePermission(forceRefresh = false) {
  if (!mainWindow) return false

  if (forceRefresh) {
    hasMicrophonePermission = null
  }

  if (hasMicrophonePermission !== null) {
    return hasMicrophonePermission
  }

  try {
    const hasPermission = await mainWindow.webContents.executeJavaScript(
      `new Promise(resolve => {
        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          .then(stream => {
            const tracks = stream.getTracks();
            tracks.forEach(track => {
              if (track.kind === 'audio') {
                track.stop();
              }
            });
            setTimeout(() => resolve(true), 100);
          })
          .catch(() => {
            resolve(false);
          });
      })`
    )

    hasMicrophonePermission = hasPermission

    if (!hasPermission && mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('microphonePermission', { hasPermission: false, source: 'runtime-check' }) } catch (_) {}
    }
    return hasPermission
  } catch (error) {
    log.error('Error checking microphone permission:', error)
    hasMicrophonePermission = false
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('microphonePermission', { hasPermission: false, source: 'runtime-check' })
      }
    } catch (_) {}
    return false
  }
}

/**
 * Passive microphone permission check that avoids triggering getUserMedia prompts.
 * Returns true only when permission is already granted.
 * @returns {Promise<boolean>}
 */
async function checkMicrophonePermissionPassive() {
  if (!mainWindow || mainWindow.isDestroyed()) return false

  if (hasMicrophonePermission !== null) {
    return hasMicrophonePermission
  }

  try {
    const status = await mainWindow.webContents.executeJavaScript(
      `new Promise((resolve) => {
        try {
          if (!navigator.permissions || !navigator.permissions.query) {
            resolve('unknown');
            return;
          }
          navigator.permissions.query({ name: 'microphone' })
            .then((result) => resolve(result && result.state ? result.state : 'unknown'))
            .catch(() => resolve('unknown'));
        } catch (_) {
          resolve('unknown');
        }
      })`
    )

    const granted = status === 'granted'
    hasMicrophonePermission = granted
    return granted
  } catch (_) {
    return false
  }
}

async function checkSystemAudioPermission() {
  if (process.platform === 'darwin') {
    const { checkScreenCapturePermission } = require('./captureScreenshots')
    try {
      const result = await checkScreenCapturePermission()
      if (result === undefined) {
        return null
      }
      return !!result
    } catch (_) {
      return false
    }
  }

  // Windows/Linux do not expose a dedicated system-audio privacy gate we can query.
  return true
}

/**
 * Internal function to start recording (used by session detection)
 * @returns {Promise<boolean>} Success status
 */
async function startRecordingInternal() {
  if (startRecordingPromise) {
    return startRecordingPromise
  }

  if (isRecording) {
    return true
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    log.error('Cannot start audio recording: main window not available')
    return false
  }

  startRecordingPromise = (async () => {
    try {
      const started = await mainWindow.webContents.executeJavaScript(
      `window.startAudioRecording && window.startAudioRecording({
        systemAudio: ${!!currentConfig.systemAudio}
      });`
      )

      if (!started) {
        log.error('[AudioCapture] Failed to start audio recording in renderer', {
          systemAudioRequested: !!currentConfig.systemAudio
        })
        return false
      }

      isRecording = true
      return true
    } catch (error) {
      log.error('Error starting audio recording:', error)
      return false
    } finally {
      startRecordingPromise = null
    }
  })()

  return startRecordingPromise
}

/**
 * Internal function to stop recording (used by session detection)
 * @returns {Promise<boolean>} Success status
 */
async function stopRecordingInternal() {
  if (!isRecording) {
    return true
  }

  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      isRecording = false
      return true
    }
    await mainWindow.webContents.executeJavaScript(
      'window.shutdownAudioRecording && window.shutdownAudioRecording();'
    )
    let stillActive = false
    try {
      stillActive = !!(await mainWindow.webContents.executeJavaScript(
        'window.isRecorderActive && window.isRecorderActive()'
      ))
      if (stillActive) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        await mainWindow.webContents.executeJavaScript(
          'window.shutdownAudioRecording && window.shutdownAudioRecording();'
        )
        stillActive = !!(await mainWindow.webContents.executeJavaScript(
          'window.isRecorderActive && window.isRecorderActive()'
        ))
      }
    } catch (verifyError) {
      log.warn('[AudioCapture] Could not verify recorder state after shutdown:', verifyError.message || verifyError)
    }

    if (stillActive) {
      isRecording = true
      log.error('[AudioCapture] Recorder still active after shutdown retry')
      return false
    }

    isRecording = false
    return true
  } catch (error) {
    log.error('Error stopping audio recording:', error)
    isRecording = false
    return false
  }
}

/**
 * Pause recording temporarily without tearing down detector/tracking state
 * @returns {Promise<boolean>} Success status
 */
async function pauseRecording() {
  if (!isRecording || !mainWindow || mainWindow.isDestroyed()) {
    return true
  }

  try {
    await mainWindow.webContents.executeJavaScript(
      'window.pauseAudioRecording && window.pauseAudioRecording()'
    )
    return true
  } catch (error) {
    log.error('Error pausing recording:', error)
    return false
  }
}

/**
 * Resume previously paused recording
 * @returns {Promise<boolean>} Success status
 */
async function resumeRecording() {
  if (!isRecording || !mainWindow || mainWindow.isDestroyed()) {
    return true
  }

  try {
    await mainWindow.webContents.executeJavaScript(
      'window.resumeAudioRecording && window.resumeAudioRecording()'
    )
    return true
  } catch (error) {
    log.error('Error resuming recording:', error)
    return false
  }
}

/**
 * Start continuous recording
 * @returns {Promise<boolean>} Success status
 */
async function startRecording() {
  return startRecordingInternal()
}

/**
 * Start audio tracking with session detection
 * @param {Object} config Configuration
 * @returns {Promise<boolean>} Success status
 */
async function startAudioTracking(config) {
  if (config && config.systemAudio !== undefined) {
    currentConfig.systemAudio = !!config.systemAudio
  }

  const hasPermission = await checkMicrophonePermission()
  if (!hasPermission) {
    log.warn('No microphone permission, cannot start audio tracking')
    isAudioTrackingActive = false
    audioSessionDetector.shutdown()
    return false
  }

  isAudioTrackingActive = true
  initializeSessionDetectionIfNeeded(config)
  await syncRecordingState('start-audio-tracking')
  return true
}

/**
 * Get audio chunks with timestamps (for cloud or local API transcription)
 * @param {boolean} resetBuffers If true, cycle the MediaRecorder for fresh headers
 * @returns {Promise<{audioChunks: Array}|null>} Chunks with base64Data, mimeType, startMs, endMs
 */
async function stopRecording(resetBuffers = false) {
  try {
    const outputChunks = []
    if (mainWindow && !mainWindow.isDestroyed()) {
      const audioChunks = await mainWindow.webContents.executeJavaScript(
        `window.getAudioChunksWithTimestamps && window.getAudioChunksWithTimestamps(${resetBuffers})`
      )
      if (audioChunks && Array.isArray(audioChunks) && audioChunks.length > 0) {
        outputChunks.push(...audioChunks)
      }
    }

    if (outputChunks.length > 0) {
      return { audioChunks: outputChunks }
    }
    return null
  } catch (error) {
    log.error('Error retrieving audio chunks:', error)
    return null
  }
}

/**
 * Stop recording completely when shutting down
 * @returns {Promise<boolean>} Success status
 */
async function shutdownRecording() {
  try {
    isAudioTrackingActive = false

    if (isRecording) {
      await stopRecordingInternal()
    }

    audioSessionDetector.shutdown()

    return true
  } catch (error) {
    log.error('Error during audio capture shutdown:', error)
    return false
  }
}

/**
 * Get recording status
 * @returns {Object} Status object
 */
function getStatus() {
  return {
    recording: isRecording,
    tracking: isAudioTrackingActive
  }
}

module.exports = {
  initialize,
  checkMicrophonePermission,
  checkMicrophonePermissionPassive,
  checkSystemAudioPermission,
  startRecording,
  pauseRecording,
  resumeRecording,
  startAudioTracking,
  stopRecording,
  shutdownRecording,
  getStatus
}
