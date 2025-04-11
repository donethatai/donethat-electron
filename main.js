const { app, ipcMain, Tray, Menu, BrowserWindow, nativeImage, screen, Notification, powerMonitor } = require('electron')
const path = require('path')
const { autoUpdater } = require('electron-updater')
const log = require('electron-log')
const { initializeApp } = require('firebase/app')
const firebaseConfig = require('./firebase-config')
const {
  captureAndSendScreenshot: moduleCapture,
  checkScreenCapturePermission: moduleCheckPermission,
  getWaylandStatus
} = require('./src-main/screenshot-capture')

// Prevent multiple instances of the app
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  log.info('App already running - quitting this instance');
  app.quit();
  // Early exit
  return;
}

// Set up second-instance handler
app.on('second-instance', (event, commandLine, workingDirectory) => {
  // Event won't work for mac
  const { dialog } = require('electron');
  
  // Define platform-specific messages
  let message = 'The app is already running in the tray. Please open it there.';
  
  if (process.platform === 'win32') {
    message += ' (bottom right of the screen next to the time)';
  } else {
    message += ' (You might have to enable your system tray)';
  }
  
  // Show platform-specific alert
  dialog.showMessageBoxSync({
    type: 'info',
    title: 'DoneThat',
    message: 'DoneThat is Already Running',
    detail: message,
    buttons: ['OK']
  });
});

// Handle macOS reactivation (when user clicks dock icon or reopens app)
app.on('activate', () => {
  log.info('App activated');
  // Show the tray menu on reactivation if tray exists
  if (tray) {
    const contextMenu = buildContextMenu();
    tray.popUpContextMenu(contextMenu);
  }
});

// To show dev tools next to main window
let DEBUG = false
// Add your Firebase function URL here
const FIREBASE_CAPTURE_URL = 'https://europe-west1-donethat.cloudfunctions.net/captureScreenshot'

// Update screenshot interval logic
let SCREENSHOT_INTERVAL_MINUTES = 5; // Default to 5 minutes for release
// Set interval based on whether it's development or production
if (!app.isPackaged) {
  SCREENSHOT_INTERVAL_MINUTES = 5; // Every minute for development
}

let iconRecordingPath = path.join(__dirname, 'resources', 'icon_recording.png')
let iconPausedPath = path.join(__dirname, 'resources', 'icon_paused.png')
let iconErrorPath = path.join(__dirname, 'resources', 'icon_error.png')
// Use let for store since we'll initialize it after imports
let store = null;
let tray = null
let mainWindow = null
let idToken = null
let screenshotInterval = null
let pauseState = {
  endTime: null,     // If non-null and in future, app is paused
  timeoutId: null    // Reference to the auto-resume timer
};
let hasScreenCapturePermission = false
let isWaylandSession = null;
let userWorkdays = [1, 2, 3, 4, 5]; // Default Mon-Fri (0=Sun, 6=Sat)
let dailyWorkdayCheckTimeout = null;

if (DEBUG) {
  // Add custom notification transport for warnings and errors
  log.hooks.push((message, transport) => {
    if (transport !== log.transports.console) return message;

    if (message.level === 'warn' || message.level === 'error') {
      // Only send notifications after app is ready
      if (app.isReady()) {
        try {
          new Notification({
            title: `DoneThat ${message.level.toUpperCase()}`,
            body: message.data.join(' ').substring(0, 100) + (message.data.join(' ').length > 100 ? '...' : ''),
            silent: false
          }).show();
        } catch (err) {
          console.error('Failed to show notification:', err);
        }
      }
    }

    return message;
  });

  // For debugging, replace console with more verbose electron-log
  const originalConsole = { ...console };
  console.log = (...args) => { log.info(...args); originalConsole.log(...args); };
  console.error = (...args) => { log.error(...args); originalConsole.error(...args); };
  console.warn = (...args) => { log.warn(...args); originalConsole.warn(...args); };
  console.info = (...args) => { log.info(...args); originalConsole.info(...args); };
  console.debug = (...args) => { log.debug(...args); originalConsole.debug(...args); };
}

// Only replace console in production, not in debug mode
if (app.isPackaged && !DEBUG) {
  console.log = log.info.bind(log)
  console.error = log.error.bind(log)
  console.warn = log.warn.bind(log)
  console.info = log.info.bind(log)
  console.debug = log.debug.bind(log)
}

// Configure logging based on environment
if (app.isPackaged) {
  // In production: only show warnings and errors
  log.transports.console.level = 'warn'
  log.transports.file.level = 'info'  // Still log info to file for troubleshooting
} else {
  // In development: show all logs
  log.transports.console.level = 'silly'
  log.transports.file.level = 'silly'
}

// Initialize Firebase with the new config
const firebaseApp = initializeApp(firebaseConfig)

////// AUTOUPDATER /////

// Configure autoUpdater
function setupAutoUpdater() {
  // Use the centralized logger
  autoUpdater.logger = log

  // Add configuration for GitHub provider
  autoUpdater.allowPrerelease = false
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true


  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info.version)

    // Send event to renderer to show update view
    if (mainWindow) {
      mainWindow.webContents.send('update-downloaded')
    }
  })

  autoUpdater.on('error', (error) => {
    log.error('Update error:', error);

    // More detailed error logging
    if (error.stack) {
      log.error('Error stack:', error.stack);
    }
    if (error.code) {
      log.error('Error code:', error.code);
    }
  })
}

// Add IPC handler to install update and restart
ipcMain.on('install-update', () => {
  console.log('Installing update and restarting...')
  autoUpdater.quitAndInstall(true, true)
})

// Function to handle scheduled update checks
function scheduleUpdateChecks() {

  // First check after 1 minute to let the app fully initialize
  setTimeout(() => {
    autoUpdater.checkForUpdates()
      .catch(err => log.error('Error in first update check:', err));

    // Then check every hour
    setInterval(() => {
      autoUpdater.checkForUpdates()
        .catch(err => log.error('Error in hourly update check:', err));
    }, 60 * 60 * 1000);
  }, 1 * 60 * 1000);
}

// Call setup function
setupAutoUpdater()


// Add IPC handler for getting app version
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

////// AUTOSTART /////

// Fix autostart implementation with platform-specific logic
function setupAutoStart() {
  try {
    if (process.platform === 'win32') {
      // For Windows, use the exact process path without going up a directory
      app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
        args: []
      });

      log.info('Windows autostart configured with path:', process.execPath);
    } else if (process.platform === 'darwin') {
      // For macOS, use the special path resolution needed for app bundles
      const appFolder = path.dirname(process.execPath);
      const exeName = path.basename(process.execPath);
      const macOSPath = path.resolve(appFolder, '..', exeName);

      app.setLoginItemSettings({
        openAtLogin: true,
        path: macOSPath
      });

    } else {
      // Linux - autostart is not currently supported
    }

    // After update is installed, this will run again with the new executable path
    // when the app restarts, ensuring the autostart always points to latest version
  } catch (error) {
    log.error('Failed to configure autostart:', error);
  }
}

////// MAIN /////

app.whenReady().then(async () => {
  // Import electron-store using dynamic import (ES Module)
  try {
    const Store = await import('electron-store');
    store = new Store.default({
      name: 'donethat-config'
    });

    // Load pause state only after store is initialized
    loadPauseState();

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

  } catch (error) {
    log.error('Failed to initialize electron-store or load settings:', error);
  }

  // Create tray with initial error icon
  let trayIcon = nativeImage.createFromPath(iconErrorPath)

  // Apply platform-specific resizing for initial icon
  if (process.platform === 'darwin') {
    // macOS menu bar icons should be 18-22px
    trayIcon = trayIcon.resize({ width: 18, height: 18 })
  }

  tray = new Tray(trayIcon)
  tray.setToolTip('DoneThat')

  // Call setupAutoStart here to ensure it runs after app is ready
  setupAutoStart();
  
  // Check screen capture permission
  hasScreenCapturePermission = await checkScreenCapturePermission()

  // Initial state check and schedule daily check
  checkWorkdayAndAdjustRecording();

  // --- Add powerMonitor listener here ---
  powerMonitor.on('resume', () => {
    // Clear the potentially delayed timeout from before sleep
    if (dailyWorkdayCheckTimeout) {
        clearTimeout(dailyWorkdayCheckTimeout);
    }
    // Immediately check the state and schedule the *next* check
    checkWorkdayAndAdjustRecording();
  });
  // --- End powerMonitor listener ---

  // Handle left-click to show a fresh context menu
  tray.on('click', () => {
    const contextMenu = buildContextMenu()
    tray.popUpContextMenu(contextMenu)
  })

  // Also handle right-click to show a fresh context menu
  tray.on('right-click', () => {
    const contextMenu = buildContextMenu()
    tray.popUpContextMenu(contextMenu)
  })

  // Create window but don't show it yet
  createWindow()

  // Check for updates with proper error handling
  try {
    // Setup updater
    setupAutoUpdater();

    if (app.isPackaged) {
      scheduleUpdateChecks();
    } else {
    }
  } catch (error) {
    log.error('Error setting up updater:', error);
  }

  // Also check permissions when the app is activated
  app.on('activate', async () => {
    hasScreenCapturePermission = await checkScreenCapturePermission();
    log.warn(`A Sending permission check result: hasPermission=${hasScreenCapturePermission}, isWaylandSession=${isWaylandSession}`);

    if (mainWindow) {
      mainWindow.webContents.send('screenCapturePermission', {
        hasPermission: hasScreenCapturePermission,
        isWaylandSession: isWaylandSession
      });
    }
  });

  // Set up periodic update checks (every hour)
  setInterval(() => {
    autoUpdater.checkForUpdates()
      .then()
      .catch(err => console.error('Error in periodic update check:', err))
  }, 60 * 60 * 1000) // 1 hours in milliseconds

})

// Handle OS-level quit events properly - especially important for macOS
app.on('before-quit', () => {
  // Flag that we're actually quitting, not just closing windows
  app.isQuitting = true;

  // Clean up resources
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
  }

  if (pauseState.timeoutId) {
    clearTimeout(pauseState.timeoutId);
  }
  
  // Save pause state before quitting if we're paused
  if (isPaused()) {
    savePauseState()
  }

  if (dailyWorkdayCheckTimeout) {
    clearTimeout(dailyWorkdayCheckTimeout);
  }
})


////// AUTH /////

// Add new IPC handler for initial auth check
ipcMain.on('initialAuthCheck', (event, isAuthenticated) => {
  if (!isAuthenticated) {
    // Only show window if user is not authenticated
    showWindowBelowTray()
  }
})

// Updated listener for login event to check if tray exists before updating
ipcMain.on('login', (event, token) => {
  idToken = token
  // Check if we should start recording based on current conditions (including workday)
  checkWorkdayAndAdjustRecording(); // Use the check function

  // Update icon to show active state (only if we have permission and tray exists)
  if (tray) {
    updateTrayIcon(!isPaused() && hasScreenCapturePermission)
  }

  // Send permission status to renderer
  if (mainWindow) {
    mainWindow.webContents.send('screenCapturePermission', {
      hasPermission: hasScreenCapturePermission,
      isWaylandSession: isWaylandSession
    });
  }
})

// Update the logout handler to check if tray exists
ipcMain.on('logout', (event) => {
  idToken = null
  // Stop recording regardless of workday status
  stopRecording();
})

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
    
    checkWorkdayAndAdjustRecording(); // Use the same logic as the daily check
  } else {
    log.error('Received invalid workdays data:', days);
  }
});

////// TRAY /////

// Function to update the tray icon based on recording state
function updateTrayIcon(isActuallyRecording) {
  // Safety check - ensure tray exists before trying to update it
  if (!tray) {
    return
  }

  let iconPath;
  let tooltip;

  const loggedIn = Boolean(idToken);
  const manuallyPaused = isPaused();
  const todayIsWorkday = isWorkday(); // Check current day

  if (isActuallyRecording) {
    iconPath = iconRecordingPath;
    tooltip = 'DoneThat - Recording';
  } else if (manuallyPaused) {
    iconPath = iconPausedPath;
    tooltip = 'DoneThat - Paused';
  } else if (!loggedIn) {
    iconPath = iconErrorPath;
    tooltip = 'DoneThat - Not Logged In';
  } else if (!hasScreenCapturePermission) {
      iconPath = iconErrorPath;
      tooltip = 'DoneThat - Screen Permission Needed';
  } else if (!todayIsWorkday) {
    iconPath = iconPausedPath; // Use paused icon for non-workdays
    tooltip = 'DoneThat - Not Recording (Non-Workday)';
  } else {
    // Default fallback (e.g., other error state?)
    iconPath = iconErrorPath;
    tooltip = 'DoneThat - Not Recording';
  }

  // Load and set the appropriate icon
  let icon = nativeImage.createFromPath(iconPath)

  // MODIFY the resizing code to skip Windows
  if (process.platform === 'darwin') {
    // macOS menu bar icons look best at 18-22px
    icon = icon.resize({ width: 18, height: 18 })
  }

  tray.setImage(icon)

  // Clear any previous title (macOS specific)
  if (process.platform === 'darwin') {
    tray.setTitle('')
  }

  // Update context menu on Linux to reflect current state
  if (process.platform === 'linux') {
    const contextMenu = buildContextMenu()
    tray.setContextMenu(contextMenu)
  }

  tray.setToolTip(tooltip)
}

// Function to navigate to a specific view
function navigateToView(viewName) {
  showWindowBelowTray();
  mainWindow.webContents.send('navigate', viewName);
}

// Function to build the context menu with pause options
function buildContextMenu() {
  const isLoggedIn = Boolean(idToken)
  const currentlyPaused = isPaused()

  // Start with basic template
  const template = []

  // Add "Open App" as the first option for all platforms
  template.push({
    label: 'Open App',
    click: () => navigateToView('signup-next')
  }, 
  // Add Open Settings option (renamed from Setup)
  {
    label: 'Open Settings',
    click: () => navigateToView('settings'),
    enabled: isLoggedIn
  },
  { type: 'separator' },
  // Add "Open Web Portal" option
  {
    label: 'Open Web Portal',
    click: () => {
      const { shell } = require('electron');
      shell.openExternal('https://app.donethat.ai');
    }
  },
  { type: 'separator' },
)

  // Add pause options
  template.push(
    {
      label: 'Pause for 5 minutes',
      click: () => pauseRecording(5 * 60 * 1000),
      enabled: isLoggedIn && !currentlyPaused && screenshotInterval
    },
    {
      label: 'Pause for 15 minutes',
      click: () => pauseRecording(15 * 60 * 1000),
      enabled: isLoggedIn && !currentlyPaused && screenshotInterval
    },
    {
      label: 'Pause for 30 minutes',
      click: () => pauseRecording(30 * 60 * 1000),
      enabled: isLoggedIn && !currentlyPaused && screenshotInterval
    },
    {
      label: 'Pause for 1 hour',
      click: () => pauseRecording(60 * 60 * 1000),
      enabled: isLoggedIn && !currentlyPaused && screenshotInterval
    },
    {
      label: 'Pause for today',
      click: () => pauseUntilNextWorkday(),
      enabled: isLoggedIn && !currentlyPaused && screenshotInterval
    },
    {
      label: 'Resume',
      click: () => resumeRecording(),
      enabled: isLoggedIn && currentlyPaused
    }
  )

  // Add separator before logout
  template.push(
    { type: 'separator' }
  );

  // Always show logout option but disable if not logged in
  template.push(
    {
      label: 'Logout',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('logout');
        }
      },
      enabled: isLoggedIn
    }
  );

  // Add quit option at the end
  template.push(
    {
      label: 'Quit',
      click: () => app.quit()
    }
  )

  return Menu.buildFromTemplate(template)
}

// Helper function to check if currently paused (manual pause)
function isPaused() {
  return pauseState.endTime !== null && pauseState.endTime > new Date();
}

// Helper function to check if today is a configured workday
function isWorkday(date = new Date()) {
  const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
  // Ensure userWorkdays is an array before checking
  return Array.isArray(userWorkdays) && userWorkdays.includes(dayOfWeek);
}

// Function to pause recording for a specified duration
function pauseRecording(duration) {
  // Stop recording first regardless of why
  stopRecording(); // Use the new helper

  if (pauseState.timeoutId) {
    clearTimeout(pauseState.timeoutId)
    pauseState.timeoutId = null
  }

  // Calculate end time
  const endTime = new Date(Date.now() + duration)
  
  // Set pause state
  pauseState = {
    endTime: endTime,
    timeoutId: setTimeout(() => resumeRecording(), duration)
  };
  
  // Save the pause state
  savePauseState()
  
  updateTrayIcon(false)

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

// Function to pause until the start (4 AM) of the next configured workday
function pauseUntilNextWorkday() {
  const now = new Date();
  let nextWorkdayDate = new Date(now);

  // Start checking from tomorrow
  nextWorkdayDate.setDate(nextWorkdayDate.getDate() + 1);

  // Find the next date that is a workday
  while (!isWorkday(nextWorkdayDate)) {
    nextWorkdayDate.setDate(nextWorkdayDate.getDate() + 1);
  }

  // Set the time to 4:00 AM on that workday
  nextWorkdayDate.setHours(4, 0, 0, 0);

  const duration = nextWorkdayDate.getTime() - now.getTime();

  // Ensure duration is positive (should always be, but safety check)
  if (duration > 0) {
    pauseRecording(duration);
  } else {
    log.error('Calculated pause duration until next workday was not positive.');
    // Fallback: Pause for 1 hour just in case
    pauseRecording(60 * 60 * 1000);
  }
}

// Function to resume recording (called manually or by timer)
function resumeRecording() {
  if (!idToken || !hasScreenCapturePermission) {
    updateTrayIcon(false); // Update icon if not logged in or no permission
    return; // Can't resume if not logged in or no permission
  }

  if (pauseState.timeoutId) {
    clearTimeout(pauseState.timeoutId);
  }

  // Reset pause state
  const wasPaused = isPaused(); // Check if we were *manually* paused
  pauseState = { endTime: null, timeoutId: null };
  if (store) store.delete('pauseState');

  // Only start new interval if one doesn't exist
  if (!screenshotInterval) {
    screenshotInterval = setInterval(captureAndSendScreenshot, SCREENSHOT_INTERVAL_MINUTES * 60000);
  }

  // Common operations for all resume cases
  updateTrayIcon(true); // Show recording state
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
      endTime: pauseState.endTime ? pauseState.endTime.getTime() : null
    }
    store.set('pauseState', stateToSave)
  } catch (error) {
    log.error('Failed to save pause state:', error)
  }
}

// Function to load pause state using electron-store
function loadPauseState() {
  try {
    // Skip if store is not initialized
    if (!store) {
      log.warn('Store not initialized');
      return false;
    }

    const savedState = store.get('pauseState')
    
    if (savedState && savedState.endTime) {
      const endTime = new Date(savedState.endTime)
      const now = new Date()
      
      // If pause end time is in the future, restore the pause
      if (endTime > now) {
        const remainingDuration = endTime.getTime() - now.getTime()
        
        pauseState = {
          endTime: endTime,
          timeoutId: setTimeout(() => resumeRecording(), remainingDuration)
        };
        
        // Send state update since we restored a pause
        if (mainWindow) {
          mainWindow.webContents.send('pauseStateChanged', true);
        }
        return true
      } else {
        // Pause period has already expired
        store.delete('pauseState')
        // Send state update since pause expired
        if (mainWindow) {
          mainWindow.webContents.send('pauseStateChanged', false);
        }
      }
    }
  } catch (error) {
    log.error('Failed to load pause state:', error)
  }
  return false
}

// Schedules a check for the next day at 4:01 AM
function scheduleDailyWorkdayCheck() {
    if (dailyWorkdayCheckTimeout) {
        clearTimeout(dailyWorkdayCheckTimeout);
    }

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    // Check at 4:01 AM local time the next day
    tomorrow.setHours(4, 1, 0, 0);

    const msUntilCheck = tomorrow.getTime() - now.getTime();
    // Ensure msUntilCheck is positive (e.g., if check runs slightly after 4:01 AM)
    const positiveMsUntilCheck = Math.max(msUntilCheck, 60000); // Minimum 1 minute wait

    dailyWorkdayCheckTimeout = setTimeout(() => {
        checkWorkdayAndAdjustRecording();
        // Note: checkWorkdayAndAdjustRecording now calls scheduleDailyWorkdayCheck again
    }, positiveMsUntilCheck);
}

// Central function to evaluate and adjust recording state based on all factors
function checkWorkdayAndAdjustRecording() {
    const isCurrentlyRecording = !!screenshotInterval;
    const canRecordEssentials = idToken && hasScreenCapturePermission && !isPaused();
    const todayIsWorkday = isWorkday();

    // Determine if recording *should* stop based on essential conditions
    const shouldStop = isCurrentlyRecording && !canRecordEssentials;
    // Determine if recording *should* start based on all conditions (including workday)
    const shouldStart = !isCurrentlyRecording && canRecordEssentials && todayIsWorkday;

    if (shouldStop) {
        stopRecording(); // Stop if logged out, permission lost, or paused
    } else if (shouldStart) {
        startRecording(); // Start automatically only if it's a workday and conditions met
    } else {
        // No change in start/stop needed, but ensure icon reflects current reality.
        // For example, if manually resumed on non-workday, icon should stay 'recording'.
        // If it's a non-workday and not recording, icon should reflect that.
        updateTrayIcon(isCurrentlyRecording);
    }

    // Schedule the next check (important for the loop)
    scheduleDailyWorkdayCheck();
}

// From dashboard
ipcMain.on('pauseUntilTomorrow', () => {
  pauseUntilNextWorkday();
});

////// WINDOWS /////

// Separate window creation from showing
function createWindow() {
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: DEBUG ? 600 : 250,
      height: DEBUG ? 600 : 450,
      // Add frame on Linux, keep frameless on other platforms
      frame: false,
      resizable: false,
      // Make window movable on Linux but keep it fixed on other platforms
      movable: !(process.platform === 'darwin'),
      show: false,
      skipTaskbar: true, // Hide from taskbar on Windows/Linux
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        partition: 'persist:donethat',
        webSecurity: true,
        // Add these to ensure proper persistence
        enableRemoteModule: false,
        sandbox: false,
        // This is important for IndexedDB persistence
        backgroundThrottling: false
      }
    })

    mainWindow.loadFile('./src/index.html')

    // Debug inspector
    if (DEBUG) {
      mainWindow.webContents.openDevTools();
    }
    // Log any webContents errors
    mainWindow.webContents.on('console-message', (event, level, message) => {
      console.log('Renderer Console:', message);
    });

    // Position the window once it's ready.
    mainWindow.once('ready-to-show', () => {
      mainWindow.webContents.send('screenCapturePermission', {
        hasPermission: hasScreenCapturePermission,
        isWaylandSession: isWaylandSession
      });
    })

    mainWindow.on('blur', () => {
      if (mainWindow && mainWindow.isVisible()) {
        mainWindow.hide()
      }
    })
  }
}

// Intelligently positions the window relative to the tray icon
// with support for multiple displays
function showWindowBelowTray() {
  // Get tray icon bounds
  const trayBounds = tray.getBounds()

  // Get window size
  const windowBounds = mainWindow.getBounds()

  // Get all displays
  const allDisplays = screen.getAllDisplays()

  // Find which display contains the tray icon
  const trayDisplay = allDisplays.find(display => {
    const { x, y, width, height } = display.bounds
    return (
      trayBounds.x >= x && trayBounds.x < x + width &&
      trayBounds.y >= y && trayBounds.y < y + height
    )
  }) || screen.getPrimaryDisplay() // Fall back to primary if not found

  // Use the working area of the display containing the tray
  const { workArea } = trayDisplay

  let x, y;

  // Linux-specific positioning logic
  if (process.platform === 'linux') {
    // On Linux, center in the primary display as a fallback
    // since tray positioning can be unreliable
    x = Math.round(workArea.x + (workArea.width / 2) - (windowBounds.width / 2))
    y = Math.round(workArea.y + (workArea.height / 2) - (windowBounds.height / 2))

    // If we have valid tray bounds, try to position near it
    if (trayBounds.width > 0 && trayBounds.height > 0) {
      // Position at the bottom of the screen if the tray appears to be at the bottom
      // Common for panels at bottom of screen
      if (trayBounds.y > workArea.y + (workArea.height / 2)) {
        y = workArea.y + workArea.height - windowBounds.height - 50; // 50px buffer
      } else {
        // Otherwise position at top with offset
        y = workArea.y + 50;
      }
    }
  } else {
    // Original positioning for Windows and macOS
    // Calculate x position: center window horizontally relative to the tray icon
    x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2))

    // Determine if tray is closer to top or bottom of the display
    const distanceToTop = trayBounds.y - workArea.y
    const distanceToBottom = (workArea.y + workArea.height) - (trayBounds.y + trayBounds.height)

    if (distanceToTop < distanceToBottom) {
      // Tray is closer to top - position window below tray
      y = trayBounds.y + trayBounds.height
    } else {
      // Tray is closer to bottom - position window above tray
      y = trayBounds.y - windowBounds.height
    }
  }

  // Ensure window doesn't go off-screen horizontally
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - windowBounds.width))

  // Ensure window doesn't go off-screen vertically
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - windowBounds.height))

  mainWindow.setPosition(x, y, false)
  mainWindow.show()
  mainWindow.focus() // Ensure window gets focus
}
// Modify the window-all-closed handler to respect system quit
app.on('window-all-closed', (event) => {
  // Only prevent default if we're not in the quit process
  if (!app.isQuitting) {
    event.preventDefault();
  }
  // Otherwise let the app quit normally
});

// Update the focus handler to use the global isWaylandSession variable
app.on('browser-window-focus', async () => {
  const oldPermission = hasScreenCapturePermission;
  hasScreenCapturePermission = await checkScreenCapturePermission();

  // Only send update if permission status actually changed
  if (oldPermission !== hasScreenCapturePermission && mainWindow) {
    // Use the global isWaylandSession variable
    mainWindow.webContents.send('screenCapturePermission', {
      hasPermission: hasScreenCapturePermission,
      isWaylandSession: isWaylandSession
    });

    // Re-evaluate recording state based on permission change
    checkWorkdayAndAdjustRecording();
  }
});


// Add listener for when summary is submitted
ipcMain.on('summarySubmitted', (event) => {
  summarySubmittedTimestamp = Date.now();
})

////// SCREENSHOTS ////

// Checks all conditions (login, permission, pause, workday) and starts interval if appropriate
function startRecording() {
  // Start the interval (caller ensures it doesn't already exist)
  screenshotInterval = setInterval(captureAndSendScreenshot, SCREENSHOT_INTERVAL_MINUTES * 60000);
  
  // Common operations
  updateTrayIcon(true); // Show recording state
  if (mainWindow) {
    mainWindow.webContents.send('pauseStateChanged', false);
    mainWindow.webContents.send('analytics-event', { 
      eventName: 'recording_state_changed',
      eventParams: { status: 'started' } 
    });
  }
}

// Stops the interval and updates the icon
function stopRecording() {
    if (screenshotInterval) {
        clearInterval(screenshotInterval);
        screenshotInterval = null;
    }
    updateTrayIcon(false); // Update icon to non-recording state
    
    // Send state updates
    if (mainWindow) {
      mainWindow.webContents.send('pauseStateChanged', true);
      mainWindow.webContents.send('analytics-event', { 
        eventName: 'recording_state_changed',
        eventParams: { status: 'stopped' } 
      });
    }
}

// Function to check screen capture permission
async function checkScreenCapturePermission() {
  hasScreenCapturePermission = await moduleCheckPermission();
  isWaylandSession = getWaylandStatus();
  return hasScreenCapturePermission;
}

async function captureAndSendScreenshot() {
  const result = await moduleCapture(idToken, FIREBASE_CAPTURE_URL);

  // Handle auth error specially
  if (result && result.authError) {
    idToken = null;
    if (mainWindow) {
      mainWindow.webContents.send('auth-error');
    }
  }
  
  // Handle token expired error
  if (result && result.tokenExpired) {    
    // Request token refresh from renderer process
    if (mainWindow) {
      mainWindow.webContents.send('refresh-token');
      
      // Set up one-time listener for the refreshed token
      ipcMain.once('token-refreshed', async (event, newToken) => {
        if (newToken) {
          idToken = newToken;
          
          // Retry the screenshot capture with new token
          const retryResult = await moduleCapture(idToken, FIREBASE_CAPTURE_URL);
          if (retryResult && retryResult.authError) {
            // If still failing after refresh, signal auth error
            idToken = null;
            mainWindow.webContents.send('auth-error');
          } else if (!retryResult) {
            // Log other errors from retry
            console.error('Screenshot retry failed after token refresh');
          }
        } else {
          log.error('Failed to refresh token');
          // Handle as auth error since refresh failed
          idToken = null;
          mainWindow.webContents.send('auth-error');
        }
      });
    }
  }

  return result;
}

// Also update the explicit permission check handler
ipcMain.on('checkScreenCapturePermission', async () => {
  hasScreenCapturePermission = await checkScreenCapturePermission();

  if (mainWindow) {
    // Send both permission status and session type
    mainWindow.webContents.send('screenCapturePermission', {
      hasPermission: hasScreenCapturePermission,
      isWaylandSession: isWaylandSession
    });
  }
});

// Add a new IPC handler for requesting screen capture permission
ipcMain.on('requestScreenCapturePermission', async () => {
  // On macOS this would open System Preferences > Security & Privacy > Screen Recording
  // On Windows there isn't a direct way to open system settings for this
  const { shell } = require('electron')

  if (process.platform === 'darwin') {
    // macOS
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  } else if (process.platform === 'win32') {
    // Windows - open general privacy settings
    shell.openExternal('ms-settings:privacy')
  } else {
    // Linux or other platforms
  }

  // After opening settings, we should check permission again when app regains focus
  const focusListener = async () => {
    // Remove listener immediately to prevent multiple triggers
    app.removeListener('browser-window-focus', focusListener);

    const hasPermission = await checkScreenCapturePermission()

    if (hasPermission !== oldPermission && mainWindow) { // Check if permission *changed*
      mainWindow.webContents.send('screenCapturePermission', {
        hasPermission: hasPermission,
        isWaylandSession: isWaylandSession
      });

      // Re-evaluate recording state based on permission change
      checkWorkdayAndAdjustRecording();
    }
  };
  // Store old permission state *before* adding listener
  const oldPermission = hasScreenCapturePermission;
  app.on('browser-window-focus', focusListener);
})

// Add IPC handler for pause state updates
ipcMain.on('pauseStateChanged', (event, isPaused) => {
  if (mainWindow) {
    mainWindow.webContents.send('pauseStateChanged', isPaused);
  }
});

// Add IPC handler for resume action
ipcMain.on('resumeRecording', () => {
  resumeRecording();
});