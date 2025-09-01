const log = require('electron-log');
const { getGeminiApiKey } = require('./main-state');

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

/**
 * Check if local processing is available (has Gemini API key)
 */
async function isLocalProcessingAvailable() {
  try {
    const result = await getGeminiApiKey();
    return result.success && result.apiKey;
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
    latestConfig = configCache.data;
    return latestConfig;
  }

  try {
    const fetch = await import('node-fetch').then(module => module.default);
    
    const headers = {
      'Authorization': `Bearer ${idToken}`
    };
    const response = await fetch(FIREBASE_CONFIG_URL, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch config: ${response.status}`);
    }

    const config = await response.json();
    
    if (!config.success) {
      throw new Error('Config fetch returned error');
    }

    // Cache the config
    configCache.data = config;
    configCache.lastFetch = now;
    latestConfig = config;
    
    return latestConfig;
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
    
    // Get Gemini API key
    const geminiResult = await getGeminiApiKey();
    if (!geminiResult.success || !geminiResult.apiKey) {
      throw new Error('No valid Gemini API key available');
    }
    
    // Initialize LLM models based on config (only Gemini)
    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    
    llmModels = config.llmModels
      .filter(modelConfig => modelConfig.provider === 'gemini')
      .map(modelConfig => new ChatGoogleGenerativeAI({
          apiKey: geminiResult.apiKey,
          model: modelConfig.model,
          maxOutputTokens: modelConfig.maxOutputTokens || 300
        }).withStructuredOutput(config.outputSchema)
      );
    
  } catch (error) {
    log.error('Error initializing LLM:', error);
    throw error;
  }
}

/**
 * Invoke LLM with fallback through multiple models
 */
async function invokeWithFallback(messages) {
  if (!llmModels || llmModels.length === 0) {
    throw new Error('No LLM models available');
  }

  const maxAttemptsPerModel = 3; // initial + 2 retries

  for (const llm of llmModels) {
    let attempt = 0;
    while (attempt < maxAttemptsPerModel) {
      try {
        const response = await llm.invoke(messages);
        return response;
      } catch (error) {
        attempt += 1;
        const remaining = maxAttemptsPerModel - attempt;
        log.warn(`LLM ${llm.constructor.name} attempt ${attempt} failed${remaining > 0 ? `, retrying (${remaining} left)` : ''}:`, error);
        if (attempt >= maxAttemptsPerModel) {
          break;
        }
      }
    }
  }

  log.warn('All LLMs failed after retries; will skip this round.');
  return null;
}

/**
 * Build content blocks based on config spec
 */
function buildBlocks(config, validScreenshots, previousScreenshots, applicationActivity, audioTranscript) {
  const spec = config.contentBlocksSpec || {};
  const imageKey = spec.imagePartKey || 'image_url';
  const blocks = [ { type: 'text', text: config.prefilledPrompt } ];

  if (applicationActivity) {
    blocks.push({ type: 'text', text: `Application Activity:\n${applicationActivity}` });
  }
  if (audioTranscript) {
    blocks.push({ type: 'text', text: `Audio Transcript:\n${audioTranscript}` });
  }

  if (previousScreenshots && previousScreenshots.images && previousScreenshots.images.length > 0) {
    blocks.push({ type: 'text', text: spec.previousLabel || 'PREVIOUS SCREENSHOTS (from 5 minutes ago):' });
    previousScreenshots.images.forEach(img => {
      if (img && img.base64Data) {
        const url = img.base64Data.startsWith('data:image') ? img.base64Data : `data:image/jpeg;base64,${img.base64Data}`;
        const imageBlock = { type: 'image_url' };
        imageBlock[imageKey] = url;
        blocks.push(imageBlock);
      }
    });
    blocks.push({ type: 'text', text: spec.currentLabel || 'CURRENT SCREENSHOTS:' });
  }

  validScreenshots.forEach(img => {
    const imageBlock = { type: 'image_url' };
    imageBlock[imageKey] = img; // already a data URL
    blocks.push(imageBlock);
  });

  return blocks;
}

/**
 * Analyze screenshots using local LLM processing
 */
async function analyzeScreenshots(screenshots, previousScreenshots, activity, audioTranscript, idToken) {
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
      await initializeLLM(idToken);
    }
    
    // Ensure we have up-to-date config
    const config = latestConfig || await getConfig(idToken);
    // Build content blocks using spec
    const blocks = buildBlocks(config, validScreenshots, previousScreenshots, activity, audioTranscript);

    // Import HumanMessage
    const { HumanMessage } = await import('@langchain/core/messages');

    // Call LLM with fallback and retries
    const response = await invokeWithFallback([
      new HumanMessage({ content: blocks })
    ]);

    // If all LLMs failed, skip this round
    if (!response) {
      log.warn('Skipping analysis this round due to repeated LLM failures.');
      return null;
    }

    // Structured object is returned directly by withStructuredOutput
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
      throw new Error(`Failed to submit results: ${response.status}`);
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
 */
async function processDataLocally(idToken, screenshots, previousScreenshots, inputData) {
  try {
    // Check if local processing is available
    if (!await isLocalProcessingAvailable()) {
      throw new Error('Local processing not available - no Gemini API key');
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

    // Analyze screenshots locally
    const structured = await analyzeScreenshots(
      screenshots,
      previousScreenshots,
      applicationActivity,
      audioTranscript,
      idToken
    );

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
  processDataLocally
};
