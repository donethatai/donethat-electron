jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }))
jest.mock('electron', () => ({ app: { getPreferredSystemLanguages: jest.fn(() => ['de-DE', 'en-US']) } }))
jest.mock('@napi-rs/system-ocr', () => ({ recognize: jest.fn() }))

const log = require('electron-log')
const { recognize } = require('@napi-rs/system-ocr')
const { isOcrSupported, ocrImages, normalizeOcrText, dataUrlToBuffer } = require('../ocrScreenshots')

const SECRET_TEXT = 'Quarterly salary report for Jane Doe'
const originalPlatform = process.platform

function setPlatform(platform) {
  Object.defineProperty(process, 'platform', { value: platform })
}

function imageDataUrl(content = 'fake-jpeg-bytes') {
  return `data:image/jpeg;base64,${Buffer.from(content).toString('base64')}`
}

function allLogOutput() {
  return [log.info, log.warn, log.error, log.debug]
    .flatMap(fn => fn.mock.calls)
    .map(args => args.join(' '))
    .join('\n')
}

describe('ocrScreenshots', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setPlatform('darwin')
  })

  afterAll(() => {
    setPlatform(originalPlatform)
  })

  test('is supported on macOS and Windows only', () => {
    setPlatform('darwin')
    expect(isOcrSupported()).toBe(true)
    setPlatform('win32')
    expect(isOcrSupported()).toBe(true)
    setPlatform('linux')
    expect(isOcrSupported()).toBe(false)
  })

  test('recognizes each image from an in-memory buffer and normalises the text', async () => {
    recognize
      .mockResolvedValueOnce({ text: `  ${SECRET_TEXT}  \n\n\n\nSecond line   \r\n` })
      .mockResolvedValueOnce({ text: 'Other screen' })

    const results = await ocrImages([imageDataUrl('one'), imageDataUrl('two')], { timeoutMs: 1000 })

    expect(results).toEqual([{ text: `${SECRET_TEXT}\n\nSecond line` }, { text: 'Other screen' }])
    const [input, accuracy, languages, signal] = recognize.mock.calls[0]
    expect(Buffer.isBuffer(input)).toBe(true)
    expect(input.toString()).toBe('one')
    expect(accuracy).toBeNull()
    expect(languages).toBeNull()
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(allLogOutput()).not.toContain(SECRET_TEXT)
  })

  test('a failing image yields empty text and a warning without content', async () => {
    recognize
      .mockRejectedValueOnce(new Error('Vision request failed'))
      .mockResolvedValueOnce({ text: SECRET_TEXT })

    const results = await ocrImages([imageDataUrl('bad'), imageDataUrl('good')], { timeoutMs: 1000 })

    expect(results).toEqual([{ text: '' }, { text: SECRET_TEXT }])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Image 0 failed'))
    expect(allLogOutput()).not.toContain(SECRET_TEXT)
  })

  test('an image without text is not reported as a failure', async () => {
    recognize.mockRejectedValueOnce(new Error('No text recognized'))
    const results = await ocrImages([imageDataUrl()], { timeoutMs: 1000 })
    expect(results).toEqual([{ text: '' }])
    expect(log.warn).not.toHaveBeenCalled()
  })

  test('times out a stuck image, aborts it and continues with the next', async () => {
    let capturedSignal = null
    recognize
      .mockImplementationOnce((buffer, accuracy, languages, signal) => {
        capturedSignal = signal
        return new Promise(() => {})
      })
      .mockResolvedValueOnce({ text: 'after timeout' })

    const results = await ocrImages([imageDataUrl('slow'), imageDataUrl('fast')], { timeoutMs: 20 })

    expect(results).toEqual([{ text: '' }, { text: 'after timeout' }])
    expect(capturedSignal.aborted).toBe(true)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  })

  test('skips inputs that are not image data URLs', async () => {
    recognize.mockResolvedValueOnce({ text: 'ok' })
    const results = await ocrImages(['/tmp/screenshot.png', null, imageDataUrl()], { timeoutMs: 1000 })
    expect(results).toEqual([{ text: '' }, { text: '' }, { text: 'ok' }])
    expect(recognize).toHaveBeenCalledTimes(1)
  })

  test('returns empty text for every image on Linux without calling the OCR engine', async () => {
    setPlatform('linux')
    const results = await ocrImages([imageDataUrl(), imageDataUrl()])
    expect(results).toEqual([{ text: '' }, { text: '' }])
    expect(recognize).not.toHaveBeenCalled()
  })

  test('uses the first system language on Windows', async () => {
    setPlatform('win32')
    recognize.mockResolvedValueOnce({ text: 'Hallo' })
    await ocrImages([imageDataUrl()], { timeoutMs: 1000 })
    expect(recognize.mock.calls[0][2]).toEqual(['de-DE'])
  })

  test('never throws for empty or invalid input', async () => {
    await expect(ocrImages(undefined)).resolves.toEqual([])
    await expect(ocrImages([])).resolves.toEqual([])
  })

  test('helpers', () => {
    expect(normalizeOcrText('a\n\n\n\nb\n')).toBe('a\n\nb')
    expect(normalizeOcrText(undefined)).toBe('')
    expect(dataUrlToBuffer('data:image/png;base64,')).toBeNull()
    expect(dataUrlToBuffer(imageDataUrl('x')).toString()).toBe('x')
  })
})
