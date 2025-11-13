const log = require('electron-log');
const { getGeminiApiKey, getOpenAICompatibleConfig } = require('./main-state');

// Firebase URLs for config and processing
const FIREBASE_CONFIG_URL = 'https://europe-west1-donethat.cloudfunctions.net/inputConfig';
const FIREBASE_PROCESS_URL = 'https://europe-west1-donethat.cloudfunctions.net/inputProcess';

// Cache for config data
let configCache = {
  data: null,
  lastFetch: 0,
  fetchInterval: 60 * 60 * 1000 // 1 hour in milliseconds
};

// LLM models (will be initialized when needed)
let llmModels = null;
// latest config snapshot for downstream use
let latestConfig = null;

// Constants from online version
const CAPTION_TOKENS = 200; // Target tokens for description truncation
const MAX_OUTPUT_TOKENS = 1000; // Max tokens allowed for model output
const MAX_SCREENSHOT_SIZE = 2000000; // 2MB per screenshot


/**
 * Truncate text to approximately maxTokens tokens (rough estimate: 1 token ≈ 4 chars)
 */
function truncateToTokens(text, maxTokens) {
  if (!text || typeof text !== 'string') return text;
  const maxChars = maxTokens * 4; // Rough estimate
  if (text.length <= maxChars) return text;
  // Truncate and ensure we don't cut in the middle of a word if possible
  const truncated = text.substring(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > maxChars * 0.8 ? truncated.substring(0, lastSpace) : truncated;
}

/**
 * Check if local processing is available (has Gemini API key or OpenAI-compatible config)
 */
async function isLocalProcessingAvailable() {
  try {
    // Check for Gemini key first (preferred)
    const geminiResult = await getGeminiApiKey();
    if (geminiResult.success && geminiResult.apiKey) {
      return true;
    }

    // Check for OpenAI-compatible config
    const openaiResult = await getOpenAICompatibleConfig();
    if (openaiResult.success && openaiResult.config && openaiResult.config.endpoint) {
      return true;
    }

    return false;
  } catch (error) {
    log.error('Error checking local processing availability:', error);
    return false;
  }
}

/**
 * Get configuration from Firebase with caching
 */
async function getConfig(idToken) {
  const now = Date.now();
  
  // Return cached config if still valid
  if (configCache.data && (now - configCache.lastFetch) < configCache.fetchInterval) {
    return configCache.data;
  }

  try {
    const fetch = await import('node-fetch').then(module => module.default);
    
    const response = await fetch(FIREBASE_CONFIG_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });

    if (!response.ok) {
      let errorBody = null;
      try {
        errorBody = await response.json();
      } catch (e) {}
      const err = new Error(`Failed to fetch config: ${response.status}`);
      err.status = response.status;
      err.source = 'FIREBASE';
      if (response.status === 401 && errorBody && errorBody.error === 'token_expired') {
        err.code = 'TOKEN_EXPIRED';
      } else if (response.status === 401 || response.status === 403) {
        err.code = 'AUTH_ERROR';
      }
      throw err;
    }

    const config = await response.json();
    
    if (!config.success) {
      throw new Error('Config fetch returned error');
    }

    // Cache the config
    configCache.data = config;
    configCache.lastFetch = now;
    latestConfig = config;

    return config;
  } catch (error) {
    log.error('Error fetching config:', error);
    throw error;
  }
}


/**
 * Initialize LLM models with structured output
 */
async function initializeLLM(idToken, testMode = false) {
  try {
    const config = await getConfig(idToken);

    // Determine provider availability
    const geminiKey = await getGeminiApiKey();
    const openaiCompat = await getOpenAICompatibleConfig();

    // If Gemini is configured, use the models from cloud config that are for Gemini
    if (geminiKey.success && geminiKey.apiKey) {
      const geminiModels = (config.llmModels || []).filter(m => m.provider === 'gemini');
      const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
      llmModels = await Promise.all(
        geminiModels.map(async (m) => new ChatGoogleGenerativeAI({
          apiKey: geminiKey.apiKey,
          model: m.model,
          maxOutputTokens: m.maxOutputTokens || MAX_OUTPUT_TOKENS,
          temperature: 0.2 // some randomness so the retries make sense
        }).withStructuredOutput(config.outputSchema, { safe: true }))
      );
      if (!llmModels || llmModels.length === 0) {
        throw new Error('No Gemini models available in config');
      }
      return;
    }

    // Otherwise, if OpenAI-compatible is configured, build a single model using that config
    if (openaiCompat.success && openaiCompat.config && openaiCompat.config.endpoint && openaiCompat.config.model) {
      const { ChatOpenAI } = await import('@langchain/openai');
      // Use provided endpoint as-is (minus trailing slash) to stay flexible
      const baseURL = openaiCompat.config.endpoint.replace(/\/$/, '');
      const outputSchema = config.outputSchema;
      const chat = new ChatOpenAI({
        apiKey: openaiCompat.config.apiKey || '',
        model: openaiCompat.config.model,
        maxTokens: MAX_OUTPUT_TOKENS,
        maxRetries: testMode ? 0 : undefined,
        temperature: 0.2, // some randomness so the retries make sense
        response_format: { type: 'json_object' },
        configuration: { baseURL }
      }).withStructuredOutput(outputSchema, { safe: true });
      llmModels = [chat];
      return;
    }

    throw new Error('No LLM provider available');
  } catch (error) {
    log.error('Error initializing LLM:', error);
    throw error;
  }
}

/**
 * Invoke LLM with fallback through multiple models
 */
async function invokeWithFallback(messages, testMode = false) {
  if (!llmModels || llmModels.length === 0) {
    throw new Error('No LLM models available');
  }

  const maxAttemptsPerModel = testMode ? 1 : 3; // only 1 attempt in test mode
  let lastError = null;

  for (const llm of llmModels) {
    let attempt = 0;
    while (attempt < maxAttemptsPerModel) {
      try {
        const response = await llm.invoke(messages);
        return response;
      } catch (error) {
        if (testMode) {
          // In test mode, throw immediately to see the actual error
          throw error;
        }

        attempt += 1;
        lastError = error;
        const remaining = maxAttemptsPerModel - attempt;
        
        // Check if it's an image processing error
        const isImageError = error.message && error.message.includes('Unable to process input image');
        
        if (isImageError) {
          log.warn(`LLM image processing error on attempt ${attempt}, trying with fewer images...`);
          // Try with fewer images on next attempt
          if (attempt === 1) {
            // Remove some images and retry
            const simplifiedMessages = simplifyMessagesForRetry(messages);
            try {
              const response = await llm.invoke(simplifiedMessages);
              return response;
            } catch (retryError) {
              log.warn(`LLM retry with fewer images also failed:`, retryError);
            }
          }
        }
        
        log.warn(`LLM ${llm.constructor.name} attempt ${attempt} failed${remaining > 0 ? `, retrying (${remaining} left)` : ''}:`, error);
        if (attempt >= maxAttemptsPerModel) {
          break;
        }
      }
    }
  }

  log.warn('All LLMs failed after retries; throwing last error for higher-level handling.');
  if (lastError) throw lastError;
  throw new Error('Local LLM failed after retries');
}

/**
 * Simplify messages by removing some images for retry attempts
 */
function simplifyMessagesForRetry(messages) {
  try {
    const simplifiedMessages = messages.map(message => {
      if (message.content && Array.isArray(message.content)) {
        // Keep only the first 2 images and all text content
        const simplifiedContent = message.content.filter(block => {
          if (block.type === 'text') return true;
          if (block.type === 'image_url') {
            // Only keep first 2 images
            const imageBlocks = message.content.filter(b => b.type === 'image_url');
            const imageIndex = imageBlocks.indexOf(block);
            return imageIndex < 2;
          }
          return false;
        });
        return { ...message, content: simplifiedContent };
      }
      return message;
    });
    return simplifiedMessages;
  } catch (error) {
    log.error('Error simplifying messages:', error);
    return messages; // Return original if simplification fails
  }
}

/**
 * Validate and process image data for LLM processing
 */
function validateAndProcessImage(imageData) {
  try {
    // Ensure it's a valid data URL
    if (!imageData || typeof imageData !== 'string' || !imageData.startsWith('data:image/')) {
      return null;
    }

    // Extract the base64 part
    const base64Part = imageData.split(',')[1];
    if (!base64Part) {
      return null;
    }

    // Decode to check if it's valid
    const buffer = Buffer.from(base64Part, 'base64');
    if (buffer.length === 0) {
      return null;
    }

    // Check file size (mirror online version's 2MB limit)
    if (buffer.length > MAX_SCREENSHOT_SIZE) {
      return null;
    }

    // Ensure it's a supported format (JPEG, PNG)
    const mimeType = imageData.match(/data:([^;]+)/)?.[1];
    if (!mimeType || !['image/jpeg', 'image/png'].includes(mimeType)) {
      return null;
    }

    return imageData;
  } catch (error) {
    log.error('Image validation error:', error);
    return null;
  }
}

/**
 * Build content blocks based on config spec (mirror online version)
 */
function buildBlocks(config, validScreenshots, previousScreenshots, applicationActivity, audioTranscript, idleTime) {
  const spec = config.contentBlocksSpec || {};
  const imageKey = spec.imagePartKey || 'image_url';
  const blocks = [ { type: 'text', text: config.prefilledPrompt } ];

  if (applicationActivity) {
    blocks.push({ type: 'text', text: `Application Activity:\n${applicationActivity}` });
  }
  if (audioTranscript) {
    blocks.push({ type: 'text', text: `Audio Transcript:\n${audioTranscript}` });
  }
  
  if (idleTime !== undefined && idleTime !== null) {
    const idleMinutes = Math.floor(idleTime / 60);
    const idleSeconds = idleTime % 60;
    blocks.push({ type: 'text', text: `System Idle Time: ${idleMinutes}m ${idleSeconds}s` });
  }

  // Add previous screenshots if available (mirror online version)
  if (previousScreenshots && previousScreenshots.images && previousScreenshots.images.length > 0) {
    blocks.push({ type: 'text', text: spec.previousLabel || 'PREVIOUS SCREENSHOTS (from 5 minutes ago):' });
    previousScreenshots.images.forEach((img, idx) => {
      if (img && img.base64Data) {
        const url = img.base64Data.startsWith('data:image') ? img.base64Data : `data:image/jpeg;base64,${img.base64Data}`;
        const validatedImage = validateAndProcessImage(url);
        if (validatedImage) {
          const imageBlock = { type: 'image_url' };
          imageBlock[imageKey] = validatedImage;
          blocks.push(imageBlock);
        }
      }
    });
    blocks.push({ type: 'text', text: spec.currentLabel || 'CURRENT SCREENSHOTS:' });
  }

  // Process current screenshots (mirror online version's approach)
  const processedScreenshots = validScreenshots
    .map((img, idx) => {
      const validatedImage = validateAndProcessImage(img);
      return validatedImage;
    })
    .filter(img => img !== null);

  processedScreenshots.forEach(img => {
    const imageBlock = { type: 'image_url' };
    imageBlock[imageKey] = img;
    blocks.push(imageBlock);
  });

  // Log summary of what's being sent to LLM
  const imageBlocks = blocks.filter(b => b.type === 'image_url');

  // If no screenshots are provided, add a note about activity-only processing (mirror online)
  if (processedScreenshots.length === 0 && 
      (!previousScreenshots || !previousScreenshots.images || previousScreenshots.images.length === 0)) {
    blocks.push({ type: 'text', text: 'NO SCREENSHOTS PROVIDED - Processing based on activity data, audio, and other inputs only.' });
  }

  return blocks;
}

/**
 * Analyze screenshots using local LLM processing
 */
async function analyzeScreenshots(screenshots, previousScreenshots, activity, audioTranscript, idleTime, idToken, testMode = false) {
  try {
    // Validate current screenshots - this is critical
    if (!screenshots || screenshots.length === 0) {
      throw new Error('No current screenshots available for analysis');
    }

    // Validate that all current screenshots have valid data
    // Current screenshots come as data URLs (strings), not objects with base64Data property
    const validScreenshots = screenshots.filter(img => img && typeof img === 'string' && img.startsWith('data:image/'));
    if (validScreenshots.length === 0) {
      throw new Error('No valid screenshot data available for analysis');
    }

    // Initialize LLM if not already done
    if (!llmModels) {
      await initializeLLM(idToken, testMode);
    }
    
    // Ensure we have up-to-date config
    const config = latestConfig || await getConfig(idToken);
    // Build content blocks using spec
    const blocks = buildBlocks(config, validScreenshots, previousScreenshots, activity, audioTranscript, idleTime);

    // Import HumanMessage
    const { HumanMessage } = await import('@langchain/core/messages');

    // Call LLM with fallback and retries
    const response = await invokeWithFallback([
      new HumanMessage({ content: blocks })
    ], testMode);

    // If all LLMs failed, skip this round
    if (!response) {
      log.warn('Skipping analysis this round due to repeated LLM failures.');
      return null;
    }

    // Truncate description field to <200 tokens if it exists
    // Schema uses uppercase keys (DESCRIPTION, CATEGORY, ONELINE)
    if (response && typeof response === 'object' && response.DESCRIPTION && typeof response.DESCRIPTION === 'string') {
      response.DESCRIPTION = truncateToTokens(response.DESCRIPTION, CAPTION_TOKENS);
    }

    return response;
  } catch (error) {
    log.error('Error in local screenshot analysis:', error);
    throw error;
  }
}

/**
 * Submit processed results to Firebase
 */
async function submitResults(idToken, timestamp, structured, parameters) {
  try {
    const fetch = await import('node-fetch').then(module => module.default);
    
    // Prepare payload for Firebase
    const payload = {
      timestamp: timestamp,
      structured: structured,
      parameters: parameters
    };
    
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    };
    const response = await fetch(FIREBASE_PROCESS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let errorBody = null;
      try {
        errorBody = await response.json();
      } catch (e) {}
      const err = new Error(`Failed to submit results: ${response.status}`);
      err.status = response.status;
      err.source = 'FIREBASE';
      if (response.status === 401 && errorBody && errorBody.error === 'token_expired') {
        err.code = 'TOKEN_EXPIRED';
      } else if (response.status === 401 || response.status === 403) {
        err.code = 'AUTH_ERROR';
      }
      throw err;
    }

    const result = await response.json();
    
    if (!result.success) {
      throw new Error('Result submission returned error');
    }

    return result;
  } catch (error) {
    log.error('Error submitting results:', error);
    throw error;
  }
}

/**
 * Main function to process data locally
 * @param {string} idToken Firebase ID token
 * @param {Array} screenshots Screenshot data
 * @param {Array} previousScreenshots Previous screenshot data
 * @param {Object} inputData Input data (audio, keystrokes, etc.)
 * @param {boolean} testMode If true, skip Firebase submission
 */
async function processDataLocally(idToken, screenshots, previousScreenshots, inputData, testMode = false) {
  try {
    // Check if local processing is available
    if (!await isLocalProcessingAvailable()) {
      throw new Error('Local processing not available - no API keys or configuration');
    }

    // Format application activity
    let applicationActivity = 'No application activity data available';
    if (inputData.activity && inputData.activity.length > 0) {
      applicationActivity = inputData.activity.map(item => 
        `${item.appName}: ${item.formattedDuration || 'active'}`
      ).join(', ');
    }

    // Get audio transcript
    let audioTranscript = 'No audio transcript available';
    if (inputData.audioTranscript) {
      audioTranscript = inputData.audioTranscript;
    }

    // Get idle time
    let idleTime = undefined;
    if (inputData.idleTime !== undefined) {
      idleTime = inputData.idleTime;
    }

    // Skip local processing if system idle time exceeds 5 minutes (300 seconds)
    if (typeof idleTime === 'number' && idleTime >= 300) {
      log.warn('Skipping local processing due to idle time > 5 minutes');
      return { success: false, skipped: true, reason: 'idle' };
    }

    // Analyze screenshots locally
    let structured;
    try {
      structured = await analyzeScreenshots(
        screenshots,
        previousScreenshots,
        applicationActivity,
        audioTranscript,
        idleTime,
        idToken,
        testMode
      );
    } catch (err) {
      // In test mode, pass through the real error
      if (testMode) {
        throw err;
      }

      // Notify user directly on local analysis errors
      try {
        const { BrowserWindow } = require('electron');
        const win = BrowserWindow.getAllWindows()?.[0];
        if (win && !win.isDestroyed()) {
          win.webContents.send('inapp:notify', {
            id: 'local-processing-error',
            title: 'Local processing error',
            message: (err && err.message) ? err.message : 'Unknown error',
            sticky: false
          });
        }
      } catch (_) {}
      // Throw canonical local-processing error marker for upstream
      throw new Error('Local Processing');
    }

    // Build parameters to send (based on config.parameters)
    const config = latestConfig || await getConfig(idToken);
    const baseParams = config.parameters || {};
    const paramsToSend = {
      ...baseParams,
      application_activity: applicationActivity || '',
      audio_transcript: audioTranscript || ''
    };

    // If no structured result (LLM failed after retries), skip submission this round
    if (!structured) {
      log.warn('No structured output available; skipping result submission this round.');
      return { success: false, skipped: true };
    }

    // Skip Firebase submission in test mode
    if (testMode) {
      return { success: true, test: true };
    }

    // Submit results to Firebase using current time
    const originalTs = Date.now();
    const result = await submitResults(
      idToken,
      originalTs,
      structured,
      paramsToSend
    );

    return result;
  } catch (error) {
    log.error('Error in local processing:', error);
    throw error;
  }
}

module.exports = {
  isLocalProcessingAvailable,
  processDataLocally,
  // Allow main process to reset cached config and models when FE updates settings
  resetLLMModels: () => { llmModels = null; }
};
