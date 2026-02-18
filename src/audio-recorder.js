// Audio recorder for the renderer process with VAD and System Audio mixing
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let isRecording = false;
let chunkTimestamps = [];
let MAX_BUFFER_DURATION_MS;
let accumulatedChunks = [];
// Guard to prevent implicit resume after sleep; set true only when main explicitly starts
window.allowAudioResume = false;

// Audio Context and Nodes for Mixing/VAD
let audioContext = null;
let micSource = null;
let systemSources = [];
let destNode = null;
let vadNode = null; // AnalyserNode or ScriptProcessor

// Keep explicit handles to raw input streams so we can always stop tracks deterministically
let micInputStream = null;
let systemInputStreams = [];
let lastStartOptions = { systemAudio: false };
let deviceChangeListenerAttached = false;
let systemTrackRestartInFlight = false;

// VAD State & Constants
let userSpeechIntervals = []; // Array of { startMs, endMs }
const VAD_THRESHOLD = 0.05; // RMS threshold (adjustable)
const VAD_MIN_SPEECH_MS = 100; // Minimum duration to consider as speech
const VAD_HANG_OVER_MS = 500; // Time to wait before ending a speech segment

// Helper: is our own recorder currently active
window.isRecorderActive = function() {
  try {
    const active = !!(mediaRecorder && mediaRecorder.state && mediaRecorder.state !== 'inactive');
    const tracks = (mediaRecorder && mediaRecorder.stream) ? mediaRecorder.stream.getAudioTracks() : [];
    const trackLive = tracks && tracks.length > 0 && tracks[0].readyState === 'live' && tracks[0].enabled === true;

    const micTracks = micInputStream ? micInputStream.getAudioTracks() : [];
    const micLive = micTracks.some(t => t.readyState === 'live' && t.enabled);

    return (active && trackLive) || micLive;
  } catch (_) {
    return false;
  }
}

/**
 * Get the best supported audio MIME type
 * @returns {string} Best supported MIME type
 */
function getBestSupportedMimeType() {
  // Use WebM format directly since we're using temp files
  return 'audio/webm;codecs=opus';
}

/**
 * Initialize audio recorder
 * @param {Object} config Configuration
 * @param {number} config.bufferDurationMs Buffer duration in ms
 * @throws {Error} If invalid parameters
 */
window.initAudioRecorder = function(config = {}) {
  if (!config.bufferDurationMs || typeof config.bufferDurationMs !== 'number' || config.bufferDurationMs <= 0) {
    const error = new Error('Audio recorder initialization failed: bufferDurationMs is required and must be a positive number');
    console.error(error);
    throw error;
  }
  
  MAX_BUFFER_DURATION_MS = config.bufferDurationMs;
  
  // Add device change listener
  if (!deviceChangeListenerAttached && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      // Restart recording with new default device if we're recording
      if (isRecording) {
        restartAudioRecording();
      }
      
      // Notify main process about device change
      if (window.electronAPI) {
        window.electronAPI.send('audio-device-changed', {
          event: 'devicechange'
        });
      }
    });
    deviceChangeListenerAttached = true;
  }
};

/**
 * Cleanup Audio Context and Nodes
 */
function cleanupAudioContext() {
  try {
    if (vadNode) {
      vadNode.disconnect();
      vadNode = null;
    }
    if (micSource) {
      micSource.disconnect();
      micSource = null;
    }
    if (systemSources.length > 0) {
      systemSources.forEach(source => {
        try { source.disconnect(); } catch (e) {}
      });
      systemSources = [];
    }
    if (destNode) {
      destNode.disconnect();
      destNode = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
  } catch (e) {
    console.error('Error cleaning up audio context:', e);
  }
}

function stopAllInputStreams() {
  try {
    if (micInputStream) {
      try { micInputStream.getTracks().forEach(track => track.stop()); } catch (_) {}
      micInputStream = null;
    }

    if (systemInputStreams.length > 0) {
      systemInputStreams.forEach((stream) => {
        try { stream.getTracks().forEach(track => track.stop()); } catch (_) {}
      });
      systemInputStreams = [];
    }
  } catch (e) {
    console.error('Error stopping input streams:', e);
  }
}

// VAD AudioWorklet Code (Inlined to avoid bundling/path issues)
const VAD_WORKLET_CODE = `
class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
    
    // VAD Parameters (matching audio-recorder.js)
    this.VAD_THRESHOLD = ${VAD_THRESHOLD};
    this.VAD_MIN_SPEECH_MS = ${VAD_MIN_SPEECH_MS};
    this.VAD_HANG_OVER_MS = ${VAD_HANG_OVER_MS};
    
    // State
    this.isSpeaking = false;
    this.speechStartTime = 0;
    this.lastSpeechTime = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    
    const channelData = input[0];
    
    // Accumulate samples to match roughly the old ScriptProcessor buffer size
    // for consistent RMS calculation
    for (let i = 0; i < channelData.length; i++) {
        this.buffer[this.bufferIndex++] = channelData[i];
        if (this.bufferIndex >= this.bufferSize) {
            this.processBuffer();
            this.bufferIndex = 0;
        }
    }
    
    return true;
  }

  processBuffer() {
    // Calculate RMS for the *current accumulated buffer*
    let sum = 0;
    for (let i = 0; i < this.bufferSize; i++) {
        const x = this.buffer[i];
        sum += x * x;
    }
    const rms = Math.sqrt(sum / this.bufferSize);
    
    // Reset buffer index to overwrite for next cycle
    this.bufferIndex = 0;
    
    // Use current time
    const now = Date.now();

    if (rms > this.VAD_THRESHOLD) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartTime = now;
        this.port.postMessage({ type: 'speech-start', time: now });
      }
      this.lastSpeechTime = now;
    } else {
      if (this.isSpeaking) {
        // Check for hang over
        if (now - this.lastSpeechTime > this.VAD_HANG_OVER_MS) {
          const duration = this.lastSpeechTime - this.speechStartTime;
          if (duration > this.VAD_MIN_SPEECH_MS) {
             this.port.postMessage({ 
                 type: 'speech-segment', 
                 startMs: this.speechStartTime, 
                 endMs: this.lastSpeechTime 
             });
          }
          this.isSpeaking = false;
          this.port.postMessage({ type: 'speech-end', time: now });
        }
      }
    }
  }
}

registerProcessor('vad-processor', VadProcessor);
`;

/**
 * Setup VAD on the microphone stream using AudioWorklet
 */
async function setupVAD(stream, context) {
  // Reset state
  userSpeechIntervals = []; // Global state

  const source = context.createMediaStreamSource(stream);
  
  // Load the worklet module from inlined code
  try {
    const blob = new Blob([VAD_WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url); // Cleanup after loading
  } catch (e) {
    console.error('Failed to load VAD worklet:', e);
  }

  const vadNode = new AudioWorkletNode(context, 'vad-processor');
  
  vadNode.port.onmessage = (event) => {
    if (!isRecording) return;
    const { type, startMs, endMs } = event.data;
    
    if (type === 'speech-segment') {
       userSpeechIntervals.push({ startMs, endMs });
    }
  };

  source.connect(vadNode);
  // Unlike ScriptProcessor, AudioWorklet doesn't need to be connected to destination to process
  // unless we want audio output. We don't want VAD audio output.
  // source.connect(destNode); // Done outside for recording path.
  
  return { source, vadNode };
}

/**
 * Start continuous recording
 * @param {Object} options Options
 * @param {boolean} options.systemAudio Whether to capture system audio
 * @returns {boolean} Success status
 */
window.startAudioRecording = async function(options = {}) {
  if (isRecording) {
    return true;
  }

  const normalizedOptions = {
    systemAudio: !!options.systemAudio
  };
  lastStartOptions = {
    systemAudio: normalizedOptions.systemAudio
  };
  
  try {
    
    window.allowAudioResume = true;
    audioChunks = [];
    chunkTimestamps = [];
    stopAllInputStreams();
    cleanupAudioContext(); // Ensure clean slate
    
    // 1. Setup Audio Context
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContext();
    await audioContext.resume();
    if (audioContext.state !== 'running') {
      throw new Error(`AudioContext failed to enter running state (state=${audioContext.state})`);
    }
    destNode = audioContext.createMediaStreamDestination();

    // 2. Get Microphone Stream
    // Use improved audio constraints for better quality
    const micStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true, 
        autoGainControl: true
      },
      video: false
    });
    
    micInputStream = micStream;

    // 3. Setup Mic Source & VAD
    const vadSetup = await setupVAD(micStream, audioContext);
    micSource = vadSetup.source;
    vadNode = vadSetup.vadNode; // Updated property name

    // Connect Mic to Destination (for mixing)
    micSource.connect(destNode);

    // 4. Get system audio stream (if enabled)
    if (normalizedOptions.systemAudio) {
      const systemStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: false
      });
      const systemTrack = systemStream.getAudioTracks()[0];
      if (!systemTrack || systemTrack.readyState !== 'live') {
        systemStream.getTracks().forEach((track) => track.stop());
        throw new Error('System audio loopback track is not live');
      }
      systemTrack.onended = async () => {
        if (!isRecording || systemTrackRestartInFlight) return;
        systemTrackRestartInFlight = true;
        try {
          await restartAudioRecording();
        } catch (e) {
          console.error('Failed to restart recording after system audio track ended:', e);
        } finally {
          systemTrackRestartInFlight = false;
        }
      };

      const videoTracks = systemStream.getVideoTracks();
      if (videoTracks.length > 0) {
        videoTracks.forEach((track) => track.stop());
      }

      const sourceNode = audioContext.createMediaStreamSource(systemStream);
      sourceNode.connect(destNode);
      systemSources.push(sourceNode);
      systemInputStreams.push(systemStream);
    }
    
    // 5. Setup MediaRecorder with destination stream
    const mixedStream = destNode.stream;
    
    const mimeType = getBestSupportedMimeType();
    const recorderOptions = {
      audioBitsPerSecond: 128000
    };
    
    if (mimeType) {
      recorderOptions.mimeType = mimeType;
    }
    
    mediaRecorder = new MediaRecorder(mixedStream, recorderOptions);
    
    
    // Explicitly guard resume events (Chromium may auto-resume after sleep)
    mediaRecorder.onresume = () => {
      if (!window.allowAudioResume) {
        window.shutdownAudioRecording();
      }
    };
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        const now = Date.now();
        audioChunks.push(event.data);
        chunkTimestamps.push(now);
        trimAudioBuffer();
        
        // Also trim intervals? Maybe not necessary for now as they are small JSON
      }
    };
    
    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
    };
    
    
    mediaRecorder.start(1000);
    recordingStartTime = Date.now();
    isRecording = true;
    
    return true;
  } catch (error) {
    console.error('Error starting audio recording:', error);
    isRecording = false;
    stopAllInputStreams();
    cleanupAudioContext();
    return false;
  }
};

/**
 * Cycle the MediaRecorder to ensure fresh headers for the next chunk
 * Preserves the audio stream and VAD state
 */
async function cycleMediaRecorder() {
  if (!isRecording || !mediaRecorder) return;
  
  try {
    // Save the current stream and config
    const currentStream = mediaRecorder.stream;
    const currentMimeType = mediaRecorder.mimeType || getBestSupportedMimeType();
    
    // Verify the stream is still valid
    const audioTracks = currentStream.getAudioTracks();
    if (!audioTracks || audioTracks.length === 0 || audioTracks[0].readyState !== 'live') {
      console.warn('Audio stream is no longer valid, cannot cycle MediaRecorder');
      return;
    }
    
    // Stop the current recorder (this will trigger final ondataavailable)
    if (mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Clear the buffer for the new session
    audioChunks = [];
    chunkTimestamps = [];
    
    // Create a new MediaRecorder with the same stream
    const recorderOptions = {
      audioBitsPerSecond: 128000
    };
    
    if (currentMimeType) {
      recorderOptions.mimeType = currentMimeType;
    }
    
    mediaRecorder = new MediaRecorder(currentStream, recorderOptions);
    
    // Re-attach event handlers
    mediaRecorder.onresume = () => {
      if (!window.allowAudioResume) {
        window.shutdownAudioRecording();
      }
    };
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        const now = Date.now();
        audioChunks.push(event.data);
        chunkTimestamps.push(now);
        trimAudioBuffer();
      }
    };
    
    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
    };
    
    // Start the new recorder
    mediaRecorder.start(1000);
    recordingStartTime = Date.now();
    
  } catch (error) {
    console.error('Error cycling MediaRecorder:', error);
  }
}

// Restart recording when audio device changes
async function restartAudioRecording() {
  if (!isRecording) return true;
  
  try {
    
    // Stop the current recording cleanly
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      // mediaRecorder.stream.getTracks().forEach(track => track.stop()); // Don't stop destination tracks
      mediaRecorder = null;
    }
    
    // Buffer inputs
    const previousChunks = [...audioChunks];
    const previousTimestamps = [...chunkTimestamps];
    const previousIntervals = [...userSpeechIntervals];

    cleanupAudioContext();
    
    const restartOptions = {
      systemAudio: !!lastStartOptions.systemAudio
    };

    // Force a real restart path; startAudioRecording short-circuits when isRecording is true.
    isRecording = false;
    stopAllInputStreams();

    const success = await window.startAudioRecording(restartOptions);
    if (!success) return false;
    
    // Restore previous chunks
    audioChunks = previousChunks;
    chunkTimestamps = previousTimestamps;
    userSpeechIntervals = previousIntervals;

    return true;
  } catch (error) {
    console.error('Error restarting audio recording:', error);
    isRecording = false;
    return false;
  }
}

// Add to window for access from main process
window.restartAudioRecording = restartAudioRecording;

/**
 * Pause recording (preserves buffer for periodic check)
 */
window.pauseAudioRecording = function() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    if (audioContext && audioContext.state === 'running') {
      audioContext.suspend();
    }
  }
};

/**
 * Resume recording after pause
 */
window.resumeAudioRecording = function() {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume();
    }
  }
};

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const bytes = new Uint8Array(r.result);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      resolve(btoa(binary));
    };
    r.onerror = reject;
    r.readAsArrayBuffer(blob);
  });
}

/**
 * Create a chunk from the current buffer
 */
async function bufferToChunk() {
  if (audioChunks.length === 0) return null;
  const mimeType = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
  const blob = new Blob(audioChunks, { type: mimeType });
  if (blob.size === 0) return null;
  const base64 = await blobToBase64(blob);
  const startMs = chunkTimestamps[0] || recordingStartTime;
  const endMs = (chunkTimestamps[chunkTimestamps.length - 1] || startMs) + 1000;
  
  // Return intervals overlapping this chunk
  const relevantIntervals = userSpeechIntervals.filter(i => i.endMs >= startMs && i.startMs <= endMs);
  
  return { 
    base64Data: base64, 
    mimeType, 
    startMs, 
    endMs,
    speechIntervals: relevantIntervals
  };
}

/**
 * Get all chunks for this capture interval: accumulated sessions + current buffer if recording
 * @param {boolean} resetBuffers If true, cycle the MediaRecorder to ensure fresh headers
 * @returns {Promise<Array<{base64Data: string, mimeType: string, startMs: number, endMs: number, speechIntervals: Array}>>}
 */
window.getAudioChunksWithTimestamps = async function(resetBuffers = false) {
  try {
    const result = [...accumulatedChunks];
    accumulatedChunks = [];
    if (isRecording && mediaRecorder && audioChunks.length > 0) {
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.requestData();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const chunk = await bufferToChunk();
      if (chunk) result.push(chunk);
    }
    
    // If resetBuffers is true, cycle the MediaRecorder to ensure fresh headers for next chunk
    if (resetBuffers && isRecording && mediaRecorder) {
      await cycleMediaRecorder();
    }
    
    return result;
  } catch (error) {
    console.error('Error getting audio chunks with timestamps:', error);
    accumulatedChunks = [];
    return [];
  }
};

/**
 * Trim audio buffer to maximum duration
 */
function trimAudioBuffer() {
  if (audioChunks.length < 2 || chunkTimestamps.length < 2) return;
  
  const now = Date.now();
  const cutoffTime = now - MAX_BUFFER_DURATION_MS;
  
  let cutoffIndex = 0;
  for (let i = 0; i < chunkTimestamps.length; i++) {
    if (chunkTimestamps[i] >= cutoffTime) {
      cutoffIndex = i;
      break;
    }
  }
  
  if (cutoffIndex > 0) {
    audioChunks = audioChunks.slice(cutoffIndex);
    chunkTimestamps = chunkTimestamps.slice(cutoffIndex);
    
    // Prune old intervals
    userSpeechIntervals = userSpeechIntervals.filter(i => i.endMs >= cutoffTime);
  }
}

/**
 * Get current audio buffer
 * DEPRECATED/UNUSED by new processLocal.js logic but kept for safety
 * @returns {Promise<Object>} Audio data
 */
window.stopAudioRecording = async function() {
    // This function was used for single clip processing. 
    // New logic uses getAudioChunksWithTimestamps.
    // Keeping minimal implementation returning null to force usage of new API if called.
    return null;
};

/**
 * Stop recording completely; saves current buffer as chunk for next capture cycle
 */
window.shutdownAudioRecording = async function() {
  const preState = mediaRecorder ? mediaRecorder.state : 'none';
  const preTracks = (mediaRecorder && mediaRecorder.stream) ? mediaRecorder.stream.getAudioTracks().map(t => ({
    id: t.id,
    readyState: t.readyState,
    enabled: t.enabled,
    muted: t.muted
  })) : [];

  const preMicTracks = micInputStream ? micInputStream.getAudioTracks().map(t => ({
    id: t.id,
    readyState: t.readyState,
    enabled: t.enabled,
    muted: t.muted
  })) : [];
  if (mediaRecorder && isRecording) {
    if (audioChunks.length > 0) {
      if (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused') {
        try { mediaRecorder.requestData(); } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const chunk = await bufferToChunk();
      if (chunk) accumulatedChunks.push(chunk);
    }
    
    // Stop raw input streams and close context
    stopAllInputStreams();
    cleanupAudioContext();
    
    if (mediaRecorder) {
        try { mediaRecorder.stream.getTracks().forEach(track => track.stop()); } catch(_) {}
        try { mediaRecorder.stop(); } catch (_) {}
    }
    
    mediaRecorder = null;
    isRecording = false;
    audioChunks = [];
    chunkTimestamps = [];
    window.allowAudioResume = false;
  }

  const postActive = (() => {
    try {
      return !!(window.isRecorderActive && window.isRecorderActive());
    } catch (_) {
      return false;
    }
  })();
};

module.exports = {
  startAudioRecording: window.startAudioRecording,
  stopAudioRecording: window.stopAudioRecording,
  shutdownAudioRecording: window.shutdownAudioRecording,
  pauseAudioRecording: window.pauseAudioRecording,
  resumeAudioRecording: window.resumeAudioRecording,
  restartAudioRecording,
  getAudioChunksWithTimestamps: window.getAudioChunksWithTimestamps
}; 
