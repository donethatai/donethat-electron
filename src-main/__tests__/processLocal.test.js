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

const {
  buildLocalProcessingNotification,
  isTransientLocalProcessingError,
  isLocalProcessingAuthError,
  shouldRethrowLocalProcessingError,
  formatLocalProcessingErrorForUser,
} = require('../processLocal');

describe('local processing notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('downgrades transport failures to in-app-only connection banners', () => {
    const error = new Error('Network error while contacting provider.');
    error.cause = new TypeError('temporary DNS lookup issue');
    error.cause.code = 'EAI_AGAIN';

    expect(isTransientLocalProcessingError(error)).toBe(true);

    expect(buildLocalProcessingNotification(error)).toEqual({
      id: 'local-processing-connection-issue',
      title: 'Connection issue',
      message: 'Could not reach the local AI provider. DoneThat will try again on the next capture.',
      sticky: false,
      noFocus: true,
      alsoNative: false
    });
  });

  test('does not treat provider 404 pages as transient just because the body says not found', () => {
    const error = new Error([
      '<!DOCTYPE html><html><body>Not Found | OpenRouter</body></html>',
      'Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_NOT_FOUND/'
    ].join('\n'));
    error.status = 404;

    expect(isTransientLocalProcessingError(error)).toBe(false);
    expect(buildLocalProcessingNotification(error)).toEqual({
      id: 'local-processing-error',
      title: 'Local processing error',
      message: formatLocalProcessingErrorForUser(error),
      sticky: true,
      alsoNative: true
    });
  });

  test('treats ENOTFOUND as non-transient so bad hostnames still notify natively', () => {
    const error = new Error('Connection error.');
    error.cause = new TypeError('fetch failed');
    error.cause.code = 'ENOTFOUND';

    expect(isTransientLocalProcessingError(error)).toBe(false);
    expect(buildLocalProcessingNotification(error).alsoNative).toBe(true);
  });

  test('shows explicit native Gemini quota notification on 429 errors', () => {
    const error = new Error(
      '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [429 Too Many Requests] Quota exceeded'
    );
    error.status = 429;

    const notification = buildLocalProcessingNotification(error);
    expect(notification.id).toBe('gemini-quota-exceeded');
    expect(notification.title).toBe('Gemini quota reached');
    expect(notification.sticky).toBe(true);
    expect(notification.alsoNative).toBe(true);
    expect(notification.message).toEqual(expect.any(String));
    expect(notification.message.toLowerCase()).toContain('quota');
  });

  test('recognizes Firebase auth failures so they can propagate', () => {
    expect(isLocalProcessingAuthError({ source: 'FIREBASE', code: 'AUTH_ERROR' })).toBe(true);
    expect(isLocalProcessingAuthError({ source: 'FIREBASE', code: 'TOKEN_EXPIRED' })).toBe(true);
    expect(isLocalProcessingAuthError({ source: 'FIREBASE', status: 401 })).toBe(true);
    expect(isLocalProcessingAuthError({ source: 'FIREBASE', status: 403 })).toBe(true);
    expect(isLocalProcessingAuthError({ code: 'AUTH_ERROR' })).toBe(false);
    expect(isLocalProcessingAuthError({ status: 401 })).toBe(false);
    expect(isLocalProcessingAuthError({ status: 500 })).toBe(false);
  });

  test('rethrows auth errors instead of converting them into local processing notifications', () => {
    expect(shouldRethrowLocalProcessingError({ source: 'FIREBASE', code: 'AUTH_ERROR' }, false)).toBe(true);
    expect(shouldRethrowLocalProcessingError({ source: 'FIREBASE', status: 401 }, false)).toBe(true);
    expect(shouldRethrowLocalProcessingError({ status: 401 }, false)).toBe(false);
    expect(shouldRethrowLocalProcessingError(new Error('Local provider offline'), false)).toBe(false);
    expect(shouldRethrowLocalProcessingError(new Error('test mode'), true)).toBe(true);
  });
});
