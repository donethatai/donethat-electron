const { app, Tray, Menu, BrowserWindow, nativeImage, screen, desktopCapturer } = require('electron')
const path = require('path')
const {ipcMain} = require('electron')

// Importing Firebase modules using the new modular API.
const { initializeApp, getAuth } = require('firebase/app')

const firebaseConfig = require('./firebase-config')
const firebaseApp = initializeApp(firebaseConfig)

// Add your Firebase function URL here
const FIREBASE_CAPTURE_URL = 'https://capturescreenshot-t374dqodfq-ew.a.run.app'

ipcMain.on('login', (event, token) => {
  console.log("ID Token:", token);
  idToken = token
})

ipcMain.on('logout', (event,) => {
  console.log("User logged out");
  idToken = ""
})

let tray = null
let mainWindow = null
let idToken = null
let screenshotInterval = null

app.whenReady().then(() => {
  // Setup tray icons as before.
  const iconGreenPath = path.join(__dirname, 'assets', 'iconGreenTemplate.png')
  const iconBasePath  = path.join(__dirname, 'assets', 'iconTemplate.png')

  // Create nativeImages and disable template rendering if needed.
  const greenIcon = nativeImage.createFromPath(iconGreenPath)
  greenIcon.setTemplateImage(false)
  const baseIcon = nativeImage.createFromPath(iconBasePath)
  baseIcon.setTemplateImage(true)

  // Initialize tray with the green icon.
  tray = new Tray(greenIcon)
  tray.setToolTip('Hi from Joey 👋')

  // Build the context menu.
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Open', 
      click: () => toggleWindow()
    },
    { 
      label: 'Quit', 
      click: () => app.quit()
    }
  ])
  tray.on('right-click', () => {
    tray.popUpContextMenu(contextMenu)
  })

  // Toggle tray icon on left-click (if needed).
  let isRecording = true
  tray.on('click', () => {
    if (isRecording) {
      tray.setImage(baseIcon)
      isRecording = false
      
      // Stop screenshot interval
      if (screenshotInterval) {
        clearInterval(screenshotInterval)
        screenshotInterval = null
        console.log('Screenshot recording stopped')
      }
    } else {
      tray.setImage(greenIcon)
      isRecording = true
      
      // Start screenshot interval (every 60 seconds)
      screenshotInterval = setInterval(captureAndSendScreenshot, 60000)
      console.log('Screenshot recording started')
    }
  })
  
  // Initialize screenshot recording since isRecording starts as true
  screenshotInterval = setInterval(captureAndSendScreenshot, 60000)
  console.log('Screenshot recording started')
})

// Function to create or toggle the window.
function toggleWindow() {
  if (mainWindow) {
    // Toggle window visibility.
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      showWindowBelowTray()
    }
  } else {
    // Create the window if it doesn't exist.
    mainWindow = new BrowserWindow({
      width: 500,  // Adjust size as needed.
      height: 600,
      frame: false,         // No title bar or window frame.
      resizable: false,
      movable: false,       // Optional: disable dragging if you want a popover.
      show: false,          // Start hidden and show after positioning.
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      }
    })

    // This file could be your login page that first shows the email/password
    // form. After successful sign in the UI might transition to your main app.
    // do index if user not signed in, otherwise do dashboard
    mainWindow.loadFile('./src/index.html')

    // Debug inspector
    // mainWindow.webContents.openDevTools();

    // Position the window once it's ready.
    mainWindow.once('ready-to-show', () => {
      showWindowBelowTray()
    })

    // Optional: Hide the window if it loses focus.
    mainWindow.on('blur', () => {
      if (mainWindow && mainWindow.isVisible()) {
        mainWindow.hide()
      }
    })
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

  console.log("idToken: ", idToken)

  try {
    // Get all available sources
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } })
    const mainSource = sources[0] // Get primary screen (you might want to modify this logic)
    
    if (mainSource) {
      const screenshot = mainSource.thumbnail.toDataURL()
      
      // Dynamically import node-fetch
      const fetch = await import('node-fetch').then(module => module.default)
      
      // Send screenshot to Firebase function
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
        throw new Error(`Failed to send screenshot: ${response.statusText}`)
      }
      
      console.log('Screenshot sent successfully')
    }
  } catch (error) {
    console.error('Error capturing or sending screenshot:', error)
  }
}

// Prevent app from quitting when all windows are closed.
app.on('window-all-closed', (event) => {
  event.preventDefault()
})