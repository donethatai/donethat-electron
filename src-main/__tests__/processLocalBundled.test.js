jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../main-state', () => ({
  getGeminiApiKey: jest.fn(),
  getLocalProcessingState: jest.fn(),
  getOpenAICompatibleConfig: jest.fn(),
  getMainWindow: jest.fn()
}));

jest.mock('../telemetry', () => ({
  recordLocalQuotaCooldownSkip: jest.fn(),
  recordLocalBudgetExceeded: jest.fn()
}));

jest.mock('../localModel', () => {
  const { MAX_PROMPT_TOKENS, MAX_OUTPUT_TOKENS } = jest.requireActual('../localModel/modelInfo');
  return {
    generateStructured: jest.fn(),
    getModelInfo: jest.fn(() => ({ id: 'qwen3.5-2b-q4_k_m' })),
    getModelStatus: jest.fn(),
    isBundledSupported: jest.fn(),
    MAX_PROMPT_TOKENS,
    MAX_OUTPUT_TOKENS
  };
});

jest.mock('../ocrScreenshots', () => ({
  ocrImages: jest.fn(),
  isOcrSupported: jest.fn()
}));

const log = require('electron-log');
const mainState = require('../main-state');
const telemetry = require('../telemetry');
const localModel = require('../localModel');
const ocr = require('../ocrScreenshots');
const processLocal = require('../processLocal');

const { processDataLocally, getLocalProvider, isLocalProcessingAvailable, resetLLMModels, __test__ } = processLocal;

const CURRENT_SHOT = 'data:image/jpeg;base64,Q1VSUkVOVA==';
const PREVIOUS_SHOT = 'data:image/jpeg;base64,UFJFVklPVVM=';
const OCR_CURRENT_SECRET = 'OCR-CURRENT-SECRET invoice 4711';
const OCR_PREVIOUS_SECRET = 'OCR-PREVIOUS-SECRET draft notes';
const UI_TEXT_SECRET = 'UITEXT-SECRET reply to Anna';
const AUDIO_SECRET = 'QVVESU8tU0VDUkVU';
const SCHEMA = { type: 'object', properties: { ONELINE: { type: 'string' }, DESCRIPTION: { type: 'string' }, CATEGORY: { type: 'string' } } };

function baseConfig(overrides = {}) {
  return {
    success: true,
    prefilledPrompt: 'IMAGE PROMPT: caption the screenshots.',
    textPrefilledPrompt: 'TEXT PROMPT: caption the screen text.',
    textContentBlocksSpec: {
      currentScreenTextLabel: 'CURRENT ACTIVITY TEXT (OCR):',
      previousScreenTextLabel: 'PREVIOUS ACTIVITY TEXT (OCR, from 5 minutes ago):',
      uiTextLabel: 'WINDOW TEXT (accessibility):'
    },
    outputSchema: SCHEMA,
    parameters: { user_name: 'Sam', application_activity: '', audio_transcript: '', selectedCategories: [] },
    ...overrides
  };
}

function uiTextPayload() {
  return {
    entries: [
      { app: 'Mail', windowTitle: 'Inbox', text: UI_TEXT_SECRET, capturedAtMs: 1 },
      { app: 'Notes', windowTitle: null, text: 'shopping list', capturedAtMs: 2 }
    ],
    truncated: false
  };
}

function cycleInput(overrides = {}) {
  return {
    activity: [{ name: 'Mail', formattedDuration: '3m' }],
    idleTime: 75,
    uiText: uiTextPayload(),
    audioCycle: { base64Data: AUDIO_SECRET, mimeType: 'audio/webm', cycleStartMs: 0, cycleEndMs: 1000 },
    previousScreenshotData: { timestamp: 1, images: [{ base64Data: PREVIOUS_SHOT, index: 0 }] },
    clientTelemetry: { cycles: 1 },
    captureIntervalMinutes: 5,
    ...overrides
  };
}

let fetchMock;
let notificationSend;
let config;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function processRequests() {
  return fetchMock.mock.calls.filter(([url]) => url.includes('inputProcess'));
}

function sentNotifications() {
  return notificationSend.mock.calls.map(([, payload]) => payload);
}

function lastPrompt() {
  const calls = localModel.generateStructured.mock.calls;
  return calls[calls.length - 1][0].prompt;
}

function allLogText() {
  return [log.info, log.warn, log.error, log.debug]
    .flatMap(fn => fn.mock.calls)
    .map(args => args.map(arg => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(' '))
    .join('\n');
}

function setLocalState(state) {
  mainState.getLocalProcessingState.mockResolvedValue({ success: true, state });
}

beforeEach(() => {
  jest.clearAllMocks();
  __test__.resetState();
  config = baseConfig();
  fetchMock = jest.fn(async (url) => {
    if (url.includes('inputConfig')) return jsonResponse(config);
    if (url.includes('inputProcess')) return jsonResponse({ success: true });
    throw new Error(`unexpected url ${url}`);
  });
  __test__.setFetchLoader(async () => fetchMock);
  notificationSend = jest.fn();
  mainState.getMainWindow.mockReturnValue({ webContents: { send: notificationSend } });
  setLocalState({ bundled: { enabled: true }, gemini: { hasKey: false }, openAICompatible: { endpoint: null } });
  localModel.isBundledSupported.mockReturnValue(true);
  localModel.getModelStatus.mockReturnValue({ state: 'ready', receivedBytes: 0, totalBytes: 0, error: null });
  localModel.generateStructured.mockResolvedValue({ ONELINE: 'Answering mail', DESCRIPTION: 'Mail triage', CATEGORY: 'Communication' });
  ocr.isOcrSupported.mockReturnValue(true);
  ocr.ocrImages.mockImplementation(async (images) => images.map((image) => ({
    text: image === CURRENT_SHOT ? OCR_CURRENT_SECRET : OCR_PREVIOUS_SECRET
  })));
});

describe('config request', () => {
  function configUrls() {
    return fetchMock.mock.calls.map(([url]) => url).filter((url) => url.includes('inputConfig'));
  }

  test('tells the backend the on-device model so it can pick a matching prompt', async () => {
    await __test__.getConfig('token');
    expect(new URL(configUrls()[0]).searchParams.toString()).toBe('provider=on-device&model=qwen3.5-2b-q4_k_m');
  });

  test('sends the OpenAI-compatible model name but never the endpoint or key', async () => {
    setLocalState({ bundled: { enabled: false }, gemini: { hasKey: false }, openAICompatible: { endpoint: 'https://llm.example' } });
    mainState.getOpenAICompatibleConfig.mockResolvedValue({ config: { endpoint: 'https://llm.example', apiKey: 'sk-secret', model: ' llama3.1:8b ' } });

    await __test__.getConfig('token');

    const url = configUrls()[0];
    expect(new URL(url).searchParams.toString()).toBe('provider=openai-compatible&model=llama3.1%3A8b');
    expect(url).not.toContain('llm.example');
    expect(url).not.toContain('sk-secret');
  });

  test('sends only the provider for Gemini, whose models come from the backend', async () => {
    setLocalState({ bundled: { enabled: false }, gemini: { hasKey: true }, openAICompatible: { endpoint: null } });
    await __test__.getConfig('token');
    expect(new URL(configUrls()[0]).searchParams.toString()).toBe('provider=gemini');
  });

  test('refetches when the provider or model changes instead of reusing the cached prompt', async () => {
    await __test__.getConfig('token');
    await __test__.getConfig('token');
    expect(configUrls()).toHaveLength(1);

    setLocalState({ bundled: { enabled: false }, gemini: { hasKey: true }, openAICompatible: { endpoint: null } });
    await __test__.getConfig('token');
    expect(configUrls()).toHaveLength(2);
  });
});

describe('local provider selection', () => {
  test('an enabled on-device model takes precedence over Gemini and OpenAI-compatible', async () => {
    setLocalState({ bundled: { enabled: true }, gemini: { hasKey: true }, openAICompatible: { endpoint: 'http://x' } });
    await expect(getLocalProvider()).resolves.toBe('bundled');
  });

  test('falls back to the API providers only when the on-device model is disabled', async () => {
    setLocalState({ bundled: { enabled: false }, gemini: { hasKey: true }, openAICompatible: { endpoint: 'http://x' } });
    await expect(getLocalProvider()).resolves.toBe('gemini');
    setLocalState({ bundled: { enabled: false }, gemini: { hasKey: false }, openAICompatible: { endpoint: 'http://x' } });
    await expect(getLocalProvider()).resolves.toBe('openai');
    setLocalState({ gemini: { hasKey: false }, openAICompatible: { endpoint: null } });
    await expect(getLocalProvider()).resolves.toBeNull();
  });

  test('local processing counts as available with only the on-device model enabled', async () => {
    await expect(isLocalProcessingAvailable()).resolves.toBe(true);
  });
});

describe('on-device model not ready', () => {
  test('loses the cycle without any other provider or upload and notifies once per streak', async () => {
    localModel.getModelStatus.mockReturnValue({ state: 'absent', receivedBytes: 0, totalBytes: 0, error: null });
    setLocalState({ bundled: { enabled: true }, gemini: { hasKey: true }, openAICompatible: { endpoint: 'http://x' } });

    await expect(processDataLocally('token', [CURRENT_SHOT], cycleInput())).rejects.toThrow('Local Processing');
    await expect(processDataLocally('token', [CURRENT_SHOT], cycleInput())).rejects.toThrow('Local Processing');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(localModel.generateStructured).not.toHaveBeenCalled();
    expect(ocr.ocrImages).not.toHaveBeenCalled();
    expect(mainState.getGeminiApiKey).not.toHaveBeenCalled();
    expect(sentNotifications()).toEqual([
      expect.objectContaining({ id: 'local-model-not-ready', message: expect.stringContaining('Settings > Bring your own LLM') })
    ]);
  });

  test('notifies again when the reason changes or after a settings reset', async () => {
    localModel.getModelStatus.mockReturnValue({ state: 'downloading', receivedBytes: 1, totalBytes: 2, error: null });
    await expect(processDataLocally('token', [], cycleInput())).rejects.toThrow('Local Processing');
    localModel.getModelStatus.mockReturnValue({ state: 'absent', receivedBytes: 0, totalBytes: 0, error: null });
    await expect(processDataLocally('token', [], cycleInput())).rejects.toThrow('Local Processing');
    resetLLMModels();
    await expect(processDataLocally('token', [], cycleInput())).rejects.toThrow('Local Processing');

    const messages = sentNotifications().map(n => n.message);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain('still downloading');
    expect(messages[1]).toContain('not downloaded yet');
  });

  test('re-arms the notification after a successful cycle', async () => {
    localModel.getModelStatus.mockReturnValue({ state: 'absent' });
    await expect(processDataLocally('token', [], cycleInput())).rejects.toThrow('Local Processing');
    localModel.getModelStatus.mockReturnValue({ state: 'ready' });
    await processDataLocally('token', [CURRENT_SHOT], cycleInput());
    localModel.getModelStatus.mockReturnValue({ state: 'absent' });
    await expect(processDataLocally('token', [], cycleInput())).rejects.toThrow('Local Processing');

    expect(sentNotifications().filter(n => n.id === 'local-model-not-ready')).toHaveLength(2);
  });

  test('reports an unsupported device when OCR or the model runtime is unavailable', async () => {
    ocr.isOcrSupported.mockReturnValue(false);
    await expect(processDataLocally('token', [CURRENT_SHOT], cycleInput())).rejects.toThrow('Local Processing');
    expect(sentNotifications()[0]).toEqual(expect.objectContaining({
      id: 'local-model-not-ready',
      message: expect.stringContaining('not supported on this computer')
    }));
    expect(processRequests()).toHaveLength(0);
  });
});

describe('on-device prompt assembly', () => {
  test('uses the text prompt with OCR, window text, activity and idle time, and no audio or images', async () => {
    await processDataLocally('token', [CURRENT_SHOT], cycleInput());

    expect(ocr.ocrImages).toHaveBeenCalledWith([CURRENT_SHOT], { timeoutMs: expect.any(Number) });
    expect(ocr.ocrImages).toHaveBeenCalledWith([PREVIOUS_SHOT], { timeoutMs: expect.any(Number) });
    expect(localModel.generateStructured).toHaveBeenCalledTimes(1);
    const request = localModel.generateStructured.mock.calls[0][0];
    expect(Object.keys(request.schema.properties)).toEqual(Object.keys(SCHEMA.properties));
    expect(request.maxTokens).toBe(localModel.MAX_OUTPUT_TOKENS);
    expect(request.signal).toBeInstanceOf(AbortSignal);
    // Capture interval 5 min -> 4 min budget; the hard timeout is the remaining budget plus a short grace.
    expect(request.timeoutMs).toBeGreaterThan(3 * 60_000);
    expect(request.timeoutMs).toBeLessThanOrEqual(4 * 60_000 + 5_000);

    const prompt = request.prompt;
    expect(prompt.startsWith('TEXT PROMPT: caption the screen text.')).toBe(true);
    expect(prompt).not.toContain('IMAGE PROMPT');
    expect(prompt).toContain('Application Activity:\nMail: 3m');
    expect(prompt).toContain('System Idle Time: 1m 15s');
    expect(prompt).toContain(`CURRENT ACTIVITY TEXT (OCR):\n${OCR_CURRENT_SECRET}`);
    expect(prompt).toContain(`PREVIOUS ACTIVITY TEXT (OCR, from 5 minutes ago):\n${OCR_PREVIOUS_SECRET}`);
    expect(prompt).toContain(`WINDOW TEXT (accessibility):\n[Mail — Inbox]\n${UI_TEXT_SECRET}\n\n[Notes]\nshopping list`);
    expect(prompt.indexOf('CURRENT ACTIVITY TEXT')).toBeLessThan(prompt.indexOf('PREVIOUS ACTIVITY TEXT'));
    expect(prompt.indexOf('PREVIOUS ACTIVITY TEXT')).toBeLessThan(prompt.indexOf('WINDOW TEXT'));
    expect(prompt).not.toContain(AUDIO_SECRET);
    expect(prompt).not.toContain('base64');
  });

  test('falls back to the image prompt plus a no-images note and default labels on old backends', async () => {
    config = baseConfig({ textPrefilledPrompt: undefined, textContentBlocksSpec: undefined });
    await processDataLocally('token', [CURRENT_SHOT], cycleInput({ previousScreenshotData: null }));

    const prompt = lastPrompt();
    expect(prompt.startsWith('IMAGE PROMPT: caption the screenshots.\n\nNo images are attached.')).toBe(true);
    expect(prompt).toContain(`CURRENT ACTIVITY TEXT (OCR):\n${OCR_CURRENT_SECRET}`);
    expect(prompt).toContain('WINDOW TEXT (accessibility):\n[Mail — Inbox]');
    expect(prompt).not.toContain('PREVIOUS ACTIVITY TEXT');
  });

  test('states when no screen text is available and leaves window text out when absent', async () => {
    await processDataLocally('token', [], cycleInput({ uiText: undefined, previousScreenshotData: null }));
    const prompt = lastPrompt();
    expect(prompt).toContain('CURRENT ACTIVITY TEXT (OCR):\nnone (no captures this cycle)');
    expect(prompt).not.toContain('WINDOW TEXT');
  });

  test('labels each screen when several displays are captured', async () => {
    const second = 'data:image/png;base64,U0VDT05E';
    ocr.ocrImages.mockImplementation(async (images) => images.map((_, index) => ({ text: `screen text ${index}` })));
    await processDataLocally('token', [CURRENT_SHOT, second], cycleInput({ previousScreenshotData: null }));
    expect(lastPrompt()).toContain('CURRENT ACTIVITY TEXT (OCR):\nDisplay 1:\nscreen text 0\n\nDisplay 2:\nscreen text 1');
  });

  test('splits a quarter of the cycle budget across OCR images within fixed bounds', () => {
    expect(__test__.getOcrTimeoutMs(240_000, 2)).toBe(15_000);
    expect(__test__.getOcrTimeoutMs(60_000, 4)).toBe(3_750);
    expect(__test__.getOcrTimeoutMs(60_000, 20)).toBe(2_000);
  });
});

describe('on-device prompt budget', () => {
  const maxCharsFor = (charsPerToken) => Math.floor((localModel.MAX_PROMPT_TOKENS - 256) * charsPerToken);
  const inputs = (overrides) => ({
    applicationActivity: 'Mail: 3m',
    idleTime: 0,
    currentScreenText: 'current',
    previousScreenText: 'previous',
    windowText: 'window',
    ...overrides
  });

  test('keeps everything when it fits', () => {
    const { prompt, truncatedSections } = __test__.buildBundledPrompt(baseConfig(), inputs());
    expect(truncatedSections).toEqual([]);
    expect(prompt).not.toContain('[truncated');
  });

  test('drops previous screen text first, then window text, then cuts current screen text', () => {
    const big = (char) => char.repeat(9_000);

    const previousCut = __test__.buildBundledPrompt(baseConfig(), inputs({
      currentScreenText: big('c'), windowText: big('w').slice(0, 7_000), previousScreenText: big('p')
    }));
    expect(previousCut.prompt).toContain(big('c'));
    expect(previousCut.prompt).toContain(big('w').slice(0, 7_000));
    expect(previousCut.truncatedSections).toEqual(['previous']);
    expect(previousCut.prompt.length).toBeLessThanOrEqual(maxCharsFor(2.5));

    const windowCut = __test__.buildBundledPrompt(baseConfig(), inputs({
      currentScreenText: big('c'), windowText: big('w'), previousScreenText: big('p')
    }));
    expect(windowCut.prompt).toContain(big('c'));
    expect(windowCut.truncatedSections).toEqual(['window', 'previous']);
    expect(windowCut.prompt).toContain('[truncated to fit the on-device model input limit]');
    expect(windowCut.prompt.length).toBeLessThanOrEqual(maxCharsFor(2.5));

    const currentCut = __test__.buildBundledPrompt(baseConfig(), inputs({
      currentScreenText: 'c'.repeat(40_000), windowText: big('w'), previousScreenText: big('p')
    }));
    expect(currentCut.truncatedSections).toEqual(['current', 'window', 'previous']);
    expect(currentCut.prompt).toContain('Application Activity:\nMail: 3m');
    expect(currentCut.prompt.startsWith('TEXT PROMPT')).toBe(true);
    expect(currentCut.prompt.length).toBeLessThanOrEqual(maxCharsFor(2.5));
    expect(Math.ceil(currentCut.prompt.length / 2.5)).toBeLessThanOrEqual(localModel.MAX_PROMPT_TOKENS);
  });

  test('a tighter estimate yields a prompt within one char per token', () => {
    const { prompt } = __test__.buildBundledPrompt(baseConfig(), inputs({ currentScreenText: 'c'.repeat(40_000) }), 1);
    expect(prompt.length).toBeLessThanOrEqual(maxCharsFor(1));
  });

  test('rebuilds once with a tighter estimate when the model reports the prompt is too long', async () => {
    const tooLong = Object.assign(new Error('Prompt has 9000 tokens; the limit is 7128'), { code: 'PROMPT_TOO_LONG' });
    localModel.generateStructured.mockRejectedValueOnce(tooLong);
    ocr.ocrImages.mockImplementation(async (images) => images.map(() => ({ text: 'x'.repeat(30_000) })));

    const result = await processDataLocally('token', [CURRENT_SHOT], cycleInput());

    expect(result.success).toBe(true);
    const [first, second] = localModel.generateStructured.mock.calls.map(([request]) => request.prompt);
    expect(second.length).toBeLessThan(first.length);
    expect(second.length).toBeLessThanOrEqual(maxCharsFor(1));
  });
});

describe('on-device result handling', () => {
  test('returns the structured result, truncates DESCRIPTION and submits only config parameters plus activity', async () => {
    localModel.generateStructured.mockResolvedValue({ ONELINE: 'Answering mail', DESCRIPTION: 'word '.repeat(400), CATEGORY: 'Communication' });

    const result = await processDataLocally('token', [CURRENT_SHOT], cycleInput());

    expect(result.success).toBe(true);
    expect(result.structured.DESCRIPTION.length).toBeLessThanOrEqual(800);
    const requests = processRequests();
    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0][1].body);
    expect(Object.keys(body.parameters).sort()).toEqual(['application_activity', 'audio_transcript', 'selectedCategories', 'user_name']);
    expect(body.parameters.application_activity).toBe('Mail: 3m');
    expect(body.parameters.audio_transcript).toBe('');
    expect(body.clientTelemetry).toEqual({ cycles: 1 });
    expect(body.localProvider).toBe('on-device');
  });

  test('never sends OCR text, window text or audio to DoneThat and never logs them', async () => {
    await processDataLocally('token', [CURRENT_SHOT], cycleInput());

    const bodies = fetchMock.mock.calls.map(([, options]) => options?.body || '').join('\n');
    for (const secret of [OCR_CURRENT_SECRET, OCR_PREVIOUS_SECRET, UI_TEXT_SECRET, 'shopping list', AUDIO_SECRET]) {
      expect(bodies).not.toContain(secret);
      expect(allLogText()).not.toContain(secret);
    }
    const body = JSON.parse(processRequests()[0][1].body);
    expect(body).not.toHaveProperty('uiText');
    expect(body.parameters).not.toHaveProperty('ui_text');
  });

  test('test mode returns the result without submitting', async () => {
    const result = await processDataLocally('token', [CURRENT_SHOT], { activity: [], idleTime: 0 }, true);
    expect(result).toEqual(expect.objectContaining({ success: true, test: true, structured: expect.any(Object) }));
    expect(processRequests()).toHaveLength(0);
  });

  test('test mode leaves room for the first model load', async () => {
    await processDataLocally('token', [CURRENT_SHOT], { activity: [], idleTime: 0 }, true);
    const request = localModel.generateStructured.mock.calls[0][0];
    expect(request.timeoutMs).toBeGreaterThan(4 * 60_000);
  });

  test('long capture intervals are not cut short by a fixed request timeout', async () => {
    await processDataLocally('token', [CURRENT_SHOT], cycleInput({ captureIntervalMinutes: 15 }));
    const request = localModel.generateStructured.mock.calls[0][0];
    expect(request.timeoutMs).toBeGreaterThan(13 * 60_000);
    expect(request.timeoutMs).toBeLessThanOrEqual(14 * 60_000 + 5_000);
  });

  test('the request timeout is capped for very long capture intervals', async () => {
    await processDataLocally('token', [CURRENT_SHOT], cycleInput({ captureIntervalMinutes: 120 }));
    expect(localModel.generateStructured.mock.calls[0][0].timeoutMs).toBe(30 * 60_000);
  });

  test('test mode surfaces a not-ready model as a user-facing error without a notification', async () => {
    localModel.getModelStatus.mockReturnValue({ state: 'absent' });
    await expect(processDataLocally('token', [CURRENT_SHOT], { activity: [], idleTime: 0 }, true))
      .rejects.toThrow('On-device model not downloaded yet');
    expect(sentNotifications()).toEqual([]);
  });
});

describe('on-device output length', () => {
  test('caps free-text fields so the model has to close the JSON in time', async () => {
    await processDataLocally('token', [CURRENT_SHOT], cycleInput());

    const { schema } = localModel.generateStructured.mock.calls[0][0];
    expect(schema.properties.ONELINE.maxLength).toBe(120);
    expect(schema.properties.DESCRIPTION.maxLength).toBe(800);
    expect(schema.properties.CATEGORY.maxLength).toBe(80);
    expect(SCHEMA.properties.DESCRIPTION).not.toHaveProperty('maxLength');
  });

  test('keeps limits and enums the backend already set, and other fields get a default cap', () => {
    const bounded = __test__.boundBundledOutputSchema({
      type: 'object',
      properties: {
        CATEGORY: { type: 'string', enum: ['Work', 'Ignore'] },
        ONELINE: { type: 'string', maxLength: 50 },
        NOTE: { type: 'string' },
        SCORE: { type: 'number' }
      }
    });
    expect(bounded.properties.CATEGORY).toEqual({ type: 'string', enum: ['Work', 'Ignore'] });
    expect(bounded.properties.ONELINE.maxLength).toBe(50);
    expect(bounded.properties.NOTE.maxLength).toBe(400);
    expect(bounded.properties.SCORE).toEqual({ type: 'number' });
  });
});

describe('on-device error mapping', () => {
  test('aborts and timeouts count toward the too-slow streak with an on-device message', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' });
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const clientTimeout = Object.assign(new Error('On-device generation timed out'), { code: 'TIMEOUT' });
    localModel.generateStructured
      .mockRejectedValueOnce(abort)
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(clientTimeout);

    for (let i = 0; i < 3; i++) {
      await expect(processDataLocally('token', [CURRENT_SHOT], cycleInput())).rejects.toThrow('Local Processing');
    }

    expect(localModel.generateStructured).toHaveBeenCalledTimes(3);
    expect(telemetry.recordLocalBudgetExceeded).toHaveBeenCalledTimes(3);
    expect(sentNotifications()).toEqual([
      expect.objectContaining({ id: 'local-processing-too-slow', message: expect.stringContaining('on-device model') })
    ]);
    expect(processRequests()).toHaveLength(0);
  });

  test.each([
    ['WORKER_EXITED', 'stopped unexpectedly'],
    ['WORKER_START_FAILED', 'stopped unexpectedly'],
    ['INVALID_OUTPUT', 'could not summarize'],
    ['GENERATION_FAILED', 'could not summarize'],
    ['INVALID_SCHEMA', 'could not summarize']
  ])('%s becomes a local processing error with a short user-safe message', async (code, expected) => {
    const error = Object.assign(new Error(`worker said: ${OCR_CURRENT_SECRET}`), { code });
    localModel.generateStructured.mockRejectedValueOnce(error);

    await expect(processDataLocally('token', [CURRENT_SHOT], cycleInput())).rejects.toThrow('Local Processing');

    expect(localModel.generateStructured).toHaveBeenCalledTimes(1);
    const [notification] = sentNotifications();
    expect(notification.id).toBe('local-processing-error');
    expect(notification.message).toContain(expected);
    expect(notification.message).not.toContain(OCR_CURRENT_SECRET);
  });

  test('a model that turns unavailable mid-cycle uses the not-ready notification', async () => {
    localModel.generateStructured.mockImplementationOnce(async () => {
      localModel.getModelStatus.mockReturnValue({ state: 'absent' });
      throw Object.assign(new Error('gone'), { code: 'MODEL_NOT_READY' });
    });
    await expect(processDataLocally('token', [CURRENT_SHOT], cycleInput())).rejects.toThrow('Local Processing');
    expect(sentNotifications()[0]).toEqual(expect.objectContaining({ id: 'local-model-not-ready', message: expect.stringContaining('not downloaded yet') }));
  });

  test('a model that is re-verified mid-cycle says it is being prepared, not missing', async () => {
    localModel.generateStructured.mockImplementationOnce(async () => {
      localModel.getModelStatus.mockReturnValue({ state: 'verifying' });
      throw Object.assign(new Error('changed on disk'), { code: 'MODEL_NOT_READY' });
    });
    await expect(processDataLocally('token', [CURRENT_SHOT], cycleInput())).rejects.toThrow('Local Processing');
    const [notification] = sentNotifications();
    expect(notification.id).toBe('local-model-not-ready');
    expect(notification.message).toContain('being prepared');
    expect(notification.message).not.toContain('not downloaded');
  });

  test('an empty model result is reported as invalid output', async () => {
    localModel.generateStructured.mockResolvedValueOnce(null);
    await expect(processDataLocally('token', [CURRENT_SHOT], cycleInput())).rejects.toThrow('Local Processing');
    expect(sentNotifications()[0].message).toContain('could not summarize');
  });
});

describe('window text for API providers', () => {
  test('adds a labelled window text block for Gemini and OpenAI-compatible', () => {
    for (const provider of ['gemini', 'openai']) {
      const blocks = __test__.buildBlocks(baseConfig({ textContentBlocksSpec: { uiTextLabel: 'UI LABEL:' } }), [CURRENT_SHOT], [], 'Mail: 3m', null, 10, provider, uiTextPayload());
      const textBlocks = blocks.filter(block => block.type === 'text').map(block => block.text);
      expect(textBlocks).toContain(`UI LABEL:\n[Mail — Inbox]\n${UI_TEXT_SECRET}\n\n[Notes]\nshopping list`);
    }
  });

  test('uses the default label on old backends and adds nothing without window text', () => {
    const withText = __test__.buildBlocks(baseConfig({ textContentBlocksSpec: undefined }), [CURRENT_SHOT], [], 'Mail', null, 0, 'gemini', uiTextPayload());
    expect(withText.some(block => block.type === 'text' && block.text.startsWith('WINDOW TEXT (accessibility):\n'))).toBe(true);

    const withoutText = __test__.buildBlocks(baseConfig(), [CURRENT_SHOT], [], 'Mail', null, 0, 'openai', null);
    expect(withoutText.some(block => block.type === 'text' && block.text.includes('WINDOW TEXT'))).toBe(false);
  });

  test('marks window text the capture had to cut', () => {
    expect(__test__.formatUiText({ entries: [{ app: 'A', windowTitle: 'B', text: 't' }], truncated: true }))
      .toBe('[A — B]\nt\n[window text truncated]');
    expect(__test__.formatUiText({ entries: [{ app: 'A', text: '   ' }], truncated: false })).toBe('');
  });
});
