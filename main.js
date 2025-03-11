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

// Hide from taskbar on all platforms
if (process.platform === 'darwin') {
  app.dock.hide()  // macOS
} else if (process.platform === 'win32') {
  // Windows
  app.setAppUserModelId('none') // This helps hide from taskbar
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
  // Create the tray
  tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('Done That')

  // Check screen capture permission
  hasScreenCapturePermission = await checkScreenCapturePermission()

  // Initial state - if not logged in, show crossed out checkmark and don't record
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
})

// Add IPC handler to manually check for updates with proper error handling
ipcMain.on('check-for-updates', async () => {
  try {
    await autoUpdater.checkForUpdates()
    console.log('Manual update check completed')
  } catch (error) {
    console.error('Error during manual update check:', error)
    if (mainWindow) {
      mainWindow.webContents.send('update-error', error.message)
    }
  }
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
  if (isRecording) {
    // Use checkmark symbol when recording
    tray.setTitle('✓')
    tray.setToolTip('Done That - Recording')
  } else {
    // Use crossed out checkmark when paused or not logged in or no permission
    tray.setTitle('⏸')
    tray.setToolTip('Done That - Not Recording')
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
    console.log('Cannot send screenshot: User not authenticated')
    return
  }

  try {
    // Reduced thumbnail size for initial capture
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 }
    })

    if (sources.length === 0) {
      console.log('No screens detected')
      return
    }

    let screenshot

    if (sources.length === 1) {
      // Single screen - standard compression
      screenshot = await compressImage(sources[0].thumbnail.toDataURL(), 1280, 800)
    } else {
      // Multiple screens - need to merge them with higher resolution limits      
      const { createCanvas, Image } = require('canvas')

      // Calculate total dimensions needed
      const displays = screen.getAllDisplays()
      let totalWidth = 0
      let totalHeight = 0

      for (const display of displays) {
        const bounds = display.bounds
        totalWidth = Math.max(totalWidth, bounds.x + bounds.width)
        totalHeight = Math.max(totalHeight, bounds.y + bounds.height)
      }

      // Calculate dynamic scaling factor based on number of screens
      // Using a logarithmic scale to handle many screens better
      const screenCount = sources.length

      // Base settings for a single screen
      const BASE_WIDTH = 1280
      const MAX_WIDTH = 3840 // Cap at 4K width

      // Dynamic scaling that increases with number of screens but at a decreasing rate
      // For 1 screen: ~1280px, 2 screens: ~1800px, 3 screens: ~2200px, 4 screens: ~2500px, etc.
      const dynamicWidth = Math.min(
        MAX_WIDTH,
        BASE_WIDTH * (1 + Math.log(screenCount) / Math.log(2))
      )

      const scaleFactor = Math.min(1, dynamicWidth / totalWidth)
      const scaledWidth = Math.floor(totalWidth * scaleFactor)
      const scaledHeight = Math.floor(totalHeight * scaleFactor)
      // Create canvas with scaled dimensions
      const canvas = createCanvas(scaledWidth, scaledHeight)
      const ctx = canvas.getContext('2d')

      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, scaledWidth, scaledHeight)

      // Draw each screen at its correct position, scaled down
      for (let i = 0; i < Math.min(sources.length, displays.length); i++) {
        const display = displays[i]
        const bounds = display.bounds

        const img = new Image()
        const dataURL = sources[i].thumbnail.toDataURL()

        await new Promise((resolve) => {
          img.onload = resolve
          img.src = dataURL
        })

        // Draw scaled to maintain relative positions
        ctx.drawImage(
          img,
          bounds.x * scaleFactor,
          bounds.y * scaleFactor,
          bounds.width * scaleFactor,
          bounds.height * scaleFactor
        )
      }

      // Dynamic JPEG quality based on number of screens
      // More screens = slightly lower quality to keep file size manageable
      const jpegQuality = Math.max(0.4, 0.7 - (screenCount * 0.05))

      screenshot = await compressImage(
        canvas.toDataURL('image/jpeg'),
        scaledWidth, // Don't resize width
        scaledHeight, // Don't resize height
        jpegQuality  // Dynamic quality
      )
    }

    const fetch = await import('node-fetch').then(module => module.default)

    const response = await fetch(FIREBASE_CAPTURE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        timestamp: Date.now(),
        screenshot: screenshot
      })
    })
    
    if (!response.ok) {
      const errorText = await response.text()
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

// Helper function to compress an image with customizable max dimensions and quality
function compressImage(dataUrl, maxWidth = 1280, maxHeight = 800, quality = 0.6) {
  return new Promise((resolve, reject) => {
    try {
      const { createCanvas, Image } = require('canvas')
      const img = new Image()

      img.onload = () => {
        let width = img.width
        let height = img.height

        // Only resize if image exceeds the max dimensions
        if (width > maxWidth) {
          height = Math.floor(height * (maxWidth / width))
          width = maxWidth
        }

        if (height > maxHeight) {
          width = Math.floor(width * (maxHeight / height))
          height = maxHeight
        }

        // Create canvas for resized image
        const canvas = createCanvas(width, height)
        const ctx = canvas.getContext('2d')

        // Draw resized image
        ctx.drawImage(img, 0, 0, width, height)

        // Convert to JPEG with specified quality
        const compressedDataUrl = canvas.toDataURL('image/jpeg', quality)

        const originalSize = Math.round(dataUrl.length / 1024)
        const compressedSize = Math.round(compressedDataUrl.length / 1024)

        resolve(compressedDataUrl)
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