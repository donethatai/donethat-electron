const { app, ipcMain, Tray, Menu, BrowserWindow, nativeImage, screen, Notification, powerMonitor } = require('electron')
const path = require('path')
const { autoUpdater } = require('electron-updater')
const log = require('electron-log')
const {
  checkScreenCapturePermission: moduleCheckPermission,
  getWaylandStatus
} = require('./src-main/captureScreenshots')
const { 
  startCaptureInterval, 
  stopCaptureInterval, 
  isCapturing,
  setCaptureInterval,
  initCapture
} = require('./src-main/capture')
const { initState } = require('./src-main/main-state')

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
  // Instead of showing a dialog, bring the existing window to foreground
  if (mainWindow) {
    // If window exists but is hidden, show it
    if (!mainWindow.isVisible()) {
      showWindowBelowTray();
    } else {
      // Focus the window to bring it to foreground
      mainWindow.focus();
    }
  }
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

// Update screenshot interval logic
let SCREENSHOT_INTERVAL_MINUTES = 5; // Default to 5 minutes for release
// Set interval based on whether it's development or production
if (!app.isPackaged) {
  SCREENSHOT_INTERVAL_MINUTES = 5; // Every minute for development
}
// Set interval in the capture module
setCaptureInterval(SCREENSHOT_INTERVAL_MINUTES);

let iconRecordingPath = path.join(__dirname, 'resources', 'icon_recording.png')
let iconPausedPath = path.join(__dirname, 'resources', 'icon_paused.png')
let iconErrorPath = path.join(__dirname, 'resources', 'icon_error.png')
// State module and variables
let stateManager = null
let tray = null
let mainWindow = null
let screenshotInterval = null

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

////// AUTOUPDATER /////

// Configure autoUpdater
function setupAutoUpdater() {
  // Use the centralized logger
  autoUpdater.logger = log

  // Add configuration for GitHub provider
  autoUpdater.allowPrerelease = false
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = app.isPackaged; // Only install on quit in packaged app
  autoUpdater.forceDevUpdateConfig = true; // Force check in dev mode

  // Set the correct channel based on the current architecture
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  autoUpdater.channel = arch

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info.version)

    if (app.isPackaged) {
      // Different update strategies per platform
      if (process.platform === 'win32') {
        // Windows - only use notifications, NEVER silent install
        log.info('Windows platform: using notification-based update');
        
        // Show notification for user to manually install
        const notification = new Notification({
          title: 'DoneThat Update',
          body: 'An update is ready. Click to install now. You may see a windows prompt to confirm.',
          silent: false
        });
        
        notification.on('click', () => {
          log.info('Update notification clicked, installing update');
          autoUpdater.quitAndInstall(false, true);
        });
        
        notification.show();
        
        // Force update after 30 minutes if notification was missed/disabled
        const currentVersion = app.getVersion();
        setTimeout(() => {
          // Check if we're still running the old version
          if (app.getVersion() === currentVersion) {
            log.info('Update not installed after 30 minutes, forcing silent update');
            autoUpdater.quitAndInstall(false, true);
          }
        }, 30 * 60 * 1000); // 30 minutes
      } else if (process.platform === 'linux') {
        // Linux - show dialog, never silent install
        log.info('Linux platform: using dialog-based update');
        
        const { dialog } = require('electron');
        dialog.showMessageBox({
          type: 'info',
          title: 'DoneThat Update Available',
          message: `A new version (${info.version}) is available and has been downloaded.`,
          detail: 'You will need to manually restart DoneThat after the update is installed.',
          buttons: ['Cancel', 'Install Update'],
          cancelId: 0,
          defaultId: 1
        }).then(({ response }) => {
          if (response === 1) { // Install Update
            log.info('Update dialog approved, installing update');
            autoUpdater.quitAndInstall(false, false);
          } else {
            log.info('Update dialog canceled by user');
          }
        }).catch(err => {
          log.error('Error showing update dialog:', err);
        });
      } else {
        // macOS - use the original silent install approach
        log.info('macOS platform: using silent update');
        setTimeout(() => {
          log.info('Executing quitAndInstall() for macOS');
          app.isQuitting = true; // Explicitly set this flag to prevent event.preventDefault in close handlers
          autoUpdater.quitAndInstall();
        }, 1000); // 1 second delay
      }
    } else {
      log.info('Development mode: skipping update installation');
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
  // Initialize the state manager with necessary callbacks
  stateManager = await initState({
    checkRecording: checkAndAdjustRecording, // for pause state changes
    navigateToView: navigateToView // for notifications
  });

  // Create application menu
  createApplicationMenu();
  
  // Register for auth state change events from renderer
  ipcMain.on('auth-state-changed', (event, isAuthenticated) => {
    createApplicationMenu(); // Update menu on auth state change
  });

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
  await checkScreenCapturePermission()
  
  // Initial state check and schedule daily check
  checkAndAdjustRecording();

  // --- Add powerMonitor listener here ---
  powerMonitor.on('resume', () => {
    // Clear the potentially delayed timeout from before sleep
    if (stateManager) {
        stateManager.resume();
    }
    // Immediately check the state and schedule the *next* check
    checkAndAdjustRecording();
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
    setupAutoUpdater();
    scheduleUpdateChecks();

  } catch (error) {
    log.error('Error setting up updater:', error);
  }

  // Also check permissions when the app is activated
  app.on('activate', async () => {
    await checkScreenCapturePermission();

    log.warn(`A Sending permission check result: hasPermission=${stateManager?.hasScreenCapturePermission()}, isWaylandSession=${stateManager?.isWaylandSession()}`);

    if (mainWindow) {
      mainWindow.webContents.send('screenCapturePermission', {
        hasPermission: stateManager?.hasScreenCapturePermission(),
        isWaylandSession: stateManager?.isWaylandSession()
      });
    }
  });

  // Add daily auth check
  scheduleDailyAuthCheck();
})

// Handle OS-level quit events properly - especially important for macOS
app.on('before-quit', () => {
  // Flag that we're actually quitting, not just closing windows
  app.isQuitting = true;

  // Clean up resources
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
  }
  
  // Clean up state (timeouts and save pause state if needed)
  stateManager?.cleanupOnQuit();
})

////// TRAY /////

// Function to update the tray icon based on recording state
function updateTrayIcon(isActuallyRecording) {
  // Safety check - ensure tray exists before trying to update it
  if (!tray) {
    return
  }

  let iconPath;
  let tooltip;

  const loggedIn = stateManager?.isAuthenticated() ?? false;
  const isPaused = stateManager?.isPaused() ?? false;
  const hasPermission = stateManager?.hasScreenCapturePermission() ?? false;

  if (isActuallyRecording) {
    iconPath = iconRecordingPath;
    tooltip = 'DoneThat - Recording';
  } else if (!hasPermission) {
    iconPath = iconErrorPath;
    tooltip = 'DoneThat - No Screen Capture Permission';
  } else if (!loggedIn) {
    iconPath = iconErrorPath;
    tooltip = 'DoneThat - Not Logged In';
  } else if (isPaused) {
    iconPath = iconPausedPath;
    tooltip = 'DoneThat - Paused';
  } else {
    // Default fallback
    iconPath = iconErrorPath;
    tooltip = 'DoneThat - Error';
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
  // Only show/position window if it's not already visible
  if (!mainWindow.isVisible()) {
    showWindowBelowTray();
  } else {
    mainWindow.focus();
  }
  mainWindow.webContents.send('navigate', viewName);
}

// Function to create application menu with Help option and context menu options
function createApplicationMenu() {
  const isLoggedIn = stateManager?.isAuthenticated() ?? false;
  const isPaused = stateManager?.isPaused() ?? false;
  const hasPermission = stateManager?.hasScreenCapturePermission() ?? false;
  
  const template = [];
  
  // File menu
  const fileMenu = {
    label: 'File',
    submenu: [
      {
        label: 'Home',
        click: () => navigateToView('signup-next')
      },
      {
        label: 'Settings',
        click: () => navigateToView('settings'),
        enabled: isLoggedIn
      },
      { type: 'separator' },
      {
        label: 'Web Portal',
        click: () => {
          const { shell } = require('electron');
          shell.openExternal('https://app.donethat.ai');
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        accelerator: 'CmdOrCtrl+Q',
        click: () => app.quit()
      }
    ]
  };
  
  // Recording menu
  const recordingMenu = {
    label: 'Recording',
    submenu: [
      {
        label: 'Pause for 5 minutes',
        click: () => stateManager?.pauseRecording(5 * 60 * 1000, mainWindow),
        enabled: isLoggedIn && !isPaused && hasPermission
      },
      {
        label: 'Pause for 15 minutes',
        click: () => stateManager?.pauseRecording(15 * 60 * 1000, mainWindow),
        enabled: isLoggedIn && !isPaused && hasPermission
      },
      {
        label: 'Pause for 30 minutes',
        click: () => stateManager?.pauseRecording(30 * 60 * 1000, mainWindow),
        enabled: isLoggedIn && !isPaused && hasPermission
      },
      {
        label: 'Pause for 1 hour',
        click: () => stateManager?.pauseRecording(60 * 60 * 1000, mainWindow),
        enabled: isLoggedIn && !isPaused && hasPermission
      },
      {
        label: 'Pause for today',
        click: () => stateManager?.pauseUntilNextWorkPeriod(mainWindow),
        enabled: isLoggedIn && !isPaused && hasPermission
      },
      {
        label: 'Resume',
        click: () => startRecording(),
        enabled: isLoggedIn && isPaused && hasPermission
      }
    ]
  };
  
  // Account menu
  const accountMenu = {
    label: 'Account',
    submenu: [
      {
        label: 'Logout',
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.send('logout');
          }
        },
        enabled: isLoggedIn
      }
    ]
  };
  
  // Help menu
  const helpMenu = {
    label: 'Help',
    submenu: [
      {
        label: 'Support',
        click: () => {
          const { shell } = require('electron');
          shell.openExternal('https://donethat.ai/support');
        }
      }
    ]
  };
  
  // Push menus to template
  template.push(fileMenu, recordingMenu, accountMenu, helpMenu);
  
  // Set as application menu
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Update context menu build function to also update application menu
function buildContextMenu() {
  const isLoggedIn = stateManager?.isAuthenticated() ?? false;
  const isPaused = stateManager?.isPaused() ?? false;
  const hasPermission = stateManager?.hasScreenCapturePermission() ?? false;

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
      click: () => stateManager?.pauseRecording(5 * 60 * 1000, mainWindow),
      enabled: isLoggedIn && !isPaused && hasPermission
    },
    {
      label: 'Pause for 15 minutes',
      click: () => stateManager?.pauseRecording(15 * 60 * 1000, mainWindow),
      enabled: isLoggedIn && !isPaused && hasPermission
    },
    {
      label: 'Pause for 30 minutes',
      click: () => stateManager?.pauseRecording(30 * 60 * 1000, mainWindow),
      enabled: isLoggedIn && !isPaused && hasPermission
    },
    {
      label: 'Pause for 1 hour',
      click: () => stateManager?.pauseRecording(60 * 60 * 1000, mainWindow),
      enabled: isLoggedIn && !isPaused && hasPermission
    },
    {
      label: 'Pause for today',
      click: () => stateManager?.pauseUntilNextWorkPeriod(mainWindow),
      enabled: isLoggedIn && !isPaused && hasPermission
    },
    {
      label: 'Resume',
      click: () => startRecording(),
      enabled: isLoggedIn && isPaused && hasPermission
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

  // After building the context menu, also refresh the application menu
  createApplicationMenu();
  
  return Menu.buildFromTemplate(template)
}

// Central function to evaluate and adjust recording state based on all factors
function checkAndAdjustRecording() {
    const isCurrentlyRecording = isCapturing();

    // Determine if we should be recording based on current conditions
    const isAuthenticated = stateManager?.isAuthenticated();
    const hasPermission = stateManager?.hasScreenCapturePermission();
    const isPaused = stateManager?.isPaused();
    const shouldBeRecording = isAuthenticated && hasPermission && !isPaused;

    // to capture some cases where auth is loaded later
    // but not recording it's not triggering above function because
    // isCurrentlyRecording is false
    updateTrayIcon(isCurrentlyRecording && shouldBeRecording);
    
    // Update application menu when recording state changes
    createApplicationMenu();

    // Regular start/stop logic
    if (isCurrentlyRecording && !shouldBeRecording) {
      stopRecording();
    } else if (!isCurrentlyRecording && shouldBeRecording) {
      startRecording();
    }
}

// Add IPC handler for resume action
ipcMain.on('resumeRecording', (event) => {
  startRecording();
  createApplicationMenu(); // Update menu after resume
});

////// WINDOWS /////

// Separate window creation from showing
function createWindow() {
  if (!mainWindow) {
    // Platform-specific window configurations
    const isPlatformMac = process.platform === 'darwin';
    const windowWidth = DEBUG ? 600 : (isPlatformMac ? 250 : 300); // Wider for Win/Linux
    const windowHeight = DEBUG ? 600 : (isPlatformMac ? 420 : 475); // Slightly taller for Win/Linux
    
    mainWindow = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      // Add frame on Linux/Windows, keep frameless on macOS
      frame: !isPlatformMac,
      resizable: false, // No resizing on any platform
      // Make window movable on Linux/Windows, keep it fixed on macOS
      movable: !isPlatformMac,
      show: false,
      skipTaskbar: true, // Hide from taskbar on all platforms
      fullscreenable: false, // Prevent full screen toggle
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
    mainWindow.webContents.on('console-message', (event) => {
      console.log('Renderer Console:', event.message);
    });

    // Position the window once it's ready.
    mainWindow.once('ready-to-show', () => {
      mainWindow.webContents.send('screenCapturePermission', {
        hasPermission: stateManager?.hasScreenCapturePermission(),
        isWaylandSession: stateManager?.isWaylandSession()
      });
      
      // Initialize capture with auth error handler
      initCapture(mainWindow, handleCaptureAuthErrors, stateManager.getIdToken);
    })

    // Only auto-hide on blur for macOS (popup style)
    mainWindow.on('blur', () => {
      if (process.platform === 'darwin' && mainWindow && mainWindow.isVisible()) {
        mainWindow.hide()
      }
    })
    
    // Handle close event for Windows/Linux - don't quit the app, just hide the window
    mainWindow.on('close', (event) => {
      // Prevent window from being closed completely if not quitting the app
      if (!app.isQuitting) {
        event.preventDefault();
        mainWindow.hide();
        return false;
      }
      return true;
    });
  }
}

// Intelligently positions the window relative to the tray icon
// with support for multiple displays
function showWindowBelowTray() {
  const isPlatformMac = process.platform === 'darwin';
  
  // Get window size
  const windowBounds = mainWindow.getBounds();
  
  // Get tray icon bounds
  const trayBounds = tray.getBounds();
  
  // Get all displays
  const allDisplays = screen.getAllDisplays();
  
  // Find which display contains the tray icon
  const trayDisplay = allDisplays.find(display => {
    const { x, y, width, height } = display.bounds;
    return (
      trayBounds.x >= x && trayBounds.x < x + width &&
      trayBounds.y >= y && trayBounds.y < y + height
    );
  }) || screen.getPrimaryDisplay(); // Fall back to primary if not found
  
  // For Windows, use the built-in center method which is more reliable
  if (process.platform === 'win32') {
    mainWindow.center();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  
  // Use the working area of the display containing the tray
  const { workArea } = trayDisplay;
  
  let x, y;
  
  // Linux positioning logic
  if (process.platform === 'linux') {
    // Center in the display - calculate with integer positions
    x = Math.floor(workArea.x + (workArea.width / 2) - (windowBounds.width / 2));
    y = Math.floor(workArea.y + (workArea.height / 2) - (windowBounds.height / 2));
    
    // If we have valid tray bounds, try to position near it
    if (trayBounds.width > 0 && trayBounds.height > 0) {
      // Position at the bottom of the screen if the tray appears to be at the bottom
      // Common for panels at bottom of screen
      if (trayBounds.y > workArea.y + (workArea.height / 2)) {
        y = Math.floor(workArea.y + workArea.height - windowBounds.height - 50); // 50px buffer
      } else {
        // Otherwise position at top with offset
        y = Math.floor(workArea.y + 50);
      }
    }
  } else {
    // Position relative to tray for macOS
    // Calculate x position: center window horizontally relative to the tray icon
    x = Math.floor(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
    
    // For macOS, determine if tray is closer to top or bottom of display
    const distanceToTop = trayBounds.y - workArea.y;
    const distanceToBottom = (workArea.y + workArea.height) - (trayBounds.y + trayBounds.height);
    
    if (distanceToTop < distanceToBottom) {
      // Tray is closer to top - position window below tray
      y = Math.floor(trayBounds.y + trayBounds.height);
    } else {
      // Tray is closer to bottom - position window above tray
      y = Math.floor(trayBounds.y - windowBounds.height);
    }
  }
  
  // Ensure window doesn't go off-screen horizontally
  x = Math.floor(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - windowBounds.width)));
  
  // Ensure window doesn't go off-screen vertically
  y = Math.floor(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - windowBounds.height)));
  
  mainWindow.setPosition(x, y, false);
  mainWindow.show();
  mainWindow.focus(); // Ensure window gets focus
}

// Modify the window-all-closed handler to respect system quit
app.on('window-all-closed', (event) => {
  // Only prevent default if we're not in the quit process
  if (!app.isQuitting) {
    event.preventDefault();
  }
  // Otherwise let the app quit normally
});

// Update the focus handler to use state manager
app.on('browser-window-focus', async () => {
  const oldPermission = stateManager?.hasScreenCapturePermission() ?? false;
  await checkScreenCapturePermission();

  // Only send update if permission status actually changed
  if (oldPermission !== stateManager?.hasScreenCapturePermission() && mainWindow) {
    // Use the state manager values
    mainWindow.webContents.send('screenCapturePermission', {
      hasPermission: stateManager?.hasScreenCapturePermission(),
      isWaylandSession: stateManager?.isWaylandSession()
    });

    // Re-evaluate recording state based on permission change
    checkAndAdjustRecording();
  }
});

////// INPUT DATA ////

function startRecording() {
  if (!stateManager?.isAuthenticated()) {
    return;
  }

  startCaptureInterval(); // Call without token

  stateManager?.recordingStarted(mainWindow);
  
  updateTrayIcon(true) // Show recording state
  createApplicationMenu(); // Update menu when recording starts

  if (mainWindow) {
    mainWindow.webContents.send('pauseStateChanged', false)
    mainWindow.webContents.send('analytics-event', { 
      eventName: 'recording_state_changed',
      eventParams: { status: 'started' } 
    })
  }
}

// Stops the interval and updates the icon
function stopRecording() {
  // Stop the capture interval and all captures
  stopCaptureInterval();

  // Don't need to call recordingStopped in state as
  // This is either handled by pause (already in state)
  // or by permissions (already in state)

  updateTrayIcon(false) // Update icon to non-recording state
  createApplicationMenu(); // Update menu when recording stops
  
  // Send state updates
  if (mainWindow) {
    mainWindow.webContents.send('pauseStateChanged', true)
    mainWindow.webContents.send('analytics-event', { 
      eventName: 'recording_state_changed',
      eventParams: { status: 'stopped' } 
    })
  }
}

// Function to check screen capture permission
async function checkScreenCapturePermission() {
  // Get current permission status from OS-level APIs
  const hasPermission = await moduleCheckPermission();
  const waylandStatus = getWaylandStatus();
  
  // Update the state manager with current values
  if (stateManager) {
    stateManager.updateScreenCapturePermission(hasPermission);
    stateManager.updateWaylandStatus(waylandStatus);
  } else {
    log.warn('State manager not initialized, cannot update screen capture permission');
  }
  
  // Update application menu when permission changes
  createApplicationMenu();
  
  return hasPermission;
}

// Also update the explicit permission check handler
ipcMain.on('checkScreenCapturePermission', async () => {
  await checkScreenCapturePermission();

  if (mainWindow) {
    // Send both permission status and session type from state manager
    mainWindow.webContents.send('screenCapturePermission', {
      hasPermission: stateManager?.hasScreenCapturePermission(),
      isWaylandSession: stateManager?.isWaylandSession()
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

    const oldPermission = stateManager?.hasScreenCapturePermission();
    await checkScreenCapturePermission();

    if (stateManager?.hasScreenCapturePermission() !== oldPermission && mainWindow) { // Check if permission *changed*
      mainWindow.webContents.send('screenCapturePermission', {
        hasPermission: stateManager?.hasScreenCapturePermission(),
        isWaylandSession: stateManager?.isWaylandSession()
      });

      // Re-evaluate recording state based on permission change
      checkAndAdjustRecording();
    }
  };
  
  app.on('browser-window-focus', focusListener);
})

/**
 * Handles authentication errors reported by the capture module
 * @param {Object} result - Authentication error object
 * @param {boolean} [result.authError] - True if there was a general authentication error
 * @param {boolean} [result.tokenExpired] - True if the authentication token has expired
 */
function handleCaptureAuthErrors(result) {
  // Handle auth error
  if (result && result.authError) {
    // This will be treated as non-critical and will trigger a retry
    // Because triggered in capture.js when there is no token
    // If creating token is the issue, then another error will be triggered
    // and that will be treated as critical and will logout
    if (mainWindow) {
      mainWindow.webContents.send('auth-error', {
        code: 'auth/capture-auth-error',
        message: 'Authentication error during capture'
      });
    }
  }
  
  // Handle token expired error
  if (result && result.tokenExpired) {
    // Request token refresh from renderer process
    if (mainWindow) {
      mainWindow.webContents.send('refresh-token');
    }
  }
}

ipcMain.on('initialAuthCheck', (event, isAuthenticated) => {
  if (!stateManager?.isAuthenticated()) {
    // If user is not authenticated, show the window
    showWindowBelowTray();
  }
  createApplicationMenu(); // Update menu after auth check
});

// Add this function before app.whenReady()
function scheduleDailyAuthCheck() {
  // Calculate time until 10 AM today or tomorrow
  const now = new Date();
  const checkTime = new Date(now);
  checkTime.setHours(10, 0, 0, 0);
  
  if (now > checkTime) {
    // If it's past 10 AM, schedule for tomorrow
    checkTime.setDate(checkTime.getDate() + 1);
  }
  
  const timeUntilCheck = checkTime.getTime() - now.getTime();
  
  // Schedule the check
  setTimeout(() => {
    // Check if user is not authenticated
    if (!stateManager?.isAuthenticated()) {
      new Notification({
        title: 'DoneThat Not Logged In',
        body: 'You are not logged in to DoneThat. Please log in to continue tracking your work.',
        silent: false,
        urgency: 'critical'
      }).show();
    }
    
    // Schedule next check
    scheduleDailyAuthCheck();
  }, timeUntilCheck);
}