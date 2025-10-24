const log = require('electron-log');
const { GlobalKeyboardListener } = require('node-global-key-listener');
const { BrowserWindow } = require('electron');

// Module state
let isTracking = false;
let keystrokeTimeline = [];
let keyboardListener = null;
let lastKeyTime = {}; // Stores the last time each key was pressed for debouncing
const DEBOUNCE_TIME = 150; // 150ms debounce time for keystrokes
const MAX_KEYSTROKE_HISTORY = 1000; // Limit keystroke history to avoid memory issues
let mainWindow = null;

/**
 * Initialize keystroke tracking module with window reference
 * @param {BrowserWindow} window Main window reference
 */
function initialize(window) {
  mainWindow = window;
}

/**
 * Check if the application has permission to track keystrokes
 * @returns {Promise<boolean>} True if permission is granted, false otherwise
 */
async function checkPermissions() {
  try {
    // On macOS (and other non-Linux), passively probe by attempting to create a listener.
    // If TCC (Input Monitoring) isn't granted, this will fail and we'll disable the feature.
    // For Linux systems, try creating a listener with options to prevent pkexec errors
    if (process.platform === 'linux') {
      try {
        // Try with allowChmod: false to prevent errors
        const testListener = new GlobalKeyboardListener({ allowChmod: false });
        testListener.kill();
        return true;
      } catch (linuxError) {
        log.error('Linux keystroke check failed:', linuxError);
        // Send notice to renderer about Linux keystrokes permission and emit permission=false
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('linux-keystrokes-permission-notice');
          mainWindow.webContents.send('keystrokesPermission', false);
        }
        
        // Return false to let the capture system handle disabling
        return false;
      }
    }

    // For non-Linux platforms, use allowChmod: false to prevent password prompts
    const testListener = new GlobalKeyboardListener({ allowChmod: false });
    testListener.kill();
    return true;
  } catch (error) {
    log.error('Keystroke tracking permission check failed:', error);
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('keystrokesPermission', false);
      }
    } catch (_) {}
    return false;
  }
}

/**
 * Normalizes key names to more readable format
 * @param {Object} e Key event
 * @param {Object} down Down state
 * @returns {string} Normalized key representation
 */
function normalizeKeyName(e, down) {
  // We only want to keep backspace, enter, and space from special keys
  const allowedSpecialKeys = {
    'backspace': null, // We'll handle backspace specially in processKeystroke
    'enter': '[ENTER]', // Clear enter representation
    'space': ' '       // Actual space character
  };

  // Direct mapping for punctuation keys
  const punctuationKeys = {
    'comma': ',',
    'period': '.',
    'semicolon': ';',
    'quote': '\'',
    'backquote': '`',
    'minus': '-',
    'equal': '=',
    'open bracket': '[',
    'close bracket': ']',
    'backslash': '\\',
    'slash': '/',
    'multiply': '*',
    'add': '+',
    'subtract': '-',
    'decimal point': '.',
    'divide': '/'
  };

  // Ignore all modifiers (ctrl, alt, meta, shift)
  // No modifier string will be added to keys
  
  // Get base key name
  let keyName = e.name ? e.name.toLowerCase() : 'Unknown';
  
  // Skip mouse-related and scrolling events
  if (keyName.includes('mouse') || 
      keyName.includes('button') || 
      keyName.includes('click') || 
      keyName.includes('scroll') || 
      keyName.includes('wheel')) {
    return null;
  }
  
  // Skip all modifier keys
  if (['shift', 'control', 'ctrl', 'alt', 'meta', 'command', 'cmd', 'super', 'win'].includes(keyName)) {
    return null;
  }
  
  // Skip all special keys except allowed ones (backspace, enter, and space)
  const isSpecialKey = [
    'tab', 'escape', 'delete', 'up', 'down', 'left', 'right',
    'home', 'end', 'page up', 'page down', 'insert', 'capslock', 'numlock',
    'scrolllock', 'pause', 'printscreen', 'clear', 'menu', 'undo', 'redo'
  ].includes(keyName);
  
  // Filter out special keys except allowed ones
  if (isSpecialKey && !allowedSpecialKeys[keyName]) {
    return null;
  }
  
  // Check if it's an allowed special key (including space)
  if (allowedSpecialKeys[keyName]) {
    return allowedSpecialKeys[keyName];
  }
  
  // Check if it's a punctuation key
  if (punctuationKeys[keyName]) {
    return punctuationKeys[keyName];
  }
  
  // Skip function keys (F1-F12)
  if (/^f\d+$/.test(keyName)) {
    return null;
  }
  
  // For single character keys
  if (keyName.length === 1) {
    return keyName;
  }
  
  // For all other keys, just ignore them
  return null;
}

/**
 * Process a keystroke event and add it to the timeline
 * @param {Object} e Key event
 * @param {boolean} down Key state
 */
function processKeystroke(e, down) {
  try {
    // Skip processing for mouse and scrolling events
    if (e.name && (e.name.toLowerCase().includes('mouse') || 
                   e.name.toLowerCase().includes('button') || 
                   e.name.toLowerCase().includes('click') ||
                   e.name.toLowerCase().includes('scroll') ||
                   e.name.toLowerCase().includes('wheel'))) {
      return;
    }
    
    // Get current time for debounce check
    const now = Date.now();
    
    // Simple debouncing without tracking modifiers
    const uniqueKey = e.name;
    
    // Debounce check - ignore if the same key was pressed recently
    if (lastKeyTime[uniqueKey] && now - lastKeyTime[uniqueKey] < DEBOUNCE_TIME) {
      return;
    }
    
    // Update last key time for debouncing
    lastKeyTime[uniqueKey] = now;
    
    // Create clean event without modifiers
    const cleanEvent = {...e};
    if (cleanEvent.state) {
      cleanEvent.state = {
        ...cleanEvent.state,
        shift: false,
        ctrl: false,
        alt: false,
        meta: false
      };
    }
    
    // Special handling for backspace
    if (e.name.toLowerCase() === 'backspace') {
      // Remove the last keystroke from the timeline
      if (keystrokeTimeline.length > 0) {
        keystrokeTimeline.pop();
      }
      return;
    }
    
    // Get normalized key name
    const normalizedKey = normalizeKeyName(cleanEvent, down);
    
    // Skip if normalizedKey is null (filtered out)
    if (normalizedKey === null) {
      return;
    }
    
    // Add to keystroke timeline - we'll correlate with window info later
    keystrokeTimeline.push({
      key: normalizedKey,
      vkey: e.vkey,
      state: down ? 'down' : 'up',
      timestamp: new Date().toISOString()
    });
    
    // Limit the size of keystroke history to avoid memory issues
    if (keystrokeTimeline.length > MAX_KEYSTROKE_HISTORY) {
      keystrokeTimeline = keystrokeTimeline.slice(-MAX_KEYSTROKE_HISTORY);
    }
  } catch (error) {
    log.error('Error processing keystroke:', error);
  }
}

/**
 * Start tracking keystrokes
 * @returns {Promise<boolean>} True if tracking started successfully, false if permission denied or error occurred
 */
async function startTracking() {
  if (isTracking) {
    return true;
  }

  // Check if we have permission to track keystrokes
  const hasPermission = await checkPermissions();
  if (!hasPermission) {
    log.warn('Keystroke tracking permission not granted');
    return false;
  }

  // Reset data before starting
  keystrokeTimeline = [];
  lastKeyTime = {};

  try {
    // Always use allowChmod: false to prevent password prompts on all platforms
    const options = { allowChmod: false };
    
    // Create the keyboard listener
    keyboardListener = new GlobalKeyboardListener(options);
    
    // Add unhandledRejection handler specifically for the pkexec error on Linux
    if (process.platform === 'linux') {
      const rejectionHandler = (reason) => {
        if (reason && reason.message && reason.message.includes('pkexec') && 
            reason.message.includes('X11KeyServer')) {
          // Clean up this specific listener - we've handled it
          process.removeListener('unhandledRejection', rejectionHandler);
          
          // Clean up keyboard listener if it was created
          if (keyboardListener) {
            try {
              keyboardListener.kill();
            } catch (cleanupError) {
              log.error('Error cleaning up keyboard listener:', cleanupError);
            }
          }
          
          // Reset tracking state
          keyboardListener = null;
          isTracking = false;
          
          // Find main window to notify
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              // Notify renderer to disable keystrokes
              mainWindow.webContents.send('disable-capture-features', { keystrokes: false });
            }
          } catch (notifyError) {
            log.error('Error notifying about keystrokes disabling:', notifyError);
          }
        }
      };
      
      // Add the handler - will be removed after first match or when stopTracking is called
      process.on('unhandledRejection', rejectionHandler);
      
      // Store reference to remove later
      keyboardListener._rejectionHandler = rejectionHandler;
    }
    
    // Handle key events
    keyboardListener.addListener(function (e, down) {
      // Only care about keydown events to avoid duplicate keystrokes
      if (!down) {
        return; // Skip key up events
      }
      
      // Process the keystroke
      processKeystroke(e, down);
    });
    
    isTracking = true;
    return true;
  } catch (error) {
    log.error('Failed to start keystroke tracking:', error);
    return false;
  }
}

/**
 * Stop tracking keystrokes
 */
function stopTracking() {
  if (!isTracking) {
    return;
  }
  
  try {
    if (keyboardListener) {
      // Remove any rejection handler we added
      if (keyboardListener._rejectionHandler) {
        process.removeListener('unhandledRejection', keyboardListener._rejectionHandler);
        keyboardListener._rejectionHandler = null;
      }
      
      keyboardListener.kill();
      keyboardListener = null;
    }
  } catch (error) {
    log.error('Error stopping keystroke tracking:', error);
  } finally {
    isTracking = false;
    // Clear the lastKeyTime object to ensure no stale data when restarting
    lastKeyTime = {};
  }
}

/**
 * Get the keystroke timeline collected so far
 * @param {number} timeWindowMs - Time window in milliseconds to get data for, defaults to 5 minutes
 * @param {boolean} resetAfterCollection - Whether to clear the timeline after collecting data
 * @returns {Array} Keystroke timeline data for the specified time window
 */
function getKeystrokeTimeline(timeWindowMs = 5 * 60 * 1000, resetAfterCollection = true) {
  if (!isTracking || keystrokeTimeline.length === 0) {
    return [];
  }
  
  // If no time window specified, return all keystrokes
  if (!timeWindowMs) {
    const result = [...keystrokeTimeline];
    
    if (resetAfterCollection) {
      keystrokeTimeline = [];
    }
    
    return result;
  }
  
  // Filter keystrokes to only include those within the time window
  const now = new Date().getTime();
  const cutoffTime = now - timeWindowMs;
  
  const result = keystrokeTimeline.filter(entry => {
    const entryTime = new Date(entry.timestamp).getTime();
    return entryTime >= cutoffTime;
  });
  
  // If requested, clear the timeline after collection to avoid duplicating data
  if (resetAfterCollection) {
    keystrokeTimeline = [];
  }
  
  return result;
}

/**
 * Clear the keystroke timeline data
 */
function clearTimeline() {
  keystrokeTimeline = [];
}

/**
 * Checks if keystroke tracking is currently active
 * @returns {boolean} True if tracking is active
 */
function isTrackingActive() {
  return isTracking;
}

module.exports = {
  initialize,
  startTracking,
  stopTracking,
  checkPermissions,
  getKeystrokeTimeline,
  clearTimeline,
  isTracking: isTrackingActive
}; 