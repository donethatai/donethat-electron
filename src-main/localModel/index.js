// Public API of the on-device ("bundled") model: model file management plus
// structured generation in an isolated utilityProcess.
//
// The worker script is resolved next to this file. In packaged builds that is
// inside app.asar (src-main/** is packed); utilityProcess.fork loads scripts
// from asar like the main process does, and node-llama-cpp maps its native
// binaries to app.asar.unpacked itself.

const os = require('os')
const path = require('path')
const log = require('electron-log')
const {
  MODEL,
  CONTEXT_SIZE,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_TOKENS
} = require('./modelInfo')
const { createModelManager } = require('./modelManager')
const { createLocalModelClient, WORKER_SERVICE_NAME } = require('./client')

const BUNDLED_PLATFORMS = ['darwin', 'win32']
// "8 GB" machines report a little under 8 GiB on Windows (hardware-reserved
// memory), so the cut-off sits at 7.5 GiB.
const MIN_TOTAL_MEMORY_BYTES = 7.5 * 1024 ** 3
const WORKER_PATH = path.join(__dirname, 'worker.js')

let manager = null
let client = null

async function nodeFetch(url, options) {
  const { default: fetch } = await import('node-fetch')
  return fetch(url, options)
}

function getManager() {
  if (!manager) {
    const { app } = require('electron')
    manager = createModelManager({
      modelsDir: path.join(app.getPath('userData'), 'models'),
      fetchImpl: nodeFetch,
      log
    })
  }
  return manager
}

function getClient() {
  if (!client) {
    const { utilityProcess } = require('electron')
    client = createLocalModelClient({
      utilityProcess,
      workerPath: WORKER_PATH,
      getModelPath: () => getManager().getVerifiedModelPath(),
      log
    })
  }
  return client
}

// Why the on-device model cannot run here: 'platform', 'memory', or null when it can.
function getBundledUnsupportedReason({ platform = process.platform, totalMemoryBytes = os.totalmem() } = {}) {
  if (!BUNDLED_PLATFORMS.includes(platform)) return 'platform'
  if (totalMemoryBytes < MIN_TOTAL_MEMORY_BYTES) return 'memory'
  return null
}

function isBundledSupported(options) {
  return getBundledUnsupportedReason(options) === null
}

function getModelInfo() {
  return { id: MODEL.id, name: MODEL.name, fileName: MODEL.fileName, sizeBytes: MODEL.sizeBytes, sha256: MODEL.sha256 }
}

function getModelStatus() {
  return getManager().getModelStatus()
}

function downloadModel() {
  return getManager().downloadModel()
}

function cancelDownload() {
  getManager().cancelDownload()
}

// The manager reports 'deleting' at once, so no new worker picks the file up;
// the running worker maps the file and is stopped before the files are removed
// (Windows refuses to delete a mapped file).
function deleteModel() {
  return getManager().deleteModel({
    beforeRemove: async () => {
      if (client) await client.shutdown()
    }
  })
}

function cleanupOrphanedModelFiles() {
  return getManager().removeOrphanedFiles()
}

function onStatusChange(listener) {
  return getManager().onStatusChange(listener)
}

function generateStructured(request) {
  if (!isBundledSupported()) {
    const error = new Error('On-device model is not supported on this device')
    error.code = 'UNSUPPORTED'
    return Promise.reject(error)
  }
  return getClient().generateStructured(request)
}

// Keeps a partial download on disk so it resumes next launch.
async function shutdown() {
  if (manager) manager.cancelDownload()
  if (client) await client.shutdown()
}

module.exports = {
  getBundledUnsupportedReason,
  getModelInfo,
  getModelStatus,
  downloadModel,
  cancelDownload,
  deleteModel,
  cleanupOrphanedModelFiles,
  onStatusChange,
  generateStructured,
  shutdown,
  isBundledSupported,
  CONTEXT_SIZE,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_TOKENS,
  WORKER_PATH,
  WORKER_SERVICE_NAME
}
