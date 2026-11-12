const log = require('electron-log');
const { getGeminiApiKey, getLocalProcessingState, getOpenAICompatibleConfig, getMainWindow } = require('./main-state');
const { recordLocalQuotaCooldownSkip, recordLocalBudgetExceeded } = require('./telemetry');
const localModel = require('./localModel');
const ocr = require('./ocrScreenshots');

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
// Model ids parallel to llmModels, for logs (the structured-output wrappers hide them)
let llmModelNames = null;
// latest config snapshot for downstream use
let latestConfig = null;
// Local provider: 'bundled', 'gemini' or 'openai'
let localProvider = null;
let skipGeminiOnceAfterQuota = false;

// Constants from online version
const CAPTION_TOKENS = 200; // Target tokens for description truncation
const MAX_OUTPUT_TOKENS = 1000; // Max tokens allowed for model output
const MAX_SCREENSHOT_SIZE = 2000000; // 2MB per screenshot
const LOCAL_LLM_MIN_CYCLE_BUDGET_MS = 60_000;
// Time kept free in each capture interval for screenshots, config fetch and result submission.
const LOCAL_LLM_CYCLE_RESERVE_MS = 60_000;
const LOCAL_LLM_BASE_ATTEMPT_TIMEOUT_MS = 120_000;
const LOCAL_LLM_MIN_ATTEMPT_TIMEOUT_MS = 3_000;
const LOCAL_BUDGET_STREAK_NOTIFY_THRESHOLD = 3;
let consecutiveLocalBudgetExceeded = 0;
const TRANSIENT_LOCAL_PROCESSING_CODES = new Set([
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
]);

// The worker rejects prompts over MAX_PROMPT_TOKENS (counted with the real tokenizer), so the
// estimate here must not undercount. Qwen's tokenizer averages ~4 chars/token on English prose
// and ~3 on code; OCR'd UI text (short words, numbers, symbols, broken lines) is denser, so 2.5
// chars/token is used, minus a safety reserve. Chat template and system prompt sit in the
// context margin the model module keeps outside MAX_PROMPT_TOKENS. If the estimate still
// undercounts (CJK, emoji-heavy screens), one rebuild at 1 char/token follows.
const BUNDLED_CHARS_PER_TOKEN = 2.5;
const BUNDLED_RETRY_CHARS_PER_TOKEN = 1;
const BUNDLED_PROMPT_SAFETY_TOKENS = 256;
// A test run may include the first model load (up to ~2 minutes), plus OCR and generation.
const BUNDLED_TEST_MIN_BUDGET_MS = 5 * 60_000;
// The model process is killed only this long after the cycle's abort, in case it ignores the abort.
const BUNDLED_REQUEST_GRACE_MS = 5_000;
const BUNDLED_MAX_REQUEST_TIMEOUT_MS = 30 * 60_000;
// OCR gets at most a quarter of the cycle budget, split across images.
const OCR_BUDGET_SHARE = 0.25;
const OCR_MIN_TIMEOUT_MS = 2_000;
const OCR_MAX_TIMEOUT_MS = 15_000;
const MIN_TRUNCATED_SECTION_CHARS = 200;
const TRUNCATION_MARKER = '\n[truncated to fit the on-device model input limit]';
const NO_IMAGES_NOTE = 'No images are attached. The activity text recognized by OCR and the window text below are provided instead.';
const DEFAULT_UI_TEXT_LABEL = 'WINDOW TEXT (accessibility):';
const DEFAULT_TEXT_BLOCK_LABELS = {
  currentScreenTextLabel: 'CURRENT ACTIVITY TEXT (OCR):',
  previousScreenTextLabel: 'PREVIOUS ACTIVITY TEXT (OCR, from the previous capture):',
  uiTextLabel: DEFAULT_UI_TEXT_LABEL
};
const BUNDLED_UNAVAILABLE_CODES = new Set(['MODEL_NOT_READY', 'UNSUPPORTED']);
const BUNDLED_ABORT_CODES = new Set(['ABORTED', 'TIMEOUT']);
const BUNDLED_WORKER_CODES = new Set(['WORKER_EXITED', 'WORKER_START_FAILED']);
let lastBundledUnavailableMessage = null;

let loadFetch = () => import('node-fetch').then(module => module.default);


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

function isGeminiQuotaError(err) {
  const { status, text } = getLocalProcessingErrorContext(err);
  const isRateLimited = status === 429 || /(429\s*too many requests|quota exceeded|rate limit)/i.test(text);
  if (!isRateLimited) {
    return false;
  }

  return /(generativelanguage\.googleapis\.com|googlegenerativeai|gemini)/i.test(text);
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
  if (isGeminiQuotaError(err)) {
    return {
      id: 'gemini-quota-exceeded',
      title: 'Gemini quota reached',
      message: 'Your Gemini API key hit a quota limit. Local processing will retry automatically on the next capture.',
      sticky: true,
      alsoNative: true
    };
  }

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

function createGeminiCooldownError() {
  const error = new Error('Gemini local processing cooldown for one cycle after quota limit');
  error.code = 'GEMINI_COOLDOWN';
  return error;
}

function base64Bytes(data) {
  if (typeof data !== 'string') return 0;
  const base64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  return Math.round(base64.length * 0.75);
}

/**
 * Describe an LLM request by size only (counts and KB), never its content.
 */
function summarizeLlmPayload(messages) {
  let imageCount = 0;
  let imageBytes = 0;
  let audioBytes = 0;
  for (const message of messages || []) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type === 'image_url') {
        const image = block.image_url;
        imageCount += 1;
        imageBytes += base64Bytes(typeof image === 'string' ? image : image?.url);
      } else if (block?.type === 'media') {
        audioBytes += base64Bytes(block.data);
      } else if (block?.type === 'input_audio') {
        audioBytes += base64Bytes(block.input_audio?.data);
      }
    }
  }
  return `${imageCount} image(s) ~${Math.round(imageBytes / 1024)}KB, audio ~${Math.round(audioBytes / 1024)}KB`;
}

function getLocalCycleBudgetMs(captureIntervalMinutes) {
  const intervalMs = Number(captureIntervalMinutes) * 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return LOCAL_LLM_MIN_CYCLE_BUDGET_MS;
  }
  return Math.max(LOCAL_LLM_MIN_CYCLE_BUDGET_MS, intervalMs - LOCAL_LLM_CYCLE_RESERVE_MS);
}

/**
 * Count a budget overrun and report whether this one should notify the user.
 * Notifies once per streak, when the streak reaches the threshold.
 */
function noteLocalBudgetExceeded() {
  consecutiveLocalBudgetExceeded += 1;
  return consecutiveLocalBudgetExceeded === LOCAL_BUDGET_STREAK_NOTIFY_THRESHOLD;
}

function resetLocalBudgetStreak() {
  consecutiveLocalBudgetExceeded = 0;
}

function buildLocalTooSlowNotification(provider = null) {
  const message = provider === 'bundled'
    ? 'The on-device model is taking too long on this computer, so recent activity was not recorded. Try a longer capture interval or another provider in Settings.'
    : 'Your local AI model is taking too long to respond, so recent activity was not recorded. Try a smaller or faster model in Settings.';
  return {
    id: 'local-processing-too-slow',
    title: 'Local model too slow',
    message,
    sticky: true,
    alsoNative: true
  };
}

function createBundledError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bundledUnavailableMessage(code, modelState) {
  if (code === 'UNSUPPORTED') {
    return 'The on-device model is not supported on this computer, so recent activity was not recorded. Choose another provider in Settings > Bring your own LLM.';
  }
  if (modelState === 'downloading') {
    return 'The on-device model is still downloading, so recent activity was not recorded. Recording resumes once the download finishes.';
  }
  if (modelState === 'verifying') {
    return 'The on-device model is being prepared (verifying the download), so recent activity was not recorded. Recording resumes once it is ready.';
  }
  return 'On-device model not downloaded yet, so recent activity was not recorded. Download it in Settings > Bring your own LLM.';
}

function bundledFailureMessage(code) {
  if (BUNDLED_WORKER_CODES.has(code)) {
    return 'The on-device model stopped unexpectedly. DoneThat will try again on the next capture.';
  }
  return 'The on-device model could not summarize this capture. DoneThat will try again on the next capture.';
}

function isBundledUnavailableError(err) {
  return BUNDLED_UNAVAILABLE_CODES.has(err?.code);
}

/**
 * Report whether this unavailable error should notify the user: once per streak, and again
 * only when the reason changes (e.g. download cancelled after it was in progress).
 */
function noteBundledUnavailable(err) {
  if (lastBundledUnavailableMessage === err.message) return false;
  lastBundledUnavailableMessage = err.message;
  return true;
}

function resetBundledUnavailableStreak() {
  lastBundledUnavailableMessage = null;
}

function buildBundledUnavailableNotification(err) {
  return {
    id: 'local-model-not-ready',
    title: 'On-device model not ready',
    message: err.message,
    sticky: true,
    alsoNative: true
  };
}

function notifyMainWindow(payload) {
  // Notify main window only — getAllWindows()[0] is not ordered; overlay (chat) has no listener.
  try {
    const win = getMainWindow();
    if (win) {
      win.webContents.send('request-notification', payload);
    } else {
      log.warn('Local processing error: main window unavailable for in-app notification');
    }
  } catch (e) {
    log.warn('Local processing error: failed to send notification:', e?.message || e);
  }
}

function createLocalBudgetExceededError() {
  const error = new Error('Local processing time budget exceeded for this cycle');
  error.code = 'LOCAL_BUDGET_EXCEEDED';
  return error;
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
 * Determine which local provider is configured. An enabled on-device model wins over API
 * providers even when it is not ready yet, so those cycles stay local (and are lost) instead of
 * silently using another provider or the cloud.
 * @returns {Promise<string|null>} 'bundled', 'gemini', 'openai' or null
 */
async function getLocalProvider() {
  try {
    const localProcessingState = await getLocalProcessingState();
    if (!localProcessingState.success) {
      return null;
    }

    if (localProcessingState.state?.bundled?.enabled) {
      return 'bundled';
    }

    // Check for Gemini key first (preferred)
    if (localProcessingState.state?.gemini?.hasKey) {
      return 'gemini';
    }

    // Check for OpenAI-compatible config
    if (localProcessingState.state?.openAICompatible?.endpoint) {
      return 'openai';
    }

    return null;
  } catch (error) {
    log.error('Error determining local provider:', error);
    return null;
  }
}

/**
 * Check if local processing is available (on-device model enabled, Gemini API key or OpenAI-compatible config)
 */
async function isLocalProcessingAvailable() {
  const provider = await getLocalProvider();
  return provider !== null;
}

/**
 * Get configuration from Firebase with caching
 */
// Provider names as reported to the backend (prompt selection, analytics); never the endpoint or key.
const SUBMITTED_PROVIDER_NAMES = {
  gemini: 'gemini',
  openai: 'openai-compatible',
  bundled: 'on-device'
};
const MAX_REPORTED_MODEL_LENGTH = 200;

/**
 * The provider and model this computer processes with, so the backend can pick a prompt
 * suited to it. Gemini models come from the backend's own config, so Gemini sends no model.
 * @returns {Promise<{provider: string|null, model: string|null}>}
 */
async function describeClientModel() {
  const provider = await getLocalProvider();
  let model = null;
  if (provider === 'bundled') {
    model = localModel.getModelInfo()?.id || null;
  } else if (provider === 'openai') {
    try {
      model = (await getOpenAICompatibleConfig())?.config?.model || null;
    } catch (error) {
      log.warn('Could not read the OpenAI-compatible model for the config request:', error?.name || 'Error');
    }
  }
  return {
    provider: SUBMITTED_PROVIDER_NAMES[provider] || null,
    model: typeof model === 'string' && model.trim() ? model.trim().slice(0, MAX_REPORTED_MODEL_LENGTH) : null
  };
}

function buildConfigUrl({ provider, model }) {
  const params = new URLSearchParams();
  if (provider) params.set('provider', provider);
  if (model) params.set('model', model);
  const query = params.toString();
  return query ? `${FIREBASE_CONFIG_URL}?${query}` : FIREBASE_CONFIG_URL;
}

async function getConfig(idToken) {
  const now = Date.now();
  const clientModel = await describeClientModel();
  const cacheKey = `${clientModel.provider || ''}|${clientModel.model || ''}`;

  // Return cached config if still valid and fetched for the same provider and model
  if (configCache.data && configCache.key === cacheKey && (now - configCache.lastFetch) < configCache.fetchInterval) {
    return configCache.data;
  }

  try {
    const fetch = await loadFetch();
    
    const response = await fetch(buildConfigUrl(clientModel), {
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
    configCache.key = cacheKey;
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
      llmModelNames = geminiModels.map(m => m.model);
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
      llmModelNames = [openaiCompat.config.model];
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
async function invokeWithFallback(messages, testMode = false, options = {}) {
  if (!llmModels || llmModels.length === 0) {
    throw new Error('No LLM models available');
  }

  let lastError = null;
  const deadlineMs = Number(options.deadlineMs) || 0;
  const hasDeadline = Number.isFinite(deadlineMs) && deadlineMs > 0;
  const payloadSummary = summarizeLlmPayload(messages);

  for (const [modelIndex, llm] of llmModels.entries()) {
    const modelName = llmModelNames?.[modelIndex] || 'unknown';
    let attempt = 0;
    while (attempt <= 2) {
      let attemptTimeoutMs = LOCAL_LLM_BASE_ATTEMPT_TIMEOUT_MS;
      const attemptStartedAt = Date.now();
      try {
        if (hasDeadline) {
          const remainingMs = deadlineMs - Date.now();
          if (remainingMs <= 0) {
            throw createLocalBudgetExceededError();
          }
          // The cycle deadline bounds every attempt, so one slow call may use all remaining time.
          attemptTimeoutMs = Math.max(LOCAL_LLM_MIN_ATTEMPT_TIMEOUT_MS, remainingMs);
        }

        const response = await llm.invoke(messages, { signal: AbortSignal.timeout(attemptTimeoutMs) });
        log.info(`[local-llm] ${localProvider} ${modelName} ok in ${Date.now() - attemptStartedAt}ms (attempt ${attempt + 1}, timeout ${attemptTimeoutMs}ms, ${payloadSummary})`);
        return response;
      } catch (error) {
        if (error?.code !== 'LOCAL_BUDGET_EXCEEDED') {
          log.warn(`[local-llm] ${localProvider} ${modelName} failed after ${Date.now() - attemptStartedAt}ms (${error?.name || 'Error'}, attempt ${attempt + 1}, timeout ${attemptTimeoutMs}ms, ${payloadSummary})`);
        }
        if (testMode) throw error;
        if (error?.code === 'LOCAL_BUDGET_EXCEEDED') throw error;
        if (hasDeadline && (deadlineMs - Date.now()) <= 0) {
          throw createLocalBudgetExceededError();
        }
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
 * @param {Object|null} uiText - Window text (accessibility) payload for this cycle
 */
function buildBlocks(config, validScreenshots, previousScreenshots, applicationActivity, audioCycle, idleTime, provider = 'gemini', uiText = null) {
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
    blocks.push({ type: 'text', text: formatIdleTime(idleTime) });
  }

  const windowText = formatUiText(uiText);
  if (windowText) {
    const label = config.textContentBlocksSpec?.uiTextLabel || DEFAULT_UI_TEXT_LABEL;
    blocks.push({ type: 'text', text: `${label}\n${windowText}` });
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

function formatIdleTime(idleTime) {
  const idleMinutes = Math.floor(idleTime / 60);
  const idleSeconds = idleTime % 60;
  return `System Idle Time: ${idleMinutes}m ${idleSeconds}s`;
}

/**
 * Format window text (accessibility) entries as `[App — Title]\ntext` blocks.
 */
function formatUiText(uiText) {
  const entries = Array.isArray(uiText?.entries) ? uiText.entries : [];
  const parts = entries
    .filter(entry => typeof entry?.text === 'string' && entry.text.trim())
    .map(entry => {
      const app = typeof entry.app === 'string' && entry.app.trim() ? entry.app.trim() : 'Unknown app';
      const title = typeof entry.windowTitle === 'string' && entry.windowTitle.trim() ? entry.windowTitle.trim() : null;
      return `${title ? `[${app} — ${title}]` : `[${app}]`}\n${entry.text.trim()}`;
    });
  if (parts.length === 0) return '';
  const text = parts.join('\n\n');
  return uiText.truncated ? `${text}\n[window text truncated]` : text;
}

function formatScreenText(ocrResults) {
  const texts = (ocrResults || []).map(result => (typeof result?.text === 'string' ? result.text.trim() : ''));
  if (texts.length <= 1) return texts[0] || '';
  return texts
    .map((text, index) => (text ? `Display ${index + 1}:\n${text}` : ''))
    .filter(Boolean)
    .join('\n\n');
}

function filterImageDataUrls(images) {
  return (Array.isArray(images) ? images : []).filter(img => typeof img === 'string' && img.startsWith('data:image/'));
}

function truncateWithMarker(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length));
  const lastBreak = cut.lastIndexOf('\n');
  const kept = lastBreak > cut.length * 0.8 ? cut.slice(0, lastBreak) : cut;
  return { text: `${kept}${TRUNCATION_MARKER}`, truncated: true };
}

function pickTextBlockLabels(spec) {
  const labels = { ...DEFAULT_TEXT_BLOCK_LABELS };
  for (const key of Object.keys(labels)) {
    if (typeof spec?.[key] === 'string' && spec[key].trim()) labels[key] = spec[key].trim();
  }
  return labels;
}

/**
 * Build the single text prompt for the on-device model and fit it into its input limit.
 * Truncation priority: instructions and activity are kept, then current screen text, then
 * window text, then previous screen text. Cut or dropped sections are marked in the text.
 * @param {Object} config inputConfig response
 * @param {{ applicationActivity: string, idleTime?: number, currentScreenText: string,
 *   previousScreenText: string, windowText: string }} inputs
 * @param {number} charsPerToken Estimate used to turn the token limit into a char budget
 * @returns {{ prompt: string, truncatedSections: string[] }}
 */
function buildBundledPrompt(config, inputs, charsPerToken = BUNDLED_CHARS_PER_TOKEN) {
  const separator = '\n\n';
  const labels = pickTextBlockLabels(config.textContentBlocksSpec);
  const instructions = config.textPrefilledPrompt || `${config.prefilledPrompt || ''}${separator}${NO_IMAGES_NOTE}`;
  const activityLabel = 'Application Activity:\n';
  const idleSection = inputs.idleTime !== undefined && inputs.idleTime !== null ? formatIdleTime(inputs.idleTime) : null;
  const maxChars = Math.floor((localModel.MAX_PROMPT_TOKENS - BUNDLED_PROMPT_SAFETY_TOKENS) * charsPerToken);
  const truncatedSections = [];

  let remaining = maxChars - instructions.length - separator.length - activityLabel.length
    - (idleSection ? separator.length + idleSection.length : 0);

  const activity = truncateWithMarker(inputs.applicationActivity || '', Math.max(0, remaining));
  if (activity.truncated) truncatedSections.push('activity');
  remaining -= activity.text.length;

  const fitSection = (name, label, body) => {
    if (!body) return null;
    const overhead = separator.length + label.length + 1;
    const room = remaining - overhead;
    if (body.length > room && room < MIN_TRUNCATED_SECTION_CHARS) {
      truncatedSections.push(name);
      const omitted = TRUNCATION_MARKER.trim();
      if (room < omitted.length) return null;
      remaining -= overhead + omitted.length;
      return `${label}\n${omitted}`;
    }
    const fitted = truncateWithMarker(body, room);
    if (fitted.truncated) truncatedSections.push(name);
    remaining -= overhead + fitted.text.length;
    return `${label}\n${fitted.text}`;
  };

  const currentSection = fitSection('current', labels.currentScreenTextLabel, inputs.currentScreenText);
  const windowSection = fitSection('window', labels.uiTextLabel, inputs.windowText);
  const previousSection = fitSection('previous', labels.previousScreenTextLabel, inputs.previousScreenText);

  const prompt = [
    instructions,
    `${activityLabel}${activity.text}`,
    idleSection,
    currentSection,
    previousSection,
    windowSection
  ].filter(Boolean).join(separator);
  return { prompt, truncatedSections };
}

function getOcrTimeoutMs(cycleBudgetMs, imageCount) {
  if (imageCount <= 0) return OCR_MAX_TIMEOUT_MS;
  const share = Math.floor((cycleBudgetMs * OCR_BUDGET_SHARE) / imageCount);
  return Math.min(OCR_MAX_TIMEOUT_MS, Math.max(OCR_MIN_TIMEOUT_MS, share));
}

function getBundledUnavailableError() {
  if (!localModel.isBundledSupported() || !ocr.isOcrSupported()) {
    return createBundledError('UNSUPPORTED', bundledUnavailableMessage('UNSUPPORTED'));
  }
  const modelState = localModel.getModelStatus()?.state;
  if (modelState !== 'ready') {
    return createBundledError('MODEL_NOT_READY', bundledUnavailableMessage('MODEL_NOT_READY', modelState));
  }
  return null;
}

/**
 * Map an on-device model failure to a budget overrun or a coded error with a user-safe message.
 */
function toBundledGenerationError(error, deadlineMs) {
  if (error?.code === 'LOCAL_BUDGET_EXCEEDED') return error;
  const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError' || BUNDLED_ABORT_CODES.has(error?.code);
  if (aborted || Date.now() >= deadlineMs) return createLocalBudgetExceededError();
  const code = typeof error?.code === 'string' && error.code ? error.code : 'GENERATION_FAILED';
  if (BUNDLED_UNAVAILABLE_CODES.has(code)) {
    return createBundledError(code, bundledUnavailableMessage(code, localModel.getModelStatus()?.state));
  }
  return createBundledError(code, bundledFailureMessage(code));
}

// Character caps the on-device grammar enforces, so a rambling model has to
// close the JSON well before the output token limit. DESCRIPTION matches the
// caption truncation applied afterwards.
const BUNDLED_FIELD_MAX_CHARS = {
  CATEGORY: 80,
  ONELINE: 120,
  DESCRIPTION: CAPTION_TOKENS * 4
};
const BUNDLED_DEFAULT_FIELD_MAX_CHARS = 400;

function boundBundledOutputSchema(schema) {
  if (!schema?.properties || typeof schema.properties !== 'object') return schema;
  const properties = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const unbounded = property?.type === 'string' && !Array.isArray(property.enum) && typeof property.maxLength !== 'number';
    properties[name] = unbounded
      ? { ...property, maxLength: BUNDLED_FIELD_MAX_CHARS[name] || BUNDLED_DEFAULT_FIELD_MAX_CHARS }
      : property;
  }
  return { ...schema, properties };
}

async function generateBundled(prompt, schema, deadlineMs) {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw createLocalBudgetExceededError();
  try {
    return await localModel.generateStructured({
      prompt,
      schema: boundBundledOutputSchema(schema),
      signal: AbortSignal.timeout(remainingMs),
      timeoutMs: Math.min(remainingMs + BUNDLED_REQUEST_GRACE_MS, BUNDLED_MAX_REQUEST_TIMEOUT_MS),
      maxTokens: localModel.MAX_OUTPUT_TOKENS
    });
  } catch (error) {
    log.warn(`[local-llm] on-device generation failed (${error?.code || error?.name || 'ERROR'}) with ${Math.max(0, deadlineMs - Date.now())} ms of the cycle budget left`);
    throw toBundledGenerationError(error, deadlineMs);
  }
}

/**
 * Summarize a cycle with the on-device model from text only: OCR of the (already masked)
 * current and previous screenshots, window text, activity and idle time. Audio is not used.
 * Recognized text stays in memory for this call and is never logged.
 */
async function analyzeWithBundledModel({ screenshots, previousScreenshots, applicationActivity, idleTime, uiText, idToken, cycleBudgetMs }) {
  const unavailableError = getBundledUnavailableError();
  if (unavailableError) throw unavailableError;

  const config = await getConfig(idToken);
  if (!config?.outputSchema) {
    throw createBundledError('INVALID_SCHEMA', bundledFailureMessage('INVALID_SCHEMA'));
  }
  const deadlineMs = Date.now() + cycleBudgetMs;

  const currentImages = filterImageDataUrls(screenshots);
  const previousImages = filterImageDataUrls(previousScreenshots);
  const ocrTimeoutMs = getOcrTimeoutMs(cycleBudgetMs, currentImages.length + previousImages.length);
  const ocrStartedAt = Date.now();
  const currentScreenText = formatScreenText(await ocr.ocrImages(currentImages, { timeoutMs: ocrTimeoutMs }));
  const previousScreenText = formatScreenText(await ocr.ocrImages(previousImages, { timeoutMs: ocrTimeoutMs }));
  const ocrMs = Date.now() - ocrStartedAt;
  if (Date.now() >= deadlineMs) throw createLocalBudgetExceededError();

  const inputs = {
    applicationActivity,
    idleTime,
    currentScreenText: currentScreenText
      || (currentImages.length > 0 ? 'none (no text recognized)' : 'none (no captures this cycle)'),
    previousScreenText,
    windowText: formatUiText(uiText)
  };
  let { prompt, truncatedSections } = buildBundledPrompt(config, inputs);
  const startedAt = Date.now();
  let response;
  try {
    response = await generateBundled(prompt, config.outputSchema, deadlineMs);
  } catch (error) {
    if (error?.code !== 'PROMPT_TOO_LONG') throw error;
    log.warn(`[local-llm] bundled prompt over the token limit (${prompt.length} chars); rebuilding once with a tighter estimate`);
    ({ prompt, truncatedSections } = buildBundledPrompt(config, inputs, BUNDLED_RETRY_CHARS_PER_TOKEN));
    response = await generateBundled(prompt, config.outputSchema, deadlineMs);
  }
  log.info(`[local-llm] bundled ok in ${Date.now() - startedAt}ms (OCR ${currentImages.length}+${previousImages.length} image(s) in ${ocrMs}ms, screen text ${currentScreenText.length}+${previousScreenText.length} chars, window text ${inputs.windowText.length} chars, prompt ${prompt.length} chars${truncatedSections.length > 0 ? `, truncated: ${truncatedSections.join(',')}` : ''})`);

  if (!response || typeof response !== 'object') {
    throw createBundledError('INVALID_OUTPUT', bundledFailureMessage('INVALID_OUTPUT'));
  }
  if (typeof response.DESCRIPTION === 'string') {
    response.DESCRIPTION = truncateToTokens(response.DESCRIPTION, CAPTION_TOKENS);
  }
  return response;
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
 * @param {Object} options - { cycleBudgetMs, uiText } time allowed for all LLM attempts this cycle, window text
 */
async function analyzeScreenshots(screenshots, previousScreenshots, activity, audioCycle, idleTime, idToken, testMode = false, options = {}) {
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
    const uiText = options.uiText ?? null;
    const blocks = buildBlocks(config, validScreenshots, previousScreenshots, activity, audioCycle, idleTime, provider, uiText);

    // Import HumanMessage
    const { HumanMessage } = await import('@langchain/core/messages');
    const cycleBudgetMs = Number(options.cycleBudgetMs) || LOCAL_LLM_MIN_CYCLE_BUDGET_MS;
    const localCycleDeadlineMs = Date.now() + cycleBudgetMs;

    // Call LLM with retry logic:
    //   - any error with audio present → log payload diagnostics, retry once without audio
    //   - image error (no audio) → retry once with fewer images
    let response;
    try {
      response = await invokeWithFallback(
        [new HumanMessage({ content: blocks })],
        testMode,
        { deadlineMs: localCycleDeadlineMs }
      );
    } catch (error) {
      if (error?.code === 'LOCAL_BUDGET_EXCEEDED') {
        throw error;
      }
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
        const blocksNoAudio = buildBlocks(config, validScreenshots, previousScreenshots, activity, null, idleTime, provider, uiText);
        response = await invokeWithFallback(
          [new HumanMessage({ content: blocksNoAudio })],
          testMode,
          { deadlineMs: localCycleDeadlineMs }
        );
      } else if (isImageError) {
        log.warn('LLM image error; retrying with fewer images...');
        const simplifiedMessages = simplifyMessagesForRetry([new HumanMessage({ content: blocks })]);
        response = await invokeWithFallback(
          simplifiedMessages,
          testMode,
          { deadlineMs: localCycleDeadlineMs }
        );
      } else {
        log.warn(`LLM failed (${error.name || 'Error'}); retrying...`);
        response = await invokeWithFallback(
          [new HumanMessage({ content: blocks })],
          testMode,
          { deadlineMs: localCycleDeadlineMs }
        );
      }
    }

    // A successful HTTP call can still yield nothing: the structured-output parser returns
    // undefined (no throw) when the provider ignores response_format or omits tool calls.
    if (!response) {
      throw new Error('The model returned no usable output. Check that your endpoint supports JSON schema responses or tool calling, and that the model id is correct.');
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

async function submitResults(idToken, timestamp, structured, parameters, clientTelemetry = null, location = null, provider = null) {
  try {
    const fetch = await loadFetch();
    
    // Prepare payload for Firebase
    const payload = {
      timestamp: timestamp,
      structured: structured,
      parameters: parameters
    };
    const localProvider = SUBMITTED_PROVIDER_NAMES[provider];
    if (localProvider) {
      payload.localProvider = localProvider
    }
    if (clientTelemetry) {
      payload.clientTelemetry = clientTelemetry
    }
    if (location) {
      payload.location = location
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
    const provider = await getLocalProvider();
    if (!provider) {
      throw new Error('Local processing not available - no API keys or configuration');
    }

    if (skipGeminiOnceAfterQuota && provider !== 'bundled') {
      skipGeminiOnceAfterQuota = false;
      recordLocalQuotaCooldownSkip();
      throw createGeminiCooldownError();
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
    const uiText = inputData?.uiText ?? null;
    const cycleBudgetMs = getLocalCycleBudgetMs(inputData?.captureIntervalMinutes);
    let structured;
    try {
      if (provider === 'bundled') {
        structured = await analyzeWithBundledModel({
          screenshots,
          previousScreenshots: prevImages,
          applicationActivity,
          idleTime,
          uiText,
          idToken,
          cycleBudgetMs: testMode ? Math.max(cycleBudgetMs, BUNDLED_TEST_MIN_BUDGET_MS) : cycleBudgetMs
        });
      } else {
        structured = await analyzeScreenshots(
          screenshots,
          prevImages,
          applicationActivity,
          audioCycle,
          idleTime,
          idToken,
          testMode,
          { cycleBudgetMs, uiText }
        );
      }
      resetLocalBudgetStreak();
      resetBundledUnavailableStreak();
    } catch (err) {
      if (shouldRethrowLocalProcessingError(err, testMode)) {
        throw err;
      }

      if (isGeminiQuotaError(err)) {
        // Cool down local Gemini for next cycle only; do not switch provider paths.
        skipGeminiOnceAfterQuota = true;
      }

      if (err?.code === 'LOCAL_BUDGET_EXCEEDED') {
        recordLocalBudgetExceeded();
        const shouldNotify = noteLocalBudgetExceeded();
        log.warn(`Local processing budget exceeded (${consecutiveLocalBudgetExceeded} in a row); skipping local processing for this cycle.`);
        if (shouldNotify) {
          notifyMainWindow(buildLocalTooSlowNotification(provider));
        }
      } else if (isBundledUnavailableError(err)) {
        log.warn(`On-device model unavailable (${err.code}); skipping local processing for this cycle.`);
        if (noteBundledUnavailable(err)) {
          notifyMainWindow(buildBundledUnavailableNotification(err));
        }
      } else if (err?.code !== 'GEMINI_COOLDOWN') {
        notifyMainWindow(buildLocalProcessingNotification(err));
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
      inputData?.clientTelemetry || null,
      inputData?.location || null,
      provider
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
  getLocalCycleBudgetMs,
  noteLocalBudgetExceeded,
  resetLocalBudgetStreak,
  summarizeLlmPayload,
  // Allow main process to reset cached config and models when FE updates settings
  resetLLMModels: () => {
    llmModels = null;
    llmModelNames = null;
    localProvider = null;
    resetBundledUnavailableStreak();
  },
  __test__: {
    buildBlocks,
    buildBundledPrompt,
    boundBundledOutputSchema,
    getConfig,
    formatUiText,
    getOcrTimeoutMs,
    setFetchLoader(loader) {
      loadFetch = loader;
    },
    resetState() {
      configCache.data = null;
      configCache.lastFetch = 0;
      configCache.key = null;
      latestConfig = null;
      llmModels = null;
      llmModelNames = null;
      localProvider = null;
      skipGeminiOnceAfterQuota = false;
      resetLocalBudgetStreak();
      resetBundledUnavailableStreak();
    }
  }
};
