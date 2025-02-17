const { app, Tray, Menu, BrowserWindow, nativeImage, screen } = require('electron')
const path = require('path')

// Importing Firebase modules using the new modular API.
const { initializeApp } = require('firebase/app')
const { 
  getAuth, 
  onAuthStateChanged, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  sendPasswordResetEmail 
} = require('firebase/auth')

const firebaseConfig = require('./firebase-config')
const firebaseApp = initializeApp(firebaseConfig)
const auth = getAuth(firebaseApp)

function signUp(email, password) {
  createUserWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      console.log("User signed up:", userCredential.user)
      // You can now transition your UI to the signed-in state.
    })
    .catch((error) => {
      console.error("Error during signup:", error.message)
      // Handle the error (e.g., notify the user).
    })
}

function signIn(email, password) {
  signInWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      console.log("User signed in:", userCredential.user)
      // Transition your interface into the signed-in state.
    })
    .catch((error) => {
      console.error("Error during sign in:", error.message)
      // Handle the error (e.g., notify the user).
    })
}

function passwordReset(email) {
  sendPasswordResetEmail(auth, email)
    .then(() => {
      console.log("Password reset email sent to:", email)
      // Inform the user to check their email.
    })
    .catch((error) => {
      console.error("Error sending password reset email:", error.message)
      // Handle the error accordingly.
    })
}

// Monitor the authentication state.
onAuthStateChanged(auth, (user) => {
  if (user) {
    console.log("User is already signed in:", user)
    // Proceed with your app's main logic.
  } else {
    console.log("No user is signed in. Please sign in or sign up with your email and password.")
    // TODO: Trigger your login/signup UI here.
    // For example, you might open a dedicated login window which collects the
    // user's email & password and then calls signUp(), signIn(), or passwordReset().
  }
})

let tray = null
let mainWindow = null

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
    } else {
      tray.setImage(greenIcon)
      isRecording = true
    }
  })
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
        contextIsolation: false
      }
    })

    // This file could be your login page that first shows the email/password
    // form. After successful sign in the UI might transition to your main app.
    mainWindow.loadFile('index.html')
    mainWindow.webContents.openDevTools();

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

// Prevent app from quitting when all windows are closed.
app.on('window-all-closed', (event) => {
  event.preventDefault()
})