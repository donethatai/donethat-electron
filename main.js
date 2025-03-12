const { app, Tray, Menu, BrowserWindow, nativeImage, screen, desktopCapturer, Notification } = require('electron')
const path = require('path')
const { ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const { execSync } = require('child_process')  // Add this for Linux screenshot alternative

// Add centralized logging configuration
const log = require('electron-log')

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

// Replace console with electron-log in production
if (app.isPackaged) {
  console.log = log.info.bind(log)
  console.error = log.error.bind(log)
  console.warn = log.warn.bind(log)
  console.info = log.info.bind(log)
  console.debug = log.debug.bind(log)
}

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

let iconRecordingPath = path.join(__dirname, 'resources', 'icon_recording.png')
let iconPausedPath = path.join(__dirname, 'resources', 'icon_paused.png')
let iconErrorPath = path.join(__dirname, 'resources', 'icon_error.png')

// Configure autoUpdater
function setupAutoUpdater() {
  // Use the centralized logger
  autoUpdater.logger = log
  
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

// Modified function to capture and send screenshots with Linux-specific handling
async function captureAndSendScreenshot() {
  if (!idToken) {
    console.log('Cannot send screenshots: User not authenticated')
    return
  }

  try {
    let screenshots = []
    
    // Use different screenshot methods based on platform
    if (process.platform === 'linux') {
      // Use a Linux-specific approach to avoid permission dialogs
      screenshots = await captureScreenshotsLinux()
    } else {
      // Use Electron's desktopCapturer for Windows and macOS
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })

      if (sources.length === 0) {
        console.log('No screens detected')
        return
      }

      // Process all screenshots to proper dimensions
      screenshots = await Promise.all(
        sources.map(async (source) => {
          return await processScreenshotForUpload(source.thumbnail.toDataURL())
        })
      )
    }
    
    if (screenshots.length === 0) {
      console.log('No screenshots captured')
      return
    }

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
        screenshots: screenshots
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

// Modified function for Linux screenshot capture with multi-display support
async function captureScreenshotsLinux() {
  try {
    const fs = require('fs')
    const os = require('os')
    const tempDir = os.tmpdir()
    const screenshotPath = path.join(tempDir, `screenshot-${Date.now()}.png`)
    
    // Take a combined screenshot first
    let screenshotTool = null
    try {
      execSync('which scrot')
      screenshotTool = 'scrot'
    } catch (e) {
      try {
        execSync('which import')
        screenshotTool = 'import'
      } catch (e) {
        try {
          execSync('which gnome-screenshot')
          screenshotTool = 'gnome-screenshot'
        } catch (e) {
          log.error('No suitable screenshot tool found.')
          return []
        }
      }
    }
    
    log.debug(`Using Linux screenshot tool: ${screenshotTool}`)
    
    // Capture screenshot with the available tool
    if (screenshotTool === 'scrot') {
      execSync(`scrot -m -z "${screenshotPath}"`)
    } else if (screenshotTool === 'import') {
      execSync(`import -window root -silent "${screenshotPath}"`)
    } else if (screenshotTool === 'gnome-screenshot') {
      try {
        execSync(`gnome-screenshot --silent -f "${screenshotPath}" 2>/dev/null`)
      } catch (e) {
        try {
          execSync(`gnome-screenshot -f "${screenshotPath}" 2>/dev/null`)
        } catch (e) {
          execSync(`gnome-screenshot -f "${screenshotPath}"`)
        }
      }
    }
    
    // Read the screenshot file
    const screenshotData = fs.readFileSync(screenshotPath)
    
    // Try to get display information using xrandr
    try {
      const displays = await getLinuxDisplayInfo()
      
      if (displays.length > 1) {
        // We have multiple displays, try to crop them using nativeImage
        const results = await cropScreenshotsWithNativeImage(screenshotData, displays)
        // Clean up the temporary file
        fs.unlinkSync(screenshotPath)
        return results
      }
    } catch (err) {
      log.warn('Failed to get display info, using combined screenshot:', err)
    }
    
    // Fallback to single combined screenshot
    const base64Data = `data:image/png;base64,${screenshotData.toString('base64')}`
    
    // Clean up the temporary file
    fs.unlinkSync(screenshotPath)
    
    // Process the screenshot to the right size
    const processedImage = await processScreenshotForUpload(base64Data)
    
    // Return as array to match Windows/macOS behavior
    return [processedImage]
  } catch (error) {
    log.error('Failed to capture Linux screenshot:', error)
    return []
  }
}

// New function to get display information using xrandr
async function getLinuxDisplayInfo() {
  try {
    const output = execSync('xrandr --current').toString()
    const displays = []
    
    // Parse xrandr output to extract connected displays
    const connectedDisplays = output.match(/^(.*) connected.*/gm)
    
    if (!connectedDisplays) {
      throw new Error('No connected displays found in xrandr output')
    }
    
    for (const displayLine of connectedDisplays) {
      // Get display name and position info
      const displayName = displayLine.split(' ')[0]
      
      // Look for the resolution and position like 1920x1080+0+0
      const geometryMatch = displayLine.match(/(\d+)x(\d+)\+(\d+)\+(\d+)/)
      
      if (geometryMatch) {
        displays.push({
          name: displayName,
          width: parseInt(geometryMatch[1]),
          height: parseInt(geometryMatch[2]),
          x: parseInt(geometryMatch[3]),
          y: parseInt(geometryMatch[4])
        })
      }
    }
    
    return displays
  } catch (error) {
    log.error('Error getting display info:', error)
    return []
  }
}

// New function to crop screenshots using Electron's nativeImage
async function cropScreenshotsWithNativeImage(imageBuffer, displays) {
  try {
    const results = []
    
    // Create nativeImage from buffer
    const fullImage = nativeImage.createFromBuffer(imageBuffer)
    
    for (const display of displays) {
      const { width, height, x, y } = display
      
      // Crop the image for this display
      const croppedImage = fullImage.crop({ x, y, width, height })
      
      // Convert to data URL
      const dataUrl = croppedImage.toDataURL()
      
      // Process the cropped screenshot
      const processedImage = await processScreenshotForUpload(dataUrl)
      results.push(processedImage)
    }
    
    return results
  } catch (error) {
    log.error('Error cropping screenshots:', error)
    // Fall back to processing the full image
    const dataUrl = nativeImage.createFromBuffer(imageBuffer).toDataURL()
    const processedImage = await processScreenshotForUpload(dataUrl)
    return [processedImage]
  }
}

// Modified checkScreenCapturePermission function
async function checkScreenCapturePermission() {
  try {
    // For Linux, we'll check if we have one of the screenshot tools available
    if (process.platform === 'linux') {
      try {
        // Try to detect if any screenshot tool is available
        execSync('which gnome-screenshot || which scrot || which import')
        hasScreenCapturePermission = true
        return true
      } catch (e) {
        console.error('No screenshot tools available on Linux')
        hasScreenCapturePermission = false
        return false
      }
    }
    
    // For other platforms, use the existing method
    await new Promise(resolve => setTimeout(resolve, 500))
    
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false
    })
    
    if (sources && sources.length > 0) {
      hasScreenCapturePermission = true
      return true
    }
    
    hasScreenCapturePermission = false
    return false
  } catch (error) {
    console.error('Error checking screen capture permission:', error)
    hasScreenCapturePermission = false
    return false
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
  if (process.platform === 'darwin') {
    // macOS menu bar icons should be 18-22px
    trayIcon = trayIcon.resize({ width: 18, height: 18 })
  }
  
  tray = new Tray(trayIcon)
  tray.setToolTip('Done That')

  // Check screen capture permission
  hasScreenCapturePermission = await checkScreenCapturePermission()

  // Initial state - update icon after tray is created
  updateTrayIcon(false)

  // Platform-specific tray click handlers
  if (process.platform === 'linux') {
    // For Linux: Set a persistent context menu and don't handle left-click
    const contextMenu = buildContextMenu()
    tray.setContextMenu(contextMenu)
    // No click handler - all functionality is in the context menu
  } else {
    // Windows & macOS: Use separate events
    tray.on('click', () => {
      toggleWindow()
    })
    
    tray.on('right-click', () => {
      const contextMenu = buildContextMenu()
      tray.popUpContextMenu(contextMenu)
    })
  }

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

// Separate window creation from showing
function createWindow() {
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: debug ? 600 : 250,
      height: debug ? 600 : 400,
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

// Simplified function to process screenshots using only Electron's nativeImage
async function processScreenshotForUpload(dataUrl) {
  try {
    // Convert data URL to buffer
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Create native image from buffer
    let img = nativeImage.createFromBuffer(buffer);
    
    // Get original dimensions
    const { width, height } = img.getSize();
    
    // Calculate new dimensions with 819px constraint on shorter edge
    let newWidth = width;
    let newHeight = height;
    const targetShortEdge = 819;
    
    if (width < height) {
      // Width is shorter
      if (width > targetShortEdge) {
        const aspectRatio = height / width;
        newWidth = targetShortEdge;
        newHeight = Math.round(newWidth * aspectRatio);
      }
    } else {
      // Height is shorter
      if (height > targetShortEdge) {
        const aspectRatio = width / height;
        newHeight = targetShortEdge;
        newWidth = Math.round(newHeight * aspectRatio);
      }
    }
    
    // Resize image if needed
    if (newWidth !== width || newHeight !== height) {
      img = img.resize({ width: newWidth, height: newHeight });
    }
    
    // Convert to JPEG with 70% quality
    const jpegOptions = { quality: 70 };
    const jpegBuffer = img.toJPEG(jpegOptions.quality);
    
    // Convert back to data URL
    return `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
  } catch (error) {
    console.error('Error processing screenshot:', error);
    // Return original as fallback
    return dataUrl;
  }
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