const log = require('electron-log')
const { activeWindow, openWindows } = require('get-windows')
const { systemPreferences, ipcMain, shell, app, screen } = require('electron')

// Helper to normalize app name
function normalizeAppName(appName) {
  if (!appName) return ''
  return appName.toLowerCase().replace(/\.(app|exe)$/i, '').trim()
}

// Helper to create a unique window identifier for z-order tracking
function getWindowId(window) {
  if (!window || !window.bounds) return null
  const normalizedApp = normalizeAppName(window.appName)
  const b = window.bounds
  const title = window.title || ''
  // Use app name + title + bounds to uniquely identify a window
  return `${normalizedApp}|${title}|${b.x},${b.y},${b.width},${b.height}`
}

/**
 * Convert window bounds from physical pixels (get-windows) to DIP (Electron screen API)
 * On macOS, get-windows already returns DIP coordinates, so no conversion is applied.
 * @param {Object} bounds Window bounds (physical pixels on Linux/Windows, DIP on macOS)
 * @param {Object} display Optional Electron display object with scaleFactor (if already known)
 * @returns {Object} Window bounds in DIP {x, y, width, height}
 */
function convertBoundsToDIP(bounds, display) {
  if (!bounds) return bounds
  
  // On macOS, get-windows already returns DIP coordinates, so no conversion needed
  if (process.platform === 'darwin') {
    return bounds
  }
  
  // If display is provided, use it directly (most efficient)
  if (display && display.scaleFactor) {
    const scaleFactor = display.scaleFactor
    return {
      x: bounds.x / scaleFactor,
      y: bounds.y / scaleFactor,
      width: bounds.width / scaleFactor,
      height: bounds.height / scaleFactor
    }
  }
  
  // Try using Electron's built-in conversion if available (Electron 20+)
  // This handles per-display DPI scaling automatically
  if (screen.screenToDipRect) {
    try {
      const dipRect = screen.screenToDipRect(null, bounds)
      if (dipRect && dipRect.x !== undefined && dipRect.y !== undefined) {
        return dipRect
      }
      // Fallback if screenToDipRect returns undefined/null or invalid result
    } catch (error) {
      // Fall through to manual conversion
    }
  }
  
  // Fallback: manually convert using the display that matches the physical rect
  // On some platforms, getDisplayMatching might work with physical pixels
  // We use it to find the display, then convert using that display's scaleFactor
  try {
    const matchingDisplay = screen.getDisplayMatching(bounds)
    if (matchingDisplay && matchingDisplay.scaleFactor) {
      const scaleFactor = matchingDisplay.scaleFactor
      return {
        x: bounds.x / scaleFactor,
        y: bounds.y / scaleFactor,
        width: bounds.width / scaleFactor,
        height: bounds.height / scaleFactor
      }
    }
  } catch (error) {
    // Fall through
  }
  
  // If we can't determine the display, assume scale factor of 1.0 (no scaling)
  return bounds
}

// Helper to get display index for window bounds
// Bounds from get-windows are in physical pixels, but screen.getDisplayMatching expects DIP
function getDisplayIndexForBounds(bounds) {
  if (!bounds) return 0
  try {
    // Convert physical pixels to DIP first
    const dipBounds = convertBoundsToDIP(bounds)
    
    // Now match using DIP coordinates
    const matchingDisplay = screen.getDisplayMatching(dipBounds)
    if (matchingDisplay) {
      const displays = screen.getAllDisplays()
      const displayIndex = displays.findIndex(display => display.id === matchingDisplay.id)
      return displayIndex >= 0 ? displayIndex : 0
    }
    return 0
  } catch (error) {
    log.error('Error getting display index for bounds:', error)
    return 0
  }
}

/**
 * Sort windows by approximate z-order using z-order cache
 * The cache is updated every 2 seconds by recordCurrentWindow(), so the active window
 * will have the most recent timestamp and naturally sort to the top
 * @param {Array} windows All windows
 * @returns {Array} Windows sorted by approximate z-order (topmost first)
 */
function sortWindowsByZOrder(windows) {
  const activityMap = zOrderCache || new Map()
  
  // Sort windows by most recent activity (higher timestamp = more recent = higher z-order)
  // Windows with no activity (never active) get 0, so they'll be sorted below recently active windows
  const sorted = [...windows].sort((a, b) => {
    const aWindowId = getWindowId(a)
    const bWindowId = getWindowId(b)
    const aActivity = aWindowId ? (activityMap.get(aWindowId) || 0) : 0
    const bActivity = bWindowId ? (activityMap.get(bWindowId) || 0) : 0
    if (aActivity !== bActivity) {
      // Descending order: more recent activity (higher timestamp) = higher z-order
      // This means recently active windows are on top of never-active windows
      return bActivity - aActivity
    }
    
    // Fallback: maintain original order
    return 0
  })
  
  return sorted
}

// Track active windows
let isTracking = false
let windowTimeline = []
let trackingInterval = null
let getAllVisibleWindowsInProgress = false
const INITIAL_TRACKING_INTERVAL_MS = 2000 // Base polling interval (2 seconds)
let currentTrackingIntervalMs = INITIAL_TRACKING_INTERVAL_MS // Current interval that can change with backoff
const MAX_BACKOFF_MS = 60000 // Maximum backoff (1 minute)
const BACKOFF_MULTIPLIER = 2 // Exponential backoff multiplier
let consecutiveFailures = 0 // Track consecutive failures for backoff
let lastBackoffTime = 0 // Track when we last applied backoff
let processingRecordWindow = false // Flag to prevent overlapping calls
let permissionCooldownUntil = 0 // Timestamp in ms; skip probes until this time when permission flips false
let lastEmittedPermission = null // Track last emitted permission state to avoid repeated emissions
let capturePausedDueToWindowsPermission = false // Circuit breaker: pause capture interval once on permission loss
let firstPermissionDeniedAt = 0 // Timestamp when permission first went false; 0 means not currently denied

// References to communicate permission/state changes without prompting the OS
let stateManagerRef = null
let mainWindowRef = null

// Separate cache for z-order approximation: window ID -> last activity timestamp
// Window ID is: normalizedAppName|bounds.x,bounds.y,bounds.width,bounds.height
// This is independent of the main timeline and never gets cleared
let zOrderCache = new Map() // Map<windowId, timestamp>

// Helper: call activeWindow with a hard timeout to avoid hangs/crashes
async function safeActiveWindow(timeoutMs = 300) {
  try {
    const result = await Promise.race([
      activeWindow(),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ])
    return result
  } catch (_) {
    return null
  }
}

/**
 * Checks if the application has permission to access window information
 * @returns {Promise<boolean>} True if permissions are granted, false otherwise
 */
async function checkPermissions() {
  try {
    // On macOS, rely on the Accessibility trust state which is stable across focus changes
    if (process.platform === 'darwin') {
      const isTrusted = systemPreferences.isTrustedAccessibilityClient(false)
      // If accessibility is trusted, treat permission as granted even if the probe fails transiently
      if (isTrusted) {
        return true
      }
      return false
    }

    // Other platforms: best effort probe
    const result = await safeActiveWindow(300)
    return result !== null
  } catch (error) {
    // Treat probe failures as transient errors unless we know permission is denied
    log.warn('Window tracking permission probe failed (treated as transient):', error)
    return process.platform === 'darwin'
      ? systemPreferences.isTrustedAccessibilityClient(false)
      : false
  }
}

/**
 * Apply exponential backoff to the tracking interval
 * @private 
 */
function applyBackoff() {
  consecutiveFailures++
  
  // Calculate new interval with exponential backoff
  currentTrackingIntervalMs = Math.min(
    currentTrackingIntervalMs * BACKOFF_MULTIPLIER,
    MAX_BACKOFF_MS
  )
  
  // Log more detailed information about backoff
  const now = Date.now()
  const timeSinceLastBackoff = now - lastBackoffTime
  log.warn(`Window tracking failed ${consecutiveFailures} times. Backing off to ${currentTrackingIntervalMs}ms interval. Time since last backoff: ${timeSinceLastBackoff}ms`)
  lastBackoffTime = now
  
  // Restart tracking with new interval if we're still tracking
  if (isTracking && trackingInterval) {
    clearInterval(trackingInterval)
    trackingInterval = setInterval(recordCurrentWindow, currentTrackingIntervalMs)
  }
}

/**
 * Reset backoff when tracking succeeds
 * @private
 */
function resetBackoff() {
  if (consecutiveFailures > 0 || currentTrackingIntervalMs !== INITIAL_TRACKING_INTERVAL_MS) {
    log.info('Window tracking succeeded. Resetting to normal interval.')
    consecutiveFailures = 0
    
    // Only reset interval if we're backing off significantly
    if (currentTrackingIntervalMs > INITIAL_TRACKING_INTERVAL_MS * 2) {
      currentTrackingIntervalMs = INITIAL_TRACKING_INTERVAL_MS
      
      // Restart tracking with normal interval
      if (isTracking && trackingInterval) {
        clearInterval(trackingInterval)
        trackingInterval = setInterval(recordCurrentWindow, currentTrackingIntervalMs)
      }
    }
  }
}

/**
 * Starts continuous tracking of active application windows
 * @returns {Promise<boolean>} True if tracking started successfully, false if permission denied or error occurred
 */
async function startTracking() {
  if (isTracking) {
    return true
  }
  
  // First check if we have permission
  const hasPermission = await checkPermissions()
  if (!hasPermission) {
    const message = 'Permission denied for window tracking. Please grant accessibility permissions in system settings.'
    log.warn('Failed to start window tracking:', message)
    return false
  }
  
  // Reset tracking state
  windowTimeline = []
  consecutiveFailures = 0
  currentTrackingIntervalMs = INITIAL_TRACKING_INTERVAL_MS
  
  // Start continuous tracking interval
  try {
    // Record initial window
    await recordCurrentWindow()
    
    // Set up interval to record windows periodically
    trackingInterval = setInterval(recordCurrentWindow, currentTrackingIntervalMs)
    
    isTracking = true
    return true
  } catch (error) {
    log.error('Error during window tracking start:', error)
    if (trackingInterval) {
      clearInterval(trackingInterval)
      trackingInterval = null
    }
    return false
  }
}

/**
 * Reconstruct windows from z-order cache and timeline when openWindows() fails
 * @private
 */
function reconstructWindowsFromCache() {
  const reconstructed = []
  
  // Parse windowId to extract app name, title, and bounds
  // Format: normalizedAppName|title|bounds.x,bounds.y,bounds.width,bounds.height
  for (const [windowId, timestamp] of zOrderCache) {
    try {
      const parts = windowId.split('|')
      if (parts.length >= 3) {
        const normalizedAppName = parts[0]
        const title = parts[1]
        const boundsStr = parts[2]
        const boundsParts = boundsStr.split(',')
        
        if (boundsParts.length === 4) {
          const bounds = {
            x: parseInt(boundsParts[0], 10),
            y: parseInt(boundsParts[1], 10),
            width: parseInt(boundsParts[2], 10),
            height: parseInt(boundsParts[3], 10)
          }
          
          // Validate bounds
          if (!isNaN(bounds.x) && !isNaN(bounds.y) && !isNaN(bounds.width) && !isNaN(bounds.height) &&
              bounds.width > 0 && bounds.height > 0) {
            // Get screen index from bounds
            const screenIndex = getDisplayIndexForBounds(bounds)
            
            // Try to find matching entry in timeline for executable
            let executable = 'unknown'
            if (windowTimeline.length > 0) {
              const matchingEntry = windowTimeline.find(entry => {
                const entryAppName = normalizeAppName(entry.app || '')
                const entryTitle = entry.title || 'Unknown'
                return entryAppName === normalizedAppName && entryTitle === title
              })
              if (matchingEntry && matchingEntry.executable) {
                executable = matchingEntry.executable
              }
            }
            
            reconstructed.push({
              appName: normalizedAppName,
              title: title,
              executable: executable,
              bounds: bounds,
              screen: screenIndex,
              minimized: false,
              hidden: false
            })
          }
        }
      }
    } catch (err) {
      // Skip invalid entries
      continue
    }
  }
  
  return reconstructed
}

/**
 * Process raw windows from openWindows() into our format with bounds and screen info
 * @private
 */
function processWindows(windows) {
  const processedWindows = []
  for (const window of windows) {
    try {
      // Skip minimized or hidden windows
      if (window.minimized || window.hidden) {
        continue
      }
      
      const bounds = window.bounds
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        continue
      }
      
      // Get screen index using Electron's getDisplayMatching
      const screenIndex = getDisplayIndexForBounds(bounds)
      
      const appName = window.owner?.name || window.owner?.processName || 'Unknown'
      const title = window.title || 'Unknown'
      const executable = window.owner?.path || 'unknown'
      
      processedWindows.push({
        appName,
        title,
        executable,
        bounds,
        screen: screenIndex,
        minimized: false,
        hidden: false
      })
    } catch (error) {
      log.warn('Error processing window:', error)
    }
  }
  return processedWindows
}

/**
 * Tracks the active window and adds it to the timeline
 * Also enumerates all visible windows in parallel
 * @private
 */
async function recordCurrentWindow() {
  // Prevent overlapping calls - if a previous call is still processing, skip this one
  if (processingRecordWindow) {
    return
  }
  
  // Pause if getAllVisibleWindows is in progress to avoid conflicts
  if (getAllVisibleWindowsInProgress) {
    return
  }
  
  processingRecordWindow = true
  
  try {
    // Generic passive permission gate before probing window info
    const now = Date.now()
    if (now < permissionCooldownUntil) {
      // Cooldown active: do not probe, just exit tick
      processingRecordWindow = false
      return
    }
    const hasPerm = await checkPermissions()
    if (!hasPerm) {
      // Always set a sane cooldown immediately to avoid hammering probes
      const nowTs = Date.now()
      const baseCooldown = Math.max(3000, currentTrackingIntervalMs)
      permissionCooldownUntil = nowTs + baseCooldown
      try { log.warn(`[windows] permission=false detected; cooldown=${baseCooldown}ms; since=${firstPermissionDeniedAt ? (nowTs-firstPermissionDeniedAt)+'ms' : 'first-false'}`) } catch (_) {}

      // Start denial window if this is the first false
      if (firstPermissionDeniedAt === 0) {
        firstPermissionDeniedAt = nowTs
      }
      
      // Gate ALL side-effects until denial is persistent for >=10s (Windows is more forgiving)
      const deniedDuration = nowTs - firstPermissionDeniedAt
      if (deniedDuration < 10000 || process.platform === 'win32') {
        processingRecordWindow = false
        return
      }

      // Persistent denial: perform the original strong actions
      try { stopTracking() } catch (_) {}
      if (!capturePausedDueToWindowsPermission) {
        capturePausedDueToWindowsPermission = true
        try {
          const captureModule = require('./capture')
          if (captureModule && typeof captureModule.stopCaptureInterval === 'function') {
            captureModule.stopCaptureInterval()
          }
        } catch (_) {}
      }
      if (lastEmittedPermission !== false) {
        lastEmittedPermission = false
        try { stateManagerRef?.updateWindowsPermission(false) } catch (_) {}
        try { if (mainWindowRef) mainWindowRef.webContents.send('windowsPermission', false) } catch (_) {}
      }
      processingRecordWindow = false
      return
    }
    // Permission present again: reset denial window
    firstPermissionDeniedAt = 0
    const activeWindowInfo = await safeActiveWindow(300)
    
    if (!activeWindowInfo) {
      // Still record the timestamp but with empty data
      windowTimeline.push({
        timestamp: new Date().toISOString(),
        title: 'Unknown Window',
        app: 'Unknown',
        executable: 'unknown'
      })
      
      // Consider this a success for backoff purposes (not an error)
      resetBackoff()
      processingRecordWindow = false
      return
    }
    
    // Record window information with bounds if available
    const bounds = activeWindowInfo.bounds
    const screenIndex = bounds ? getDisplayIndexForBounds(bounds) : null
    
    const appName = activeWindowInfo.owner?.name || activeWindowInfo.owner?.processName || 'Unknown'
    
    windowTimeline.push({
      timestamp: new Date().toISOString(),
      title: activeWindowInfo.title || 'Unknown',
      app: appName,
      executable: activeWindowInfo.owner?.path || 'unknown',
      bounds: bounds,
      screen: screenIndex
    })
    
    // Update z-order cache with this specific window (never cleared, just updated with latest activity)
    if (bounds) {
      const windowObj = {
        appName: appName,
        title: activeWindowInfo.title || 'Unknown',
        bounds: bounds
      }
      const windowId = getWindowId(windowObj)
      if (windowId) {
        zOrderCache.set(windowId, Date.now())
      }
    }
    
    // Keep timeline at a reasonable size (store at most 1 hour of data)
    const MAX_ENTRIES = 60 * 60 / (INITIAL_TRACKING_INTERVAL_MS/1000)
    if (windowTimeline.length > MAX_ENTRIES) {
      windowTimeline = windowTimeline.slice(-MAX_ENTRIES)
    }
    
    // Reset backoff on success and clear any cooldown
    resetBackoff()
    permissionCooldownUntil = 0
    lastEmittedPermission = true
    // Do not auto-resume main capture here; user/system flow will re-enable as needed
    
  } catch (error) {
    log.warn('Error tracking window (treated as transient):', error?.message || error)
    
    // Record the error in the timeline
    windowTimeline.push({
      timestamp: new Date().toISOString(),
      title: 'Error Tracking Window',
      app: 'Error',
      executable: error.message
    })
    
    // Apply exponential backoff
    applyBackoff()
  } finally {
    // Always reset the processing flag
    processingRecordWindow = false
  }
}

/**
 * Gets the window timeline for a specific time period without stopping tracking
 * @param {number} timeWindowMs - Time window in milliseconds to get data for, defaults to 5 minutes
 * @param {boolean} resetAfterCollection - Whether to clear the timeline after collecting data
 * @returns {Array} Timeline data for the specified time window
 */
function getTimelineBuffer(timeWindowMs = 5 * 60 * 1000, resetAfterCollection = true) {
  if (!isTracking || windowTimeline.length === 0) {
    return []
  }
  
  const now = new Date().getTime()
  const cutoffTime = now - timeWindowMs
  
  // Filter timeline to only include entries within the time window
  const filtered = windowTimeline.filter(entry => {
    const entryTime = new Date(entry.timestamp).getTime()
    return entryTime >= cutoffTime
  })
  
  // Remove bounds and screen from timeline entries before returning
  const result = filtered.map(entry => {
    const { bounds, screen, ...rest } = entry
    return rest
  })
  
  // If requested, clear the timeline after collection to avoid duplicating data
  if (resetAfterCollection) {
    windowTimeline = []
  }
  
  return result
}

/**
 * Stop tracking active windows and clean up
 */
function stopTracking() {
  if (!isTracking) return
  
  if (trackingInterval) {
    clearInterval(trackingInterval)
    trackingInterval = null
  }
  
  isTracking = false
  // Reset backoff state when stopping
  consecutiveFailures = 0
  currentTrackingIntervalMs = INITIAL_TRACKING_INTERVAL_MS
}

/**
 * Clear the window timeline data without stopping tracking
 * Note: This does NOT clear the z-order cache, which is separate
 */
function clearTimeline() {
  windowTimeline = []
}

/**
 * Check if a window should be excluded based on app exclusions
 * Works with both window objects (from getAllVisibleWindows) and window periods (from processTimelineData)
 * @param {Object} window Window object or window period with appName/name and title
 * @param {Array} excludedApps Array of exclusion rules
 * @returns {boolean} True if window should be excluded
 */
function shouldExcludeWindow(window, excludedApps) {
  if (!excludedApps || excludedApps.length === 0) return false
  
  // Get app name from various possible fields (window objects use appName, window periods use name)
  const appName = (window.appName || window.app || window.name || window.owner?.name || window.owner?.processName || '').trim()
  const title = (window.title || '').trim()
  
  if (!appName) {
    return false
  }
  
  for (const exclusion of excludedApps) {
    if (!exclusion.appName || !exclusion.appName.trim()) continue
    
    const exclusionAppName = exclusion.appName.trim().toLowerCase()
    const windowAppName = appName.toLowerCase()
    
    // Normalize app names for comparison
    const normalizedExclusion = normalizeAppName(exclusionAppName)
    const normalizedWindow = normalizeAppName(windowAppName)
    
    // Check if normalized names match or contain each other
    const appMatches = normalizedWindow === normalizedExclusion ||
                       normalizedWindow.includes(normalizedExclusion) ||
                       normalizedExclusion.includes(normalizedWindow) ||
                       windowAppName.includes(exclusionAppName) ||
                       exclusionAppName.includes(windowAppName)
    
    if (!appMatches) {
      continue
    }
    
    // Handle both old format (titlePattern) and new format (titlePatterns)
    let titlePatterns = exclusion.titlePatterns || []
    if (exclusion.titlePattern && !titlePatterns.length) {
      // Migrate old format
      titlePatterns = [exclusion.titlePattern]
    }
    
    // If no title patterns, exclude all windows of this app
    if (!titlePatterns || titlePatterns.length === 0) {
      return true
    }
    
    // Check if title matches any of the patterns (case-insensitive, substring)
    const titleLower = title.toLowerCase()
    for (const pattern of titlePatterns) {
      if (!pattern || !pattern.trim()) continue
      const patternLower = pattern.trim().toLowerCase()
      if (titleLower.includes(patternLower)) {
        return true
      }
    }
  }
  
  return false
}

/**
 * Check if a window's activity should be ignored based on app exclusions with ignoreActivity flag
 * Works with both window objects (from getAllVisibleWindows) and window periods (from processTimelineData)
 * @param {Object} window Window object or window period with appName/name and title
 * @param {Array} excludedApps Array of exclusion rules
 * @returns {boolean} True if window activity should be ignored
 */
function shouldIgnoreActivity(window, excludedApps) {
  if (!excludedApps || excludedApps.length === 0) return false
  
  // Filter to only exclusions with ignoreActivity flag, then reuse shouldExcludeWindow
  const ignoreActivityExclusions = excludedApps.filter(exclusion => exclusion.ignoreActivity === true)
  return shouldExcludeWindow(window, ignoreActivityExclusions)
}

/**
 * Process timeline data into a more usable format
 * @param {Array} timeline Raw timeline data
 * @returns {Array} Processed timeline data with window usage periods
 */
async function processTimelineData(timeline) {
  if (!timeline || !Array.isArray(timeline) || timeline.length === 0) {
    return []
  }
  
  // Sort by timestamp
  const sorted = [...timeline].sort((a, b) => {
    return new Date(a.timestamp) - new Date(b.timestamp)
  })
  
  // Group by app and title
  const windows = []
  let currentWindow = null
  
  for (const entry of sorted) {
    const entryTime = new Date(entry.timestamp).getTime()
    
    if (!currentWindow || 
        currentWindow.title !== entry.title || 
        currentWindow.name !== entry.app) {
      
      // If we have a current window, close it out
      if (currentWindow) {
        currentWindow.endTime = entryTime
        currentWindow.duration = currentWindow.endTime - currentWindow.startTime
        windows.push(currentWindow)
      }
      
      // Start a new window period
      currentWindow = {
        title: entry.title,
        name: entry.app,
        executable: entry.executable,
        startTime: entryTime,
        endTime: null,
        duration: 0
      }
    }
  }
  
  // Close out the last window if it exists
  if (currentWindow) {
    // Use the last entry time as the end time
    const lastTime = new Date(sorted[sorted.length - 1].timestamp).getTime()
    currentWindow.endTime = lastTime
    currentWindow.duration = currentWindow.endTime - currentWindow.startTime
    windows.push(currentWindow)
  }
  
  // Filter out windows with ignoreActivity flag set
  try {
    const { default: Store } = await import('electron-store')
    const { app } = require('electron')
    const store = new Store({ name: 'donethat-config', cwd: app.getPath('userData') })
    const exclusions = store.get('appExclusions') || []
    
    if (exclusions && exclusions.length > 0) {
      return windows.filter(windowPeriod => {
        return !shouldIgnoreActivity(windowPeriod, exclusions)
      })
    }
  } catch (error) {
    // Non-critical: if exclusion filtering fails, continue with all window data
    log.warn('Error filtering ignored activity from window data:', error)
  }
  
  return windows
}

/**
 * Checks if window tracking is currently active
 * @returns {boolean} True if tracking is active
 */
function isTrackingActive() {
  return isTracking;
}

/**
 * Gets the current tracking interval in milliseconds
 * @returns {number} Current tracking interval
 */
function getCurrentInterval() {
  return currentTrackingIntervalMs;
}

/**
 * Get all visible windows with current bounds and screen info, sorted by z-order (topmost first)
 * Updates z-order cache with current active window to ensure it has the most recent timestamp
 * @returns {Promise<Array>} Array of window objects with appName, title, executable, bounds, screen, sorted by z-order
 */
async function getAllVisibleWindows() {  
  // Check permissions
  const hasPerm = await checkPermissions()
  if (!hasPerm) {
    return []
  }
  
  // Set flag to pause recordCurrentWindow to avoid conflicts
  getAllVisibleWindowsInProgress = true
  
  try {
    // Wait a second to let any in-flight recordCurrentWindow calls finish
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    // Enumerate windows on-demand
    let windows = []
    try {
      windows = await openWindows()
    } catch (error) {
      log.warn('Error enumerating windows:', error)
      
      // Try to reconstruct windows from z-order cache and timeline
      windows = reconstructWindowsFromCache()
    }
    
    // Process windows
    const processedWindows = processWindows(windows)
    
    // Update z-order cache with latest active window from timeline
    // Try to match it to one of the visible windows by app name and title
    if (windowTimeline.length > 0) {
      const latestEntry = windowTimeline[windowTimeline.length - 1]
      if (latestEntry && latestEntry.app) {
        const activeAppName = latestEntry.app
        const activeTitle = latestEntry.title || 'Unknown'
        
        // Find matching window in processed windows (match by app name and title)
        const matchingWindow = processedWindows.find(w => {
          const appMatches = normalizeAppName(w.appName) === normalizeAppName(activeAppName)
          const titleMatches = (w.title || 'Unknown') === activeTitle
          return appMatches && titleMatches
        })
        
        if (matchingWindow) {
          const windowId = getWindowId(matchingWindow)
          if (windowId) {
            zOrderCache.set(windowId, Date.now())
          }
        }
      }
    }
    
    // Add z-order activity information to each window (after cache update)
    for (const window of processedWindows) {
      const windowId = getWindowId(window)
      if (windowId) {
        window.hasActivity = zOrderCache.has(windowId)
      } else {
        window.hasActivity = false
      }
    }
    
    // Clean up z-order cache: remove windows that are no longer visible
    const visibleWindowIds = new Set()
    for (const window of processedWindows) {
      const windowId = getWindowId(window)
      if (windowId) {
        visibleWindowIds.add(windowId)
      }
    }
    
    // Remove any cache entries for windows that are no longer visible
    for (const [windowId] of zOrderCache) {
      if (!visibleWindowIds.has(windowId)) {
        zOrderCache.delete(windowId)
      }
    }
    
    return sortWindowsByZOrder(processedWindows)
  } finally {
    // Clear flag to allow recordCurrentWindow to resume
    getAllVisibleWindowsInProgress = false
  }
}

// Initialize Windows permission handling
function initWindowsPermissionHandling(mainWindow, stateManager, checkAndAdjustRecording, sendOverlayState) {
  // Store refs for permission state propagation from tracking loop
  mainWindowRef = mainWindow
  stateManagerRef = stateManager
  ipcMain.on('requestWindowsPermission', async (event, shouldOpenSettings = true) => {
    // Only open system settings if explicitly requested (user clicked toggle)
    if (shouldOpenSettings === true) {
      if (process.platform === 'darwin') {
        // macOS
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
      } else if (process.platform === 'win32') {
        // Windows - open general privacy settings
        shell.openExternal('ms-settings:privacy')
      } else {
        // Linux or other platforms
      }
      // After opening settings, re-check permission exactly once when the app regains focus
      const focusListener = async () => {
        app.removeListener('browser-window-focus', focusListener);
        try {
          const hasPermission = await checkPermissions();
          stateManager?.updateWindowsPermission(hasPermission);
          if (mainWindow) {
            mainWindow.webContents.send('windowsPermission', hasPermission);
          }
        } catch (e) {}
      };
      app.on('browser-window-focus', focusListener);
    } else {
      // Just check permission without opening settings
      // Harden against transient false by confirming twice before emitting false
      let hasPermission = await checkPermissions();
      if (!hasPermission) {
        try { await new Promise(res => setTimeout(res, 500)); } catch (_) {}
        const second = await checkPermissions();
        hasPermission = hasPermission || second; // only stay false if both checks are false
      }
      stateManager?.updateWindowsPermission(hasPermission);
      if (mainWindow) {
        mainWindow.webContents.send('windowsPermission', hasPermission);
      }
    }
  });
}

module.exports = {
  startTracking,
  stopTracking,
  checkPermissions,
  getTimelineBuffer,
  clearTimeline,
  processTimelineData,
  isTracking: isTrackingActive,
  getCurrentInterval,
  getAllVisibleWindows,
  initWindowsPermissionHandling,
  normalizeAppName,
  shouldExcludeWindow,
  convertBoundsToDIP
} 