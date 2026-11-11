// On-device OCR of capture screenshots via the OS text recognizer (Vision on
// macOS, Windows.Media.Ocr on Windows) through @napi-rs/system-ocr.
//
// Images are decoded from their data URLs into memory buffers and handed to the
// recognizer directly; nothing is written to disk. Recognized text is returned
// to the caller only and never logged.

const log = require('electron-log')

const OCR_PLATFORMS = ['darwin', 'win32']
const DEFAULT_OCR_TIMEOUT_MS = 15000
const NO_TEXT_MESSAGE = 'No text recognized'
const DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i

let ocrModule = null

function isOcrSupported() {
  return OCR_PLATFORMS.includes(process.platform)
}

function loadOcrModule() {
  if (!ocrModule) {
    ocrModule = require('@napi-rs/system-ocr')
  }
  return ocrModule
}

function dataUrlToBuffer(dataUrl) {
  if (typeof dataUrl !== 'string' || !DATA_URL_PATTERN.test(dataUrl)) return null
  const buffer = Buffer.from(dataUrl.replace(DATA_URL_PATTERN, ''), 'base64')
  return buffer.length > 0 ? buffer : null
}

function normalizeOcrText(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Windows OCR only uses the first language and fails when that language pack
// is missing, so prefer the user's own system language there. macOS Vision
// keeps the library default.
function defaultLanguages() {
  if (process.platform !== 'win32') return null
  try {
    const { app } = require('electron')
    const preferred = app.getPreferredSystemLanguages?.() || []
    return preferred.length > 0 ? [preferred[0]] : null
  } catch (error) {
    return null
  }
}

async function recognizeWithTimeout(recognize, buffer, languages, timeoutMs) {
  const controller = new AbortController()
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`OCR timed out after ${timeoutMs} ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([recognize(buffer, null, languages, controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function ocrImage(recognize, dataUrl, index, languages, timeoutMs) {
  const buffer = dataUrlToBuffer(dataUrl)
  if (!buffer) {
    log.warn(`[ocr] Image ${index} skipped: not an image data URL`)
    return { text: '' }
  }
  try {
    const result = await recognizeWithTimeout(recognize, buffer, languages, timeoutMs)
    return { text: normalizeOcrText(result?.text) }
  } catch (error) {
    if (error?.message === NO_TEXT_MESSAGE) return { text: '' }
    log.warn(`[ocr] Image ${index} failed: ${error?.message || 'unknown error'}`)
    return { text: '' }
  }
}

/**
 * OCR a list of screenshot data URLs, one at a time.
 * Never throws: an image that fails or times out yields { text: '' }.
 * @param {string[]} dataUrls
 * @param {{ timeoutMs?: number, languages?: string[] }} [options]
 * @returns {Promise<Array<{ text: string }>>} One entry per input, same order
 */
async function ocrImages(dataUrls, { timeoutMs = DEFAULT_OCR_TIMEOUT_MS, languages } = {}) {
  const images = Array.isArray(dataUrls) ? dataUrls : []
  if (images.length === 0) return []
  if (!isOcrSupported()) return images.map(() => ({ text: '' }))

  let recognize
  try {
    recognize = loadOcrModule().recognize
  } catch (error) {
    log.warn(`[ocr] OCR module unavailable: ${error?.message || 'unknown error'}`)
    return images.map(() => ({ text: '' }))
  }

  const resolvedLanguages = Array.isArray(languages) && languages.length > 0 ? languages : defaultLanguages()
  const startedAt = Date.now()
  const results = []
  for (let index = 0; index < images.length; index++) {
    results.push(await ocrImage(recognize, images[index], index, resolvedLanguages, timeoutMs))
  }
  const totalChars = results.reduce((sum, result) => sum + result.text.length, 0)
  log.debug(`[ocr] ${images.length} image(s), ${totalChars} chars in ${Date.now() - startedAt} ms`)
  return results
}

module.exports = {
  isOcrSupported,
  ocrImages,
  normalizeOcrText,
  dataUrlToBuffer,
  DEFAULT_OCR_TIMEOUT_MS
}
