const log = require('electron-log')
const os = require('os')
const stream = require('stream')

let pipeline = null
let isInitialized = false

/**
 * Get system capabilities and select appropriate Whisper model
 * @returns {string} Model name
 */
function selectWhisperModel() {
  return 'Xenova/whisper-tiny'
}

/**
 * Initialize the Whisper pipeline
 * @returns {Promise<boolean>} Success status
 */
async function initialize() {
  if (isInitialized) {
    return true
  }

  try {
    // Dynamic import to avoid issues in main process
    const { pipeline: whisperPipeline } = await import('@xenova/transformers')
    
    // Select model based on system capabilities
    const selectedModel = selectWhisperModel()
    
    // Initialize pipeline only (processor not needed for this workflow)
    pipeline = await whisperPipeline('automatic-speech-recognition', selectedModel, { quantized: true })
    
    isInitialized = true
    return true
  } catch (error) {
    log.error('Error initializing Whisper pipeline:', error)
    return false
  }
}





/**
 * Converts an audio buffer from PCM to PCM (already in correct format from Web Audio API)
 * @param {Buffer} inputBuffer The audio buffer to convert.
 * @returns {Promise<Buffer>} A promise that resolves with the raw PCM audio buffer.
 */
async function convertAudioBuffer(inputBuffer) {
  if (!inputBuffer || inputBuffer.length === 0) {
    throw new Error('Empty audio buffer')
  }

  try {
    // Input is already 16kHz mono PCM from Web Audio API
    // Just validate and return as-is
    
    // Validate it's 16-bit PCM (even number of bytes)
    if (inputBuffer.length % 2 !== 0) {
      throw new Error('Invalid PCM buffer size (must be even)')
    }
    
    return inputBuffer
  } catch (error) {
    log.error('Audio conversion failed:', error.message)
    throw error
  }
}

/**
 * Create a minimal silence buffer as fallback
 * @returns {Buffer}
 */
function createSilenceBuffer() {
  // Create 1 second of silence at 16kHz mono 16-bit PCM
  const sampleRate = 16000
  const duration = 1
  const samples = sampleRate * duration
  const pcmBuffer = Buffer.alloc(samples * 2) // 16-bit samples
  
  // Fill with silence (0 values)
  pcmBuffer.fill(0)
  
  return pcmBuffer
}

/**
 * Transcribe audio buffer directly by first converting it with FFmpeg
 * @param {Buffer} audioBuffer Audio data as buffer (from WebM/Opus)
 * @returns {Promise<string>} Transcribed text
 */
async function transcribeAudioBuffer(audioBuffer) {
  if (!isInitialized) {
    const initialized = await initialize()
    if (!initialized) {
      log.warn('Failed to initialize Whisper pipeline, returning empty transcript')
      return ''
    }
  }

  try {
    // Basic validation
    if (!audioBuffer || audioBuffer.length === 0) {
      return 'No audio transcript available'
    }
    
    // 1. Decode the WebM/Opus buffer into a raw PCM buffer
    const rawPcmBuffer = await convertAudioBuffer(audioBuffer)
    
    // Debug: Log buffer info
    log.info(`Audio buffer: ${audioBuffer.length} bytes, PCM buffer: ${rawPcmBuffer.length} bytes`)
    
    // Validate PCM buffer
    if (rawPcmBuffer.length < 100) {
      log.warn('PCM buffer too small, likely invalid audio data')
      return 'No audio transcript available'
    }
    
    // Check if buffer contains mostly zeros (silence)
    let nonZeroCount = 0
    for (let i = 0; i < Math.min(1000, rawPcmBuffer.length); i += 2) {
      if (rawPcmBuffer.readInt16LE(i) !== 0) {
        nonZeroCount++
      }
    }
    const silenceRatio = 1 - (nonZeroCount / Math.min(500, rawPcmBuffer.length / 2))
    log.info(`Silence ratio: ${silenceRatio.toFixed(2)} (${nonZeroCount} non-zero samples)`)
    
    if (silenceRatio > 0.95) {
      log.warn('Audio buffer is mostly silence')
      return 'No speech detected'
    }

    // 2. Convert the 16-bit PCM buffer to a Float32Array
    // The Whisper pipeline expects audio as a Float32Array normalized between -1 and 1.
    const numSamples = Math.floor(rawPcmBuffer.length / 2)
    const audioData = new Float32Array(numSamples)
    
    for (let i = 0; i < numSamples; i++) {
      const offset = i * 2
      // Check bounds before reading
      if (offset + 1 < rawPcmBuffer.length) {
        // Read a 16-bit signed integer from the buffer
        const int16 = rawPcmBuffer.readInt16LE(offset)
        // Normalize to the range [-1.0, 1.0]
        audioData[i] = int16 / 32768.0
      } else {
        // Pad with zeros if buffer is incomplete
        audioData[i] = 0
      }
    }
    
    // 3. Use Whisper pipeline with the converted Float32Array
    const result = await pipeline(audioData, {
      // Shorter chunks reduce repetition across boundaries
      chunk_length_s: 20,
      stride_length_s: 2.5,
      return_timestamps: false,
      // Anti-repetition/quality controls
      condition_on_previous_text: false,
      temperature: 0.0,
      compression_ratio_threshold: 2.4,
      logprob_threshold: -1.0,
      no_speech_threshold: 0.6
    })
    
    let transcription = result.text.trim()

    // Lightweight de-duplication of immediate repeated segments
    // (handles edge cases where the same phrase is emitted multiple times)
    if (transcription.length > 0) {
      const parts = transcription.split(/([.!?]\s+|\n+)/)
      const cleaned = []
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i]
        if (seg && seg.trim().length > 0) {
          const last = cleaned[cleaned.length - 1]
          if (!last || last.trim().toLowerCase() !== seg.trim().toLowerCase()) {
            cleaned.push(seg)
          }
        } else if (seg) {
          // keep delimiters
          cleaned.push(seg)
        }
      }
      transcription = cleaned.join("")
    }

    // Additional de-duplication for repeated word- and phrase-loops
    transcription = removeRepetitions(transcription)
    
    console.log('Transcript:', transcription)
    
    return transcription || 'No speech detected'

  } catch (error) {
    // Handle ffmpeg errors gracefully
    if (error.message && error.message.includes('ffmpeg exited with code 1')) {
      log.warn('FFmpeg conversion failed:', error.message)
      return 'No audio transcript available'
    }
    
    log.error('Error transcribing audio buffer:', error)
    log.error('Error stack:', error.stack)
    return 'No audio transcript available'
  }
}

/**
 * Check if voice-to-text is available
 * @returns {Promise<boolean>} Availability status
 */
async function isAvailable() {
  try {
    return await initialize()
  } catch (error) {
    log.error('Voice-to-text not available:', error)
    return false
  }
}

/**
 * Get initialization status
 * @returns {Object} Status object
 */
function getStatus() {
  return {
    initialized: isInitialized,
    available: isInitialized
  }
}

module.exports = {
  initialize,
  transcribeAudioBuffer,
  isAvailable,
  getStatus
}

// --- helpers ---
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function removeRepetitions(text) {
  if (!text) return text
  let t = normalizeWhitespace(text)

  // 1) Remove exact 2-gram loops like: "hello hello hello"
  t = t.replace(/\b(\w+)(?:\s+\1){2,}\b/gi, (m, w) => w)

  // 2) Remove short phrase loops up to ~6 words: "let's go there let's go there let's go there"
  // Capture a phrase of 2-6 words and collapse consecutive repeats
  t = t.replace(/\b((?:\w+[\s,;:]+){1,5}\w+)\b(?:[\s,;:]+\1\b){1,}\.?/gi, '$1')

  // 3) Collapse triple-or-more sentence repeats separated by punctuation or newlines
  t = t.replace(/(\b[^.!?\n]{3,}\b)(?:[\s]*[.!?\n]+\s*\1){1,}/gi, '$1')

  return t
}
