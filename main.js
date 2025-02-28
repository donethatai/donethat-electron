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
  
  // Check if user is logged in, if not open the window automatically
  if (!idToken) {
    toggleWindow()
    console.log('Window opened automatically - user not logged in')
  }
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
      width: 250, 
      height: 400,
      frame: false,
      resizable: false,
      movable: false,
      show: false,
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
      console.log(`Merging ${sources.length} screens into one screenshot`)
      
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
      
      console.log(`Using dynamic resolution: ${scaledWidth}x${scaledHeight} for ${screenCount} screens`)
      
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
      throw new Error(`Failed to send screenshot: ${response.statusText}`)
    }
    
    console.log('Screenshot sent successfully')
  } catch (error) {
    console.error('Error capturing or sending screenshot:', error)
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
        console.log(`Image compressed: ${originalSize}KB → ${compressedSize}KB (${Math.round((1 - compressedSize/originalSize) * 100)}% reduction)`)
        
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

// Prevent app from quitting when all windows are closed.
app.on('window-all-closed', (event) => {
  event.preventDefault()
})