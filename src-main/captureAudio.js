const log = require('electron-log')
const { ipcMain, systemPreferences } = require('electron')
const audioSessionDetector = require('./audioSessionDetector')
const { recordAudioRestart, recordLog, recordSignal } = require('./telemetry')
let mediabunnyPromise = null

// Variables to track audio capture
let isRecording = false
let mainWindow = null
let isAudioTrackingActive = false
let startRecordingPromise = null

// Permission state cache (updated by checks; do not treat as permanent truth)
let hasMicrophonePermission = null

// Configuration state
let currentConfig = {
  systemAudio: false
}

function getAudioConversionLogLevel(action) {
  return String(action || '').includes('failed') ? 'warn' : 'info'
}

function recordAudioConversion(action, meta = {}) {
  recordLog(getAudioConversionLogLevel(action), 'audio-conversion', `audio-conversion-${action}`, {
    sampleRate: meta.sampleRate,
    channels: meta.channels,
    length: meta.length,
    segmentCount: meta.segmentCount,
    byteLength: meta.byteLength,
    error: meta.error,
    stage: meta.stage
  })
}

function normalizeBase64Audio(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  return value.includes(',') ? value.split(',')[1] : value
}

function filterIntervalsToWindow(intervals, windowStartMs, windowEndMs) {
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) {
    return []
  }
  return (Array.isArray(intervals) ? intervals : [])
    .map((interval) => {
      const startMs = Number(interval?.startMs)
      const endMs = Number(interval?.endMs)
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return null
      }
      const clippedStart = Math.max(startMs, windowStartMs)
      const clippedEnd = Math.min(endMs, windowEndMs)
      if (clippedEnd <= clippedStart) return null
      return { startMs: clippedStart, endMs: clippedEnd }
    })
    .filter(Boolean)
}

async function getMediaBunny() {
  if (!mediabunnyPromise) {
    mediabunnyPromise = import('mediabunny')
  }
  return mediabunnyPromise
}

function arrayBufferToBase64(arrayBuffer) {
  return Buffer.from(arrayBuffer).toString('base64')
}

function toOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function mergeWebmSegmentsToBase64(segments) {
  const {
    Input,
    Output,
    BufferSource,
    BufferTarget,
    WebMOutputFormat,
    WEBM,
    EncodedPacketSink,
    EncodedAudioPacketSource,
    EncodedVideoPacketSource
  } = await getMediaBunny()

  const inputs = segments.map((segment) => new Input({
    source: new BufferSource(Buffer.from(segment.base64Data, 'base64')),
    formats: [WEBM]
  }))

  try {
    const baseTracks = await inputs[0].getTracks()
    if (!baseTracks || baseTracks.length === 0) {
      throw new Error('No tracks found in first segment')
    }

    const output = new Output({
      format: new WebMOutputFormat(),
      target: new BufferTarget()
    })

    const trackContexts = []
    for (const track of baseTracks) {
      if (track.isAudioTrack()) {
        if (!track.codec) throw new Error('Missing audio codec for merge')
        const source = new EncodedAudioPacketSource(track.codec)
        const audioTrackMetadata = {
          languageCode: toOptionalString(track.languageCode),
          name: toOptionalString(track.name)
        }
        output.addAudioTrack(source, audioTrackMetadata)
        trackContexts.push({
          type: 'audio',
          number: track.number,
          source,
          metaSent: false,
          offset: 0,
          sequence: 0
        })
      } else if (track.isVideoTrack()) {
        if (!track.codec) throw new Error('Missing video codec for merge')
        const source = new EncodedVideoPacketSource(track.codec)
        const videoTrackMetadata = {
          languageCode: toOptionalString(track.languageCode),
          name: toOptionalString(track.name),
          rotation: track.rotation,
          frameRate: track.frameRate
        }
        output.addVideoTrack(source, videoTrackMetadata)
        trackContexts.push({
          type: 'video',
          number: track.number,
          source,
          metaSent: false,
          offset: 0,
          sequence: 0
        })
      }
    }

    await output.start()

    for (const input of inputs) {
      const tracks = await input.getTracks()
      for (const ctx of trackContexts) {
        const track = tracks.find((candidate) => {
          if (ctx.type === 'audio' && !candidate.isAudioTrack()) return false
          if (ctx.type === 'video' && !candidate.isVideoTrack()) return false
          return candidate.number === ctx.number
        })
        if (!track) continue

        const sink = new EncodedPacketSink(track)
        const decoderConfig = (!ctx.metaSent && typeof track.getDecoderConfig === 'function')
          ? await track.getDecoderConfig()
          : null

        let segmentStartTs = null
        let segmentEndTs = null
        for await (const packet of sink.packets()) {
          if (segmentStartTs == null) segmentStartTs = packet.timestamp
          const normalizedTimestamp = (packet.timestamp - segmentStartTs) + ctx.offset
          const normalizedPacket = packet.clone({
            timestamp: normalizedTimestamp,
            sequenceNumber: ctx.sequence
          })
          ctx.sequence += 1

          const maybeMeta = (!ctx.metaSent && decoderConfig)
            ? { decoderConfig }
            : undefined
          await ctx.source.add(normalizedPacket, maybeMeta)
          if (!ctx.metaSent) ctx.metaSent = true
          segmentEndTs = normalizedTimestamp + packet.duration
        }

        if (segmentEndTs != null) {
          ctx.offset = segmentEndTs
        }
      }
    }

    await output.finalize()
    const finalBuffer = output.target.buffer
    if (!finalBuffer) {
      throw new Error('Merged output buffer is empty')
    }
    return arrayBufferToBase64(finalBuffer)
  } finally {
    for (const input of inputs) {
      try {
        if (typeof input.dispose === 'function') {
          input.dispose()
        }
      } catch (_) {}
    }
  }
}

async function convertWebmToWavInRenderer(base64Webm) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null
  }
  const script = `window.convertWebmBase64ToWavBase64 && window.convertWebmBase64ToWavBase64(${JSON.stringify(base64Webm)})`
  return mainWindow.webContents.executeJavaScript(script)
}

async function buildCycleAudioPayload(rawAudioCycle, options = {}) {
  if (!rawAudioCycle || typeof rawAudioCycle !== 'object') {
    return null
  }

  const includeOpenAIWav = options.includeOpenAIWav === true
  const payloadBuildStartedAt = Date.now()
  let mergeWebmMs = 0
  let wavConvertMs = 0
  const sourceSegments = Array.isArray(rawAudioCycle.segments) ? rawAudioCycle.segments : []
  const normalizedSegments = sourceSegments
    .map((segment, index) => {
      const base64Data = normalizeBase64Audio(segment?.base64Data)
      if (!base64Data) return null
      return {
        index,
        base64Data,
        mimeType: (segment?.mimeType || 'audio/webm').split(';')[0] || 'audio/webm',
        startMs: Number(segment?.startMs),
        endMs: Number(segment?.endMs)
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aStart = Number.isFinite(a.startMs) ? a.startMs : Number.MAX_SAFE_INTEGER
      const bStart = Number.isFinite(b.startMs) ? b.startMs : Number.MAX_SAFE_INTEGER
      return aStart - bStart || a.index - b.index
    })
  if (normalizedSegments.length === 0) {
    return null
  }

  let payloadBase64 = normalizedSegments[normalizedSegments.length - 1].base64Data
  let payloadMimeType = 'audio/webm'
  let mergedSegmentCount = normalizedSegments.length
  let effectiveStartMs = Number(rawAudioCycle.cycleStartMs)
  let effectiveEndMs = Number(rawAudioCycle.cycleEndMs)

  if (normalizedSegments.length === 1) {
    payloadBase64 = normalizedSegments[0].base64Data
    payloadMimeType = normalizedSegments[0].mimeType || 'audio/webm'
    effectiveStartMs = normalizedSegments[0].startMs
    effectiveEndMs = normalizedSegments[0].endMs
    recordAudioConversion('webm-merge-success', {
      segmentCount: 1,
      byteLength: Buffer.byteLength(payloadBase64, 'base64')
    })
  } else {
    try {
      const mergeStartedAt = Date.now()
      payloadBase64 = await mergeWebmSegmentsToBase64(normalizedSegments)
      mergeWebmMs = Date.now() - mergeStartedAt
      payloadMimeType = 'audio/webm'
      mergedSegmentCount = normalizedSegments.length
      effectiveStartMs = normalizedSegments[0].startMs
      effectiveEndMs = normalizedSegments[normalizedSegments.length - 1].endMs
      recordAudioConversion('webm-merge-success', {
        segmentCount: normalizedSegments.length,
        byteLength: Buffer.byteLength(payloadBase64, 'base64')
      })
    } catch (error) {
      const fallback = normalizedSegments[normalizedSegments.length - 1]
      payloadBase64 = fallback.base64Data
      payloadMimeType = fallback.mimeType || 'audio/webm'
      mergedSegmentCount = 1
      effectiveStartMs = fallback.startMs
      effectiveEndMs = fallback.endMs
      recordAudioConversion('webm-merge-failed', {
        segmentCount: normalizedSegments.length,
        error: error?.message || String(error),
        stage: 'merge'
      })
    }
  }

  const audioCycle = {
    base64Data: payloadBase64,
    mimeType: payloadMimeType,
    cycleStartMs: effectiveStartMs,
    cycleEndMs: effectiveEndMs,
    recordingIntervals: filterIntervalsToWindow(rawAudioCycle.recordingIntervals, effectiveStartMs, effectiveEndMs),
    speechIntervals: filterIntervalsToWindow(rawAudioCycle.speechIntervals, effectiveStartMs, effectiveEndMs),
    segmentCount: mergedSegmentCount,
    source: rawAudioCycle.source || 'mixed',
    systemAudioEnabled: !!rawAudioCycle.systemAudioEnabled
  }

  if (includeOpenAIWav) {
    try {
      const wavStartedAt = Date.now()
      const wavBase64 = await convertWebmToWavInRenderer(payloadBase64)
      wavConvertMs = Date.now() - wavStartedAt
      if (!wavBase64 || typeof wavBase64 !== 'string') {
        throw new Error('Renderer WAV conversion returned empty result')
      }

      audioCycle.openai = {
        base64Data: wavBase64,
        mimeType: 'audio/wav',
        format: 'wav'
      }
      recordAudioConversion('wav-conversion-success', {
        byteLength: Buffer.byteLength(wavBase64, 'base64')
      })
    } catch (error) {
      recordAudioConversion('wav-conversion-failed', {
        error: error?.message || String(error),
        stage: 'transcode'
      })
    }
  }

  recordSignal('audio_payload_phases_end', {
    blobToBase64Ms: -1,
    mergeWebmMs: Math.round(mergeWebmMs),
    wavConvertMs: Math.round(wavConvertMs),
    segmentCount: normalizedSegments.length,
    webmBytes: Buffer.byteLength(payloadBase64 || '', 'base64'),
    wavRequested: includeOpenAIWav ? '1' : '0',
    totalMs: Math.max(0, Date.now() - payloadBuildStartedAt)
  })

  return audioCycle
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
    if (info?.event === 'audio-restart-metric') {
      recordAudioRestart(info.reason, info.action)
      return
    }
    if (info?.event === 'audio-conversion-metric') {
      const action = typeof info.action === 'string' ? info.action : 'unknown'
      recordAudioConversion(action, {
        sampleRate: info.sampleRate,
        channels: info.numberOfChannels || info.channels,
        length: info.length,
        segmentCount: info.segmentCount,
        byteLength: info.byteLength,
        stage: info.stage,
        error: info.error
      })
      return
    }
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
    const initialized = audioSessionDetector.initialize({ checkIntervalMs: 5000 })
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
  recordSignal('audio_runtime_state_change', {
    action: 'restart',
    reason: 'device-switch',
    systemAudio: currentConfig.systemAudio ? '1' : '0'
  })
}

/**
 * Check microphone permission once
 * @returns {Promise<boolean>} Permission status
 */
async function checkMicrophonePermission(forceRefresh = false, options = {}) {
  const allowPrompt = options.allowPrompt !== false
  const targetWindow = options.mainWindow || mainWindow
  if (!targetWindow || targetWindow.isDestroyed?.()) return false

  if (forceRefresh) {
    hasMicrophonePermission = null
  }
  if (hasMicrophonePermission !== null) {
    return hasMicrophonePermission
  }

  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone')
      if (status === 'granted') {
        hasMicrophonePermission = true
        return true
      }

      // Only prompt on explicit user-driven checks.
      if (forceRefresh && status === 'not-determined') {
        if (!allowPrompt) {
          hasMicrophonePermission = false
          if (targetWindow && !targetWindow.isDestroyed()) {
            try { targetWindow.webContents.send('microphonePermission', { hasPermission: false, source: 'runtime-check' }) } catch (_) {}
          }
          return false
        }
        const granted = await systemPreferences.askForMediaAccess('microphone')
        hasMicrophonePermission = !!granted
        if (!granted && targetWindow && !targetWindow.isDestroyed()) {
          try { targetWindow.webContents.send('microphonePermission', { hasPermission: false, source: 'runtime-check' }) } catch (_) {}
        }
        return !!granted
      }

      hasMicrophonePermission = false
      if (targetWindow && !targetWindow.isDestroyed()) {
        try { targetWindow.webContents.send('microphonePermission', { hasPermission: false, source: 'runtime-check' }) } catch (_) {}
      }
      return false
    } catch (error) {
      log.error('Error checking microphone permission via macOS API:', error)
      hasMicrophonePermission = false
      if (targetWindow && !targetWindow.isDestroyed()) {
        try { targetWindow.webContents.send('microphonePermission', { hasPermission: false, source: 'runtime-check' }) } catch (_) {}
      }
      return false
    }
  }

  try {
    const hasPermission = await targetWindow.webContents.executeJavaScript(
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

    if (!hasPermission && targetWindow && !targetWindow.isDestroyed()) {
      try { targetWindow.webContents.send('microphonePermission', { hasPermission: false, source: 'runtime-check' }) } catch (_) {}
    }
    return hasPermission
  } catch (error) {
    log.error('Error checking microphone permission:', error)
    hasMicrophonePermission = false
    try {
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send('microphonePermission', { hasPermission: false, source: 'runtime-check' })
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
async function checkMicrophonePermissionPassive(forceRefresh = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (forceRefresh) {
    hasMicrophonePermission = null
  }
  if (hasMicrophonePermission !== null) {
    return hasMicrophonePermission
  }

  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone')
      const granted = status === 'granted'
      hasMicrophonePermission = granted
      return granted
    } catch (_) {
      return false
    }
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

    if (status === 'granted') {
      hasMicrophonePermission = true
      return true
    }
    if (status === 'denied') {
      hasMicrophonePermission = false
      return false
    }

    // 'unknown' (or any unrecognized state) should not overwrite cached state.
    // Let active startup checks decide via getUserMedia when needed.
    return false
  } catch (_) {
    return false
  }
}

async function checkSystemAudioPermission(options = {}) {
  const activeProbe = !!options.activeProbe
  const interactiveScreenProbe = !!options.interactiveScreenProbe
  if (process.platform === 'darwin') {
      const { checkScreenCapturePermission } = require('./captureScreenshots')
    try {
      const result = await checkScreenCapturePermission('system-audio', {
        interactive: interactiveScreenProbe
      })
      if (result === undefined) {
        return null
      }
      if (!result) {
        return false
      }
      if (!activeProbe) {
        return true
      }
      if (!mainWindow || mainWindow.isDestroyed()) {
        return false
      }

      // Active loopback probe (explicit user check path): verify getDisplayMedia can
      // actually provide a live audio track, not just screen-capture entitlement.
      const canCaptureLoopback = await mainWindow.webContents.executeJavaScript(
        `new Promise((resolve) => {
          const finish = (value) => resolve(!!value);
          (async () => {
            try {
              if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
                finish(false);
                return;
              }
              const stream = await navigator.mediaDevices.getDisplayMedia({
                audio: true,
                video: false
              });
              const track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
              const ok = !!(track && track.readyState === 'live');
              try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
              finish(ok);
            } catch (_) {
              finish(false);
            }
          })();
        })`
      )
      return !!canCaptureLoopback
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
      const startInRenderer = async (systemAudio) => {
        return mainWindow.webContents.executeJavaScript(
          `window.startAudioRecording && window.startAudioRecording({
            systemAudio: ${!!systemAudio}
          });`
        )
      }

      let started = await startInRenderer(!!currentConfig.systemAudio)

      if (!started) {
        log.error('[AudioCapture] Failed to start audio recording in renderer', {
          systemAudioRequested: !!currentConfig.systemAudio
        })

        // If system audio was requested, treat this as evidence that loopback capture
        // is currently unavailable and immediately notify UI/state. Then retry mic-only.
        if (currentConfig.systemAudio) {
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('systemAudioPermission', {
                hasPermission: false,
                source: 'runtime-start-failed'
              })
            }
          } catch (_) {}

          started = await startInRenderer(false)
          if (started) {
            log.warn('[AudioCapture] System audio start failed; continuing with microphone-only capture')
            isRecording = true
            return true
          }
        }

        // Mic start failed as well; reflect this immediately in permission UI/state.
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('microphonePermission', {
              hasPermission: false,
              source: 'runtime-start-failed'
            })
          }
        } catch (_) {}
        return false
      }

      isRecording = true
      recordSignal('audio_runtime_state_change', {
        action: 'start',
        reason: 'recording-active',
        systemAudio: currentConfig.systemAudio ? '1' : '0'
      })
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
    recordSignal('audio_runtime_state_change', {
      action: 'stop',
      reason: 'recording-stopped',
      systemAudio: currentConfig.systemAudio ? '1' : '0'
    })
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
  recordSignal('audio_runtime_state_change', {
    action: 'tracking-start',
    reason: 'start-audio-tracking',
    systemAudio: currentConfig.systemAudio ? '1' : '0'
  })
  initializeSessionDetectionIfNeeded(config)
  await syncRecordingState('start-audio-tracking')
  return true
}

/**
 * Get one audio file with metadata for this capture cycle
 * @param {boolean} resetBuffers If true, cycle the MediaRecorder for fresh headers
 * @param {Object} options
 * @param {boolean} options.includeOpenAIWav If true, include WAV payload for OpenAI local path
 * @returns {Promise<{audioCycle: Object}|{error: boolean, reason: string, message: string}|null>}
 */
async function stopRecording(resetBuffers = false, options = {}) {
  try {
    const includeOpenAIWav = options.includeOpenAIWav === true
    if (mainWindow && !mainWindow.isDestroyed()) {
      const rawAudioCycle = await mainWindow.webContents.executeJavaScript(
        `window.getAudioCycleWithMetadata && window.getAudioCycleWithMetadata(${resetBuffers}, ${includeOpenAIWav})`
      )
      const audioCycle = await buildCycleAudioPayload(rawAudioCycle, { includeOpenAIWav })
      if (audioCycle && typeof audioCycle === 'object' && audioCycle.base64Data) {
        return { audioCycle }
      }
    }
    return null
  } catch (error) {
    log.error('Error retrieving audio cycle:', error)
    return {
      error: true,
      reason: 'retrieve_failed',
      message: error?.message || 'Unknown error retrieving audio cycle'
    }
  }
}

/**
 * Stop recording completely when shutting down
 * @returns {Promise<boolean>} Success status
 */
async function shutdownRecording() {
  try {
    isAudioTrackingActive = false
    recordSignal('audio_runtime_state_change', {
      action: 'tracking-stop',
      reason: 'shutdown-recording',
      systemAudio: currentConfig.systemAudio ? '1' : '0'
    })

    if (isRecording) {
      await stopRecordingInternal()
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        await mainWindow.webContents.executeJavaScript(
          'window.shutdownAudioRecording && window.shutdownAudioRecording({ clearCycleState: true });'
        )
      } catch (_) {}
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
