const log = require('electron-log')
const { activeWindow } = require('get-windows')
const { systemPreferences, ipcMain, shell, app } = require('electron')

// Track active windows
let isTracking = false
let windowTimeline = []
let trackingInterval = null
const INITIAL_TRACKING_INTERVAL_MS = 2000 // Base polling interval (2 seconds)
let currentTrackingIntervalMs = INITIAL_TRACKING_INTERVAL_MS // Current interval that can change with backoff
const MAX_BACKOFF_MS = 60000 // Maximum backoff (1 minute)
const BACKOFF_MULTIPLIER = 2 // Exponential backoff multiplier
let consecutiveFailures = 0 // Track consecutive failures for backoff
let lastBackoffTime = 0 // Track when we last applied backoff
let processingRecordWindow = false // Flag to prevent overlapping calls

// References to communicate permission/state changes without prompting the OS
let stateManagerRef = null
let mainWindowRef = null

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
 * Tracks the active window and adds it to the timeline
 * @private
 */
async function recordCurrentWindow() {
  // Prevent overlapping calls - if a previous call is still processing, skip this one
  if (processingRecordWindow) {
    log.debug('Skipping overlapping window tracking call')
    return
  }
  
  processingRecordWindow = true
  
  try {
    // Generic passive permission gate before probing window info
    const hasPerm = await checkPermissions()
    if (!hasPerm) {
      // Permission not available: propagate and stop tracking without prompting OS settings
      try { stateManagerRef?.updateWindowsPermission(false) } catch (_) {}
      try { if (mainWindowRef) mainWindowRef.webContents.send('windowsPermission', false) } catch (_) {}
      // Don't stop tracking here; let the renderer's settings flow disable it via updateInputDataSettings
      processingRecordWindow = false
      return
    }
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
    
    // Record window information
    windowTimeline.push({
      timestamp: new Date().toISOString(),
      title: activeWindowInfo.title || 'Unknown',
      app: activeWindowInfo.owner?.name || activeWindowInfo.owner?.processName || 'Unknown',
      executable: activeWindowInfo.owner?.path || 'unknown'
    })
    
    // Keep timeline at a reasonable size (store at most 1 hour of data)
    const MAX_ENTRIES = 60 * 60 / (INITIAL_TRACKING_INTERVAL_MS/1000)
    if (windowTimeline.length > MAX_ENTRIES) {
      windowTimeline = windowTimeline.slice(-MAX_ENTRIES)
    }
    
    // Reset backoff on success
    resetBackoff()
    
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
  const result = windowTimeline.filter(entry => {
    const entryTime = new Date(entry.timestamp).getTime()
    return entryTime >= cutoffTime
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
 */
function clearTimeline() {
  windowTimeline = []
}

/**
 * Process timeline data into a more usable format
 * @param {Array} timeline Raw timeline data
 * @returns {Array} Processed timeline data with window usage periods
 */
function processTimelineData(timeline) {
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
      const hasPermission = await checkPermissions();
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
  initWindowsPermissionHandling
} 