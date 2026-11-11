const log = require('electron-log')
const windowsCapture = require('./captureWindows')
const { shouldExcludeWindow } = windowsCapture
const { screen } = require('electron')
const { calculateVisibleRegion, applyMaskToImage } = require('./windowRegionUtils')

function normalizeDisplayId(displayId) {
  if (displayId === undefined || displayId === null) return null
  const normalized = String(displayId).trim()
  return normalized ? normalized : null
}

function normalizeScreenshotEntries(screenshots) {
  if (!Array.isArray(screenshots) || screenshots.length === 0) return []
  return screenshots.map((screenshot) => {
    if (typeof screenshot === 'string') {
      return {
        imageDataUrl: screenshot,
        displayId: null,
        merged: false
      }
    }

    return {
      imageDataUrl: screenshot?.imageDataUrl,
      displayId: normalizeDisplayId(screenshot?.displayId),
      merged: !!screenshot?.merged
    }
  })
}

function toPublicScreenshots(screenshotEntries) {
  return screenshotEntries.map((entry) => entry.imageDataUrl)
}

function findDisplayById(displayBounds, displayId) {
  const normalizedDisplayId = normalizeDisplayId(displayId)
  if (!normalizedDisplayId) return null
  return displayBounds.find((display) => normalizeDisplayId(display?.id) === normalizedDisplayId) || null
}

function isSameWindow(w1, w2) {
  if (!w1?.bounds || !w2?.bounds) return false
  return w1.appName === w2.appName &&
         w1.bounds.x === w2.bounds.x &&
         w1.bounds.y === w2.bounds.y &&
         w1.bounds.width === w2.bounds.width &&
         w1.bounds.height === w2.bounds.height
}

function reorderWindowsByVisibility(allWindows, excludedWindows) {
  const windowsWithActivity = allWindows.filter((window) => window.hasActivity === true)
  const excludedNoActivity = allWindows.filter((window) =>
    window.hasActivity !== true && excludedWindows.some((excludedWindow) => isSameWindow(excludedWindow, window))
  )
  const nonExcludedNoActivity = allWindows.filter((window) =>
    window.hasActivity !== true && !excludedWindows.some((excludedWindow) => isSameWindow(excludedWindow, window))
  )

  return [...windowsWithActivity, ...excludedNoActivity, ...nonExcludedNoActivity]
}

function shouldUseIndexDisplayFallback(screenshotEntries, displayBounds) {
  if (screenshotEntries.length === 0) return false
  if (screenshotEntries.length === 1 && screenshotEntries[0]?.merged) return false
  return screenshotEntries.every((entry) => !entry.displayId)
}

/**
 * In strict mode a screenshot that might still show an excluded app is an
 * error rather than something to pass through unmasked.
 */
function failIfStrict(throwOnError, reason) {
  if (!throwOnError) return
  const error = new Error(`App exclusion masking unavailable: ${reason}`)
  error.code = 'APP_EXCLUSION_MASKING_UNAVAILABLE'
  throw error
}

function getWindowLogMeta(window, extra = {}) {
  const title = typeof window?.title === 'string' ? window.title : ''
  return {
    appName: window?.appName || 'Unknown',
    titlePresent: title ? 'true' : 'false',
    titleLength: String(title.length),
    windowDisplayId: normalizeDisplayId(window?.displayId) || 'unresolved',
    windowScreen: Number.isInteger(window?.screen) ? String(window.screen) : 'null',
    ...extra
  }
}

/**
 * Mask excluded apps from screenshots (internal function with all parameters)
 * @param {Array} screenshots Array of screenshot entries or screenshot data URLs
 * @param {Array} excludedApps Array of exclusion rules [{appName, titlePattern}]
 * @param {Array} windowData Array of window info with bounds, screen, displayId, app name, title (already sorted by z-order)
 * @param {Array} displayBounds Array of display bounds from screen.getAllDisplays()
 * @param {{throwOnError?: boolean}} options throwOnError throws instead of returning
 *   screenshots that could not be fully masked
 * @returns {Promise<Array>} Masked screenshot entries array
 */
async function maskExcludedApps(screenshots, excludedApps, windowData, displayBounds, { throwOnError = false } = {}) {
  try {
    const screenshotEntries = normalizeScreenshotEntries(screenshots)
    if (screenshotEntries.length === 0) return screenshotEntries
    if (!excludedApps || excludedApps.length === 0) return screenshotEntries
    if (!windowData || windowData.length === 0) {
      failIfStrict(throwOnError, 'no window data')
      return screenshotEntries
    }
    if (!displayBounds || displayBounds.length === 0) {
      failIfStrict(throwOnError, 'no display bounds')
      return screenshotEntries
    }
    if (throwOnError && windowData.some((window) => window && !window.bounds && shouldExcludeWindow(window, excludedApps))) {
      failIfStrict(throwOnError, 'excluded window without bounds')
    }

    const isMergedScreenshot = screenshotEntries.length === 1 &&
      (screenshotEntries[0].merged || displayBounds.length > 1)

    if (isMergedScreenshot) {
      const screenshotEntry = screenshotEntries[0]
      const minX = Math.min(...displayBounds.map((display) => display.bounds.x))
      const minY = Math.min(...displayBounds.map((display) => display.bounds.y))
      const maxX = Math.max(...displayBounds.map((display) => display.bounds.x + display.bounds.width))
      const maxY = Math.max(...displayBounds.map((display) => display.bounds.y + display.bounds.height))
      const mergedBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }

      const excludedWindows = windowData.filter((window) => {
        if (!window?.bounds) return false
        return shouldExcludeWindow(window, excludedApps)
      })
      if (excludedWindows.length === 0) return screenshotEntries

      const reorderedWindows = reorderWindowsByVisibility(windowData, excludedWindows)
      const primaryDisplay = displayBounds.find((display) => display.id === screen.getPrimaryDisplay().id) || displayBounds[0]
      const allMaskRegions = []

      for (const excludedWindow of excludedWindows) {
        let windowDisplay = findDisplayById(displayBounds, excludedWindow.displayId)
        if (!windowDisplay && Number.isInteger(excludedWindow.screen)) {
          windowDisplay = displayBounds[excludedWindow.screen] || null
        }
        if (!windowDisplay) {
          failIfStrict(throwOnError, 'excluded window with unresolved display')
          log.warn('[app-masking] Skipping excluded window with unresolved display', getWindowLogMeta(excludedWindow, {
            screenshotDisplayId: 'merged',
            screenshotIndex: '0',
            fallback: 'none',
            skipped: 'true'
          }))
          continue
        }

        log.debug('[app-masking] Applying mask to merged screenshot', getWindowLogMeta(excludedWindow, {
          screenshotDisplayId: 'merged',
          screenshotIndex: '0',
          fallback: 'none',
          skipped: 'false'
        }))
        const regions = calculateVisibleRegion(excludedWindow, reorderedWindows, mergedBounds, windowDisplay)
        allMaskRegions.push(...regions)
      }

      if (allMaskRegions.length === 0) return screenshotEntries

      const maskedImage = await applyMaskToImage(screenshotEntry.imageDataUrl, allMaskRegions, mergedBounds)
      return [{ ...screenshotEntry, imageDataUrl: maskedImage }]
    }

    const useIndexFallback = shouldUseIndexDisplayFallback(screenshotEntries, displayBounds)
    if (useIndexFallback) {
      log.warn('[app-masking] Falling back to index-based screenshot matching', {
        screenshotCount: String(screenshotEntries.length),
        displayCount: String(displayBounds.length)
      })
    }

    if (!useIndexFallback) {
      const screenshotDisplayIds = new Set(
        screenshotEntries.map((entry) => normalizeDisplayId(entry.displayId)).filter(Boolean)
      )
      for (const excludedWindow of windowData) {
        if (!excludedWindow?.bounds || !shouldExcludeWindow(excludedWindow, excludedApps)) continue
        if (!excludedWindow.displayId) {
          failIfStrict(throwOnError, 'excluded window with unresolved display')
          log.warn('[app-masking] Skipping excluded window with unresolved display', getWindowLogMeta(excludedWindow, {
            screenshotDisplayId: 'unresolved',
            screenshotIndex: 'n/a',
            fallback: 'none',
            skipped: 'true'
          }))
          continue
        }
        if (!screenshotDisplayIds.has(excludedWindow.displayId)) {
          failIfStrict(throwOnError, 'excluded window without matching screenshot')
          log.warn('[app-masking] Skipping excluded window without matching screenshot', getWindowLogMeta(excludedWindow, {
            screenshotDisplayId: excludedWindow.displayId,
            screenshotIndex: 'n/a',
            fallback: 'none',
            skipped: 'true'
          }))
        }
      }
    }

    if (throwOnError && useIndexFallback) {
      const unplacedExcludedWindow = windowData.some((window) =>
        window?.bounds && !Number.isInteger(window.screen) && shouldExcludeWindow(window, excludedApps)
      )
      if (unplacedExcludedWindow) failIfStrict(throwOnError, 'excluded window with unresolved display')
    }

    const maskedScreenshotEntries = []
    for (let i = 0; i < screenshotEntries.length; i++) {
      const screenshotEntry = screenshotEntries[i]
      const display = useIndexFallback
        ? displayBounds[i]
        : findDisplayById(displayBounds, screenshotEntry.displayId)

      if (!display || !display.bounds) {
        if (throwOnError && windowData.some((window) => window?.bounds && shouldExcludeWindow(window, excludedApps))) {
          failIfStrict(throwOnError, 'screenshot with unresolved display')
        }
        if (!useIndexFallback) {
          log.warn('[app-masking] Skipping screenshot entry with unresolved display', {
            screenshotDisplayId: screenshotEntry.displayId || 'unresolved',
            screenshotIndex: String(i)
          })
        }
        maskedScreenshotEntries.push(screenshotEntry)
        continue
      }

      const screenBounds = display.bounds
      const windowsOnScreen = windowData.filter((window) => {
        if (!window?.bounds) return false
        if (useIndexFallback) {
          return Number.isInteger(window.screen) && window.screen === i
        }
        return !!window.displayId && window.displayId === screenshotEntry.displayId
      })
      const excludedWindows = windowsOnScreen.filter((window) => shouldExcludeWindow(window, excludedApps))
      if (excludedWindows.length === 0) {
        maskedScreenshotEntries.push(screenshotEntry)
        continue
      }

      const reorderedWindows = reorderWindowsByVisibility(windowsOnScreen, excludedWindows)
      const allMaskRegions = []
      for (const excludedWindow of excludedWindows) {
        log.debug('[app-masking] Applying mask to screenshot entry', getWindowLogMeta(excludedWindow, {
          screenshotDisplayId: screenshotEntry.displayId || 'index-fallback',
          screenshotIndex: String(i),
          fallback: useIndexFallback ? 'index' : 'none',
          skipped: 'false'
        }))
        const regions = calculateVisibleRegion(excludedWindow, reorderedWindows, screenBounds, display)
        allMaskRegions.push(...regions)
      }

      if (allMaskRegions.length > 0) {
        const maskedImage = await applyMaskToImage(screenshotEntry.imageDataUrl, allMaskRegions, screenBounds)
        maskedScreenshotEntries.push({ ...screenshotEntry, imageDataUrl: maskedImage })
      } else {
        maskedScreenshotEntries.push(screenshotEntry)
      }
    }

    return maskedScreenshotEntries
  } catch (error) {
    log.error('Error masking excluded apps:', error)
    if (throwOnError) throw error
    return normalizeScreenshotEntries(screenshots)
  }
}

/**
 * Apply app exclusions to detailed screenshots (internal API)
 * Handles loading exclusions from store, gathering window data, and applying masks
 * @param {Array} screenshots Array of screenshot entries or screenshot data URLs
 * @param {{throwOnError?: boolean}} options throwOnError throws when exclusions are
 *   configured but masking failed or could not be applied, instead of returning the
 *   unmasked screenshots
 * @returns {Promise<Array>} Masked screenshot entries array (or original if no exclusions or error)
 */
async function applyAppExclusionsToDetailedScreenshots(screenshots, { throwOnError = false } = {}) {
  try {
    const screenshotEntries = normalizeScreenshotEntries(screenshots)
    if (screenshotEntries.length === 0) return screenshotEntries

    const { default: Store } = require('electron-store')
    const { app } = require('electron')
    const store = new Store({ name: 'donethat-config', cwd: app.getPath('userData') })
    const exclusions = store.get('appExclusions') || []
    if (!exclusions || exclusions.length === 0) return screenshotEntries

    const windowData = await windowsCapture.getAllVisibleWindows()
    const displayBounds = screen.getAllDisplays()
    if (!windowData || windowData.length === 0 || !displayBounds || displayBounds.length === 0) {
      failIfStrict(throwOnError, 'no window or display data')
      return screenshotEntries
    }

    return await maskExcludedApps(screenshotEntries, exclusions, windowData, displayBounds, { throwOnError })
  } catch (error) {
    log.error('Error applying app exclusions:', error)
    if (throwOnError) throw error
    return normalizeScreenshotEntries(screenshots)
  }
}

/**
 * Apply app exclusions to screenshots (public API)
 * @param {Array} screenshots Array of screenshot data URLs
 * @returns {Promise<Array>} Masked screenshots array (or original if no exclusions or error)
 */
async function applyAppExclusions(screenshots) {
  const maskedEntries = await applyAppExclusionsToDetailedScreenshots(screenshots)
  return toPublicScreenshots(maskedEntries)
}

module.exports = {
  applyAppExclusions,
  applyAppExclusionsToDetailedScreenshots,
  __test__: {
    maskExcludedApps,
    normalizeScreenshotEntries,
    shouldUseIndexDisplayFallback
  }
}
