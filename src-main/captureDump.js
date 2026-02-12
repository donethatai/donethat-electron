const log = require('electron-log')
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

let storeCache = null

async function getStore() {
  if (!storeCache) {
    const { default: Store } = await import('electron-store')
    storeCache = new Store({ name: 'donethat-config', cwd: app.getPath('userData') })
  }
  return storeCache
}

async function getBasePath() {
  const store = await getStore()
  const customPath = store.get('saveCaptureDataPath')
  if (customPath && typeof customPath === 'string' && customPath.trim()) {
    return customPath.trim()
  }
  return path.join(app.getPath('userData'), 'donethat')
}

/**
 * Save capture payload and screenshots to folder
 * @param {Array<string>} screenshots Data URLs
 * @param {Object} inputData activity, audioTranscript, idleTime
 * @param {number} timestamp
 * @param {'cloud'|'local'} pathType
 * @param {Object|null} previousScreenshotData { images: [{ base64Data, index }] } or null - exactly as sent to LLM/cloud
 * @returns {Promise<string|null>} Dump dir path or null if disabled/failed
 */
async function saveCaptureDump(screenshots, inputData, timestamp, pathType, previousScreenshotData = null) {
  try {
    const store = await getStore()
    if (!store.get('saveCaptureDataToFolder')) return null

    const basePath = await getBasePath()
    const d = new Date(timestamp)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const dateStr = `${y}-${m}-${day}`
    const hrs = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    const sec = String(d.getSeconds()).padStart(2, '0')
    const ms = String(d.getMilliseconds()).padStart(3, '0')
    const readableStamp = `${dateStr}-${hrs}-${min}-${sec}-${ms}`
    const sendDir = path.join(basePath, dateStr, readableStamp)

    fs.mkdirSync(sendDir, { recursive: true })

    const payload = {
      timestamp,
      path: pathType,
      activity: inputData?.activity || [],
      audioTranscript: inputData?.audioTranscript || '',
      idleTime: inputData?.idleTime
    }
    fs.writeFileSync(path.join(sendDir, 'payload.json'), JSON.stringify(payload, null, 2))

    if (screenshots && screenshots.length > 0) {
      for (let i = 0; i < screenshots.length; i++) {
        const dataUrl = screenshots[i]
        const base64 = (typeof dataUrl === 'string' ? dataUrl : dataUrl?.base64Data || dataUrl)?.replace(/^data:image\/\w+;base64,/, '')
        if (base64) {
          const buf = Buffer.from(base64, 'base64')
          fs.writeFileSync(path.join(sendDir, `screenshot-${i}.jpg`), buf)
        }
      }
    }

    const prevImages = previousScreenshotData?.images
    if (prevImages && prevImages.length > 0) {
      for (let i = 0; i < prevImages.length; i++) {
        const img = prevImages[i]
        const dataUrl = img?.base64Data ?? img
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) continue
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
        if (base64) {
          const buf = Buffer.from(base64, 'base64')
          fs.writeFileSync(path.join(sendDir, `prev-screenshot-${i}.jpg`), buf)
        }
      }
    }

    return sendDir
  } catch (error) {
    log.error('Error saving capture dump:', error)
    return null
  }
}

/**
 * Append structured and parameters to existing dump dir (for local path)
 */
function appendCaptureDump(dumpDir, structured, parameters) {
  try {
    if (!dumpDir) return
    if (structured) {
      fs.writeFileSync(path.join(dumpDir, 'structured.json'), JSON.stringify(structured, null, 2))
    }
    if (parameters) {
      fs.writeFileSync(path.join(dumpDir, 'parameters.json'), JSON.stringify(parameters, null, 2))
    }
  } catch (error) {
    log.error('Error appending capture dump:', error)
  }
}

module.exports = {
  saveCaptureDump,
  appendCaptureDump,
  getBasePath,
  getStore
}
