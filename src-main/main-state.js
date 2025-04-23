const { ipcMain, Notification, app } = require('electron');
const log = require('electron-log');

// State variables
let store = null;
let pauseState = {
  endTime: null,     // If non-null and in future, app is paused
  timeoutId: null,    // Reference to the auto-resume timer
  reason: null        // Reason for pausing (workday-start, manual, etc.)
};
let userWorkdays = [1, 2, 3, 4, 5]; // Default Mon-Fri (0=Sun, 6=Sat)
let userWorkhours = { start: "09:00", end: "17:00" }; // Default 9 AM to 5 PM
let lastSummaryTimestamp = null;
let hasScreenCapturePermission = false;
let isWaylandSession = null;
let idToken = null; // User authentication token
let workPeriodCheckTimeoutId = null; // For scheduling next workday/workhours check
let autoSubmit = false;

// Function references that will be set by main.js
let checkAndAdjustRecording = null;
let navigateToView = null;

/**
 * Initialize the state manager
 * @param {Object} options Configuration options
 * @param {Function} options.checkRecording Function to check and adjust recording
 */
async function initState(options = {}) {
  // Store callback functions
  checkAndAdjustRecording = options.checkRecording;
  navigateToView = options.navigateToView;
  try {
    // Set AppUserModelId for Windows notifications
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.donethat.app');
    }

    // Initialize electron-store using dynamic import for ES module
    const { default: Store } = await import('electron-store');
    store = new Store({
      name: 'donethat-config'
    });

    // Load saved states
    loadWorkSettings();
    loadSummaryTimestamp();

    resume();
    
    // Set up IPC handlers
    setupIPCHandlers();

    return {
      store,
      isPaused,
      isWorkday,
      isWithinWorkHours,
      isActiveWorkPeriod,
      pauseRecording,
      recordingStarted,
      pauseUntilNextWorkPeriod,
      updateWaylandStatus,
      updateScreenCapturePermission,
      getUserWorkdays: () => userWorkdays,
      getUserWorkhours: () => userWorkhours,
      hasScreenCapturePermission: () => hasScreenCapturePermission,
      isWaylandSession: () => isWaylandSession,
      isAuthenticated: () => Boolean(idToken),
      getIdToken: () => {
        return idToken;
      },
      setIdToken,
      clearIdToken,
      cleanupOnQuit,
      resume
    };
  } catch (error) {
    log.error('Failed to initialize state:', error);
    return null;
  }
}

/**
 * Reset timers when starting or power back
 */
function resume() {
  if (workPeriodCheckTimeoutId) {
    clearTimeout(workPeriodCheckTimeoutId);
    workPeriodCheckTimeoutId = null;
  }
  _scheduleNextWorkEndCheck();
  loadPauseState();
}

// Helper function to check if currently paused
function isPaused() {
  return pauseState.endTime !== null && (pauseState.endTime > new Date());
}

// Helper function to check if today is a configured workday
function isWorkday(date = new Date()) {
  const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
  // Ensure userWorkdays is an array before checking
  return Array.isArray(userWorkdays) && userWorkdays.includes(dayOfWeek);
}

// Helper function to check if current time is within configured work hours
function isWithinWorkHours(date = new Date()) {
  // Parse the start and end hours from the format "HH:MM"
  const startParts = userWorkhours.start.split(':');
  const endParts = userWorkhours.end.split(':');
  
  if (startParts.length < 2 || endParts.length < 2) {
    // Invalid format, default to true to avoid disrupting the app
    log.error('Invalid work hours format');
    return true;
  }
  
  const startHour = parseInt(startParts[0], 10);
  const startMinute = parseInt(startParts[1], 10);
  const endHour = parseInt(endParts[0], 10);
  const endMinute = parseInt(endParts[1], 10);

  if (isNaN(startHour) || isNaN(startMinute) || isNaN(endHour) || isNaN(endMinute)) {
    // Invalid numbers, default to true to avoid disrupting the app
    log.error('Invalid work hours numbers');
    return true;
  }
  
  // Create date objects for today's start and end times
  const startTime = new Date(date);
  startTime.setHours(startHour, startMinute, 0, 0);
  
  const endTime = new Date(date);
  endTime.setHours(endHour, endMinute, 0, 0);
  
  // Check if current time is between start and end
  return date >= startTime && date < endTime;
}

// Helper function to check if it's currently an active work period
function isActiveWorkPeriod(date = new Date()) {
  return isWorkday(date) && isWithinWorkHours(date);
}

function _checkWorkdayEndNotification() {
  const threeHoursInMillis = 3 * 60 * 60 * 1000;

  if (lastSummaryTimestamp && (Date.now() - lastSummaryTimestamp > threeHoursInMillis)) {
    // Create notification with same options structure as start notification
    const notification = new Notification({
      title: "Workday Ended",
      body: "Remember to generate your summary in DoneThat!",
      silent: false,
      hasReply: false,
      urgency: 'critical'
    });

    notification.on('click', () => {
      if (navigateToView) {
        navigateToView('signup-next');
      }
    });

    // Show notification
    notification.show();
  }
}

function _checkWorkdayStartNotification() {
  // Only show notification if we have a valid period end time and it's been more than 12 hours
  if (typeof lastSummaryTimestamp === 'number' 
      && !isNaN(lastSummaryTimestamp) && lastSummaryTimestamp > 0) {
    const hoursSinceLastSummary = (Date.now() - lastSummaryTimestamp) / (1000 * 60 * 60);

    if (hoursSinceLastSummary > 12) {
      // Create the same notification options as the end notification for consistency
      const notification = new Notification({
        title: "Review Yesterday's Work",
        body: "You haven't reviewed your last summary. Generate one in DoneThat to catch up!",
        silent: false,
        hasReply: false,
        urgency: 'critical'
      });
      
      // Set callback before showing
      notification.on('click', () => {
        if (navigateToView) {
          navigateToView('signup-next');
        }
      });
      
      notification.show();
    }
  }
}

function _resumeRecording() {
  if (pauseState.reason === 'workday-start') {
    _checkWorkdayStartNotification();
  }

  if (checkAndAdjustRecording) {
    checkAndAdjustRecording();
  }
}

// Function to pause recording for a specified duration
function pauseRecording(duration, mainWindow, reason = null) {
  if (pauseState.timeoutId) {
    clearTimeout(pauseState.timeoutId);
    pauseState.timeoutId = null;
  }

  // Calculate end time
  const endTime = new Date(Date.now() + duration);
  
  // Set pause state
  pauseState = {
    endTime: endTime,
    timeoutId: setTimeout(() => _resumeRecording(), duration),
    reason: reason
  };

  savePauseState();
  
  // Make sure recording is stopped
  if (checkAndAdjustRecording) {
    checkAndAdjustRecording();
  }

  // Send analytics event to renderer
  if (mainWindow) {
    mainWindow.webContents.send('analytics-event', {
      eventName: 'recording_state_changed',
      eventParams: {
        status: 'paused',
        duration_minutes: Math.round(duration / (60 * 1000))
      }
    });
  }
}

// Function to pause until the start of the next active work period (either today or next workday)
function pauseUntilNextWorkPeriod(mainWindow, silent=false) {
  const now = new Date();
  
  if (!silent) {
    _checkWorkdayEndNotification();
  }
  
  // Parse work hours
  const startParts = userWorkhours.start.split(':');
  const endParts = userWorkhours.end.split(':');
  
  if (startParts.length < 2 || endParts.length < 2) {
    // Invalid format, fall back to pausing for a day
    log.error('Invalid work hours format when trying to pause until next period');
    pauseRecording(24 * 60 * 60 * 1000, mainWindow);
    return;
  }
  
  const startHour = parseInt(startParts[0], 10);
  const startMinute = parseInt(startParts[1], 10);

  // Today's start time
  const todayStartTime = new Date(now);
  todayStartTime.setHours(startHour, startMinute, 0, 0);
  
  // Check if we're before today's start time on a workday
  if (isWorkday(now) && now < todayStartTime) {
    const duration = todayStartTime.getTime() - now.getTime();
    if (duration > 0) {
      pauseRecording(duration, mainWindow, 'workday-start');
      // Schedule next check after this pause ends
      return;
    }
  }
  
  // Find the next workday
  let nextWorkdayDate = new Date(now);
  nextWorkdayDate.setDate(nextWorkdayDate.getDate() + 1);
  
  let daysAhead = 0;
  while (!isWorkday(nextWorkdayDate) && daysAhead < 7) {
    nextWorkdayDate.setDate(nextWorkdayDate.getDate() + 1);
    daysAhead++;
  }
  
  // If no workday found in the next week, just pause for a day
  if (daysAhead >= 7) {
    log.warn('No workday found in the next week, pausing for 24 hours');
    pauseRecording(24 * 60 * 60 * 1000, mainWindow);
    return;
  }
  
  // Set the time to the start of work hours on that workday
  nextWorkdayDate.setHours(startHour, startMinute, 0, 0);
  
  const duration = nextWorkdayDate.getTime() - now.getTime();
  
  // Ensure duration is positive
  if (duration > 0) {
    pauseRecording(duration, mainWindow, 'workday-start');
  } else {
    log.error('Calculated pause duration was not positive');
    // Fallback: Pause for 1 hour
    pauseRecording(60 * 60 * 1000, mainWindow);
  }
}

// Function to resume recording (called manually or by timer)
function recordingStarted(mainWindow) {
  if (pauseState.timeoutId) {
    clearTimeout(pauseState.timeoutId);
  }

  // Reset pause state
  const wasPaused = isPaused(); // Check if we were paused
  pauseState = { endTime: null, timeoutId: null };
  if (store) store.delete('pauseState');

  _scheduleNextWorkEndCheck();

  // Common operations for all resume cases
  if (mainWindow && wasPaused) {
    mainWindow.webContents.send('pauseStateChanged', false);
    mainWindow.webContents.send('analytics-event', { 
        eventName: 'recording_state_changed',
        eventParams: { status: 'resumed' } 
    });
  }
}

// Function to save pause state using electron-store
function savePauseState() {
  try {
    // Skip if store is not initialized
    if (!store) {
      log.warn('Store not initialized');
      return;
    }

    const stateToSave = {
      endTime: pauseState.endTime ? pauseState.endTime.getTime() : null,
      reason: pauseState.reason
    };
    store.set('pauseState', stateToSave);
  } catch (error) {
    log.error('Failed to save pause state:', error);
  }
}

// Function to load pause state using electron-store
function loadPauseState() {
  try {
    // Skip if store is not initialized
    if (!store) {
      log.warn('Store not initialized when loading pause state');
      return false;
    }

    const savedState = store.get('pauseState');
    
    if (savedState && savedState.endTime) {
      const endTime = new Date(savedState.endTime);
      const now = new Date();
      
      // If pause end time is in the future, restore the pause
      if (endTime > now) {
        const remainingDuration = endTime.getTime() - now.getTime();
        
        pauseState = {
          endTime: endTime,
          timeoutId: setTimeout(() => _resumeRecording(), remainingDuration),
          reason: savedState.reason
        };
        
        return true;
      } else {
        // Pause period has already expired
        store.delete('pauseState');
      }
    }
  } catch (error) {
    log.error('Failed to load pause state:', error);
  }
  return false;
}

// Load work settings (days and hours) from store
function loadWorkSettings() {
  try {
    if (!store) {
      log.warn('Store not initialized when loading work settings');
      return;
    }

    // Load userWorkdays from store, with validation and default fallback
    const savedWorkdays = store.get('userWorkdays');
    if (Array.isArray(savedWorkdays) && savedWorkdays.every(d => typeof d === 'number' && d >= 0 && d <= 6)) {
      userWorkdays = [...new Set(savedWorkdays)].sort((a, b) => a - b); // Ensure unique & sorted
    } else {
      // Default is already set, but save it initially if not present
      if (!savedWorkdays) {
        store.set('userWorkdays', userWorkdays);
      }
    }

    // Load userWorkhours from store, with validation and default fallback
    const savedWorkhours = store.get('userWorkhours');
    if (savedWorkhours && typeof savedWorkhours === 'object' && savedWorkhours.start && savedWorkhours.end) {
      userWorkhours = {
        start: savedWorkhours.start,
        end: savedWorkhours.end
      };
    } else {
      // Default is already set, but save it initially if not present
      if (!savedWorkhours) {
        store.set('userWorkhours', userWorkhours);
      }
    }

    // Load autoSubmit setting from store
    const storedAutoSubmit = store.get('autoSubmit');
    if (typeof storedAutoSubmit === 'boolean') {
      autoSubmit = storedAutoSubmit;
    }

  } catch (error) {
    log.error('Failed to load work settings:', error);
  }
}

// Load last summary timestamp from store
function loadSummaryTimestamp() {
  try {
    if (!store) {
      log.warn('Store not initialized when loading summary timestamp');
      return;
    }
    
    let loadedTimestamp = store.get('lastSummaryPeriodEnd');

    // Directly try to use the loaded value, assuming it's milliseconds (number)
    if (loadedTimestamp !== null && loadedTimestamp !== undefined) {
      try {
        const dateObject = new Date(loadedTimestamp);
        // Validate the date created from the loaded number
        if (!isNaN(dateObject.getTime())) {
          lastSummaryTimestamp = loadedTimestamp; // Store as milliseconds
        } else {
          // If the loaded number results in an invalid date, log error and delete the stored value
          log.error('Invalid period end format received:', loadedTimestamp, 
                    'Type:', typeof loadedTimestamp, 
                    'Resulting date object:', dateObject);
          store.delete('lastSummaryPeriodEnd');
          lastSummaryTimestamp = null;
        }
      } catch (error) {
        log.error('Error processing period end:', error, 
                 'Raw value:', loadedTimestamp, 
                 'Type:', typeof loadedTimestamp);
        store.delete('lastSummaryPeriodEnd');
        lastSummaryTimestamp = null;
      }
    } else {
      // For new users, initialize timestamp to current time
      // This gives them time to use the app before showing notifications
      lastSummaryTimestamp = Date.now();
      store.set('lastSummaryPeriodEnd', lastSummaryTimestamp);
    }
  } catch (error) {
    log.error('Failed to load summary timestamp:', error);
  }
}

// Update Wayland session status
function updateWaylandStatus(status) {
  isWaylandSession = status;
}

// Update screen capture permission status
function updateScreenCapturePermission(permission) {
  hasScreenCapturePermission = permission;
}

// Set up IPC handlers for state management
function setupIPCHandlers() {
  // Auth handlers - single source of truth for login/logout events
  ipcMain.on('login', (event, token) => {
    const mainWindow = event.sender.getOwnerBrowserWindow();
    
    if (setIdToken(token)) {
      // Check if we're outside of work hours and should pause
      const now = new Date();
      if (!isActiveWorkPeriod(now)) {
        pauseUntilNextWorkPeriod(mainWindow);
      } 

      // Only start recording if we're in work hours
      if (checkAndAdjustRecording) {
        checkAndAdjustRecording();
      }
      
      // Send permission status to renderer
      if (mainWindow) {
        mainWindow.webContents.send('screenCapturePermission', {
          hasPermission: hasScreenCapturePermission,
          isWaylandSession: isWaylandSession
        });
      }
    }
  });
  
  ipcMain.on('logout', (event) => {
    clearIdToken();
    
    // Stop recording on logout
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  });
  
  // Token refresh handling
  ipcMain.on('token-refreshed', (event, newToken) => {
    const mainWindow = event.sender.getOwnerBrowserWindow();

    if (setIdToken(newToken)) {
      // Token updated successfully
    } else {
      if (mainWindow) {
        mainWindow.webContents.send('auth-error');
      }
    }
  });

  // Listen for workday updates from renderer
  ipcMain.on('updateWorkdays', (event, days) => {
    if (Array.isArray(days) && days.every(d => typeof d === 'number' && d >= 0 && d <= 6)) {
      userWorkdays = [...new Set(days)].sort((a, b) => a - b); // Update state, ensure unique & sorted
      
      // Save the updated workdays to the store
      try {
        if (store) {
          store.set('userWorkdays', userWorkdays);
        } else {
          log.warn('Store not initialized, cannot save userWorkdays.');
        }
      } catch (error) {
        log.error('Failed to save userWorkdays:', error);
      }
      
      if (isPaused() && pauseState.reason === 'workday-start') {
        pauseUntilNextWorkPeriod(event.sender.getOwnerBrowserWindow(), silent=true);
      } else {
        _scheduleNextWorkEndCheck();
      }

    } else {
      log.error('Received invalid workdays data:', days);
    }
  });

  // Listen for workhours updates from renderer
  ipcMain.on('updateWorkhours', (event, hours) => {
    if (hours && typeof hours === 'object' && hours.start && hours.end) {
      userWorkhours = {
        start: hours.start,
        end: hours.end
      };
      
      // Save the updated workhours to the store
      try {
        if (store) {
          store.set('userWorkhours', userWorkhours);
        } else {
          log.warn('Store not initialized, cannot save userWorkhours.');
        }
      } catch (error) {
        log.error('Failed to save userWorkhours:', error);
      }
      
      // Check if we should adjust recording based on the new hours
      if (isPaused() && pauseState.reason === 'workday-start') {
        pauseUntilNextWorkPeriod(event.sender.getOwnerBrowserWindow(), silent=true);
      } else {
        _scheduleNextWorkEndCheck();
      }

    } else {
      log.error('Received invalid workhours data:', hours);
    }
  });

  // Add handler to get initial pause state
  ipcMain.handle('getInitialPauseState', () => {
    return isPaused();
  });

  // From dashboard
  ipcMain.on('pauseUntilTomorrow', (event) => {
    const mainWindow = event.sender.getOwnerBrowserWindow();
    pauseUntilNextWorkPeriod(mainWindow);
  });

  // Add IPC handler for pause state updates
  ipcMain.on('pauseStateChanged', (event, isPaused) => {
    const mainWindow = event.sender.getOwnerBrowserWindow();
    if (mainWindow) {
      mainWindow.webContents.send('pauseStateChanged', isPaused);
    }
  });

  // Listen for summary submission events
  ipcMain.on('summarySubmitted', (event, data) => {
    // Check if we received the period end time
    if (data && data.lastSummaryPeriodEnd) {
      // Store the period end time
      const lastSummaryPeriodEnd = data.lastSummaryPeriodEnd;
      
      // Update the local timestamp variable with the period end time
      lastSummaryTimestamp = lastSummaryPeriodEnd;
      
      // Save to persistent store
      if (store) {
        store.set('lastSummaryPeriodEnd', lastSummaryPeriodEnd);
      } else {
        log.warn('Store not initialized, cannot save lastSummaryPeriodEnd on summary submission');
      }
    } else {
      log.warn('No period end time received with summary submission');
    }
  });

  // Add IPC handler for receiving last summary timestamp
  ipcMain.on('updateLastSummaryTimestamp', (event, timestamp) => {
    try {
      // Check if timestamp exists before trying to access its properties
      if (!timestamp) {
        log.warn('Received null or undefined timestamp');
        return;
      }
      
      // Attempt to convert directly, assuming Firebase Timestamp object
      const timestampInMillis = timestamp._seconds * 1000 + Math.floor(timestamp._nanoseconds / 1000000);

      // Attempt to store the converted milliseconds
      if (store) {
        lastSummaryTimestamp = timestampInMillis; // Update local variable
        store.set('lastSummaryPeriodEnd', timestampInMillis); // Store as periodEnd
      } else {
        // Log only if store isn't ready - potentially important
        log.warn('Store not initialized, cannot save lastSummaryPeriodEnd.');
      }
    } catch (error) {
      // Log any errors during conversion or storage
      log.error('Error processing/storing lastSummaryPeriodEnd:', error, 'Raw value:', timestamp);
    }
  });

  // Add IPC handler for auto submit setting
  ipcMain.on('updateAutoSubmit', (event, value) => {
    if (typeof value === 'boolean') {
      autoSubmit = value;
      
      // Save to persistent store
      if (store) {
        store.set('autoSubmit', value);
      } else {
        log.warn('Store not initialized, cannot save autoSubmit setting');
      }
    } else {
      log.error('Received invalid autoSubmit value:', value);
    }
  });
}

/**
 * Schedules a check for the next workday end
 * Returns the time until the next check in milliseconds
 */
function _scheduleNextWorkEndCheck() {
  // Clear any existing timeout
  if (workPeriodCheckTimeoutId) {
    clearTimeout(workPeriodCheckTimeoutId);
    workPeriodCheckTimeoutId = null;
  }

  const now = new Date();
  
  // We only care about when the current/next work period ends
  let nextWorkEndTime = null;
  
  // Parse work hours
  const endParts = userWorkhours.end.split(':');
  
  if (endParts.length >= 2) {
    const endHour = parseInt(endParts[0], 10);
    const endMinute = parseInt(endParts[1], 10);
    
    if (!isNaN(endHour) && !isNaN(endMinute)) {
      // Today's end time
      const todayEndTime = new Date(now);
      todayEndTime.setHours(endHour, endMinute, 0, 0);
      
      if (isWorkday(now) && now < todayEndTime) {
        // We're on a workday before end time - check at end time
        nextWorkEndTime = todayEndTime;
      } else {
        // Find the next workday
        let nextWorkday = new Date(now);
        
        // Start from tomorrow if we're past today's end time or not a workday
        if (!isWorkday(now) || now >= todayEndTime) {
          nextWorkday.setDate(nextWorkday.getDate() + 1);
        }
        
        // Find the next workday
        let daysAhead = 0;
        while (!isWorkday(nextWorkday) && daysAhead < 7) {
          nextWorkday.setDate(nextWorkday.getDate() + 1);
          daysAhead++;
        }
        
        if (daysAhead < 7) {
          // Set to the end time of next workday
          nextWorkEndTime = new Date(nextWorkday);
          nextWorkEndTime.setHours(endHour, endMinute, 0, 0);
        }
      }
    }
  }
  
  // If we couldn't determine next work end time, default to checking at 5:00 PM today or tomorrow
  if (!nextWorkEndTime) {
    nextWorkEndTime = new Date(now);
    if (now.getHours() >= 17) {
      nextWorkEndTime.setDate(nextWorkEndTime.getDate() + 1);
    }
    nextWorkEndTime.setHours(17, 0, 0, 0);
  }
  
  // Calculate milliseconds until next check
  const msUntilCheck = nextWorkEndTime.getTime() - now.getTime();
  
  // Ensure msUntilCheck is positive
  const positiveMsUntilCheck = Math.max(msUntilCheck, 60000); // Minimum 1 minute wait
    
  // Set timeout for next check - when work period ends, pause until next work period
  workPeriodCheckTimeoutId = setTimeout(() => {
    // Create a bridge to mainWindow
    let mainWindow = null;
    try {
      const { BrowserWindow } = require('electron');
      mainWindow = BrowserWindow.getAllWindows()[0];
    } catch (error) {
      log.error('Failed to get mainWindow for pauseUntilNextWorkPeriod:', error);
    }
    
    // When work period ends, pause until next work period
    pauseUntilNextWorkPeriod(mainWindow);
  }, positiveMsUntilCheck);
  
  return positiveMsUntilCheck;
}

/**
 * Cleanup function for app quit
 * Clears any timeouts and saves pause state if needed
 */
function cleanupOnQuit() {
  try {
    // Clear pause timeout if active
    if (pauseState.timeoutId) {
      clearTimeout(pauseState.timeoutId);
      pauseState.timeoutId = null;
    }
    
    // Clear work period check timeout if active
    if (workPeriodCheckTimeoutId) {
      clearTimeout(workPeriodCheckTimeoutId);
      workPeriodCheckTimeoutId = null;
    }
    
    // Save pause state to persist after restart if paused
    if (isPaused()) {
      savePauseState();
    }
  } catch (error) {
    log.error('Error during cleanup on quit:', error);
  }
}

/**
 * Set the user's authentication token
 * @param {string} token ID token from authentication provider
 */
function setIdToken(token) {
  if (token && typeof token === 'string') {
    idToken = token;
    return true;
  } else {
    return false;
  }
}

/**
 * Clear the authentication token (logout)
 */
function clearIdToken() {
  idToken = null;
}

module.exports = {
  initState,
  getAutoSubmit: () => autoSubmit
}