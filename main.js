const { app, Tray, Menu, BrowserWindow, nativeImage, screen, desktopCapturer, Notification } = require('electron')
const path = require('path')
const { ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const { execSync } = require('child_process')  // Add this for Linux screenshot alternative

// To show dev tools next to main window
let debug = false  // Change this to true for debugging

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

// Add debug notifications based on debug flag, not packaging
if (debug) {
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
if (app.isPackaged && !debug) {
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
    log.warn('Cannot send screenshots: User not authenticated');
    return;
  }

  try {
    let screenshots = []
    
    // Use different screenshot methods based on platform
    if (process.platform === 'linux') {
      log.info('Using Linux screenshot method');
      screenshots = await captureScreenshotsLinux()
    } else {
      log.info('Using Electron desktopCapturer');
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })

      if (sources.length === 0) {
        log.warn('No screens detected');
        return;
      }

      log.info(`Found ${sources.length} screen(s)`);

      // Process all screenshots to proper dimensions
      screenshots = await Promise.all(
        sources.map(async (source) => {
          log.info(`Processing screenshot from source: ${source.name}`);
          return await processScreenshotForUpload(source.thumbnail.toDataURL());
        })
      )
    }
    
    if (screenshots.length === 0) {
      log.warn('No screenshots captured');
      return;
    }

    log.info(`Captured ${screenshots.length} screenshot(s), preparing to upload...`);

    const fetch = await import('node-fetch').then(module => module.default);

    log.info('Sending screenshots to server...');
    
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
    });
    
    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }
    
    log.info('Screenshots uploaded successfully');
  } catch (error) {
    log.error('Screenshot error:', error.message, error.stack);
    
    // If it's an auth error, clear the token to force re-login
    if (error.message.includes('401') || error.message.includes('403')) {
      idToken = null;
      if (mainWindow) {
        mainWindow.webContents.send('auth-error');
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
    
    // Define screenshot tools to try (excluding gnome-screenshot and import)
    const tools = [
      { name: 'scrot', cmd: `scrot -m -z "${screenshotPath}"` },
      { name: 'maim', cmd: `maim "${screenshotPath}"` },             // Alternative modern tool
      { name: 'spectacle', cmd: `spectacle -b -n -o "${screenshotPath}"` }, // KDE screenshot tool
      { name: 'flameshot', cmd: `flameshot full -p "${screenshotPath}"` }   // Another alternative
    ]
    
    for (const tool of tools) {
      try {
        // Check if tool exists
        execSync(`which ${tool.name}`)
        
        log.info(`Using ${tool.name} for screenshot: ${tool.cmd}`)
        execSync(tool.cmd, { timeout: 5000 })
        
        // Check if screenshot was taken successfully
        if (fs.existsSync(screenshotPath)) {
          const stats = fs.statSync(screenshotPath)
          log.info(`Screenshot file size: ${stats.size} bytes`)
          
          if (stats.size > 0) {
            const screenshotData = fs.readFileSync(screenshotPath)
            const base64Data = `data:image/png;base64,${screenshotData.toString('base64')}`
            fs.unlinkSync(screenshotPath)
            
            // Try to detect multiple displays
            try {
              // Get display information using xrandr
              const displays = await getLinuxDisplays()
              
              if (displays.length > 1) {
                // If we have multiple displays, try to split the screenshot
                // Convert base64 to buffer for nativeImage
                const imageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64')
                
                // Use Electron's nativeImage to crop the screenshots
                const croppedImages = await cropScreenshotsWithNativeImage(imageBuffer, displays)
                return croppedImages
              }
            } catch (e) {
              log.info(`Failed to process multi-display: ${e.message}, using full screenshot`)
            }
            
            // If multi-display handling fails or there's only one display,
            // process the single full screenshot
            const processedImage = await processScreenshotForUpload(base64Data)
            return [processedImage]
          } else {
            log.info(`${tool.name} created an empty file, trying next tool`)
          }
        } else {
          log.info(`${tool.name} did not create a file, trying next tool`)
        }
      } catch (e) {
        log.info(`${tool.name} failed: ${e.message}`)
        // Continue to next tool
      }
    }
    
    // If we got here, all tools failed
    log.error('No screenshot tools were successful. Please install scrot: sudo apt-get install scrot. Fallbacks are maim, kde-spectacle, flameshot, or shutter.')
    return []
  } catch (error) {
    log.error('Failed to capture Linux screenshot:', error)
    return []
  }
}

// Helper function to get display information on Linux
async function getLinuxDisplays() {
  try {
    // Try to get display info using xrandr
    const xrandrOutput = execSync('xrandr --current').toString()
    const displays = []
    
    // Parse xrandr output to find connected displays
    const displayRegex = /(\S+) connected.*?(\d+)x(\d+)\+(\d+)\+(\d+)/g
    let match
    
    while ((match = displayRegex.exec(xrandrOutput)) !== null) {
      const [, name, width, height, x, y] = match
      displays.push({
        name,
        width: parseInt(width, 10),
        height: parseInt(height, 10),
        x: parseInt(x, 10),
        y: parseInt(y, 10)
      })
      
      if (debug) log.info(`Detected display: ${name} ${width}x${height}+${x}+${y}`)
    }
    
    return displays
  } catch (error) {
    if (debug) log.info(`Failed to get display information: ${error.message}`)
    // Return a default display if xrandr fails
    return [{ name: 'default', width: 1920, height: 1080, x: 0, y: 0 }]
  }
}

// Modified function to crop screenshots using Electron's nativeImage
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
      // Linux - include the --no-sandbox flag which is often needed
      app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
        args: ['--no-sandbox']
      });
      
      log.info('Linux autostart configured with path:', process.execPath, 'with --no-sandbox flag');
    }
    
    // After update is installed, this will run again with the new executable path
    // when the app restarts, ensuring the autostart always points to latest version
  } catch (error) {
    log.error('Failed to configure autostart:', error);
  }
}

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