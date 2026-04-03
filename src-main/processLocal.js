const log = require('electron-log');
const { getGeminiApiKey, getOpenAICompatibleConfig, getMainWindow } = require('./main-state');

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
// Local provider: 'gemini' or 'openai'
let localProvider = null;

// Constants from online version
const CAPTION_TOKENS = 200; // Target tokens for description truncation
const MAX_OUTPUT_TOKENS = 1000; // Max tokens allowed for model output
const MAX_SCREENSHOT_SIZE = 2000000; // 2MB per screenshot
const TRANSIENT_LOCAL_PROCESSING_CODES = new Set([
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
]);


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

function getLocalProcessingErrorContext(err) {
  const messages = [];
  const codes = [];
  let status;
  const seen = new Set();
  let current = err;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);

    const currentStatus = current.status ?? current.statusCode;
    if (typeof currentStatus === 'number' && !status) {
      status = currentStatus;
    }

    if (typeof current.code === 'string' && current.code.trim()) {
      codes.push(current.code.trim());
    }

    if (typeof current.message === 'string' && current.message.trim()) {
      messages.push(current.message.trim());
    }

    current = current.cause;
  }

  if (messages.length === 0 && err != null) {
    messages.push(String(err));
  }

  return {
    status,
    codes,
    text: messages.join(' | ')
  };
}

function isTransientLocalProcessingError(err) {
  const { status, codes, text } = getLocalProcessingErrorContext(err);

  if (status === 408) {
    return true;
  }

  if (typeof status === 'number') {
    return false;
  }

  if (codes.some((code) => TRANSIENT_LOCAL_PROCESSING_CODES.has(code))) {
    return true;
  }

  return /(network error|offline|getaddrinfo|\bEAI_AGAIN\b|\bENETDOWN\b|\bENETRESET\b|\bENETUNREACH\b)/i.test(text);
}

/**
 * Short summary for banners when the OpenAI client puts full HTML bodies in error.message (e.g. 404 pages).
 */
function formatLocalProcessingErrorForUser(err) {
  if (!err) return 'Unknown error';

  let { status, text } = getLocalProcessingErrorContext(err);

  const looksLikeHtml = /<!DOCTYPE/i.test(text) || /<html[\s>]/i.test(text) || /<head[\s>]/i.test(text);
  const leadingStatusMatch = text.trim().match(/^(\d{3})\s/);
  if (!status && leadingStatusMatch) {
    status = parseInt(leadingStatusMatch[1], 10);
  }

  if (looksLikeHtml || /^\d{3}\s*</.test(text.trim())) {
    if (status === 404) {
      return 'The API returned 404 (not found). Check your OpenAI-compatible base URL (often …/v1) and model id.';
    }
    if (status === 401 || status === 403) {
      return 'The API rejected the request (authentication). Check your API key and account.';
    }
    if (status === 429) {
      return 'Rate limited by the API. Try again in a moment.';
    }
    if (status >= 500) {
      return `The API returned server error ${status}. Try again later or check your provider.`;
    }
    if (status) {
      return `The API returned ${status} with a non-JSON response. Check the endpoint URL and model name.`;
    }
    return 'The API returned an HTML page instead of JSON. Check your base URL and model id.';
  }

  const maxLen = 400;
  if (text.length > maxLen) {
    return text.slice(0, maxLen - 1) + '…';
  }
  return text;
}

function buildLocalProcessingNotification(err) {
  if (isTransientLocalProcessingError(err)) {
    return {
      id: 'local-processing-connection-issue',
      title: 'Connection issue',
      message: 'Could not reach the local AI provider. DoneThat will try again on the next capture.',
      sticky: false,
      noFocus: true,
      alsoNative: false
    };
  }

  return {
    id: 'local-processing-error',
    title: 'Local processing error',
    message: formatLocalProcessingErrorForUser(err),
    sticky: true,
    alsoNative: true
  };
}

function isLocalProcessingAuthError(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }

  if (err.source !== 'FIREBASE') {
    return false;
  }

  const code = err.code;
  const status = err.status ?? err.statusCode;
  return code === 'TOKEN_EXPIRED' || code === 'AUTH_ERROR' || status === 401 || status === 403;
}

function shouldRethrowLocalProcessingError(err, testMode = false) {
  return testMode || isLocalProcessingAuthError(err);
}

/**
 * Determine which local provider is configured ('gemini' or 'openai')
 * @returns {Promise<string>} 'gemini' or 'openai'
 */
async function getLocalProvider() {
  try {
    // Check for Gemini key first (preferred)
    const geminiResult = await getGeminiApiKey();
    if (geminiResult.success && geminiResult.apiKey) {
      return 'gemini';
    }

    // Check for OpenAI-compatible config
    const openaiResult = await getOpenAICompatibleConfig();
    if (openaiResult.success && openaiResult.config && openaiResult.config.endpoint) {
      return 'openai';
    }

    return null;
  } catch (error) {
    log.error('Error determining local provider:', error);
    return null;
  }
}

/**
 * Check if local processing is available (has Gemini API key or OpenAI-compatible config)
 */
async function isLocalProcessingAvailable() {
  const provider = await getLocalProvider();
  return provider !== null;
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
      },
      signal: AbortSignal.timeout(15_000)
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
async function initializeLLM(idToken) {
  try {
    const config = await getConfig(idToken);

    // Determine provider availability
    localProvider = await getLocalProvider();
    if (!localProvider) {
      throw new Error('No LLM provider available');
    }

    // If Gemini is configured, use the models from cloud config that are for Gemini
    if (localProvider === 'gemini') {
      const geminiKey = await getGeminiApiKey();
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
    if (localProvider === 'openai') {
      const openaiCompat = await getOpenAICompatibleConfig();
      const { ChatOpenAI } = await import('@langchain/openai');
      // Use provided endpoint as-is (minus trailing slash) to stay flexible
      const baseURL = openaiCompat.config.endpoint.replace(/\/$/, '');
      const outputSchema = config.outputSchema;
      const chat = new ChatOpenAI({
        apiKey: openaiCompat.config.apiKey || '',
        model: openaiCompat.config.model,
        maxTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        temperature: 0.2, // some randomness so the retries make sense
        response_format: { type: 'json_object' },
        configuration: { baseURL }
      }).withStructuredOutput(outputSchema, { safe: true });
      llmModels = [chat];
      return;
    }
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

  let lastError = null;

  for (const llm of llmModels) {
    let attempt = 0;
    while (attempt <= 2) {
      try {
        return await llm.invoke(messages, { signal: AbortSignal.timeout(120_000) });
      } catch (error) {
        if (testMode) throw error;
        // Let caller handle these — no point retrying with the same payload
        if (error.name === 'TimeoutError') throw error;
        if (error.message && error.message.includes('Unable to process input image')) throw error;
        lastError = error;
        attempt += 1;
        const remaining = 2 - attempt + 1;
        log.warn(`LLM ${llm.constructor.name} attempt ${attempt} failed${remaining > 0 ? `, retrying (${remaining} left)` : ''}:`, error);
      }
    }
  }

  log.warn('All LLMs failed; throwing last error for higher-level handling.');
  throw lastError ?? new Error('Local LLM failed');
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
          if (block.type === 'media') return true;
          if (block.type === 'input_audio') return true;
          if (block.type?.startsWith?.('audio/')) return true;
          if (block.type === 'image_url') {
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
 * @param {Object} config - Config spec
 * @param {Array<string>} validScreenshots - Current screenshot data URLs
 * @param {Array<string>} previousScreenshots - Previous snapshot data URLs for context (optional)
 * @param {string} applicationActivity - Activity text
 * @param {Object|null} audioCycle - Audio cycle payload for multimodal input
 * @param {number} idleTime - Idle time in seconds
 * @param {string} provider - 'gemini' or 'openai' to determine image format
 */
function buildBlocks(config, validScreenshots, previousScreenshots, applicationActivity, audioCycle, idleTime, provider = 'gemini') {
  const spec = config.contentBlocksSpec || {};
  const imageKey = spec.imagePartKey || 'image_url';
  const blocks = [ { type: 'text', text: config.prefilledPrompt } ];

  if (applicationActivity) {
    blocks.push({ type: 'text', text: `Application Activity:\n${applicationActivity}` });
  }
  if (audioCycle && audioCycle.base64Data) {
      blocks.push({
        type: 'text',
        text: 'Recorded audio (one file for this capture cycle). Timestamps are ms since epoch:'
      });
      blocks.push({
        type: 'text',
        text: `Combined audio range ${audioCycle.cycleStartMs}-${audioCycle.cycleEndMs} from ${audioCycle.segmentCount || 1} segment(s).`
      });

      const recordingIntervals = Array.isArray(audioCycle.recordingIntervals) ? audioCycle.recordingIntervals : [];
      recordingIntervals.forEach((segment) => {
        blocks.push({
          type: 'text',
          text: `Recording interval ${segment.startMs}-${segment.endMs}`
        });
      });

      const speechIntervals = Array.isArray(audioCycle.speechIntervals) ? audioCycle.speechIntervals : [];
      if (speechIntervals.length > 0) {
        const intervals = speechIntervals
          .map(i => `[${i.startMs}-${i.endMs}]`)
          .join(', ');
        blocks.push({
          type: 'text',
          text: `Audio Context: The user was speaking during these intervals (ms): ${intervals}. All other audio is system/computer sound.`
        });
      }

      if (provider === 'gemini') {
        blocks.push({
          type: 'media',
          mimeType: audioCycle.mimeType || 'audio/webm',
          data: audioCycle.base64Data
        });
      } else {
        const openaiAudio = audioCycle.openai && audioCycle.openai.base64Data
          ? audioCycle.openai
          : null;
        if (openaiAudio) {
          blocks.push({
            type: 'input_audio',
            input_audio: {
              data: openaiAudio.base64Data,
              format: openaiAudio.format || 'wav'
            }
          });
        } else {
          log.warn('OpenAI provider selected but no WAV audio payload available; skipping audio block for this cycle');
        }
      }
  } else if (audioCycle) {
    log.warn('audioCycle present but no valid base64 payload');
  }
  
  if (idleTime !== undefined && idleTime !== null) {
    const idleMinutes = Math.floor(idleTime / 60);
    const idleSeconds = idleTime % 60;
    blocks.push({ type: 'text', text: `System Idle Time: ${idleMinutes}m ${idleSeconds}s` });
  }

  // Previous screenshots as context (from ~5 min ago)
  const prevArr = Array.isArray(previousScreenshots)
    ? previousScreenshots
    : previousScreenshots?.images?.map(i => i?.base64Data ?? i)?.filter(Boolean) ?? [];
  const validPrevScreenshots = (prevArr || [])
    .filter(img => img && typeof img === 'string' && img.startsWith('data:image/'))
    .map(img => validateAndProcessImage(img))
    .filter(img => img !== null);
  if (validPrevScreenshots.length > 0) {
    blocks.push({ type: 'text', text: 'Previous screenshots (from ~5 minutes ago):' });
    validPrevScreenshots.forEach(img => {
      const imageBlock = { type: 'image_url' };
      if (provider === 'openai') {
        imageBlock[imageKey] = { url: img };
      } else {
        imageBlock[imageKey] = img;
      }
      blocks.push(imageBlock);
    });
    blocks.push({ type: 'text', text: 'Current screenshots:' });
  }

  const processedScreenshots = validScreenshots
    .map((img, idx) => {
      const validatedImage = validateAndProcessImage(img);
      return validatedImage;
    })
    .filter(img => img !== null);

  processedScreenshots.forEach(img => {
    const imageBlock = { type: 'image_url' };
    // OpenAI-compatible APIs need { url: '...' }, Gemini needs just the string
    if (provider === 'openai') {
      imageBlock[imageKey] = { url: img };
    } else {
      imageBlock[imageKey] = img;
    }
    blocks.push(imageBlock);
  });

  // Log summary of what's being sent to LLM
  const imageBlocks = blocks.filter(b => b.type === 'image_url');

  if (processedScreenshots.length === 0) {
    blocks.push({ type: 'text', text: 'NO SCREENSHOTS PROVIDED - Processing based on activity data, audio, and other inputs only.' });
  }

  return blocks;
}

/**
 * Analyze screenshots using local LLM processing
 * @param {Array<string>} screenshots - Current screenshot data URLs
 * @param {Array<string>} previousScreenshots - Previous snapshot data URLs for context (optional)
 * @param {string} activity - Application activity text
 * @param {Object|null} audioCycle - Audio cycle payload for multimodal input
 * @param {number} idleTime - Idle time in seconds
 * @param {string} idToken - Firebase ID token
 * @param {boolean} testMode - If true, skip Firebase submission
 */
async function analyzeScreenshots(screenshots, previousScreenshots, activity, audioCycle, idleTime, idToken, testMode = false) {
  try {
    // Screenshots are optional: we can still process cycles using audio/activity/idle data.
    const screenshotList = Array.isArray(screenshots) ? screenshots : [];
    // Current screenshots come as data URLs (strings), not objects with base64Data property.
    const validScreenshots = screenshotList.filter(img => img && typeof img === 'string' && img.startsWith('data:image/'));

    // Initialize LLM if not already done
    if (!llmModels) {
      await initializeLLM(idToken, testMode);
    }
    
    // Get the local provider (use cached value if available, otherwise fetch)
    const provider = localProvider || await getLocalProvider() || 'gemini';
    
    // Ensure we have up-to-date config
    const config = latestConfig || await getConfig(idToken);
    // Build content blocks using spec with correct provider format
    const blocks = buildBlocks(config, validScreenshots, previousScreenshots, activity, audioCycle, idleTime, provider);

    // Import HumanMessage
    const { HumanMessage } = await import('@langchain/core/messages');

    // Call LLM with retry logic:
    //   - any error with audio present → log payload diagnostics, retry once without audio
    //   - image error (no audio) → retry once with fewer images
    let response;
    try {
      response = await invokeWithFallback([new HumanMessage({ content: blocks })], testMode);
    } catch (error) {
      const isImageError = error.message && error.message.includes('Unable to process input image');

      if (audioCycle) {
        const imgCount = validScreenshots.length;
        const imgBytes = validScreenshots.reduce((sum, img) => {
          const b64 = img.split(',')[1] || '';
          return sum + Math.round(b64.length * 0.75);
        }, 0);
        const audioBytes = Math.round((audioCycle.base64Data?.length || 0) * 0.75);
        const audioDurationSec = (audioCycle.cycleEndMs && audioCycle.cycleStartMs)
          ? ((audioCycle.cycleEndMs - audioCycle.cycleStartMs) / 1000).toFixed(1)
          : 'unknown';
        log.warn(`LLM failed (${error.name || 'Error'}); payload: ${imgCount} image(s) ~${(imgBytes / 1024).toFixed(0)}KB; audio ~${(audioBytes / 1024).toFixed(0)}KB ${audioDurationSec}s; total ~${((imgBytes + audioBytes) / 1024).toFixed(0)}KB`);
        log.warn('Retrying without audio payload...');
        const blocksNoAudio = buildBlocks(config, validScreenshots, previousScreenshots, activity, null, idleTime, provider);
        response = await invokeWithFallback([new HumanMessage({ content: blocksNoAudio })], testMode);
      } else if (isImageError) {
        log.warn('LLM image error; retrying with fewer images...');
        const simplifiedMessages = simplifyMessagesForRetry([new HumanMessage({ content: blocks })]);
        response = await invokeWithFallback(simplifiedMessages, testMode);
      } else {
        log.warn(`LLM failed (${error.name || 'Error'}); retrying...`);
        response = await invokeWithFallback([new HumanMessage({ content: blocks })], testMode);
      }
    }

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
async function submitResults(idToken, timestamp, structured, parameters, clientTelemetry = null) {
  try {
    const fetch = await import('node-fetch').then(module => module.default);
    
    // Prepare payload for Firebase
    const payload = {
      timestamp: timestamp,
      structured: structured,
      parameters: parameters
    };
    if (clientTelemetry) {
      payload.clientTelemetry = clientTelemetry
    }
    
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    };
    const response = await fetch(FIREBASE_PROCESS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000)
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
 * @param {Array} screenshots Screenshot data (with diff bounding boxes already applied)
 * @param {Object} inputData Input data (audio, windows, etc.). May include previousScreenshotData/clientTelemetry.
 * @param {boolean} testMode If true, skip Firebase submission
 */
async function processDataLocally(idToken, screenshots, inputData, testMode = false) {
  try {
    // Check if local processing is available
    if (!await isLocalProcessingAvailable()) {
      throw new Error('Local processing not available - no API keys or configuration');
    }

    // Format application activity
    let applicationActivity = 'No application activity data available';
    if (inputData.activity && inputData.activity.length > 0) {
      applicationActivity = inputData.activity.map(item => 
        `${item.name || 'Unknown'}: ${item.formattedDuration || (item.duration ? `${Math.round(item.duration / 1000)}s` : 'active')}`
      ).join(', ');
    }

    const audioCycle = inputData?.audioCycle ?? null;

    // Get idle time
    let idleTime = undefined;
    if (inputData.idleTime !== undefined) {
      idleTime = inputData.idleTime;
    }

    const prevImages = inputData?.previousScreenshotData?.images?.map(i => i.base64Data) ?? [];
    let structured;
    try {
      structured = await analyzeScreenshots(
        screenshots,
        prevImages,
        applicationActivity,
        audioCycle,
        idleTime,
        idToken,
        testMode
      );
    } catch (err) {
      if (shouldRethrowLocalProcessingError(err, testMode)) {
        throw err;
      }

      // Notify main window only — getAllWindows()[0] is not ordered; overlay (chat) has no listener.
      try {
        const win = getMainWindow();
        if (win) {
          win.webContents.send('request-notification', buildLocalProcessingNotification(err));
        } else {
          log.warn('Local processing error: main window unavailable for in-app notification');
        }
      } catch (e) {
        log.warn('Local processing error: failed to send notification:', e?.message || e);
      }
      // Throw canonical local-processing error marker for upstream
      throw new Error('Local Processing');
    }

    // Build parameters to send (based on config.parameters)
    const config = latestConfig || await getConfig(idToken);
    const baseParams = config.parameters || {};
    const paramsToSend = {
      ...baseParams,
      application_activity: applicationActivity || ''
    };

    // If no structured result (LLM failed after retries), skip submission this round
    if (!structured) {
      log.warn('No structured output available; skipping result submission this round.');
      return { success: false, skipped: true };
    }

    // Skip Firebase submission in test mode
    if (testMode) {
      return { success: true, test: true, structured, parameters: paramsToSend };
    }

    // Submit results to Firebase using current time
    const originalTs = Date.now();
    const result = await submitResults(
      idToken,
      originalTs,
      structured,
      paramsToSend,
      inputData?.clientTelemetry || null
    );

    return { ...result, structured, parameters: paramsToSend };
  } catch (error) {
    log.error('Error in local processing:', error);
    throw error;
  }
}

module.exports = {
  isLocalProcessingAvailable,
  getLocalProvider,
  processDataLocally,
  isTransientLocalProcessingError,
  isLocalProcessingAuthError,
  shouldRethrowLocalProcessingError,
  buildLocalProcessingNotification,
  formatLocalProcessingErrorForUser,
  // Allow main process to reset cached config and models when FE updates settings
  resetLLMModels: () => { 
    llmModels = null; 
    localProvider = null;
  }
};
