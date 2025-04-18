const log = require('electron-log')
const activeWindow = require('active-win')

// Track active windows
let isTracking = false
let windowTimeline = []
let trackingInterval = null
const TRACKING_INTERVAL_MS = 2000 // Poll every 2 seconds

/**
 * Checks if the application has permission to access window information
 * @returns {Promise<boolean>} True if permissions are granted, false otherwise
 */
async function checkPermissions() {
  try {
    // Try to get active window info - if it fails, it's likely a permission issue
    const result = await activeWindow()
    return result !== null
  } catch (error) {
    log.error('Window tracking permission check failed:', error)
    return false
  }
}

/**
 * Starts continuous tracking of active application windows
 * @returns {Promise<boolean>} True if tracking started successfully, false if permission denied or error occurred
 */
async function startTracking() {
  if (isTracking) {
    return
  }
  
  // First check if we have permission
  const hasPermission = await checkPermissions()
  if (!hasPermission) {
    const message = 'Permission denied for window tracking. Please grant accessibility permissions in system settings.'
    log.error('Failed to start window tracking:', message)
    return false
  }
  
  // Clear previous data
  windowTimeline = []
  
  // Start continuous tracking interval
  try {
    // Record initial window
    await recordCurrentWindow()
    
    // Set up interval to record windows periodically
    trackingInterval = setInterval(async () => {
      try {
        await recordCurrentWindow()
      } catch (err) {
        // Log error but continue tracking
        log.error('Error during periodic window tracking:', err)
      }
    }, TRACKING_INTERVAL_MS)
    
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
  try {
    const activeWindowInfo = await activeWindow()
    
    if (!activeWindowInfo) {
      // Still record the timestamp but with empty data
      windowTimeline.push({
        timestamp: new Date().toISOString(),
        title: 'Unknown Window',
        app: 'Unknown',
        executable: 'unknown'
      })
      return
    }
    
    // Record window information
    windowTimeline.push({
      timestamp: new Date().toISOString(),
      title: activeWindowInfo.title || 'Unknown',
      app: activeWindowInfo.owner.name || 'Unknown',
      executable: activeWindowInfo.owner.path || 'unknown'
    })
    
    // Keep timeline at a reasonable size (store at most 1 hour of data)
    const MAX_ENTRIES = 60 * 60 / (TRACKING_INTERVAL_MS/1000)
    if (windowTimeline.length > MAX_ENTRIES) {
      windowTimeline = windowTimeline.slice(-MAX_ENTRIES)
    }
    
  } catch (error) {
    log.error('Error tracking window:', error)
    // Record the error in the timeline
    windowTimeline.push({
      timestamp: new Date().toISOString(),
      title: 'Error Tracking Window',
      app: 'Error',
      executable: error.message
    })
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

module.exports = {
  startTracking,
  stopTracking,
  checkPermissions,
  getTimelineBuffer,
  clearTimeline,
  processTimelineData,
  isTracking: isTrackingActive
} 