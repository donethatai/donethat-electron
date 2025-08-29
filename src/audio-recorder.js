// Audio recorder for the renderer process
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let isRecording = false;
let chunkTimestamps = [];
let MAX_BUFFER_DURATION_MS;

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
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      // Restart recording with new default device if we're recording
      if (isRecording) {
        restartAudioRecording();
      }
      
      // Notify main process about device change
      if (window.electron && window.electron.ipcRenderer) {
        window.electron.ipcRenderer.send('audio-device-changed', {
          event: 'devicechange'
        });
      }
    });
  }
};

/**
 * Start continuous recording
 * @returns {boolean} Success status
 */
window.startAudioRecording = async function() {
  if (isRecording) {
    return true;
  }
  
  try {
    audioChunks = [];
    chunkTimestamps = [];
    
    // Use improved audio constraints for better quality
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true, 
        autoGainControl: true
      },
      video: false
    });
    
    const mimeType = getBestSupportedMimeType();
    const options = {
      audioBitsPerSecond: 128000
    };
    
    if (mimeType) {
      options.mimeType = mimeType;
    }
    
    mediaRecorder = new MediaRecorder(stream, options);
    
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
    
    
    mediaRecorder.start(1000);
    recordingStartTime = Date.now();
    isRecording = true;
    
    return true;
  } catch (error) {
    console.error('Error starting audio recording:', error);
    isRecording = false;
    return false;
  }
};

// Restart recording when audio device changes
async function restartAudioRecording() {
  if (!isRecording) return true;
  
  try {
    
    
    // Stop the current recording cleanly
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stream.getTracks().forEach(track => track.stop());
      mediaRecorder = null;
    }
    
    // Save current chunks
    const previousChunks = [...audioChunks];
    const previousTimestamps = [...chunkTimestamps];
    
    // Start a new recording with the new default device
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true, 
        autoGainControl: true
      },
      video: false
    });
    
    const mimeType = getBestSupportedMimeType();
    const options = {
      audioBitsPerSecond: 128000
    };
    
    if (mimeType) {
      options.mimeType = mimeType;
    }
    
    mediaRecorder = new MediaRecorder(stream, options);
    
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
    
    // Restore previous chunks if possible
    audioChunks = previousChunks;
    chunkTimestamps = previousTimestamps;
    
    mediaRecorder.start(1000);
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
  }
}

/**
 * Get current audio buffer
 * @returns {Promise<Object>} Audio data
 */
window.stopAudioRecording = async function() {
  if (!isRecording || !mediaRecorder) {
    return null;
  }
  
  try {
    mediaRecorder.requestData();
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const oldestTimestamp = chunkTimestamps[0] || recordingStartTime;
    const duration = Date.now() - oldestTimestamp;
    
    if (audioChunks.length === 0) {
      console.warn('No audio data captured');
      return null;
    }
    
    // Use the recorder's selected MIME type
    const mimeType = mediaRecorder.mimeType || 'audio/webm';
    const blob = new Blob(audioChunks, { type: mimeType });
    
    // Basic validation
    if (blob.size === 0) {
      return null;
    }
    
    // Decode WebM/Opus to PCM using Web Audio API
    return new Promise((resolve) => {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const reader = new FileReader();
      
      reader.onloadend = async () => {
        try {
          // Decode the audio data
          const arrayBuffer = reader.result;
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
          
          // Convert to 16kHz mono PCM
          const sampleRate = 16000;
          const numSamples = Math.floor(audioBuffer.duration * sampleRate);
          
          // Get the source data (mix to mono if stereo)
          let sourceData;
          if (audioBuffer.numberOfChannels === 1) {
            sourceData = audioBuffer.getChannelData(0);
          } else {
            // Mix stereo to mono
            const left = audioBuffer.getChannelData(0);
            const right = audioBuffer.getChannelData(1);
            sourceData = new Float32Array(left.length);
            for (let i = 0; i < left.length; i++) {
              sourceData[i] = (left[i] + right[i]) / 2;
            }
          }
          
          // Resample to 16kHz using linear interpolation
          const resampledData = new Float32Array(numSamples);
          const sourceSampleRate = audioBuffer.sampleRate;
          const ratio = sourceSampleRate / sampleRate;
          
          for (let i = 0; i < numSamples; i++) {
            const sourceIndex = i * ratio;
            const sourceIndexFloor = Math.floor(sourceIndex);
            const sourceIndexCeil = Math.min(sourceIndexFloor + 1, sourceData.length - 1);
            const fraction = sourceIndex - sourceIndexFloor;
            
            const sample1 = sourceData[sourceIndexFloor] || 0;
            const sample2 = sourceData[sourceIndexCeil] || 0;
            resampledData[i] = sample1 + (sample2 - sample1) * fraction;
          }
          
          // Convert to 16-bit PCM
          const pcmBuffer = new ArrayBuffer(numSamples * 2);
          const pcmView = new DataView(pcmBuffer);
          
          for (let i = 0; i < numSamples; i++) {
            const sample = Math.max(-1, Math.min(1, resampledData[i]));
            const int16 = Math.round(sample * 32767);
            pcmView.setInt16(i * 2, int16, true); // little-endian
          }
          
          // Convert to base64 using a more reliable method
          const uint8Array = new Uint8Array(pcmBuffer);
          let binary = '';
          for (let i = 0; i < uint8Array.length; i++) {
            binary += String.fromCharCode(uint8Array[i]);
          }
          const base64 = btoa(binary);
          
          resolve({
            base64Data: `data:audio/pcm;base64,${base64}`,
            mimeType: 'audio/pcm',
            timeMs: duration
          });
          
        } catch (error) {
          console.error('Error decoding audio:', error);
          // Fallback to raw WebM if decoding fails
          resolve({
            base64Data: reader.result,
            mimeType: mimeType,
            timeMs: duration
          });
        } finally {
          audioContext.close();
        }
      };
      
      reader.onerror = () => {
        console.error('Error reading audio blob');
        resolve(null);
      };
      
      reader.readAsArrayBuffer(blob);
    });
  } catch (error) {
    console.error('Error getting audio buffer:', error);
    return null;
  }
};

/**
 * Stop recording completely
 */
window.shutdownAudioRecording = function() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stream.getTracks().forEach(track => track.stop());
    mediaRecorder = null;
    isRecording = false;
    audioChunks = [];
    chunkTimestamps = [];
  }
};

module.exports = {
  startAudioRecording: window.startAudioRecording,
  stopAudioRecording: window.stopAudioRecording,
  shutdownAudioRecording: window.shutdownAudioRecording,
  restartAudioRecording
}; 