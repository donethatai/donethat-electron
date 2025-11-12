const { ipcMain, Notification, app, dialog } = require('electron');
const log = require('electron-log');
const path = require('path');
const { encryptData, decryptData } = require('./encryption');

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
let idToken = null; // User authentication token
let workPeriodCheckTimeoutId = null; // For scheduling next workday/workhours check
let autoSubmit = false;
let hasShownStorageError = false; // Flag to prevent multiple error alerts
let userStatus = 'active'; // User status - 'active' or 'inactive'

// Function references that will be set by main.js
let checkAndAdjustRecording = null;
let navigateToView = null;
let mainWindow = null;
let overlayWindow = null;

// State validation heartbeat
let stateValidationIntervalId = null;

// Track manual resume override for work hours
let manualOverrideWorkHours = false;

// Track system lock/suspend state
let isScreenLocked = false;
let isSystemSuspended = false;

/**
 * Periodic state validator that ensures consistency after sleep/wake cycles.
 * Runs every minute to catch timer failures and state drift.
 * Reuses existing logic - no duplication.
 */
function _validateState() {
  try {
    // Safety check: detect user activity to clear potentially stuck suspend flag
    // Note: We can't use idle time for lock screen (user can move mouse on lock screen)
    // but we CAN use it for suspend (system activity = not suspended)
    if (isSystemSuspended) {
      try {
        const { powerMonitor } = require('electron');
        const idleTime = powerMonitor.getSystemIdleTime();
        
        // If system has been active in the last 60 seconds, it can't be suspended
        // Also require idle time > 0 to avoid broken platforms that always return 0
        if (idleTime > 0 && idleTime < 60) {
          log.info('Detected system activity while suspended flag was set - clearing flag');
          isSystemSuspended = false;
        }
      } catch (e) {
        log.warn('Could not check system idle time for suspend detection:', e);
      }
    }
    
    const now = new Date();
    const isActive = isActiveWorkPeriod(now);
    const paused = isPaused();
    const pauseReason = pauseState.reason;
    const pauseExpired = pauseState.endTime && pauseState.endTime < now;
    
    // Integrated pause expiry and work hours logic
    if (pauseExpired) {
      // Pause expired - only clear it if we should be recording
      if (isActive || manualOverrideWorkHours) {
        // Either in work hours OR user manually overrode - resume recording
        _clearPauseStateAndCheckRecording();
      } else {
        // Outside work hours and no override - replace with work-hours pause
        pauseUntilNextWorkPeriod(mainWindow, true); // silent=true
      }
    } else if (!isActive && !paused && !manualOverrideWorkHours) {
      // Outside work hours but not paused (and no manual override) - should be paused
      pauseUntilNextWorkPeriod(mainWindow, true); // silent=true
    } else if (isActive && paused && pauseReason === 'workday-start') {
      // In work hours but paused due to work-hours - check if pause extends beyond today
      // Only clear if pause ends today (waiting for work hours to start scenario)
      // Don't clear if pause extends to tomorrow (manual "pause until tomorrow" scenario)
      const endParts = userWorkhours.end.split(':');
      let shouldClearPause = true;
      
      if (pauseState.endTime && endParts.length >= 2) {
        const endHour = parseInt(endParts[0], 10);
        const endMinute = parseInt(endParts[1], 10);
        
        if (!isNaN(endHour) && !isNaN(endMinute)) {
          const todayWorkHoursEnd = new Date(now);
          todayWorkHoursEnd.setHours(endHour, endMinute, 0, 0);
          
          // Only clear pause if it ends today or earlier (automatic pause scenario)
          // If pause ends beyond today's work hours end, it's a manual "pause until tomorrow"
          shouldClearPause = pauseState.endTime <= todayWorkHoursEnd;
        }
      }
      
      if (shouldClearPause) {
        // In work hours but paused due to work-hours - should be active
        _clearPauseStateAndCheckRecording();
        // Clear manual override when work hours naturally start
        manualOverrideWorkHours = false;
      }
    } else if (isActive && !paused && manualOverrideWorkHours) {
      // Work hours started naturally while user had manual override - clear it
      manualOverrideWorkHours = false;
    }
    
    // Ensure recording state matches all conditions
    // This catches any other state drift (permissions, auth, etc.)
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  } catch (error) {
    log.error('Error in state validation heartbeat:', error);
  }
}

/**
 * Starts the periodic state validation heartbeat
 */
function startStateValidation() {
  if (stateValidationIntervalId) {
    clearInterval(stateValidationIntervalId);
  }
  // Run every 60 seconds to catch timer failures after sleep/wake
  stateValidationIntervalId = setInterval(_validateState, 60000);
}

/**
 * Stops the periodic state validation heartbeat
 */
function stopStateValidation() {
  if (stateValidationIntervalId) {
    clearInterval(stateValidationIntervalId);
    stateValidationIntervalId = null;
  }
}

/**
 * Show storage error message to the user
 * @param {Error} error The error that occurred
 */
function showStorageError(error) {
  if (hasShownStorageError) return; // Prevent multiple alerts
  
  log.error('Storage operation failed:', error);
  
  // Only show for permission errors
  if (error.code === 'EPERM' || error.message.includes('permission') || 
      error.message.includes('access') || error.message.includes('denied')) {
    
    hasShownStorageError = true;
    
    try {
      dialog.showErrorBox(
        'Storage Permission Error',
        'Could not store configuration. This may be caused by antivirus software or permission settings. Please check your security software and ensure DoneThat has permission to write files.'
      );
    } catch (dialogError) {
      // Fallback to notification if dialog fails
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.show(); mainWindow.focus(); } catch (e) {}
        mainWindow.webContents.send('inapp:notify', {
          id: 'storage-permission-error',
          title: 'Storage Permission Error',
          message: 'Could not store configuration. Please check your antivirus software.',
          sticky: true
        });
      }
    } catch (notificationError) {
        log.error('Failed to send in-app storage error notification:', notificationError);
      }
    }
  }
}

/**
 * Safely perform store operations with error handling
 * @param {Function} operation Function that performs store operation
 * @param {string} errorContext Context description for logging
 * @returns {any} Result of the operation or undefined on error
 */
function safeStoreOperation(operation, errorContext) {
  if (!store) {
    return undefined;
  }
  
  try {
    return operation();
  } catch (error) {
    log.error(`Store operation failed (${errorContext}):`, error);
    showStorageError(error);
    return undefined;
  }
}

/**
 * Initialize the state manager
 * @param {Object} options Configuration options
 * @param {Function} options.checkRecording Function to check and adjust recording
 */
async function initState(options = {}) {
  // Store callback functions
  checkAndAdjustRecording = options.checkRecording;
  navigateToView = options.navigateToView;
  mainWindow = options.mainWindow;
  overlayWindow = options.overlayWindow;
  try {
    // Set AppUserModelId for Windows notifications
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.donethat.app');
    }

    // Initialize store with fallback mechanism
    await initializeStore();

    // Load saved states
    loadWorkSettings();
    loadSummaryTimestamp();

    resume();
    
    // Set up IPC handlers
    setupIPCHandlers();
    
    // Set up power monitor handlers
    setupPowerMonitorHandlers();

    return {
      store,
      isPaused,
      isWorkday,
      isWithinWorkHours,
      isActiveWorkPeriod,
      pauseRecording,
      recordingStarted,
      pauseUntilNextWorkPeriod,
      updateScreenCapturePermission,
      updateWindowsPermission,
      hasWindowsPermission: getWindowsPermission,
      updateUserStatus,
      getUserWorkdays: () => userWorkdays,
      getUserWorkhours: () => userWorkhours,
      hasScreenCapturePermission: () => hasScreenCapturePermission,
      isAuthenticated: () => Boolean(idToken),
      hasValidAccess: () => userStatus === 'active',
      getIdToken: () => {
        return idToken;
      },
      setIdToken,
      clearIdToken,
      cleanupOnQuit,
      resume,
      isSystemIdle,
      clearSystemIdleFlags
    };
  } catch (error) {
    log.error('Failed to initialize state:', error);
    return null;
  }
}

/**
 * Initialize electron-store with fallback locations
 */
async function initializeStore() {
  const { default: Store } = await import('electron-store');
  const locations = [
    { name: 'default', cwd: app.getPath('userData') },
    { name: 'documents', cwd: path.join(app.getPath('documents'), '.donethat-config') },
    { name: 'temp', cwd: app.getPath('temp') }
  ];
  
  // Check all locations for existing data
  let dataFound = false;
  
  for (const location of locations) {
    try {
      // Create a test store to check if data exists
      const testStore = new Store({
        name: 'donethat-config',
        cwd: location.cwd,
        clearInvalidConfig: true
      });
      
      // If we get here, we could access this location
      // Check if there's existing data
      const hasData = Object.keys(testStore.store).length > 0;
      
      if (hasData) {
        // Found data, use this location
        store = testStore;
        dataFound = true;
        break;
      }
    } catch (err) {
      log.warn(`Unable to access ${location.name} location:`, err.message);
      
      // Check if this is a permission error
      if (err.code === 'EPERM' || err.message.includes('permission') || 
          err.message.includes('access') || err.message.includes('denied')) {
        showStorageError(err);
      }
      
      // Continue to next location
    }
  }
  
  // If no data was found, create a new store in the first available location
  if (!dataFound) {
    for (const location of locations) {
      try {
        store = new Store({
          name: 'donethat-config',
          cwd: location.cwd,
          clearInvalidConfig: true
        });
        log.info(`Created new store in ${location.name} location: ${location.cwd}`);
        break;
      } catch (err) {
        log.warn(`Failed to create store in ${location.name} location:`, err.message);
        
        // Check if this is a permission error
        if (err.code === 'EPERM' || err.message.includes('permission') || 
            err.message.includes('access') || err.message.includes('denied')) {
          showStorageError(err);
        }
        
        // Continue to next location
      }
    }
  }
  
  // If we still don't have a store, throw an error
  if (!store) {
    const error = new Error('Unable to initialize configuration storage in any location');
    showStorageError(error);
    throw error;
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
  
  // Check if we should be paused based on work hours when app starts
  // This handles the case where user is already authenticated and it's past work hours
  const now = new Date();
  // Respect manual override: do not auto-pause outside work hours if user manually resumed
  if (!isActiveWorkPeriod(now) && !isPaused() && !manualOverrideWorkHours) {
    pauseUntilNextWorkPeriod(mainWindow, true); // silent=true to avoid notification on startup
  }
  
  // Start periodic state validation heartbeat to catch timer failures
  startStateValidation();
  
  // Ensure all state is synchronized after initialization
  if (checkAndAdjustRecording) {
    checkAndAdjustRecording();
  }
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

  // Only show notification if:
  // 1. We have a last summary timestamp
  // 2. 3+ hours have passed since last summary
  // 3. The app was NOT already paused (to avoid showing notification when user manually paused)
  if (lastSummaryTimestamp && 
      (Date.now() - lastSummaryTimestamp > threeHoursInMillis) && 
      !isPaused()) {
    // Create notification with same options structure as start notification
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.show(); mainWindow.focus(); } catch (e) {}
        mainWindow.webContents.send('inapp:notify', {
          id: 'workday-ended',
          title: 'Workday Ended',
          message: 'Remember to generate your summary. You can change your work hours in settings.',
          sticky: false
        });
      }
    } catch (e) {}
  }
}

function _clearPauseStateAndCheckRecording() {
  // Clear pause state to avoid issues
  pauseState = { endTime: null, timeoutId: null, reason: null };

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
    timeoutId: setTimeout(() => _clearPauseStateAndCheckRecording(), duration),
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
  
  // Clear manual override flag when applying work-hours pause
  manualOverrideWorkHours = false;
  
  if (!silent) {
    _checkWorkdayEndNotification();
  }
  
  // Parse work hours
  const startParts = userWorkhours.start.split(':');
  const endParts = userWorkhours.end.split(':');
  
  if (startParts.length < 2 || endParts.length < 2) {
    // Invalid format, fall back to pausing for a day
    log.error('Invalid work hours format when trying to pause until next period');
    pauseRecording(24 * 60 * 60 * 1000, mainWindow, 'workday-start');
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
    pauseRecording(24 * 60 * 60 * 1000, mainWindow, 'workday-start');
    return;
  }
  
  // Set the time to the start of work hours on that workday
  nextWorkdayDate.setHours(startHour, startMinute, 0, 0);
  
  const duration = nextWorkdayDate.getTime() - now.getTime();
  
  // If the duration is less than 5 minutes, don't pause at all
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  if (duration > 0 && duration < FIVE_MINUTES_MS) {
    log.info(`Time until next workday start is only ${Math.round(duration / 1000 / 60)} minutes, skipping pause`);
    // Don't pause, just schedule the next work end check
    _scheduleNextWorkEndCheck();
    return;
  }
  
  // Ensure duration is positive
  if (duration > 0) {
    pauseRecording(duration, mainWindow, 'workday-start');
  } else {
    log.error('Calculated pause duration was not positive');
    // Fallback: Pause for 1 hour
    pauseRecording(60 * 60 * 1000, mainWindow, 'workday-start');
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
  
  // Clear the saved pause state
  safeStoreOperation(() => store.delete('pauseState'), 'clear pause state');

  // If user manually resumes outside work hours, set override flag
  const now = new Date();
  if (!isActiveWorkPeriod(now)) {
    manualOverrideWorkHours = true;
  }

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
  // Skip if store is not initialized
  if (!store) {
    log.warn('Store not initialized');
    return;
  }

  const stateToSave = {
    endTime: pauseState.endTime ? pauseState.endTime.getTime() : null,
    reason: pauseState.reason
  };
  
  safeStoreOperation(() => store.set('pauseState', stateToSave), 'save pause state');
}

// Function to load pause state using electron-store
function loadPauseState() {
  // Skip if store is not initialized
  if (!store) {
    log.warn('Store not initialized when loading pause state');
    return false;
  }

  const savedState = safeStoreOperation(() => store.get('pauseState'), 'load pause state');
  
  if (savedState && savedState.endTime) {
    const endTime = new Date(savedState.endTime);
    const now = new Date();
    
    // If pause end time is in the future, restore the pause
    if (endTime > now) {
      const remainingDuration = endTime.getTime() - now.getTime();
      
      pauseState = {
        endTime: endTime,
        timeoutId: setTimeout(() => _clearPauseStateAndCheckRecording(), remainingDuration),
        reason: savedState.reason
      };
      
      return true;
    } else {
      // Pause period has already expired
      safeStoreOperation(() => store.delete('pauseState'), 'delete expired pause state');
    }
  }
  
  return false;
}

// Load work settings (days and hours) from store
function loadWorkSettings() {
  if (!store) {
    log.warn('Store not initialized when loading work settings');
    return;
  }

  // Load userWorkdays from store, with validation and default fallback
  const savedWorkdays = safeStoreOperation(() => store.get('userWorkdays'), 'load workdays');
  if (Array.isArray(savedWorkdays) && savedWorkdays.every(d => typeof d === 'number' && d >= 0 && d <= 6)) {
    userWorkdays = [...new Set(savedWorkdays)].sort((a, b) => a - b); // Ensure unique & sorted
  } else {
    // Default is already set, but save it initially if not present
    if (!savedWorkdays) {
      safeStoreOperation(() => store.set('userWorkdays', userWorkdays), 'save default workdays');
    }
  }

  // Load userWorkhours from store, with validation and default fallback
  const savedWorkhours = safeStoreOperation(() => store.get('userWorkhours'), 'load workhours');
  if (savedWorkhours && typeof savedWorkhours === 'object' && savedWorkhours.start && savedWorkhours.end) {
    userWorkhours = {
      start: savedWorkhours.start,
      end: savedWorkhours.end
    };
  } else {
    // Default is already set, but save it initially if not present
    if (!savedWorkhours) {
      safeStoreOperation(() => store.set('userWorkhours', userWorkhours), 'save default workhours');
    }
  }

  // Load autoSubmit setting from store
  const storedAutoSubmit = safeStoreOperation(() => store.get('autoSubmit'), 'load autoSubmit');
  if (typeof storedAutoSubmit === 'boolean') {
    autoSubmit = storedAutoSubmit;
  }
}

// Load last summary timestamp from store
function loadSummaryTimestamp() {
  if (!store) {
    log.warn('Store not initialized when loading summary timestamp');
    return;
  }
  
  let loadedTimestamp = safeStoreOperation(() => store.get('lastSummaryPeriodEnd'), 'load summary timestamp');

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
        safeStoreOperation(() => store.delete('lastSummaryPeriodEnd'), 'delete invalid summary timestamp');
        lastSummaryTimestamp = null;
      }
    } catch (error) {
      log.error('Error processing period end:', error, 
               'Raw value:', loadedTimestamp, 
               'Type:', typeof loadedTimestamp);
      safeStoreOperation(() => store.delete('lastSummaryPeriodEnd'), 'delete invalid summary timestamp');
      lastSummaryTimestamp = null;
    }
  } else {
    // If no timestamp in store, initialize to null
    lastSummaryTimestamp = null;
  }
}

// Update screen capture permission status
function updateScreenCapturePermission(permission) {
  hasScreenCapturePermission = permission;
}

// Windows permission state
let hasWindowsPermission = false;

// Update Windows permission status
function updateWindowsPermission(permission) {
  hasWindowsPermission = permission;
}

// Get Windows permission status
function getWindowsPermission() {
  return hasWindowsPermission;
}

// Update user status
function updateUserStatus(status) {
  userStatus = status;
  
  // Trigger recording state check when status changes
  if (checkAndAdjustRecording) {
    checkAndAdjustRecording();
  }
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
          hasPermission: hasScreenCapturePermission
        });
      }
    }
  });
  
  ipcMain.on('logout', (event) => {
    resetSessionState();
    
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
      log.warn('Token refresh failed - no valid token received');
      if (mainWindow) {
        mainWindow.webContents.send('auth-error', {
          code: 'auth/token-refresh-failed',
          message: 'Failed to refresh authentication token'
        });
      }
    }
  });

  // Listen for workday updates from renderer
  ipcMain.on('updateWorkdays', (event, days) => {
    if (Array.isArray(days) && days.every(d => typeof d === 'number' && d >= 0 && d <= 6)) {
      userWorkdays = [...new Set(days)].sort((a, b) => a - b); // Update state, ensure unique & sorted
      
      // Save the updated workdays to the store
      safeStoreOperation(() => {
        if (store) {
          store.set('userWorkdays', userWorkdays);
        } else {
          log.warn('Store not initialized, cannot save userWorkdays.');
        }
      }, 'save updated workdays');
      
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
      safeStoreOperation(() => {
        if (store) {
          store.set('userWorkhours', userWorkhours);
        } else {
          log.warn('Store not initialized, cannot save userWorkhours.');
        }
      }, 'save updated workhours');
      
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
      safeStoreOperation(() => {
        if (store) {
          store.set('lastSummaryPeriodEnd', lastSummaryPeriodEnd);
        } else {
          log.warn('Store not initialized, cannot save lastSummaryPeriodEnd on summary submission');
        }
      }, 'save summary period end');
    } else {
      log.warn('No period end time received with summary submission');
    }
  });

  // Add IPC handler for user status updates
  ipcMain.on('updateUserStatus', (event, status) => {
    updateUserStatus(status);
  });

  // Add IPC handler for auto submit setting
  ipcMain.on('updateAutoSubmit', (event, value) => {
    if (typeof value === 'boolean') {
      autoSubmit = value;
      
      // Save to persistent store
      safeStoreOperation(() => {
        if (store) {
          store.set('autoSubmit', value);
        } else {
          log.warn('Store not initialized, cannot save autoSubmit setting');
        }
      }, 'save autoSubmit setting');
    } else {
      log.error('Received invalid autoSubmit value:', value);
    }
  });

  // Linux screenshot command handlers
  ipcMain.handle('save-linux-screenshot-command', async (event, command) => {
    try {
      if (command && typeof command !== 'string') {
        throw new Error('Invalid command provided');
      }

      // Save command to store (no encryption needed for commands)
      safeStoreOperation(() => {
        if (store) {
          if (command && command.trim()) {
            store.set('linuxScreenshotCommand', command.trim());
          } else {
            store.delete('linuxScreenshotCommand');
          }
        } else {
          throw new Error('Store not initialized');
        }
      }, 'save Linux screenshot command');

      log.info('Linux screenshot command saved successfully');
      return { success: true };
    } catch (error) {
      log.error('Error saving Linux screenshot command:', error);
      throw error;
    }
  });

  ipcMain.handle('get-linux-screenshot-command', async (event) => {
    try {
      const command = safeStoreOperation(() => {
        if (store) {
          return store.get('linuxScreenshotCommand');
        } else {
          return null;
        }
      }, 'get Linux screenshot command');

      return { success: true, command: command || null };
    } catch (error) {
      log.error('Error retrieving Linux screenshot command:', error);
      return { success: false, error: error.message };
    }
  });


  // Gemini API key handlers
  ipcMain.handle('save-gemini-api-key', async (event, apiKey) => {
    try {
      if (!apiKey || typeof apiKey !== 'string') {
        throw new Error('Invalid API key provided');
      }

      // Encrypt the API key
      const encryptedKey = encryptData(apiKey);
      
      // Save encrypted key to store
      safeStoreOperation(() => {
        if (store) {
          store.set('geminiApiKey', encryptedKey);
        } else {
          throw new Error('Store not initialized');
        }
      }, 'save encrypted Gemini API key');

      try { require('./processLocal').resetLLMModels(); } catch (_) {}
      return { success: true };
    } catch (error) {
      log.error('Error saving Gemini API key:', error);
      throw error;
    }
  });

  ipcMain.handle('get-gemini-api-key', async (event) => {
    // Delegate to the internal getter to ensure consistent error handling
    try {
      const result = await getGeminiApiKey();
      return result;
    } catch (error) {
      log.error('Error retrieving Gemini API key (ipc):', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('clear-gemini-api-key', async (event) => {
    try {
      safeStoreOperation(() => {
        if (store) {
          store.delete('geminiApiKey');
        } else {
          throw new Error('Store not initialized');
        }
      }, 'delete Gemini API key');

      try { require('./processLocal').resetLLMModels(); } catch (_) {}
      log.info('Gemini API key cleared successfully');
      return { success: true };
    } catch (error) {
      log.error('Error clearing Gemini API key:', error);
      throw error;
    }
  });

  // OpenAI-compatible config handlers
  ipcMain.handle('save-openai-compatible-config', async (event, config) => {
    try {
      if (!config || typeof config !== 'object') {
        throw new Error('Invalid config provided');
      }

      const { endpoint, apiKey } = config;

      if (endpoint && typeof endpoint !== 'string') {
        throw new Error('Invalid endpoint provided');
      }

      if (apiKey && typeof apiKey !== 'string') {
        throw new Error('Invalid API key provided');
      }

      // Encrypt the API key if provided
      let encryptedKey = null;
      if (apiKey) {
        encryptedKey = encryptData(apiKey);
      }

      // Save config to store
      safeStoreOperation(() => {
        if (store) {
          store.set('openaiCompatibleConfig', {
            endpoint: endpoint || null,
            model: config.model || null,
            apiKey: encryptedKey
          });
        } else {
          throw new Error('Store not initialized');
        }
      }, 'save OpenAI-compatible config');

      try { require('./processLocal').resetLLMModels(); } catch (_) {}
      log.info('OpenAI-compatible config saved successfully');
      return { success: true };
    } catch (error) {
      log.error('Error saving OpenAI-compatible config:', error);
      throw error;
    }
  });

  ipcMain.handle('get-openai-compatible-config', async (event) => {
    try {
      const result = await getOpenAICompatibleConfig();
      return result;
    } catch (error) {
      log.error('Error retrieving OpenAI-compatible config (ipc):', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('clear-openai-compatible-config', async (event) => {
    try {
      safeStoreOperation(() => {
        if (store) {
          store.delete('openaiCompatibleConfig');
        } else {
          throw new Error('Store not initialized');
        }
      }, 'delete OpenAI-compatible config');

      try { require('./processLocal').resetLLMModels(); } catch (_) {}
      log.info('OpenAI-compatible config cleared successfully');
      return { success: true };
    } catch (error) {
      log.error('Error clearing OpenAI-compatible config:', error);
      throw error;
    }
  });

  // Test local processing handler
  ipcMain.handle('test-local-processing', async (event) => {
    try {
      const { processDataLocally } = require('./processLocal');

      // Use minimal dummy input data for testing - avoids complex collection that might hang
      const inputData = {
        activity: [],
        audioTranscript: 'Test audio transcript',
        idleTime: 0
      };

      const screenshots = await require('./captureScreenshots').captureScreenshot();

      // Check if we have local processing available
      const { isLocalProcessingAvailable } = require('./processLocal');
      if (!await isLocalProcessingAvailable()) {
        return { success: false, message: 'No local processing configuration found. Set up Gemini API key or OpenAI-compatible endpoint first.' };
      }

      // Attempt with current token; on FIREBASE auth error, request refresh and retry once
      let token = idToken || null;
      try {
        await processDataLocally(token, screenshots, null, inputData, true);
        return { success: true, message: 'Local processing test successful' };
      } catch (err) {
        const isFirebase = err && err.source === 'FIREBASE';
        const isAuth = isFirebase && (err.code === 'TOKEN_EXPIRED' || err.code === 'AUTH_ERROR' || err.status === 401 || err.status === 403);
        if (!isAuth) {
          throw err;
        }
        // Ask renderer to refresh token and wait for response
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('refresh-token');
          }
        } catch (_) {}

        // Wait for token-refreshed event (max 10s)
        token = await new Promise((resolve) => {
          let done = false;
          const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 10000);
          const handler = (_e, newToken) => {
            if (done) return;
            done = true;
            try { clearTimeout(timer); } catch (_) {}
            resolve(newToken || null);
          };
          try { ipcMain.once('token-refreshed', handler); } catch (_) { resolve(null); }
        });

        if (!token) {
          return { success: false, message: 'Token refresh failed. Please sign in again.' };
        }

        // Retry once with refreshed token
        await processDataLocally(token, screenshots, null, inputData, true);
        return { success: true, message: 'Local processing test successful' };
      }
    } catch (error) {
      log.error('Error in local processing test:', error);
      return { success: false, message: error.message };
    }
  });

  ipcMain.handle('check-do-not-disturb', async () => {
    try {
      if (process.platform === 'darwin') {
        // macOS: Use recommended module to check notification state
        const { getDoNotDisturb } = require('macos-notification-state');
        return getDoNotDisturb();
      } else if (process.platform === 'win32') {
        // Windows: Use recommended module to check notification state
        const { getDoNotDisturb } = require('windows-notification-state');
        return getDoNotDisturb();
      } else {
        // Linux: Not implemented, return false (don't block)
        return false;
      }
    } catch (error) {
      log.warn('Error checking do not disturb:', error);
      // If check fails, assume DND is off (fail open)
      return false;
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
    
  // Capture the intended fire time to avoid late (post-sleep) notifications
  const intendedFireTs = nextWorkEndTime.getTime();

  // Set timeout for next check - when work period ends, pause until next work period
  workPeriodCheckTimeoutId = setTimeout(() => {
    // Use the stored mainWindow reference
    
    // If this timer fires significantly late (e.g., device resumed next day),
    // avoid showing a stale end-of-day notification
    const now = Date.now();
    const LATE_GRACE_MS = 30 * 60 * 1000; // 30 minutes
    const firedLate = now - intendedFireTs > LATE_GRACE_MS;

    // Check if user is away (screen locked or system suspended) to avoid notifications
    const isUserAway = isSystemIdle();

    // When work period ends, pause until next work period
    // Use silent=true when firing late OR when user is away to suppress the banner
    const shouldBeSilent = firedLate === true || isUserAway;
    pauseUntilNextWorkPeriod(mainWindow, shouldBeSilent);
  }, positiveMsUntilCheck);
  
  return positiveMsUntilCheck;
}

/**
 * Cleanup function for app quit
 * Clears any timeouts and saves pause state if needed
 */
function cleanupOnQuit() {
  try {
    // Stop state validation heartbeat
    stopStateValidation();
    
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
 * Clear the authentication token only
 */
function clearIdToken() {
  idToken = null;
}

/**
 * Reset all session-specific state on logout
 * Keeps user preferences (work hours, settings) but clears session data
 */
function resetSessionState() {
  // Clear token
  clearIdToken();
  
  // Clear pause state and timers
  if (pauseState.timeoutId) {
    clearTimeout(pauseState.timeoutId);
  }
  pauseState = {
    endTime: null,
    timeoutId: null,
    reason: null
  };
  
  // Clear saved pause state from store
  safeStoreOperation(() => {
    if (store) {
      store.delete('pauseState');
    }
  }, 'clear pause state on logout');
  
  // Clear work period check timeout
  if (workPeriodCheckTimeoutId) {
    clearTimeout(workPeriodCheckTimeoutId);
    workPeriodCheckTimeoutId = null;
  }
  
  // Clear manual override flag
  manualOverrideWorkHours = false;
  
  // Clear system state flags
  isScreenLocked = false;
  isSystemSuspended = false;
  
  // Reset user status to default (avoid showing inactive when logged out)
  userStatus = 'active';
}

/**
 * Check if system is idle (locked or suspended)
 */
function isSystemIdle() {
  return isScreenLocked || isSystemSuspended;
}

/**
 * Clear lock/suspend flags when we detect user activity
 * Called as a worst-case fallback when user interacts with the app
 */
function clearSystemIdleFlags() {
  if (isScreenLocked || isSystemSuspended) {
    log.info('Clearing lock/suspend flags due to app interaction (fallback)');
    isScreenLocked = false;
    isSystemSuspended = false;
  }
}

/**
 * Setup power monitor event handlers
 * Called automatically during initState()
 */
function setupPowerMonitorHandlers() {
  const { powerMonitor } = require('electron');
  
  powerMonitor.on('resume', () => {
    isSystemSuspended = false;
    // Rebase timers after system resume
    resume();
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  });
  
  powerMonitor.on('unlock-screen', () => {
    isScreenLocked = false;
    // Rebase timers after unlock as some Windows devices may not emit 'resume'
    // and existing setTimeouts would otherwise extend pauses by sleep duration
    resume();
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  });
  
  powerMonitor.on('suspend', () => {
    isSystemSuspended = true;
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  });
  
  powerMonitor.on('lock-screen', () => {
    isScreenLocked = true;
    if (checkAndAdjustRecording) {
      checkAndAdjustRecording();
    }
  });
}

/**
 * Get Gemini API key (for internal use)
 */
async function getGeminiApiKey() {
  try {
    const encryptedKey = safeStoreOperation(() => {
      if (store) {
        return store.get('geminiApiKey');
      } else {
        return null;
      }
    }, 'get encrypted Gemini API key');

    if (!encryptedKey) {
      return { success: true, apiKey: null };
    }

    // Decrypt the API key
    const decryptedKey = decryptData(encryptedKey);

    return { success: true, apiKey: decryptedKey };
  } catch (error) {
    log.error('Error retrieving Gemini API key:', error);
    // If decryption failed, clear the key and notify the user to re-enter
    if (error && typeof error.message === 'string' && error.message.includes('Failed to decrypt data')) {
      try {
        // Clear the stored key
        safeStoreOperation(() => {
          if (store) {
            store.delete('geminiApiKey');
          }
        }, 'delete corrupted Gemini API key');
      } catch (e) {
        log.warn('Failed to clear corrupted Gemini API key:', e);
      }
      // Send a sticky in-app notification to prompt user
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.show(); mainWindow.focus(); } catch (e) {}
        mainWindow.webContents.send('inapp:notify', {
          id: 'gemini-key-decrypt-failed',
          title: 'Settings',
          message: "We couldn't read your Gemini API key. Please set it again in Settings. For now we'll use cloud processing.",
          sticky: true
        });
      }
    } catch (notifyErr) {
        log.warn('Failed to send in-app notification for Gemini key reset:', notifyErr);
      }
      // Return success with null apiKey to fall back to cloud processing
      return { success: true, apiKey: null };
    }
    return { success: false, error: error.message };
  }
}

/**
 * Get OpenAI-compatible config (for internal use)
 */
async function getOpenAICompatibleConfig() {
  try {
    const storedConfig = safeStoreOperation(() => {
      if (store) {
        return store.get('openaiCompatibleConfig');
      } else {
        return null;
      }
    }, 'get OpenAI-compatible config');

    if (!storedConfig) {
      return { success: true, config: null };
    }

    // Decrypt the API key if present
    let apiKey = null;
    if (storedConfig.apiKey) {
      try {
        apiKey = decryptData(storedConfig.apiKey);
      } catch (error) {
        log.error('Error decrypting OpenAI-compatible API key:', error);
        // Clear corrupted config
        safeStoreOperation(() => {
          if (store) {
            store.delete('openaiCompatibleConfig');
          }
        }, 'delete corrupted OpenAI-compatible config');
        return { success: true, config: null };
      }
    }

    return {
      success: true,
      config: {
        endpoint: storedConfig.endpoint,
        model: storedConfig.model,
        apiKey: apiKey
      }
    };
  } catch (error) {
    log.error('Error retrieving OpenAI-compatible config:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  initState,
  resume,
  isPaused,
  isWorkday,
  isWithinWorkHours,
  isActiveWorkPeriod,
  pauseRecording,
  pauseUntilNextWorkPeriod,
  recordingStarted,
  loadWorkSettings,
  loadSummaryTimestamp,
  updateScreenCapturePermission,
  updateWindowsPermission,
  hasWindowsPermission: getWindowsPermission,
  setupIPCHandlers,
  cleanupOnQuit,
  setIdToken,
  clearIdToken,
  resetSessionState,
  isSystemIdle,
  clearSystemIdleFlags,
  getGeminiApiKey,
  getOpenAICompatibleConfig,
  getAutoSubmit: () => autoSubmit
}