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
let isWaylandSession = null;
let idToken = null; // User authentication token
let workPeriodCheckTimeoutId = null; // For scheduling next workday/workhours check
let autoSubmit = false;
let hasShownStorageError = false; // Flag to prevent multiple error alerts
let subscriptionStatus = null; // User subscription status
let hasActiveTeam = false; // Whether user has active team membership

// Function references that will be set by main.js
let checkAndAdjustRecording = null;
let navigateToView = null;

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
        const { BrowserWindow } = require('electron');
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          try { win.show(); win.focus(); } catch (e) {}
          win.webContents.send('inapp:notify', {
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
  try {
    // Set AppUserModelId for Windows notifications
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.donethat.app');
    }

    // Initialize store with fallback mechanism
    initializeStore();

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
      updateSubscriptionState,
      getUserWorkdays: () => userWorkdays,
      getUserWorkhours: () => userWorkhours,
      hasScreenCapturePermission: () => hasScreenCapturePermission,
      isWaylandSession: () => isWaylandSession,
      isAuthenticated: () => Boolean(idToken),
      hasValidAccess: () => hasActiveTeam || subscriptionStatus === 'trialing' || subscriptionStatus === 'active',
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
        log.info(`Using existing data from ${location.name} location: ${location.cwd}`);
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
    try {
      const { BrowserWindow } = require('electron');
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        try { win.show(); win.focus(); } catch (e) {}
        win.webContents.send('inapp:notify', {
          id: 'workday-ended',
          title: 'Workday Ended',
          message: 'Remember to generate your summary in DoneThat!',
          sticky: true
        });
      }
    } catch (e) {}
  }
}

function _resumeRecording() {
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
  
  // Clear the saved pause state
  safeStoreOperation(() => store.delete('pauseState'), 'clear pause state');

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
        timeoutId: setTimeout(() => _resumeRecording(), remainingDuration),
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

// Update Wayland session status
function updateWaylandStatus(status) {
  isWaylandSession = status;
}

// Update screen capture permission status
function updateScreenCapturePermission(permission) {
  hasScreenCapturePermission = permission;
}

// Update subscription state
function updateSubscriptionState(newSubscriptionStatus, activeTeam) {
  subscriptionStatus = newSubscriptionStatus;
  hasActiveTeam = activeTeam;
  
  // Trigger recording state check when subscription state changes
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

  // Add IPC handler for subscription state updates
  ipcMain.on('updateSubscriptionState', (event, subscriptionStatus, activeTeam) => {
    updateSubscriptionState(subscriptionStatus, activeTeam);
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

      log.info('Gemini API key saved successfully');
      return { success: true };
    } catch (error) {
      log.error('Error saving Gemini API key:', error);
      throw error;
    }
  });

  ipcMain.handle('get-gemini-api-key', async (event) => {
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

      log.info('Gemini API key cleared successfully');
      return { success: true };
    } catch (error) {
      log.error('Error clearing Gemini API key:', error);
      throw error;
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
    // Create a bridge to mainWindow
    let mainWindow = null;
    try {
      const { BrowserWindow } = require('electron');
      mainWindow = BrowserWindow.getAllWindows()[0];
    } catch (error) {
      log.error('Failed to get mainWindow for pauseUntilNextWorkPeriod:', error);
    }
    
    // If this timer fires significantly late (e.g., device resumed next day),
    // avoid showing a stale end-of-day notification
    const now = Date.now();
    const LATE_GRACE_MS = 30 * 60 * 1000; // 30 minutes
    const firedLate = now - intendedFireTs > LATE_GRACE_MS;

    // When work period ends, pause until next work period
    // Use silent=true when firing late to suppress the banner
    pauseUntilNextWorkPeriod(mainWindow, firedLate === true);
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
  updateWaylandStatus,
  updateScreenCapturePermission,
  setupIPCHandlers,
  cleanupOnQuit,
  setIdToken,
  clearIdToken,
  getGeminiApiKey,
  getAutoSubmit: () => autoSubmit
}