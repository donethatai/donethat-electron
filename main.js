const { app, Tray, Menu, BrowserWindow, nativeImage, screen, desktopCapturer, Notification } = require('electron')
const path = require('path')
const { ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')

// Importing Firebase modules using the new modular API.
const { initializeApp, getAuth } = require('firebase/app')
const firebaseConfig = require('./firebase-config')

// Initialize Firebase with the new config
const firebaseApp = initializeApp(firebaseConfig)

// Add your Firebase function URL here
const FIREBASE_CAPTURE_URL = 'https://europe-west1-donethat.cloudfunctions.net/captureScreenshot'

// To show dev tools next to main window
let debug = false

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

// Update screenshot interval logic
let SCREENSHOT_INTERVAL_MINUTES = 5; // Default to 5 minutes for release

// Set interval based on whether it's development or production
if (!app.isPackaged) {
  SCREENSHOT_INTERVAL_MINUTES = 1; // Every minute for development
}

// Define paths to the different icon images based on platform
let iconRecordingPath, iconPausedPath, iconErrorPath;

if (process.platform === 'win32') {
  // Use .ico files for Windows
  iconRecordingPath = path.join(__dirname, 'resources', 'icon-recording.ico')
  iconPausedPath = path.join(__dirname, 'resources', 'icon-paused.ico')
  iconErrorPath = path.join(__dirname, 'resources', 'icon-error.ico')
} else {
  // Use .png files for macOS and Linux
  iconRecordingPath = path.join(__dirname, 'resources', 'icon_recording.png')
  iconPausedPath = path.join(__dirname, 'resources', 'icon_paused.png')
  iconErrorPath = path.join(__dirname, 'resources', 'icon_error.png')
}

// Configure autoUpdater
function setupAutoUpdater() {
  // Log update events
  autoUpdater.logger = require('electron-log')
  autoUpdater.logger.transports.file.level = 'info'
  
  // Add configuration for GitHub provider
  autoUpdater.allowPrerelease = false
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  
  // Uncomment to check for updates in development mode
  /*
  if (!app.isPackaged) {
    // Instead of trying to modify internal objects, let's use a more direct approach
    autoUpdater.forceDevUpdateConfig = true;
    
  }
  */

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info)

    // Send event to renderer to show update view
    if (mainWindow) {
      mainWindow.webContents.send('update-downloaded')
    }
  })

  autoUpdater.on('error', (error) => {
    console.error('Update error:', error);
  })
}

// Call setup function
setupAutoUpdater()

// Check if we have screen recording permission
async function checkScreenCapturePermission() {
  try {
    // Add a small delay to ensure system is ready
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false
    });
    
    // If we can get sources, we likely have permission
    if (sources && sources.length > 0) {
      hasScreenCapturePermission = true;
      return true;
    }
    
    hasScreenCapturePermission = false;
    return false;
  } catch (error) {
    console.error('Error checking screen capture permission:', error);
    hasScreenCapturePermission = false;
    return false;
  }
}

// Start at login
const appFolder = path.dirname(process.execPath)
const ourExeName = path.basename(process.execPath)
const stubLauncher = path.resolve(appFolder, '..', ourExeName)
app.setLoginItemSettings({
  openAtLogin: true,
  path: stubLauncher, // Windows only, one dir higher for latest
})

app.whenReady().then(async () => {
  // Create tray with initial error icon
  let trayIcon = nativeImage.createFromPath(iconErrorPath)
  
  // Apply platform-specific resizing for initial icon
  if (process.platform === 'win32') {
    // Windows typically uses 16x16 icons for the system tray
    trayIcon = trayIcon.resize({ width: 16, height: 16 })
  } else if (process.platform === 'darwin') {
    // macOS menu bar icons should be 18-22px
    trayIcon = trayIcon.resize({ width: 18, height: 18 })
  }
  
  tray = new Tray(trayIcon)
  tray.setToolTip('Done That')

  // Check screen capture permission
  hasScreenCapturePermission = await checkScreenCapturePermission()

  // Initial state - update icon after tray is created
  updateTrayIcon(false)

  // Left-click opens the window
  tray.on('click', () => {
    toggleWindow()
  })

  // Show context menu with pause options on right-click
  tray.on('right-click', () => {
    const contextMenu = buildContextMenu()
    tray.popUpContextMenu(contextMenu)
  })

  // Create window but don't show it yet
  createWindow()

  // Check for updates with proper error handling
  try {
    if (!app.isPackaged) {
      console.log('Setting custom update URL for development testing')
      const options = {
        provider: 'github',
        owner: 'donethatai',
        repo: 'donethat-releases'
      }
      await autoUpdater.setFeedURL(options)
    }

    await autoUpdater.checkForUpdates()
    console.log('Update check completed')
  } catch (error) {
    console.error('Error checking for updates:', error)
  }

  // Also check permissions when the app is activated
  app.on('activate', async () => {
    hasScreenCapturePermission = await checkScreenCapturePermission();
    if (mainWindow) {
      mainWindow.webContents.send('screenCapturePermission', hasScreenCapturePermission);
    }
  });

  // Set up periodic update checks (every hour)
  setInterval(() => {
    autoUpdater.checkForUpdates()
      .then(() => console.log('Periodic update check completed'))
      .catch(err => console.error('Error in periodic update check:', err))
  }, 60 * 60 * 1000) // 1 hours in milliseconds
})

// Add IPC handler to install update and restart
ipcMain.on('install-update', () => {
  console.log('Installing update and restarting...')
  autoUpdater.quitAndInstall(true, true)
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
    mainWindow.webContents.send('screenCapturePermission', hasScreenCapturePermission)
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
  
  // Platform-specific icon resizing
  if (process.platform === 'win32') {
    // Windows typically uses 16x16 icons for the system tray
    icon = icon.resize({ width: 16, height: 16 })
  } else if (process.platform === 'darwin') {
    // macOS menu bar icons look best at 18-22px
    // Uses 'aspectFit' to maintain aspect ratio
    icon = icon.resize({ width: 18, height: 18 })
  }
  
  tray.setImage(icon)
  
  // Clear any previous title (macOS specific)
  if (process.platform === 'darwin') {
    tray.setTitle('')
  }
}

// Function to start the recording
function startRecording() {
  if (!screenshotInterval) {
    screenshotInterval = setInterval(captureAndSendScreenshot, SCREENSHOT_INTERVAL_MINUTES * 60000)
    console.log(`Screenshot recording started (every ${SCREENSHOT_INTERVAL_MINUTES} minutes)`)
  }
}

// Function to build the context menu with pause options
function buildContextMenu() {
  const isLoggedIn = Boolean(idToken)

  return Menu.buildFromTemplate([
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
  ])
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

// Separate window creation from showing
function createWindow() {
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: debug ? 600 : 250,
      height: debug ? 600 : 400,
      frame: false,
      resizable: false,
      movable: false,
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
    if (debug) {
      mainWindow.webContents.openDevTools();
    }    
    // Log any webContents errors
    mainWindow.webContents.on('console-message', (event, level, message) => {
      console.log('Renderer Console:', message);
    });

    // Position the window once it's ready.
    mainWindow.once('ready-to-show', () => {
      mainWindow.webContents.send('screenCapturePermission', hasScreenCapturePermission)
    })

    mainWindow.on('blur', () => {
      if (mainWindow && mainWindow.isVisible()) {
        mainWindow.hide()
      }
    })
  }
}

// Update toggleWindow to only handle showing/hiding
function toggleWindow() {
  if (mainWindow) {
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      showWindowBelowTray()
    }
  }
}

// Positions the window directly below the tray icon.
function showWindowBelowTray() {
  // Get tray icon bounds.
  const trayBounds = tray.getBounds()
  // Get the window's size.
  const windowBounds = mainWindow.getBounds()

  // Calculate x position: center window horizontally relative to the tray icon.
  const x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2))
  // Calculate y position: place it directly below the tray icon.
  const y = Math.round(trayBounds.y + trayBounds.height)

  mainWindow.setPosition(x, y, false)
  mainWindow.show()
}

// Function to capture and send screenshots
async function captureAndSendScreenshot() {
  if (!idToken) {
    console.log('Cannot send screenshots: User not authenticated')
    return
  }

  try {
    // Capture each screen separately
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 } // Higher initial resolution for better quality
    })

    if (sources.length === 0) {
      console.log('No screens detected')
      return
    }

    // Process all screenshots to proper dimensions
    const screenshots = await Promise.all(
      sources.map(async (source) => {
        // Process each screenshot with 819px constraint on shorter edge
        return await processScreenshotForUpload(source.thumbnail.toDataURL())
      })
    )

    const fetch = await import('node-fetch').then(module => module.default)

    // Send all screenshots in a single API call
    const response = await fetch(FIREBASE_CAPTURE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        timestamp: Date.now(),
        screenshots: screenshots // Now sending an array of screenshots
      })
    })
    
    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`)
    }
  } catch (error) {
    // Simplified error handling
    console.error('Screenshot error:', error.message)
    
    // If it's an auth error, clear the token to force re-login
    if (error.message.includes('401') || error.message.includes('403')) {
      idToken = null
      if (mainWindow) {
        mainWindow.webContents.send('auth-error')
      }
    }
  }
}

// New function to process screenshots for upload with 819px constraint on shorter edge
async function processScreenshotForUpload(dataUrl) {
  return new Promise((resolve, reject) => {
    try {
      const { createCanvas, Image } = require('canvas')
      const img = new Image()

      img.onload = () => {
        let width = img.width
        let height = img.height
        const targetShortEdge = 819 // Maximum size for the shorter edge
        
        // Determine which dimension is shorter
        const isWidthShorter = width < height
        
        // Calculate new dimensions ensuring shorter edge is max 819px
        // while maintaining aspect ratio
        if (isWidthShorter) {
          if (width > targetShortEdge) {
            const aspectRatio = height / width
            width = targetShortEdge
            height = Math.round(width * aspectRatio)
          }
        } else {
          if (height > targetShortEdge) {
            const aspectRatio = width / height
            height = targetShortEdge
            width = Math.round(height * aspectRatio)
          }
        }

        // Create canvas for resized image
        const canvas = createCanvas(width, height)
        const ctx = canvas.getContext('2d')

        // Draw resized image
        ctx.drawImage(img, 0, 0, width, height)

        // Convert to JPEG with quality adjusted based on image size
        const quality = 0.7 // Slightly higher quality since we're controlling dimensions
        const processedDataUrl = canvas.toDataURL('image/jpeg', quality)

        resolve(processedDataUrl)
      }

      img.onerror = (err) => {
        reject(err)
      }

      img.src = dataUrl
    } catch (error) {
      reject(error)
    }
  })
}

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

// Add listener for when summary is submitted
ipcMain.on('summarySubmitted', (event) => {
  console.log("Summary submitted notification received");
  summarySubmittedTimestamp = Date.now();
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
});

// Modify the window-all-closed handler to respect system quit
app.on('window-all-closed', (event) => {
  // Only prevent default if we're not in the quit process
  if (!app.isQuitting) {
    event.preventDefault();
  }
  // Otherwise let the app quit normally
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
      mainWindow.webContents.send('screenCapturePermission', true)

      // Update icon and start recording if logged in
      if (idToken && !isPaused) {
        updateTrayIcon(true)
        startRecording()
      }
    }
  })
})

// Simplify this handler to just check if notifications are supported at all
ipcMain.handle('checkNotificationPermission', async () => {
  // Just check if notifications are supported by the system
  return Notification.isSupported();
})

// Add new IPC handler for initial auth check
ipcMain.on('initialAuthCheck', (event, isAuthenticated) => {
  if (!isAuthenticated) {
    // Only show window if user is not authenticated
    showWindowBelowTray()
  }
})

// Update the focus handler to be more specific
app.on('browser-window-focus', async () => {
  const oldPermission = hasScreenCapturePermission;
  hasScreenCapturePermission = await checkScreenCapturePermission();
  
  // Only send update if permission status actually changed
  if (oldPermission !== hasScreenCapturePermission && mainWindow) {
    mainWindow.webContents.send('screenCapturePermission', hasScreenCapturePermission);
    
    // Update icon and recording state if needed
    if (hasScreenCapturePermission && idToken && !isPaused) {
      updateTrayIcon(true);
      startRecording();
    }
  }
});

// Add new IPC handler for pausing until tomorrow from renderer
ipcMain.on('pauseUntilTomorrow', () => {
  console.log('Pausing recording until tomorrow due to summary submission');
  pauseUntilTomorrow();
});