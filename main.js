// Suppress ONNX runtime warnings - must be set before any imports

process.env.ORT_LOGGING_LEVEL = '4'
process.env.ORT_LOGGING_VERBOSE = '0'

const { app, ipcMain, Tray, Menu, BrowserWindow, nativeImage, screen, Notification, powerMonitor, globalShortcut } = require('electron')
const path = require('path')
const { autoUpdater } = require('electron-updater')
const log = require('electron-log')
const {
  checkScreenCapturePermission: moduleCheckPermission,
  getWaylandStatus,
  initScreenCapturePermissionHandling
} = require('./src-main/captureScreenshots')
const { initWindowsPermissionHandling } = require('./src-main/captureWindows')

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
  // Check if the app was launched with a URL (for Google SSO)
  const url = commandLine.find(arg => arg.startsWith('donethat://'));
  if (url) {
    try {
      const urlObj = new URL(url);
      const token = urlObj.searchParams.get('token');
      if (token) {
        enqueueDeepLinkToken(token);
      }
    } catch (error) {
      log.error('Error parsing URL in second-instance:', error);
    }
  }

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
  // Also ensure overlay is shown (only if authenticated)
  try {
    if (stateManager?.isAuthenticated()) {
      if (!overlayWindow || overlayWindow.isDestroyed()) {
        createOverlayWindow();
      }
      showOverlayOnCurrentSpace();
    }
  } catch (e) {}
});

// Handle macOS reactivation (when user clicks dock icon or reopens app)
app.on('activate', () => {
  log.info('App activated');
  // Open dashboard instead of showing tray dropdown
  try { navigateToView('dashboard') } catch (e) {}
});

// To show dev tools next to main window
let DEBUG = false

// Global hotkey configuration (suffix only, final character)
let HOTKEY_SUFFIX = 'D' // default
let lastRegisteredAccelerator = null;

function getHotkeyAccelerator() {
  const suffix = String(HOTKEY_SUFFIX || 'D').trim().slice(-1).toUpperCase();
  return `CommandOrControl+Shift+${suffix}`;
}

function getHotkeyLabelPrefix() {
  return process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
}

function getHotkeyLabel() {
  const suffix = String(HOTKEY_SUFFIX || 'D').trim().slice(-1).toUpperCase();
  return `${getHotkeyLabelPrefix()}+Shift+${suffix}`;
}

function registerGlobalShortcut() {
  try {
    const accel = getHotkeyAccelerator();
    if (lastRegisteredAccelerator) {
      try { globalShortcut.unregister(lastRegisteredAccelerator); } catch (_) {}
    }
    const ok = globalShortcut.register(accel, () => {
      try {
        // Check if user is authenticated and has valid access before showing overlay
        if (!stateManager?.isAuthenticated()) {
          return;
        }
        if (!stateManager?.hasValidAccess()) {
          return;
        }
        
        if (!overlayWindow || overlayWindow.isDestroyed()) {
          createOverlayWindow();
        }
        if (overlayWindow.isVisible()) {
          overlayWindow.hide();
        } else {
          showOverlayOnCurrentSpace();
        }
      } catch (e) {}
    });
    if (!ok) {
      log.warn('Failed to register global shortcut for Open Chat with', accel);
    } else {
      lastRegisteredAccelerator = accel;
    }
  } catch (e) {
    log.error('Error registering global shortcut:', e);
  }
}

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
let overlayWindow = null
let screenshotInterval = null
// Persist overlay position
let overlayStore = null
let savedOverlayPosition = null
let saveOverlayPositionDebounce = null
let overlayPositionUserSet = false
// Track OS suspension/lock state to gate recording
let isSystemSuspended = false
let isScreenLocked = false

// Deep-link auth flow coordination
let pendingDeepLinkToken = null;
let rendererReadyForAuth = false;
// Suppress disruptive webview reloads during active auth attempts
let suppressWebviewReloadUntil = 0;

function enqueueDeepLinkToken(token) {
  if (!token) return;
  pendingDeepLinkToken = token;
  tryDeliverDeepLinkToken();
}

function tryDeliverDeepLinkToken() {
  try {
    if (!pendingDeepLinkToken) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!rendererReadyForAuth) return;

    const token = pendingDeepLinkToken;
    pendingDeepLinkToken = null;
    // Briefly suppress webview reloads to avoid interrupting auth UI
    try { suppressWebviewReloadUntil = Date.now() + 30000; } catch (_) {}
    try { mainWindow.webContents.send('firebase-custom-token', token); } catch (e) { log.warn('Failed to send firebase-custom-token to renderer:', e); }
  } catch (e) {
    log.error('Error in tryDeliverDeepLinkToken:', e);
  }
}

// Track last time we reloaded the embedded webview to avoid excessive reloads
const RELOAD_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastWebviewReloadAt = 0;

if (DEBUG) {
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

// Global hook: surface ERROR logs as non-sticky in-app notifications
// Only enable this behavior in DEBUG mode to avoid disruptive overlays in production
try {
  log.hooks.push((message) => {
    if (!message || message.level !== 'error') return message;
    if (!DEBUG) return message;
    if (!app.isReady() || !mainWindow) return message;
    try {
      const data = Array.isArray(message.data) ? message.data : [message.data];
      const text = data.filter(Boolean).map(String).join(' ');
      const body = text.substring(0, 160) + (text.length > 160 ? '…' : '');
      try { if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) overlayWindow.hide(); } catch (e) {}
      try { mainWindow.show(); } catch (e) {}
      try { mainWindow.focus(); } catch (e) {}
      mainWindow.webContents.send('inapp:notify', {
        id: 'log-error-' + Date.now(),
        title: 'DoneThat Error',
        message: body,
        sticky: false
      });
    } catch (_) {}
    return message;
  });
} catch (_) {}

// Utility: hide main window only if app is not active (no focused window)
function hideMainWindowIfVisible() {
  try {
    const hasFocusedWindow = !!BrowserWindow.getFocusedWindow();
    if (!hasFocusedWindow && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide();
    }
  } catch (e) {}
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
        try {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('inapp:notify', {
              id: 'update-available',
              title: 'DoneThat Update',
              message: 'An update is ready. Click to install now. You may see a Windows prompt to confirm.',
              sticky: true,
              action: { label: 'Install Update', channel: 'update:install', payload: { forceRunAfter: true } }
            });
          }
        } catch (e) { log.warn('Failed to send in-app update notify:', e); }
        
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
        
        try {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('inapp:notify', {
              id: 'update-available',
              title: 'DoneThat Update Available',
              message: `A new version (${info.version}) is available and has been downloaded.`,
              sticky: true,
              action: { label: 'Install Update', channel: 'update:install', payload: { forceRunAfter: false } }
            });
          }
        } catch (e) { log.warn('Failed to send in-app update notify (linux):', e); }
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

// Expose debug flag to renderer
ipcMain.handle('get-debug-flag', () => {
  return DEBUG === true;
});

// Recording control handlers for renderer topbar
ipcMain.on('pauseForMs', (event, ms) => {
  try { stateManager?.pauseRecording(Number(ms), mainWindow); } catch (e) {}
});
ipcMain.on('pauseForToday', () => {
  try { stateManager?.pauseUntilNextWorkPeriod(mainWindow); } catch (e) {}
});
ipcMain.on('logout-request', () => {
  if (mainWindow) {
    mainWindow.webContents.send('logout');
  }
});

// Ensure UI reacts on logout: hide overlay, show main window, and notify
ipcMain.on('logout', () => {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.hide();
    }
  } catch (e) {}
  if (mainWindow) {
    try { mainWindow.show(); } catch (e) {}
    try { mainWindow.focus(); } catch (e) {}
  }
});

// Add IPC handler for custom token
ipcMain.on('firebase-custom-token', (event, token) => {
  if (mainWindow) {
    mainWindow.webContents.send('firebase-custom-token', token);
  }
});

// Add IPC handler for processing external URLs
ipcMain.on('process-external-url', (event, urlString) => {
  if (mainWindow) {
    mainWindow.webContents.send('process-external-url', urlString);
  }
});

// Add IPC handler to focus app window
ipcMain.on('focus-app-window', (event) => {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.hide();
    }
  } catch (e) {}
  if (mainWindow) {
    try { mainWindow.show(); } catch (e) {}
    try { mainWindow.focus(); } catch (e) {}
  }
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
  // Register Hotkey IPC early so renderer can invoke during startup
  ipcMain.handle('hotkey:get', async () => {
    try {
      const suffix = String(HOTKEY_SUFFIX || 'D').trim().slice(-1).toUpperCase();
      return { success: true, suffix, accelerator: getHotkeyAccelerator(), label: getHotkeyLabel() };
    } catch (e) {
      return { success: false, error: String(e && e.message || e) };
    }
  });

  ipcMain.handle('hotkey:set', async (_event, payload) => {
    try {
      const raw = (payload && payload.suffix) || '';
      const clean = String(raw).trim();
      if (!clean || !/^[a-zA-Z]$/.test(clean.slice(-1))) {
        return { success: false, error: 'Suffix must be a single A-Z character.' };
      }
      HOTKEY_SUFFIX = clean.slice(-1).toUpperCase();
      try { overlayStore?.set('hotkeySuffix', HOTKEY_SUFFIX); } catch (_) {}
      registerGlobalShortcut();
      // Refresh menus so accelerators/labels update
      createApplicationMenu();
      const payloadOut = { success: true, suffix: HOTKEY_SUFFIX, accelerator: getHotkeyAccelerator(), label: getHotkeyLabel() };
      try { mainWindow?.webContents?.send('hotkey:updated', payloadOut); } catch (_) {}
      return payloadOut;
    } catch (e) {
      return { success: false, error: String(e && e.message || e) };
    }
  });

  // Renderer readiness handshake for auth delivery (register BEFORE creating the window)
  ipcMain.on('renderer:ready-for-auth', () => {
    try {
      rendererReadyForAuth = true;
      tryDeliverDeepLinkToken();
    } catch (e) {}
  });

  // Create window as early as possible (kept hidden) to avoid losing early deep-links
  createWindow()

  // Lazy-load electron-store for overlay position persistence
  try {
    const { default: Store } = await import('electron-store');
    overlayStore = new Store({ name: 'donethat-config' });
    try {
      // Load persisted hotkey suffix if available
      const persistedSuffix = overlayStore.get('hotkeySuffix');
      if (typeof persistedSuffix === 'string' && persistedSuffix.length > 0) {
        HOTKEY_SUFFIX = String(persistedSuffix).trim().slice(-1).toUpperCase();
      }

      savedOverlayPosition = overlayStore.get('overlayPosition') || null;
      if (savedOverlayPosition && Number.isFinite(savedOverlayPosition.x) && (Number.isFinite(savedOverlayPosition.y) || Number.isFinite(savedOverlayPosition.bottom))) {
        overlayPositionUserSet = true;
      } else {
        overlayPositionUserSet = false;
      }
    } catch (e) {}
  } catch (e) {}
  // Register custom URL scheme for Google SSO
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('donethat', process.execPath, [path.resolve(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient('donethat')
  }

  // Initialize the state manager with necessary callbacks
  stateManager = await initState({
    checkRecording: checkAndAdjustRecording, // for pause state changes
    navigateToView: navigateToView, // for notifications
    getUserAwayState: () => isScreenLocked || isSystemSuspended // for checking if user is away
  });



  // Create application menu
  createApplicationMenu();
  
  // Register for auth state change events from renderer
  ipcMain.on('auth-state-changed', (event, isAuthenticated) => {
    createApplicationMenu(); // Update menu on auth state change
  });

  // Allow renderer modules to trigger in-app notifications centrally
  ipcMain.on('inapp:notify', (_event, payload) => {
    try { if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) overlayWindow.hide(); } catch (e) {}
    if (mainWindow) {
      // Respect noFocus for non-intrusive banners (e.g., transient network issues)
      const noFocus = !!(payload && payload.noFocus);
      if (!noFocus) {
        try { mainWindow.show(); } catch (e) {}
        try { mainWindow.focus(); } catch (e) {}
      }
      try { mainWindow.webContents.send('inapp:notify', payload); } catch (e) {}
    }
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
  
  // Check screen capture permission (do not block window creation earlier)
  await checkScreenCapturePermission()
  
  // Initial state check and schedule daily check
  checkAndAdjustRecording();

  // --- Add powerMonitor listener here ---
  powerMonitor.on('resume', () => {
    isSystemSuspended = false;
    if (stateManager) {
        stateManager.resume();
    }
    checkAndAdjustRecording();
  });
  powerMonitor.on('unlock-screen', () => {
    isScreenLocked = false;
    // Rebase timers after unlock as some Windows devices may not emit 'resume'
    // and existing setTimeouts would otherwise extend pauses by sleep duration
    if (stateManager) {
      try { stateManager.resume(); } catch (e) {}
    }
    checkAndAdjustRecording();
  });
  powerMonitor.on('suspend', () => {
    isSystemSuspended = true;
    checkAndAdjustRecording();
  });
  powerMonitor.on('lock-screen', () => {
    isScreenLocked = true;
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

  
  // IPC to install update from in-app notification
  ipcMain.on('update:install', (_event, payload) => {
    try {
      const runAfter = payload && payload.forceRunAfter === true;
      // Windows: silent flag true for runAfter
      if (process.platform === 'win32') {
        autoUpdater.quitAndInstall(false, runAfter);
      } else {
        app.isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    } catch (e) { log.error('Failed to install update from banner:', e); }
  });

  

  // Create overlay window (hidden initially)
  createOverlayWindow()

  // Check for updates with proper error handling
  try {
    setupAutoUpdater();
    scheduleUpdateChecks();

  } catch (error) {
    log.error('Error setting up updater:', error);
  }

  // Register global shortcut for Open Chat (configurable suffix)
  try { registerGlobalShortcut(); } catch (e) { log.error('Error registering global shortcut:', e); }

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

    // Re-check Windows (active apps) permission passively and notify renderer
    try {
      const winPerm = await checkWindowsPermission();
      const prev = stateManager?.hasWindowsPermission();
      stateManager?.updateWindowsPermission(winPerm);
      if (mainWindow && winPerm !== prev) {
        mainWindow.webContents.send('windowsPermission', winPerm);
      }
    } catch (e) {}
  });

  // Add daily auth check
  scheduleDailyAuthCheck();

  // Handle custom URL scheme for Google SSO and internal navigation
  app.on('open-url', (event, urlString) => {
    event.preventDefault();
    const url = new URL(urlString);
    const token = url.searchParams.get('token');
    
    if (token) {
      enqueueDeepLinkToken(token);
    } else if (mainWindow) {
      // Forward other donethat:// URLs for internal navigation
      mainWindow.webContents.send('router:open-link', urlString);
    }
  });

  // Handle URL when app is launched with URL (all platforms)
  const url = process.argv.find(arg => arg.startsWith('donethat://'));
  if (url) {
    try {
      const urlObj = new URL(url);
      const token = urlObj.searchParams.get('token');
      if (token) {
        enqueueDeepLinkToken(token);
      } else if (mainWindow) {
        // Forward other donethat:// URLs for internal navigation
        mainWindow.webContents.send('router:open-link', url);
      }
    } catch (error) {
      log.error('Error parsing URL in app launch:', error);
    }
  }
})

////// OVERLAY IPC //////

ipcMain.handle('overlay:get-state', () => {
  return {
    isPaused: stateManager?.isPaused() ?? false,
    hasPermission: stateManager?.hasScreenCapturePermission() ?? false,
    isAuthenticated: stateManager?.isAuthenticated() ?? false
  }
})

  // Chat message handling - main window handles all Firebase logic
  ipcMain.handle('chat:send-message', async (event, messageData) => {
    // Forward to main window for Firebase processing
    mainWindow.webContents.send('chat:process-message', messageData)
    return { success: true, pending: true }
  })

  // Handle chat message response from main window
  ipcMain.on('chat:message-result', (event, result) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('chat:message-update', result)
    }
  })

  // Handle chat messages from main window
  ipcMain.on('chat:set-messages', (event, messages) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('chat:receive-messages', messages)
    }
  })

  // Handle screenshot capture for chat
  ipcMain.handle('chat:capture-screenshot', async () => {
    try {
      const { captureScreenshot } = require('./src-main/captureScreenshots');
      const screenshots = await captureScreenshot();
      
      // The screenshots are already processed by processScreenshotForUpload()
      // and returned as optimized JPEG data URLs, so we can use them directly
      const imageData = screenshots;
      
      return { success: true, images: imageData };
    } catch (error) {
      console.error('[MAIN] Error capturing screenshot for chat:', error);
      return { success: false, error: error.message };
    }
  })

  // Handle chat reset - clear current chat and prepare for new chat
  ipcMain.handle('chat:reset', () => {
    // Forward to main window to reset chat state
    mainWindow.webContents.send('chat:reset-state');
    return { success: true };
  })





ipcMain.on('create-overlay-if-needed', () => {
  try {
    // Create overlay if it doesn't exist
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
  } catch (e) {
    console.error('[MAIN] Error creating overlay after sign-in:', e);
  }
})

ipcMain.on('overlay:hide', () => {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide()
    }
  } catch (e) {}
})

ipcMain.on('overlay:open-main', (event, view) => {
  if (typeof view === 'string') {
    navigateToView(view)
  } else {
    navigateToView('signup-next')
  }
})

// Toggle overlay visibility
ipcMain.on('overlay:toggle', () => {
  try {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
    
    // Check if overlay is currently visible
    if (overlayWindow.isVisible()) {
      // Hide the overlay
      overlayWindow.hide();
    } else {
      // Show the overlay (ensure current Space on macOS)
      showOverlayOnCurrentSpace();
    }
  } catch (e) {}
});

ipcMain.on('overlay:show', () => {
  try {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
    showOverlayOnCurrentSpace();
  } catch (e) {}
});

ipcMain.on('overlay:show-if-hidden', () => {
  try {
    const isAuthenticated = stateManager?.isAuthenticated();
    const hasValidAccess = stateManager?.hasValidAccess();
    
    // Check if user is authenticated and has valid access before showing overlay
    if (!isAuthenticated) {
      return;
    }
    if (!hasValidAccess) {
      return;
    }
    
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
    
    // Only show if the window is currently hidden
    if (!overlayWindow.isVisible()) {
      hideMainWindowIfVisible();
      showOverlayOnCurrentSpace();
    }
  } catch (e) {
    console.error('[MAIN] Error in overlay:show-if-hidden:', e)
  }
});

// Overlay dynamic resize
ipcMain.on('overlay:resize', (event, height) => {
  try {
    if (overlayWindow && typeof height === 'number' && isFinite(height)) {
      const bounds = overlayWindow.getBounds();
      const MAX_H = 600
      const clamped = Math.max(40, Math.min(MAX_H, Math.floor(height)));
      const heightDiff = clamped - bounds.height;
      
      // Set new size
      overlayWindow.setSize(bounds.width, clamped, false);
      
      // Adjust Y position to keep top edge fixed (shrink from bottom)
      if (heightDiff !== 0) {
        const newY = bounds.y - heightDiff;
        overlayWindow.setPosition(bounds.x, newY, false);
      }
    }
  } catch (e) {}
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
  const hasScreenPermission = stateManager?.hasScreenCapturePermission() ?? false;
  const hasWindowsPermission = stateManager?.hasWindowsPermission() ?? false;
  const hasValidAccess = stateManager?.hasValidAccess() ?? false;

  // Show main window for authentication, account, or permission issues
  if (!loggedIn || !hasValidAccess || !hasScreenPermission || !hasWindowsPermission) {
    if (mainWindow && !mainWindow.isVisible()) {
      showWindowBelowTray();
    }
  }

  if (isActuallyRecording) {
    iconPath = iconRecordingPath;
    tooltip = 'DoneThat - Recording';
  } else if (!hasScreenPermission) {
    iconPath = iconErrorPath;
    tooltip = 'DoneThat - No Screen Capture Permission';
  } else if (!hasWindowsPermission) {
    iconPath = iconErrorPath;
    tooltip = 'DoneThat - No Windows Permission';
  } else if (!loggedIn) {
    iconPath = iconErrorPath;
    tooltip = 'DoneThat - Not Logged In';
  } else if (!hasValidAccess) {
    iconPath = iconErrorPath;
    tooltip = 'DoneThat - Account Inactive';
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
  const hasValidAccess = stateManager?.hasValidAccess() ?? false;
  const isMac = process.platform === 'darwin';
  
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
        enabled: isLoggedIn && !isPaused && hasPermission && hasValidAccess
      },
      {
        label: 'Pause for 15 minutes',
        click: () => stateManager?.pauseRecording(15 * 60 * 1000, mainWindow),
        enabled: isLoggedIn && !isPaused && hasPermission && hasValidAccess
      },
      {
        label: 'Pause for 30 minutes',
        click: () => stateManager?.pauseRecording(30 * 60 * 1000, mainWindow),
        enabled: isLoggedIn && !isPaused && hasPermission && hasValidAccess
      },
      {
        label: 'Pause for 1 hour',
        click: () => stateManager?.pauseRecording(60 * 60 * 1000, mainWindow),
        enabled: isLoggedIn && !isPaused && hasPermission && hasValidAccess
      },
      {
        label: 'Pause for today',
        click: () => stateManager?.pauseUntilNextWorkPeriod(mainWindow),
        enabled: isLoggedIn && !isPaused && hasPermission && hasValidAccess
      },
      {
        label: 'Resume',
        click: () => startRecording(),
        enabled: isLoggedIn && isPaused && hasPermission && hasValidAccess
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
        label: `Open Chat (${getHotkeyLabel()})`,
        accelerator: getHotkeyAccelerator(),
        click: () => {
          try {
            showOverlayOnCurrentSpace();
          } catch (e) {}
        }
      },
      {
        label: 'Support',
        click: () => {
          const { shell } = require('electron');
          shell.openExternal('https://donethat.ai/support');
        }
      }
    ]
  };
  // Add standard Edit menu for system-wide copy/paste/dictation support
  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ]
  };
  
  // Window menu to support standard shortcuts like Cmd/Ctrl+W (close)
  const windowMenu = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      // Explicit accelerator ensures it works reliably across platforms
      { role: 'close', accelerator: 'CmdOrCtrl+W' }
    ]
  };
  
  // Push menus to template
  template.push(fileMenu, editMenu, windowMenu, recordingMenu, accountMenu, helpMenu);
  
  // Set as application menu
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Update context menu build function to also update application menu
function buildContextMenu() {
  const isLoggedIn = stateManager?.isAuthenticated() ?? false;
  const isPaused = stateManager?.isPaused() ?? false;
  const hasPermission = stateManager?.hasScreenCapturePermission() ?? false;
  const hasValidAccess = stateManager?.hasValidAccess() ?? false;

  // Start with basic template
  const template = []

  // Add "Open App" as the first option for all platforms
  template.push({
    label: 'Open App',
    click: () => navigateToView('signup-next')
  },
    {
      label: `Open Chat (${getHotkeyLabel()})`,
      enabled: isLoggedIn && hasValidAccess,
      click: () => {
        // Only show overlay if authenticated and has valid access
        if (!stateManager?.isAuthenticated()) {
          return;
        }
        if (!stateManager?.hasValidAccess()) {
          return;
        }
        try { showOverlayOnCurrentSpace() } catch (e) { }
      }
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
      enabled: isLoggedIn && !isPaused && hasPermission && hasValidAccess
    },
    {
      label: 'Pause for 15 minutes',
      click: () => stateManager?.pauseRecording(15 * 60 * 1000, mainWindow),
      enabled: isLoggedIn && !isPaused && hasPermission && hasValidAccess
    },
    {
      label: 'Pause for 30 minutes',
      click: () => stateManager?.pauseRecording(30 * 60 * 1000, mainWindow),
      enabled: isLoggedIn && !isPaused && hasPermission && hasValidAccess
    },
    {
      label: 'Pause for 1 hour',
      click: () => stateManager?.pauseRecording(60 * 60 * 1000, mainWindow),
      enabled: isLoggedIn && !isPaused && hasPermission && hasValidAccess
    },
    {
      label: 'Pause for today',
      click: () => stateManager?.pauseUntilNextWorkPeriod(mainWindow),
      enabled: isLoggedIn && !isPaused && hasPermission && hasValidAccess
    },
    {
      label: 'Resume',
      click: () => startRecording(),
      enabled: isLoggedIn && isPaused && hasPermission && hasValidAccess
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
let hasShownInactiveBanner = false;

function checkAndAdjustRecording() {
    const isCurrentlyRecording = isCapturing();

    // Determine if we should be recording based on current conditions
    const isAuthenticated = stateManager?.isAuthenticated();
    const hasPermission = stateManager?.hasScreenCapturePermission();
    const hasValidAccess = stateManager?.hasValidAccess();
    const isPaused = stateManager?.isPaused();
    const shouldBeRecording = isAuthenticated && hasPermission && hasValidAccess && !isPaused && !isSystemSuspended && !isScreenLocked;

    // to capture some cases where auth is loaded later
    // but not recording it's not triggering above function because
    // isCurrentlyRecording is false
    updateTrayIcon(isCurrentlyRecording && shouldBeRecording);
    sendOverlayState();
    
    // Update application menu when recording state changes
    createApplicationMenu();

    // Show sticky banner if account is inactive (once per session)
    if (isAuthenticated && !hasValidAccess && !hasShownInactiveBanner) {
      try {
        if (mainWindow) {
          try { mainWindow.show(); mainWindow.focus(); } catch (e) {}
          mainWindow.webContents.send('inapp:notify', {
            id: 'subscription-inactive',
            title: 'Subscription Required',
            message: 'Your subscription is inactive. Recording is paused until you renew.',
            sticky: true
          });
          hasShownInactiveBanner = true;
        }
      } catch (e) {}
    }

    // Regular start/stop logic
    if (isCurrentlyRecording && !shouldBeRecording) {
      stopRecording();
    } else if (!isCurrentlyRecording && shouldBeRecording) {
      startRecording();
    }
  // Notify overlay about state for icon updates
  sendOverlayState();
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
    // Use a standard, larger default size for all platforms
    const windowWidth = 1200; // Increased from 1024
    const windowHeight = 750; // Increased from 720
    
    mainWindow = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      // Use a standard framed window on all platforms
      frame: true,
      resizable: true,
      minWidth: 900, // Increased from 800
      minHeight: 580, // Increased from 560
      // Make window movable on all platforms
      movable: true,
      show: false,
      // Show in taskbar/dock so it's a normal app window
      skipTaskbar: false,
      fullscreenable: false, // Prevent full screen toggle
      // Enable high DPI scaling on all platforms
      enableHighDpiScaling: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        partition: 'persist:donethat',
        webSecurity: true,
        webviewTag: true,
        // Add these to ensure proper persistence
        enableRemoteModule: false,
        sandbox: false,
        // This is important for IndexedDB persistence
        backgroundThrottling: false,
        // Enable context menus and copy-paste
        spellcheck: false
      }
    })

    mainWindow.loadFile('./src/index.html')

    // Debug inspector
    if (DEBUG) {
      mainWindow.webContents.openDevTools();
    }
    // Log any webContents errors (only in debug mode)
    if (DEBUG) {
      mainWindow.webContents.on('console-message', (event) => {
        console.log('Renderer Console:', event.message);
      });
    }

    // Position the window once it's ready.
    mainWindow.once('ready-to-show', async () => {
      mainWindow.webContents.send('screenCapturePermission', {
        hasPermission: stateManager?.hasScreenCapturePermission(),
        isWaylandSession: stateManager?.isWaylandSession()
      });
      
      // Initialize capture with auth error handler
      initCapture(mainWindow, handleCaptureAuthErrors, stateManager.getIdToken);

      // Initialize permission handlers
      initScreenCapturePermissionHandling(mainWindow, stateManager, checkAndAdjustRecording, sendOverlayState);
      initWindowsPermissionHandling(mainWindow, stateManager, checkAndAdjustRecording, sendOverlayState);

      // Passive initial check for Windows (active apps) permission and notify renderer
      try {
        const winPerm = await checkWindowsPermission();
        stateManager?.updateWindowsPermission(winPerm);
        try { mainWindow.webContents.send('windowsPermission', winPerm); } catch (e) {}
      } catch (e) {}

      // Renderer will handle opening the window if a permission is missing based on emitted events
    })

    // Remove macOS-specific auto-hide on blur to behave like a normal window
    
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

    // Ensure Dock icon is visible whenever the main window is shown (macOS)
    mainWindow.on('show', () => {
      if (process.platform === 'darwin') {
        try { app.dock.show(); } catch (e) {}
      } else {
        // Ensure taskbar presence on Windows/Linux
        try { mainWindow.setSkipTaskbar(false); } catch (e) {}
      }
      // Notify renderer to reload the embedded webview when app window is shown/unhidden,
      // but only if at least RELOAD_MIN_INTERVAL_MS has passed since last reload
      try {
        const now = Date.now();
        if (!lastWebviewReloadAt || (now - lastWebviewReloadAt) > RELOAD_MIN_INTERVAL_MS) {
          if (now < suppressWebviewReloadUntil) {
            // Skip reload during active auth window
            return;
          }
          try { mainWindow.webContents.send('webview:reload'); } catch (e) {}
              lastWebviewReloadAt = now;
        }
      } catch (e) {}
    });

    // Conditionally request webview reload when the main window gains focus
    mainWindow.on('focus', () => {
      try {
        const now = Date.now();
        // Skip reloads if we're within an active auth sequence suppression window
        if (now < suppressWebviewReloadUntil) {
          return;
        }
        if (!lastWebviewReloadAt || (now - lastWebviewReloadAt) > RELOAD_MIN_INTERVAL_MS) {
          try { mainWindow.webContents.send('webview:reload'); } catch (e) {}
          lastWebviewReloadAt = now;
        }
      } catch (e) {}
    });

    // Hide Dock icon when main window is hidden (macOS)
    mainWindow.on('hide', () => {
      if (process.platform === 'darwin') {
        try { app.dock.hide(); } catch (e) {}
      } else {
        // Hide from taskbar on Windows/Linux when main window is hidden
        try { mainWindow.setSkipTaskbar(true); } catch (e) {}
      }
    });

    // Enable context menus
    mainWindow.webContents.on('context-menu', (event, params) => {
      // Allow default context menu behavior
    event.preventDefault();
    // Create a simple context menu with copy/paste
    const { Menu, MenuItem } = require('electron');
    const contextMenu = new Menu();
    
    if (params.selectionText) {
      contextMenu.append(new MenuItem({ role: 'copy' }));
    }
    if (params.isEditable) {
      contextMenu.append(new MenuItem({ role: 'paste' }));
      contextMenu.append(new MenuItem({ role: 'cut' }));
      contextMenu.append(new MenuItem({ role: 'selectAll' }));
    }
    
    if (contextMenu.items.length > 0) {
      contextMenu.popup({ window: mainWindow });
    }
    });
  }
}

// Minimal overlay window setup
function createOverlayWindow() {
  if (!overlayWindow) {
    const isPlatformMac = process.platform === 'darwin';
    // Compute an initial position explicitly to avoid Electron's default centering
    const margin = 16;
    const defaultWidth = 390; // Increased from 260 to 390 (1.5x wider)
    const defaultHeight = 40;
    let initX;
    let initY;
    try {
      if (overlayPositionUserSet && savedOverlayPosition && Number.isFinite(savedOverlayPosition.x) && (Number.isFinite(savedOverlayPosition.y) || Number.isFinite(savedOverlayPosition.bottom))) {
        const hasBottom = Number.isFinite(savedOverlayPosition.bottom)
        initX = Math.round(savedOverlayPosition.x);
        initY = Math.round(hasBottom ? (savedOverlayPosition.bottom - defaultHeight) : savedOverlayPosition.y);
      } else {
        const cursorPoint = screen.getCursorScreenPoint();
        let targetDisplay = screen.getDisplayNearestPoint(cursorPoint) || screen.getPrimaryDisplay();
        const trayBounds = tray?.getBounds();
        if (trayBounds) {
          const allDisplays = screen.getAllDisplays();
          const found = allDisplays.find(d => {
            const b = d.bounds;
            return trayBounds.x >= b.x && trayBounds.x < b.x + b.width && trayBounds.y >= b.y && trayBounds.y < b.y + b.height;
          });
          if (found) targetDisplay = found;
        }
        const work = targetDisplay.workArea;
        initX = Math.floor(work.x + (work.width / 2) - (defaultWidth / 2));
        initY = Math.floor(work.y + work.height - defaultHeight - margin);
      }
    } catch (e) {}

    overlayWindow = new BrowserWindow({
      width: defaultWidth,
      height: defaultHeight,
      x: initX,
      y: initY,
      frame: false,
      resizable: false,
      movable: true,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      fullscreenable: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        partition: 'persist:donethat',
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: true
      },
      ...(isPlatformMac ? { visibleOnAllWorkspaces: true, acceptFirstMouse: true } : {})
    })

    overlayWindow.loadFile('./src/chat.html')

    // Log any overlay webContents console messages (only in debug mode)
    if (DEBUG) {
      overlayWindow.webContents.on('console-message', (event) => {
        console.log('Overlay Console:', event.message);
      });
    }

    overlayWindow.once('ready-to-show', () => {
      positionOverlayWindow()
      // Only show overlay if authenticated and has valid access
      if (stateManager?.isAuthenticated() && stateManager?.hasValidAccess()) {
        overlayWindow.showInactive()
      }
      sendOverlayState()
    })

    overlayWindow.on('blur', () => {
      try { overlayWindow.setAlwaysOnTop(true) } catch (e) {}
      try { overlayWindow.webContents.send('overlay:collapse') } catch (e) {}
    })

    // Removed focus event that was causing auto-expansion on drag

    overlayWindow.on('closed', () => {
      overlayWindow = null
    })

    // Persist position when moved (save both y and bottom to be robust)
    overlayWindow.on('move', () => {
      try {
        if (!overlayStore) return
        const [x, y] = overlayWindow.getPosition()
        const bounds = overlayWindow.getBounds()
        const bottom = y + bounds.height
        // Save both y and bottom for backward/forward compatibility
        const display = screen.getDisplayNearestPoint({ x, y })
        const displayId = display?.id
        savedOverlayPosition = { x, y, bottom, displayId }
        overlayPositionUserSet = true
        clearTimeout(saveOverlayPositionDebounce)
        saveOverlayPositionDebounce = setTimeout(() => {
          try { overlayStore.set('overlayPosition', savedOverlayPosition) } catch (e) {}
        }, 200)
      } catch (e) {}
    })

    // Enable context menus (copy/paste) for overlay window
    overlayWindow.webContents.on('context-menu', (event, params) => {
      event.preventDefault();
      const { Menu, MenuItem } = require('electron');
      const cm = new Menu();
      if (params.selectionText && params.selectionText.length > 0) {
        cm.append(new MenuItem({ role: 'copy' }));
      }
      if (params.isEditable) {
        cm.append(new MenuItem({ role: 'paste' }));
        cm.append(new MenuItem({ role: 'cut' }));
        cm.append(new MenuItem({ role: 'selectAll' }));
      }
      if (cm.items.length > 0) {
        cm.popup({ window: overlayWindow });
      }
    });

    screen.on('display-metrics-changed', () => {
      if (overlayWindow && overlayWindow.isVisible()) {
        positionOverlayWindow()
      }
    })
  }
}

function positionOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  const margin = 16

  // Determine the active (current cursor) display
  const cursorPoint = screen.getCursorScreenPoint()
  const targetDisplay = screen.getDisplayNearestPoint(cursorPoint) || screen.getPrimaryDisplay()
  const work = targetDisplay.workArea

  const winBounds = overlayWindow.getBounds()
  let x, y

  const hasSaved = savedOverlayPosition && Number.isFinite(savedOverlayPosition.x) && (Number.isFinite(savedOverlayPosition.y) || Number.isFinite(savedOverlayPosition.bottom))
  const isSameDisplay = hasSaved && savedOverlayPosition.displayId && savedOverlayPosition.displayId === targetDisplay.id

  if (overlayPositionUserSet && isSameDisplay) {
    // Restore saved position on the same display, clamped to work area
    const hasBottom = Number.isFinite(savedOverlayPosition.bottom)
    const hasY = Number.isFinite(savedOverlayPosition.y)
    const virtualY = hasBottom ? savedOverlayPosition.bottom - winBounds.height : (hasY ? savedOverlayPosition.y : undefined)
    x = Math.round(savedOverlayPosition.x)
    y = Math.round(virtualY ?? (work.y + work.height - winBounds.height - margin))

    const maxX = work.x + work.width - winBounds.width
    const maxY = work.y + work.height - winBounds.height
    x = Math.min(Math.max(x, work.x), Math.max(work.x, maxX))
    y = Math.min(Math.max(y, work.y), Math.max(work.y, maxY))
  } else {
    // Default: bottom-center on current cursor display
    x = Math.floor(work.x + (work.width / 2) - (winBounds.width / 2))
    y = Math.floor(work.y + work.height - winBounds.height - margin)
  }

  try { overlayWindow.setPosition(x, y, false) } catch (e) {}
}

// Helper: Show overlay on the current Space (macOS) without switching Spaces
function showOverlayOnCurrentSpace() {
  try {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
    positionOverlayWindow();
    if (process.platform === 'darwin') {
      try { overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
      try { overlayWindow.show(); } catch (e) {}
      try { overlayWindow.focus(); } catch (e) {}
      try { overlayWindow.setVisibleOnAllWorkspaces(false); } catch (e) {}
    } else {
      try { overlayWindow.show(); } catch (e) {}
      try { overlayWindow.focus(); } catch (e) {}
    }
  } catch (e) {}
}

function sendOverlayState() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  try {
    overlayWindow.webContents.send('overlay:state', {
      isPaused: stateManager?.isPaused() ?? false,
      hasPermission: stateManager?.hasScreenCapturePermission() ?? false,
      isAuthenticated: stateManager?.isAuthenticated() ?? false
    })
  } catch (e) {}
}

// Intelligently positions the window relative to the tray icon
// with support for multiple displays
function showWindowBelowTray() {
  // Show the main window centered and focused on all platforms
  try { mainWindow.center(); } catch (e) {}
  try { mainWindow.show(); } catch (e) {}
  try { mainWindow.focus(); } catch (e) {}
}

// Modify the window-all-closed handler to respect system quit
app.on('window-all-closed', (event) => {
  // Only prevent default if we're not in the quit process
  if (!app.isQuitting) {
    event.preventDefault();
  }
  // Otherwise let the app quit normally
});

// Unregister shortcuts on quit
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (e) {}
});

// Update the focus handler to use state manager
app.on('browser-window-focus', async () => {
  // Safety: assume focused window implies unlocked/active session
  try { isSystemSuspended = false; isScreenLocked = false; } catch (e) {}
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
  
  if (!stateManager?.hasValidAccess()) {
    return;
  }

  startCaptureInterval(); // Call without token

  stateManager?.recordingStarted(mainWindow);
  
  updateTrayIcon(true) // Show recording state
  createApplicationMenu(); // Update menu when recording starts
  sendOverlayState();

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
  sendOverlayState();
  
  // Send state updates
  if (mainWindow) {
    // Always emit pauseStateChanged, include cause to let renderer decide UI
    let cause = 'other';
    try {
      if (isScreenLocked) cause = 'lock-screen';
      else if (isSystemSuspended) cause = 'system-suspend';
      else if (stateManager?.isPaused && stateManager.isPaused()) cause = 'paused-state';
    } catch (e) {}
    try { mainWindow.webContents.send('pauseStateChanged', true, { cause }); } catch (e) {}
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
  sendOverlayState();
  
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
      try {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('inapp:notify', {
            id: 'not-logged-in',
            title: 'DoneThat Not Logged In',
            message: 'You are not logged in. Please log in to continue tracking your work.',
            sticky: true
          });
        }
      } catch (e) {}
    }
    
    // Schedule next check
    scheduleDailyAuthCheck();
  }, timeUntilCheck);
}