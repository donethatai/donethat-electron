// Download, verification and lifecycle of the on-device model file.
//
// Layout under modelsDir:
//   <fileName>                final file, only ever produced by an atomic rename
//   <fileName>.part           in-progress download, kept across cancel/quit for resume
//   <fileName>.verified.json  marker written after a full sha256 match
//
// Files matching these patterns for any other model file name are left over
// from a previously pinned model and are removed by removeOrphanedFiles().
//
// The marker binds the verified sha256 to the file's size and mtime. A file is
// only reported ready (and handed to the inference worker) while its current
// size and mtime match a marker for the pinned sha256. Startup therefore costs a
// stat instead of hashing 1.2 GB each launch; a file that changes on disk, or
// has no marker (e.g. a crash between rename and marker write), is re-hashed in
// the background before it can be used.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { once } = require('events')
const { finished } = require('stream/promises')
const { MODEL, isAllowedDownloadUrl } = require('./modelInfo')

const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const STALL_TIMEOUT_MS = 60 * 1000
const PROGRESS_INTERVAL_MS = 500
const DISK_SPACE_MARGIN_BYTES = 64 * 1024 * 1024
const HASH_READ_CHUNK_BYTES = 4 * 1024 * 1024
// Windows briefly locks a freshly written file (antivirus, indexer), so the
// final renames and the delete retry a few times before giving up.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 5
const RENAME_RETRY_DELAY_MS = 100
const REMOVE_OPTIONS = { force: true, maxRetries: 5, retryDelay: 200 }
const MODEL_FILE_PATTERN = /\.gguf(\.part|\.verified\.json(\.tmp)?)?$/i

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatGigabytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function statOrNull(filePath) {
  try {
    return fs.statSync(filePath)
  } catch (error) {
    return null
  }
}

function removeQuietly(filePath) {
  try {
    fs.rmSync(filePath, { force: true })
  } catch (error) {
    // Best effort; a leftover file is re-checked on next start.
  }
}

function discardBody(response) {
  try {
    response?.body?.destroy?.()
  } catch (error) {
    // Nothing to release.
  }
}

function contentRangeMatches(response, offset, sizeBytes) {
  const header = response.headers?.get?.('content-range') || ''
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim())
  if (!match) return false
  return Number(match[1]) === offset &&
    Number(match[2]) === sizeBytes - 1 &&
    (match[3] === '*' || Number(match[3]) === sizeBytes)
}

function createModelManager({
  modelsDir,
  model = MODEL,
  fetchImpl,
  log,
  statfs = fs.promises.statfs,
  stallTimeoutMs = STALL_TIMEOUT_MS,
  progressIntervalMs = PROGRESS_INTERVAL_MS,
  renameRetryDelayMs = RENAME_RETRY_DELAY_MS,
  now = Date.now
}) {
  const modelPath = path.join(modelsDir, model.fileName)
  const partPath = `${modelPath}.part`
  const markerPath = `${modelPath}.verified.json`
  const listeners = new Set()
  let status = null
  let activeDownload = null
  let activeVerify = null
  let activeDelete = null
  let deleting = false

  function snapshot() {
    return { ...status }
  }

  // While a delete runs, a cancelled download or finished verification must
  // not move the state back to absent/ready before the files are gone.
  function setStatus(patch) {
    status = { ...status, ...patch }
    if (deleting) status.state = 'deleting'
    const current = snapshot()
    for (const listener of listeners) {
      try {
        listener(current)
      } catch (error) {
        log.warn('[localModel] Status listener failed:', error.message)
      }
    }
  }

  function partSizeSync() {
    const partStat = statOrNull(partPath)
    return partStat ? Math.min(partStat.size, model.sizeBytes) : 0
  }

  function readMarker() {
    try {
      return JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    } catch (error) {
      return null
    }
  }

  function markerMatches(fileStat) {
    const marker = readMarker()
    return Boolean(marker) &&
      marker.sha256 === model.sha256 &&
      marker.sizeBytes === fileStat.size &&
      marker.mtimeMs === fileStat.mtimeMs
  }

  async function renameWithRetry(fromPath, toPath) {
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.promises.rename(fromPath, toPath)
        return
      } catch (error) {
        if (!RENAME_RETRY_CODES.has(error.code) || attempt >= RENAME_ATTEMPTS) throw error
        log.warn(`[localModel] Rename failed (${error.code}); retrying (${attempt}/${RENAME_ATTEMPTS - 1})`)
        await delay(renameRetryDelayMs * 2 ** (attempt - 1))
      }
    }
  }

  async function writeMarker(fileStat) {
    const marker = { sha256: model.sha256, sizeBytes: fileStat.size, mtimeMs: fileStat.mtimeMs, verifiedAt: now() }
    const tempPath = `${markerPath}.tmp`
    await fs.promises.writeFile(tempPath, JSON.stringify(marker))
    await renameWithRetry(tempPath, markerPath)
  }

  async function hashFileInto(hash, filePath, shouldStop = () => false) {
    const stream = fs.createReadStream(filePath, { highWaterMark: HASH_READ_CHUNK_BYTES })
    try {
      for await (const chunk of stream) {
        if (shouldStop()) return false
        hash.update(chunk)
      }
      return true
    } finally {
      stream.destroy()
    }
  }

  function initialStatus() {
    const base = { totalBytes: model.sizeBytes, error: null }
    const finalStat = statOrNull(modelPath)
    if (finalStat && finalStat.size === model.sizeBytes) {
      if (markerMatches(finalStat)) return { ...base, state: 'ready', receivedBytes: model.sizeBytes }
      return { ...base, state: 'verifying', receivedBytes: model.sizeBytes, needsVerify: true }
    }
    if (finalStat) {
      log.warn(`[localModel] Removing model file with unexpected size ${finalStat.size}`)
      removeQuietly(modelPath)
      removeQuietly(markerPath)
    }
    return { ...base, state: 'absent', receivedBytes: partSizeSync() }
  }

  function ensureInitialized() {
    if (status) return
    const { needsVerify, ...initial } = initialStatus()
    status = initial
    if (needsVerify) startVerifyExisting()
  }

  function startVerifyExisting() {
    activeVerify = verifyExisting().finally(() => {
      activeVerify = null
    })
  }

  async function verifyExisting() {
    try {
      const hash = crypto.createHash('sha256')
      await hashFileInto(hash, modelPath)
      const fileStat = await fs.promises.stat(modelPath)
      if (hash.digest('hex') === model.sha256 && fileStat.size === model.sizeBytes) {
        await writeMarker(fileStat)
        log.info('[localModel] Existing model file verified')
        setStatus({ state: 'ready', receivedBytes: model.sizeBytes, error: null })
        return
      }
      log.warn('[localModel] Existing model file failed verification; removing it')
    } catch (error) {
      log.warn('[localModel] Could not verify existing model file:', error.message)
    }
    removeQuietly(modelPath)
    removeQuietly(markerPath)
    setStatus({ state: 'absent', receivedBytes: partSizeSync(), error: null })
  }

  function getModelStatus() {
    ensureInitialized()
    return snapshot()
  }

  function onStatusChange(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  // Only returns a path whose size and mtime still match the verified marker.
  function getVerifiedModelPath() {
    ensureInitialized()
    if (deleting || status.state !== 'ready') return null
    const fileStat = statOrNull(modelPath)
    if (fileStat && fileStat.size === model.sizeBytes && markerMatches(fileStat)) return modelPath
    log.warn('[localModel] Model file changed on disk since verification; re-verifying')
    if (fileStat && fileStat.size === model.sizeBytes) {
      setStatus({ state: 'verifying', receivedBytes: model.sizeBytes, error: null })
      startVerifyExisting()
    } else {
      removeQuietly(modelPath)
      removeQuietly(markerPath)
      setStatus({ state: 'absent', receivedBytes: partSizeSync(), error: null })
    }
    return null
  }

  async function ensureDiskSpace(neededBytes) {
    if (typeof statfs !== 'function') return
    let stats
    try {
      stats = await statfs(modelsDir)
    } catch (error) {
      return
    }
    const freeBytes = Number(stats.bavail) * Number(stats.bsize)
    const requiredBytes = neededBytes + DISK_SPACE_MARGIN_BYTES
    if (Number.isFinite(freeBytes) && freeBytes < requiredBytes) {
      throw codedError('DISK_SPACE', `Not enough free disk space: ${formatGigabytes(requiredBytes)} needed, ${formatGigabytes(freeBytes)} available`)
    }
  }

  function createStallWatchdog(job) {
    let timer = null
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        job.stalled = true
        job.controller.abort()
      }, stallTimeoutMs)
    }
    return { reset, clear: () => clearTimeout(timer) }
  }

  async function requestModel(job, offset, watchdog) {
    let url = model.url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedDownloadUrl(url)) {
        throw codedError('HOST_NOT_ALLOWED', `Refusing to download the model from ${new URL(url).host}`)
      }
      const headers = { 'Accept-Encoding': 'identity' }
      if (offset > 0) headers.Range = `bytes=${offset}-`
      watchdog.reset()
      const response = await fetchImpl(url, { headers, redirect: 'manual', compress: false, signal: job.controller.signal })
      watchdog.reset()
      if (!REDIRECT_STATUSES.has(response.status)) return response
      const location = response.headers?.get?.('location')
      discardBody(response)
      if (!location) throw codedError('HTTP_ERROR', `Model download redirect without a location (HTTP ${response.status})`)
      url = new URL(location, url).toString()
    }
    throw codedError('TOO_MANY_REDIRECTS', 'Model download was redirected too many times')
  }

  async function streamToPart(job, body, writeOffset, hash, watchdog) {
    const out = fs.createWriteStream(partPath, { flags: writeOffset > 0 ? 'a' : 'w' })
    let writeError = null
    out.on('error', error => {
      writeError = error
    })
    let received = writeOffset
    let lastProgressAt = 0
    try {
      for await (const chunk of body) {
        watchdog.reset()
        if (job.cancelled) break
        if (writeError) throw writeError
        received += chunk.length
        if (received > model.sizeBytes) throw codedError('SIZE_MISMATCH', 'Model download is larger than expected')
        hash.update(chunk)
        if (!out.write(chunk)) await once(out, 'drain')
        if (now() - lastProgressAt >= progressIntervalMs) {
          lastProgressAt = now()
          setStatus({ receivedBytes: received })
        }
      }
    } catch (error) {
      if (!job.cancelled) throw error
    } finally {
      // `finished` also settles when the stream already failed and closed
      // (e.g. the .part file could not be opened); its error is in writeError.
      out.end()
      await finished(out).catch(() => {})
    }
    if (writeError) throw writeError
    if (job.cancelled) return
    setStatus({ receivedBytes: received })
    if (received !== model.sizeBytes) throw codedError('INCOMPLETE', 'Model download ended early; try again to resume')
  }

  async function fetchIntoPart(job, offset, hash, watchdog) {
    const response = await requestModel(job, offset, watchdog)
    let writeOffset = offset
    let writeHash = hash
    if (offset > 0) {
      if (response.status === 206 && contentRangeMatches(response, offset, model.sizeBytes)) {
        log.info(`[localModel] Resuming model download at ${offset} bytes`)
      } else if (response.status === 200) {
        log.info('[localModel] Server ignored the resume range; restarting download')
        writeOffset = 0
        writeHash = crypto.createHash('sha256')
        setStatus({ receivedBytes: 0 })
      } else if (response.status === 206 || response.status === 416) {
        log.warn(`[localModel] Resume rejected (HTTP ${response.status}); restarting download`)
        discardBody(response)
        await fs.promises.rm(partPath, { force: true })
        setStatus({ receivedBytes: 0 })
        return fetchIntoPart(job, 0, crypto.createHash('sha256'), watchdog)
      } else {
        discardBody(response)
        throw codedError('HTTP_ERROR', `Model download failed (HTTP ${response.status})`)
      }
    } else if (response.status !== 200) {
      discardBody(response)
      throw codedError('HTTP_ERROR', `Model download failed (HTTP ${response.status})`)
    }
    if (writeOffset === 0) {
      const contentLength = Number(response.headers?.get?.('content-length'))
      if (contentLength && contentLength !== model.sizeBytes) {
        discardBody(response)
        throw codedError('SIZE_MISMATCH', `Model download has unexpected size ${contentLength}`)
      }
    }
    await streamToPart(job, response.body, writeOffset, writeHash, watchdog)
    return writeHash
  }

  async function finalizeDownload() {
    const partStat = await fs.promises.stat(partPath)
    await writeMarker(partStat)
    await renameWithRetry(partPath, modelPath)
  }

  function finishCancelled() {
    log.info('[localModel] Model download cancelled')
    setStatus({ state: 'absent', receivedBytes: partSizeSync(), error: null })
  }

  async function runDownload(job) {
    const watchdog = createStallWatchdog(job)
    try {
      if (activeVerify) await activeVerify
      if (status.state === 'ready') return
      await fs.promises.mkdir(modelsDir, { recursive: true })
      let offset = partSizeSync()
      const partStat = statOrNull(partPath)
      if (partStat && partStat.size > model.sizeBytes) {
        await fs.promises.rm(partPath, { force: true })
        offset = 0
      }
      setStatus({ state: 'downloading', receivedBytes: offset, totalBytes: model.sizeBytes, error: null })
      await ensureDiskSpace(model.sizeBytes - offset)

      let hash = crypto.createHash('sha256')
      if (offset > 0) {
        const hashed = await hashFileInto(hash, partPath, () => job.cancelled)
        if (!hashed) return finishCancelled()
      }
      if (offset < model.sizeBytes) {
        hash = await fetchIntoPart(job, offset, hash, watchdog)
      }
      if (job.cancelled) return finishCancelled()

      setStatus({ state: 'verifying', receivedBytes: model.sizeBytes })
      if (hash.digest('hex') !== model.sha256) {
        await fs.promises.rm(partPath, { force: true })
        throw codedError('CHECKSUM_MISMATCH', 'Downloaded model failed its checksum; please download it again')
      }
      await finalizeDownload()
      log.info('[localModel] Model downloaded and verified')
      setStatus({ state: 'ready', receivedBytes: model.sizeBytes, error: null })
    } catch (error) {
      if (job.cancelled) return finishCancelled()
      const failure = job.stalled ? codedError('STALLED', 'Model download stalled; try again to resume') : error
      log.warn(`[localModel] Model download failed (${failure.code || 'ERROR'}): ${failure.message}`)
      setStatus({ state: 'error', receivedBytes: partSizeSync(), error: failure.message })
      throw failure
    } finally {
      watchdog.clear()
    }
  }

  // Resolves when the model is ready or the download was cancelled; rejects on
  // failure (status moves to 'error'; a partial download is kept for resume).
  function downloadModel() {
    ensureInitialized()
    if (deleting) return Promise.reject(codedError('DELETING', 'The on-device model is being deleted; try again in a moment'))
    if (activeDownload) return activeDownload.promise
    if (status.state === 'ready' && !activeVerify) return Promise.resolve()
    const job = { controller: new AbortController(), cancelled: false, stalled: false, promise: null }
    activeDownload = job
    job.promise = runDownload(job).finally(() => {
      if (activeDownload === job) activeDownload = null
    })
    return job.promise
  }

  function cancelDownload() {
    if (!activeDownload) return
    activeDownload.cancelled = true
    activeDownload.controller.abort()
  }

  // The state is 'deleting' (and getVerifiedModelPath() returns null) from the
  // first moment, so no new inference can pick the file up. beforeRemove runs
  // after downloads and verification stopped and before the files go; the
  // caller uses it to stop the inference worker that maps the file.
  function deleteModel({ beforeRemove } = {}) {
    ensureInitialized()
    if (activeDelete) return activeDelete
    deleting = true
    activeDelete = runDelete(beforeRemove).finally(() => {
      activeDelete = null
    })
    return activeDelete
  }

  async function runDelete(beforeRemove) {
    setStatus({ error: null })
    try {
      const job = activeDownload
      if (job) {
        cancelDownload()
        await job.promise.catch(() => {})
      }
      if (activeVerify) await activeVerify.catch(() => {})
      if (beforeRemove) await beforeRemove()
      await Promise.all([modelPath, partPath, markerPath, `${markerPath}.tmp`].map(filePath => fs.promises.rm(filePath, REMOVE_OPTIONS)))
      log.info('[localModel] Model files deleted')
      deleting = false
      setStatus({ state: 'absent', receivedBytes: 0, error: null })
    } catch (error) {
      log.warn('[localModel] Could not delete the model files:', error.message)
      deleting = false
      status = null
      ensureInitialized()
      setStatus({})
      throw error
    }
  }

  // Removes files left by a previously pinned model (other file names that
  // match the model file patterns). Only regular files directly in modelsDir.
  async function removeOrphanedFiles() {
    let entries
    try {
      entries = await fs.promises.readdir(modelsDir, { withFileTypes: true })
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn('[localModel] Could not list the models folder:', error.message)
      return []
    }
    const keep = new Set([modelPath, partPath, markerPath, `${markerPath}.tmp`].map(filePath => path.basename(filePath)))
    const orphans = entries
      .filter(entry => entry.isFile() && MODEL_FILE_PATTERN.test(entry.name) && !keep.has(entry.name))
      .map(entry => entry.name)
    for (const name of orphans) {
      try {
        await fs.promises.rm(path.join(modelsDir, name), REMOVE_OPTIONS)
      } catch (error) {
        log.warn('[localModel] Could not remove an old model file:', error.message)
      }
    }
    if (orphans.length > 0) log.info(`[localModel] Removed ${orphans.length} file(s) of a previous model`)
    return orphans
  }

  return {
    getModelStatus,
    onStatusChange,
    downloadModel,
    cancelDownload,
    deleteModel,
    removeOrphanedFiles,
    getVerifiedModelPath,
    paths: { modelPath, partPath, markerPath }
  }
}

module.exports = {
  createModelManager,
  STALL_TIMEOUT_MS
}
