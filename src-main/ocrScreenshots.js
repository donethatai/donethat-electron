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

// Width x height from a PNG or JPEG header, for diagnostics only.
function imageSize(buffer) {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length && buffer[offset] === 0xff) {
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
      if (isFrameHeader) return `${buffer.readUInt16BE(offset + 7)}x${buffer.readUInt16BE(offset + 5)}`
      offset += 2 + length
    }
  }
  return 'unknown size'
}

function describeImage(buffer, index, languages) {
  return `Image ${index} (${imageSize(buffer)}, ${Math.round(buffer.length / 1024)} KB, languages ${languages ? languages.join(',') : 'default'})`
}

// On Windows the recognizer picks its image decoder by sniffing the bytes and
// rejects Electron's JPEG screenshots ("Could not recognize file"), so they are
// re-encoded as PNG in memory first. macOS Vision decodes them as they are.
function prepareForRecognizer(buffer) {
  if (process.platform !== 'win32') return buffer
  const { nativeImage } = require('electron')
  const image = nativeImage.createFromBuffer(buffer)
  return image.isEmpty() ? buffer : image.toPNG()
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
    const result = await recognizeWithTimeout(recognize, prepareForRecognizer(buffer), languages, timeoutMs)
    const text = normalizeOcrText(result?.text)
    if (!text) log.info(`[ocr] ${describeImage(buffer, index, languages)}: no text recognized`)
    return { text }
  } catch (error) {
    if (error?.message === NO_TEXT_MESSAGE) {
      log.info(`[ocr] ${describeImage(buffer, index, languages)}: no text recognized`)
      return { text: '' }
    }
    log.warn(`[ocr] ${describeImage(buffer, index, languages)} failed: ${error?.message || 'unknown error'}`)
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

  // Without explicit languages, Windows picks the first of the user's languages
  // that has OCR installed, and macOS Vision uses its own defaults.
  const resolvedLanguages = Array.isArray(languages) && languages.length > 0 ? languages : null
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
