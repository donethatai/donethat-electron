const { app, ipcMain, Tray, Menu, BrowserWindow, nativeImage, screen, Notification } = require('electron')
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

// To show dev tools next to main window
let DEBUG = false
// Add your Firebase function URL here
const FIREBASE_CAPTURE_URL = 'https://europe-west1-donethat.cloudfunctions.net/captureScreenshot'

// Update screenshot interval logic
let SCREENSHOT_INTERVAL_MINUTES = 5; // Default to 5 minutes for release
// Set interval based on whether it's development or production
if (!app.isPackaged) {
  SCREENSHOT_INTERVAL_MINUTES = 1; // Every minute for development
}

let iconRecordingPath = path.join(__dirname, 'resources', 'icon_recording.png')
let iconPausedPath = path.join(__dirname, 'resources', 'icon_paused.png')
let iconErrorPath = path.join(__dirname, 'resources', 'icon_error.png')

let tray = null
let mainWindow = null
let idToken = null
let screenshotInterval = null
let pauseTimeout = null
let isPaused = false
let summaryNotificationTime = null
let summaryNotificationTimeout = null
let summarySubmittedTimestamp = null
let hasScreenCapturePermission = false
let isWaylandSession = null;

if (DEBUG) {
  // Add custom notification transport for warnings and errors
  log.hooks.push((message, transport) => {
    if (transport !== log.transports.console) return message;
    
    if (message.level === 'warn' || message.level === 'error') {
      // Only send notifications after app is ready
      if (app.isReady()) {
        try {
          new Notification({
            title: `Done That ${message.level.toUpperCase()}`,
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

///// AUTOUPDATER /////

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
  log.info('Setting up update check schedule...');
  
  // First check after 1 minute to let the app fully initialize
  setTimeout(() => {
    log.info('Running first scheduled update check...');
    autoUpdater.checkForUpdates()
      .catch(err => log.error('Error in first update check:', err));
    
    // Then check every hour
    setInterval(() => {
      log.info('Running hourly update check...');
      autoUpdater.checkForUpdates()
        .catch(err => log.error('Error in hourly update check:', err));
    }, 60 * 60 * 1000);
  }, 1 * 60 * 1000);
}

// Call setup function
setupAutoUpdater()

///// AUTOSTART /////

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
      
      log.info('macOS autostart configured with path:', macOSPath);
    } else {
      // Linux - autostart is not currently supported
      log.info('Autostart on Linux is not currently supported');
    }
    
    // After update is installed, this will run again with the new executable path
    // when the app restarts, ensuring the autostart always points to latest version
  } catch (error) {
    log.error('Failed to configure autostart:', error);
  }
}

///// MAIN /////

app.whenReady().then(async () => {
  // Create tray with initial error icon
  let trayIcon = nativeImage.createFromPath(iconErrorPath)
  
  // Apply platform-specific resizing for initial icon
  if (process.platform === 'darwin') {
    // macOS menu bar icons should be 18-22px
    trayIcon = trayIcon.resize({ width: 18, height: 18 })
  }
  
  tray = new Tray(trayIcon)
  tray.setToolTip('Done That')

  // Call setupAutoStart here to ensure it runs after app is ready
  setupAutoStart();

  // Check screen capture permission
  hasScreenCapturePermission = await checkScreenCapturePermission()

  // Initial state - update icon after tray is created
  updateTrayIcon(false)
  
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
      log.info('Setting up auto-update checks...');
      scheduleUpdateChecks();
    } else {
      log.info('Skipping update checks in development mode');
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
      .then(() => console.log('Periodic update check completed'))
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
  
  if (pauseTimeout) {
    clearTimeout(pauseTimeout);
  }
  
  if (summaryNotificationTimeout) {
    clearTimeout(summaryNotificationTimeout);
  }
})


///// AUTH /////

// Add new IPC handler for initial auth check
ipcMain.on('initialAuthCheck', (event, isAuthenticated) => {
  if (!isAuthenticated) {
    // Only show window if user is not authenticated
    showWindowBelowTray()
  }
})

// Updated listener for login event - simplified to not store token
ipcMain.on('login', (event, token) => {
  console.log("ID Token received from renderer");
  idToken = token
  
  // Start recording if we weren't already and not paused and have permissions
  if (!screenshotInterval && !isPaused && hasScreenCapturePermission) {
    startRecording()
  }

  // Update icon to show active state (only if we have permission)
  updateTrayIcon(!isPaused && hasScreenCapturePermission)

  // Send permission status to renderer
  if (mainWindow) {
    mainWindow.webContents.send('screenCapturePermission', {
      hasPermission: hasScreenCapturePermission,
      isWaylandSession: isWaylandSession
    });
  }
})

ipcMain.on('logout', (event) => {
  console.log("User logged out");
  idToken = null
  
  // Stop recording if we were recording
  if (screenshotInterval) {
    clearInterval(screenshotInterval)
    screenshotInterval = null
  }

  // Update icon to show inactive state
  updateTrayIcon(false)
})

///// TRAY /////

// Function to update the tray icon based on recording state
function updateTrayIcon(isRecording) {
  let iconPath;
  
  if (isRecording) {
    // Use recording icon when recording
    iconPath = iconRecordingPath
    tray.setToolTip('Done That - Recording')
  } else if (isPaused) {
    // Use paused icon when paused
    iconPath = iconPausedPath
    tray.setToolTip('Done That - Paused')
  } else {
    // Use error icon when not recording and not paused (e.g., not logged in)
    iconPath = iconErrorPath
    tray.setToolTip('Done That - Not Recording')
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
}

// Function to build the context menu with pause options
function buildContextMenu() {
  const isLoggedIn = Boolean(idToken)

  // Start with basic template
  const template = []
  
  // Add "Open App" as the first option for all platforms
  template.push({
    label: 'Open App',
    click: () => toggleWindow()
  }, { type: 'separator' })

  // Add pause options
  template.push(
    {
      label: 'Pause for 5 minutes',
      click: () => pauseRecording(5 * 60 * 1000),
      enabled: isLoggedIn && !isPaused && screenshotInterval
    },
    {
      label: 'Pause for 15 minutes',
      click: () => pauseRecording(15 * 60 * 1000),
      enabled: isLoggedIn && !isPaused && screenshotInterval
    },
    {
      label: 'Pause for 30 minutes',
      click: () => pauseRecording(30 * 60 * 1000),
      enabled: isLoggedIn && !isPaused && screenshotInterval
    },
    {
      label: 'Pause for 1 hour',
      click: () => pauseRecording(60 * 60 * 1000),
      enabled: isLoggedIn && !isPaused && screenshotInterval
    },
    {
      label: 'Pause for today',
      click: () => pauseUntilTomorrow(),
      enabled: isLoggedIn && !isPaused && screenshotInterval
    },
    {
      label: 'Pause for this week',
      click: () => pauseUntilNextWeek(),
      enabled: isLoggedIn && !isPaused && screenshotInterval
    },
    { type: 'separator' },
    {
      label: 'Resume',
      click: () => resumeRecording(),
      enabled: isLoggedIn && isPaused
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit()
    }
  )

  return Menu.buildFromTemplate(template)
}

// Function to pause recording for a specified duration
function pauseRecording(duration) {
  // Clear existing interval and timeout
  if (screenshotInterval) {
    clearInterval(screenshotInterval)
    screenshotInterval = null
  }

  if (pauseTimeout) {
    clearTimeout(pauseTimeout)
  }

  // Set pause state
  isPaused = true
  updateTrayIcon(false)
  console.log(`Screenshot recording paused for ${duration / 60000} minutes`)

  // Set timeout to resume recording after duration
  pauseTimeout = setTimeout(() => {
    resumeRecording()
  }, duration)
}

// Function to pause until tomorrow (next day at midnight)
function pauseUntilTomorrow() {
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)

  const duration = tomorrow - now
  pauseRecording(duration)
  console.log(`Screenshot recording paused until tomorrow`)
}

// Add new function to pause until next week
function pauseUntilNextWeek() {
  const now = new Date()
  const nextMonday = new Date(now)
  nextMonday.setDate(now.getDate() + (8 - now.getDay()) % 7)
  nextMonday.setHours(0, 0, 0, 0)

  const duration = nextMonday - now
  pauseRecording(duration)
  console.log(`Screenshot recording paused until next Monday`)
}

// Function to resume recording
function resumeRecording() {
  if (pauseTimeout) {
    clearTimeout(pauseTimeout)
    pauseTimeout = null
  }

  isPaused = false

  // Only restart recording if logged in
  if (idToken) {
    updateTrayIcon(true)

    // Restart screenshot interval
    if (!screenshotInterval) {
      screenshotInterval = setInterval(captureAndSendScreenshot, SCREENSHOT_INTERVAL_MINUTES * 60000)
      console.log(`Screenshot recording resumed (every ${SCREENSHOT_INTERVAL_MINUTES} minutes)`)
    }
  } else {
    updateTrayIcon(false)
    console.log('Cannot resume recording - user not logged in')
  }
}

// Add new IPC handler for pausing until tomorrow from renderer
ipcMain.on('pauseUntilTomorrow', () => {
  log.info('Pausing recording until tomorrow due to summary submission');
  pauseUntilTomorrow();
});

///// WINDOWS /////

// Separate window creation from showing
function createWindow() {
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: DEBUG ? 600 : 250,
      height: DEBUG ? 600 : 400,
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

// Function to toggle window visibility (used from menu)
function toggleWindow() {
  if (mainWindow) {
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      showWindowBelowTray()
    }
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
    
    // Update icon and recording state if needed
    if (hasScreenCapturePermission && idToken && !isPaused) {
      updateTrayIcon(true);
      startRecording();
    }
  }
});


// Add listener for when summary is submitted
ipcMain.on('summarySubmitted', (event) => {
  console.log("Summary submitted notification received");
  summarySubmittedTimestamp = Date.now();
})

///// NOTIFICATIONS /////

// Simplify this handler to just check if notifications are supported at all
ipcMain.handle('checkNotificationPermission', async () => {
  // Just check if notifications are supported by the system
  return Notification.isSupported();
})

// Add new listener for receiving summary notification settings
ipcMain.on('updateSummaryNotificationTime', (event, time) => {
  console.log("Updating summary notification time:", time);
  summaryNotificationTime = time;

  // Clear any existing notification timeout
  if (summaryNotificationTimeout) {
    clearTimeout(summaryNotificationTimeout);
    summaryNotificationTimeout = null;
  }

  // Schedule the next notification if we have a valid time
  if (summaryNotificationTime) {
    scheduleNextSummaryNotification();
  }
})

// Function to schedule the next summary notification
function scheduleNextSummaryNotification() {
  if (!summaryNotificationTime || !idToken) return;

  // Clear any existing timeout
  if (summaryNotificationTimeout) {
    clearTimeout(summaryNotificationTimeout);
  }

  const now = new Date();
  const [hours, minutes] = summaryNotificationTime.split(':').map(Number);

  // Set target time for today
  const targetTime = new Date(now);
  targetTime.setHours(hours, minutes, 0, 0);

  // If the target time has already passed today, schedule for tomorrow
  if (now > targetTime) {
    targetTime.setDate(targetTime.getDate() + 1);
  }

  // Calculate ms until the notification should be shown
  const msUntilNotification = targetTime - now;

  console.log(`Scheduling summary notification for ${targetTime.toLocaleString()} (in ${msUntilNotification / 60000} minutes)`);

  // Set the timeout
  summaryNotificationTimeout = setTimeout(() => {
    showSummaryNotification();
  }, msUntilNotification);
}

// Function to show the summary notification
function showSummaryNotification() {
  // Skip notification if recording is paused or not active
  if (isPaused || !screenshotInterval) {
    console.log("Skipping notification - recording is paused or not active");
    scheduleNextSummaryNotification(); // Schedule for next time
    return;
  }

  // Check if summary was submitted recently
  if (shouldSkipNotification()) {
    console.log("Skipping notification - summary already submitted today");
    scheduleNextSummaryNotification(); // Schedule for next time
    return;
  }

  const notification = new Notification({
    title: 'Done That',
    body: 'Time to submit your daily summary!',
    silent: false
  });

  notification.on('click', () => {
    // Open the app when notification is clicked
    if (mainWindow) {
      showWindowBelowTray();
    } else {
      toggleWindow();
    }
  });

  notification.on('close', () => {
    // If notification was dismissed, reschedule for tomorrow
    scheduleNextSummaryNotification();
  });

  notification.show();

  // Schedule the next notification
  scheduleNextSummaryNotification();
}

// Function to check if we should skip showing notification
function shouldSkipNotification() {
  if (!summarySubmittedTimestamp) return false;

  const now = new Date();
  const submittedDate = new Date(summarySubmittedTimestamp);

  // If submission was on a different day, don't skip
  if (submittedDate.getDate() !== now.getDate() ||
    submittedDate.getMonth() !== now.getMonth() ||
    submittedDate.getFullYear() !== now.getFullYear()) {
    return false;
  }

  // Get notification time for today
  const [hours, minutes] = summaryNotificationTime.split(':').map(Number);
  const notificationTimeToday = new Date(now);
  notificationTimeToday.setHours(hours, minutes, 0, 0);

  // Two hour window before notification time
  const twoHoursBeforeNotification = new Date(notificationTimeToday);
  twoHoursBeforeNotification.setHours(notificationTimeToday.getHours() - 2);
  // If submitted within 2 hours before notification time or any time after
  return submittedDate >= twoHoursBeforeNotification;
}

//// SCREENSHOTS ////

function startRecording() {
  if (!screenshotInterval) {
    screenshotInterval = setInterval(captureAndSendScreenshot, SCREENSHOT_INTERVAL_MINUTES * 60000)
    console.log(`Screenshot recording started (every ${SCREENSHOT_INTERVAL_MINUTES} minutes)`)
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
    console.log('No direct way to open screen capture settings on this platform')
  }

  // After opening settings, we should check permission again when app regains focus
  app.on('browser-window-focus', async () => {
    const hasPermission = await checkScreenCapturePermission()

    if (hasPermission && mainWindow) {
      mainWindow.webContents.send('screenCapturePermission', {
        hasPermission: hasPermission,
        isWaylandSession: isWaylandSession
      });

      // Update icon and start recording if logged in
      if (idToken && !isPaused) {
        updateTrayIcon(true)
        startRecording()
      }
    }
  })
})