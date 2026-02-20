const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const { toDataUrl } = require('./imageDiff')

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
 * @param {Object} inputData activity, audioCycle, idleTime
 * @param {number} timestamp
 * @param {'cloud'|'local'} pathType
 * @param {Object|null} previousScreenshotData { images: [{ base64Data, index }] } or null - exactly as sent to LLM/cloud
 * @param {boolean} emptyFolderOnly Create the dump directory only (no payload/media files)
 * @returns {Promise<string|null>} Dump dir path or null if disabled/failed
 */
async function saveCaptureDump(screenshots, inputData, timestamp, pathType, previousScreenshotData = null, emptyFolderOnly = false) {
  try {
    const store = await getStore()
    const saveEnabled = store.get('saveCaptureDataToFolder')
    if (!saveEnabled) {
      return null
    }

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
    if (emptyFolderOnly) {
      return sendDir
    }

    const audioCycle = inputData?.audioCycle || null;
    let audioCycleMeta = null;
    if (audioCycle && audioCycle.base64Data) {
      const cycleBase64 = typeof audioCycle.base64Data === 'string' && audioCycle.base64Data.includes(',')
        ? audioCycle.base64Data.split(',')[1]
        : audioCycle.base64Data;
      const cycleExt = (audioCycle.mimeType || 'audio/webm').split(';')[0].split('/').pop() || 'webm';
      const openaiAudio = audioCycle.openai && audioCycle.openai.base64Data
        ? audioCycle.openai
        : null;
      const openaiBase64 = openaiAudio
        ? (typeof openaiAudio.base64Data === 'string' && openaiAudio.base64Data.includes(',')
            ? openaiAudio.base64Data.split(',')[1]
            : openaiAudio.base64Data)
        : null;
      const openaiExt = openaiAudio
        ? ((openaiAudio.mimeType || 'audio/wav').split(';')[0].split('/').pop() || 'wav')
        : null;
      audioCycleMeta = {
        mimeType: audioCycle.mimeType,
        cycleStartMs: audioCycle.cycleStartMs,
        cycleEndMs: audioCycle.cycleEndMs,
        recordingIntervals: audioCycle.recordingIntervals || [],
        speechIntervals: audioCycle.speechIntervals || [],
        segmentCount: audioCycle.segmentCount,
        source: audioCycle.source,
        systemAudioEnabled: !!audioCycle.systemAudioEnabled,
        sizeBytes: cycleBase64 ? Buffer.byteLength(cycleBase64, 'base64') : 0,
        ...(openaiBase64 ? {
          openai: {
            mimeType: openaiAudio.mimeType || 'audio/wav',
            format: openaiAudio.format || 'wav',
            sizeBytes: Buffer.byteLength(openaiBase64, 'base64')
          }
        } : {})
      };
      if (cycleBase64) {
        const buf = Buffer.from(cycleBase64, 'base64');
        fs.writeFileSync(path.join(sendDir, `audio-cycle.${cycleExt}`), buf);
      }
      if (openaiBase64 && openaiExt) {
        const openaiBuf = Buffer.from(openaiBase64, 'base64');
        fs.writeFileSync(path.join(sendDir, `audio-cycle-openai.${openaiExt}`), openaiBuf);
      }
    }

    const payload = {
      timestamp,
      path: pathType,
      activity: inputData?.activity || [],
      audioCycle: audioCycleMeta,
      idleTime: inputData?.idleTime
    }
    fs.writeFileSync(path.join(sendDir, 'payload.json'), JSON.stringify(payload, null, 2))

    if (screenshots && screenshots.length > 0) {
      for (let i = 0; i < screenshots.length; i++) {
        const dataUrl = toDataUrl(screenshots[i]) ?? toDataUrl(screenshots[i]?.base64Data)
        const base64 = dataUrl?.replace(/^data:image\/\w+;base64,/, '')
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
    // eslint-disable-next-line no-console
    console.error('[capture-dump] Failed to save capture dump:', error?.message || error)
    return null
  }
}

/**
 * Append structured, parameters, and optional telemetry to existing dump dir (for local path)
 */
function shouldWriteTelemetryDump(dumpDir) {
  return typeof dumpDir === 'string' && dumpDir.includes('DEBUG')
}

function appendCaptureDump(dumpDir, structured, parameters, telemetry) {
  try {
    if (!dumpDir) return
    if (structured) {
      fs.writeFileSync(path.join(dumpDir, 'structured.json'), JSON.stringify(structured, null, 2))
    }
    if (parameters) {
      fs.writeFileSync(path.join(dumpDir, 'parameters.json'), JSON.stringify(parameters, null, 2))
    }
    if (telemetry && shouldWriteTelemetryDump(dumpDir)) {
      fs.writeFileSync(path.join(dumpDir, 'telemetry.json'), JSON.stringify(telemetry, null, 2))
    }
  } catch (error) {
  }
}

module.exports = {
  saveCaptureDump,
  appendCaptureDump,
  getBasePath,
  getStore
}
