const { nativeImage, ipcMain, shell, app } = require('electron')
const { execSync } = require('child_process')
const path = require('path')
const log = require('electron-log')
const { getScreenSources } = require('./screenCaptureSemaphore')
const { recordPermissionCheck } = require('./telemetry')

// Store Linux screenshot command
let linuxScreenshotCommand = null

// Store the last captured screenshots for next upload
let lastScreenshots = null
let lastScreenshotTimestamp = null

// Scale factor for previous screenshot (50% = 0.5)
const PREVIOUS_SCREENSHOT_SCALE_FACTOR = 0.5
// Maximum age factor for previous screenshot (1.5x the capture interval)
const PREVIOUS_SCREENSHOT_MAX_AGE_FACTOR = 1.5

let screenPermissionFocusListener = null
const DEFAULT_LINUX_SCREENSHOT_COMMAND = `bash -c 'getOriginalAnimationSetting=$(gsettings get org.gnome.desktop.interface enable-animations); getOriginalSoundSetting=$(gsettings get org.gnome.desktop.sound event-sounds); gsettings set org.gnome.desktop.interface enable-animations false; gsettings set org.gnome.desktop.sound event-sounds false; gnome-screenshot -f "%s"; gsettings set org.gnome.desktop.interface enable-animations $getOriginalAnimationSetting; gsettings set org.gnome.desktop.sound event-sounds $getOriginalSoundSetting'`

///// UTILITIES /////
function isValidImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return false
  const payload = dataUrl.slice(commaIndex + 1).trim()
  return payload.length > 0
}

function filterValidScreenshots(screenshots, source = 'unknown') {
  if (!Array.isArray(screenshots) || screenshots.length === 0) return []
  const valid = screenshots.filter((shot) => isValidImageDataUrl(shot))
  if (valid.length !== screenshots.length) {
    log.warn(`Dropped ${screenshots.length - valid.length} invalid screenshot(s) from ${source}`)
  }
  return valid
}

function getSourceLogContext(source, index, caller) {
  const thumbnailSize = source?.thumbnail?.getSize ? source.thumbnail.getSize() : {}
  return {
    caller,
    sourceIndex: index,
    sourceId: source?.id || 'unknown',
    sourceName: source?.name || 'unknown',
    displayId: source?.display_id || 'unknown',
    thumbWidth: thumbnailSize?.width || 0,
    thumbHeight: thumbnailSize?.height || 0
  }
}

// Function to scale down a screenshot to the configured scale factor
function scaleScreenshotToPreviousSize(dataUrl) {
  try {
    if (!isValidImageDataUrl(dataUrl)) return dataUrl
    // Convert data URL to buffer
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    const buffer = Buffer.from(base64Data, 'base64')
    
    // Create native image from buffer
    let img = nativeImage.createFromBuffer(buffer)
    
    // Get original dimensions
    const { width, height } = img.getSize()
    
    // Calculate scaled dimensions using the constant
    const newWidth = Math.round(width * PREVIOUS_SCREENSHOT_SCALE_FACTOR)
    const newHeight = Math.round(height * PREVIOUS_SCREENSHOT_SCALE_FACTOR)
    
    // Resize image to the configured scale factor
    const scaledImg = img.resize({ width: newWidth, height: newHeight })
    
    // Convert to JPEG with 70% quality (consistent with processScreenshotForUpload)
    const jpegBuffer = scaledImg.toJPEG(70)
    
    // Convert back to data URL
    return `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`
  } catch (error) {
    log.error(`Error scaling screenshot to ${PREVIOUS_SCREENSHOT_SCALE_FACTOR * 100}%:`, error)
    // Return original as fallback
    return dataUrl
  }
}

// Function to get the previous screenshots scaled down to the configured scale factor
// Only returns them if they're less than 1.5x the capture interval old
function getPreviousScreenshots(captureIntervalMinutes = null) {
  if (!lastScreenshots || !lastScreenshotTimestamp || !captureIntervalMinutes) {
    return null
  }
  
  const now = Date.now()
  const screenshotAge = now - lastScreenshotTimestamp
  const maxAge = captureIntervalMinutes * 60 * 1000 * PREVIOUS_SCREENSHOT_MAX_AGE_FACTOR
  
  if (screenshotAge >= maxAge) {
    return null
  }

  const validScreenshots = filterValidScreenshots(lastScreenshots, 'previous-cache')
  if (validScreenshots.length === 0) {
    return null
  }
  
  return {
    timestamp: lastScreenshotTimestamp,
    images: validScreenshots.map((screenshot, index) => ({
      base64Data: screenshot,
      index
    }))
  }
}

// Function to save the current screenshots for next upload
function saveCurrentScreenshot(screenshots) {
  const validScreenshots = filterValidScreenshots(screenshots, 'current-capture')
  if (validScreenshots.length > 0) {
    lastScreenshots = validScreenshots
    lastScreenshotTimestamp = Date.now()
  }
}



// Function to check screen capture permission
async function checkScreenCapturePermission(source = 'unknown') {
  const startedAt = Date.now()
  try {
    // Linux-specific handling
    if (process.platform === 'linux') {    
      const hasPermission = await checkLinuxScreenCapturePermission()
      recordPermissionCheck('screen', source, hasPermission ? 'granted' : 'denied', Date.now() - startedAt)
      return hasPermission
    }
    
    // For other platforms (macOS, Windows)
    const sources = await getScreenSources(
      {
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      },
      {
        wait: true,
        timeoutMs: 2000,
        caller: 'permission_probe'
      }
    )
    if (!sources) {
      recordPermissionCheck('screen', source, 'skipped_busy', Date.now() - startedAt)
      return undefined
    }
    const granted = !!(sources && sources.length > 0)
    recordPermissionCheck('screen', source, granted ? 'granted' : 'denied', Date.now() - startedAt)
    return granted
  } catch (error) {
    console.error('Error checking screen capture permission:', error)
    recordPermissionCheck('screen', source, 'error', Date.now() - startedAt)
    return false
  }
}


// Function to load Linux screenshot command from store
async function loadLinuxScreenshotCommand() {
  try {
    if (process.platform !== 'linux') {
      return null;
    }

    // Load from the same store that main-state.js uses
    const { default: Store } = await import('electron-store');
    const store = new Store({ name: 'donethat-config' });
    let customCommand = store.get('linuxScreenshotCommand');
    
    // Always seed a default Linux command so Wayland fallback is available too.
    if (!customCommand) {
      customCommand = DEFAULT_LINUX_SCREENSHOT_COMMAND
      store.set('linuxScreenshotCommand', customCommand);
      log.info('Set default Linux screenshot command');
    }
    
    setLinuxScreenshotCommand(customCommand);
    
    return customCommand;
  } catch (error) {
    log.error('Error loading Linux screenshot command:', error);
    return null;
  }
}

// Function to set Linux screenshot command (called from main process)
function setLinuxScreenshotCommand(command) {
  linuxScreenshotCommand = command;
  if (command) {
    log.info('Using Linux screenshot command:', command);
  }
}

// Linux-specific permission checking - only uses custom command
async function checkLinuxScreenCapturePermission() {
  try {
    const fs = require('fs')
    const os = require('os')
    const tempDir = os.tmpdir()
    const testPath = path.join(tempDir, `test-screenshot-${Date.now()}.png`)
    
    // Load Linux command if not already loaded
    if (!linuxScreenshotCommand) {
      await loadLinuxScreenshotCommand();
    }
    
    // Linux command fallback
    if (linuxScreenshotCommand) {
      try {
        // Test the Linux command
        const testCommand = linuxScreenshotCommand.replace('%s', `"${testPath}"`);
        execSync(testCommand, { timeout: 5000, stdio: 'pipe' });
        
        if (fs.existsSync(testPath)) {
          fs.unlinkSync(testPath);
          return true;
        }
      } catch (e) {
        log.warn('Linux screenshot command failed:', e.message);
      }
    }
    return false
  } catch (error) {
    log.error('Linux screenshot permission check failed:', error)
    return false
  }
}

///// MAIN /////

// Use a single unified method for all platforms - only captures screenshots
async function captureScreenshot(options = {}) {
  try {
    const { caller = 'unknown' } = options
    let screenshots = [];
    
    // Use Linux-specific method on Linux platforms
    if (process.platform === 'linux') {
      screenshots = await captureScreenshotsLinux();
    } else {
      const sources = await getScreenSources(
        {
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 }
        },
        {
          wait: true,
          timeoutMs: 10000,
          caller
        }
      )
      if (!sources) {
        log.warn('Screenshot capture skipped - timed out waiting for shared screen sources')
        return []
      }

      // Use the standard Electron approach for other platforms
      if (sources.length === 0) {
        log.warn('No screen sources found');
        return [];
      }
      // Process each source
      screenshots = await Promise.all(
        sources.map(async (source, index) => {
          const context = getSourceLogContext(source, index, caller)
          let rawDataUrl = null
          try {
            rawDataUrl = source.thumbnail.toDataURL()
          } catch (error) {
            log.warn('[screen-capture] Failed to read source thumbnail', {
              ...context,
              reason: 'thumbnail_to_data_url_error',
              error: error?.message || String(error)
            })
            return null
          }

          if (!isValidImageDataUrl(rawDataUrl)) {
            log.warn('[screen-capture] Source produced invalid thumbnail data URL', {
              ...context,
              reason: 'invalid_raw_data_url',
              rawDataUrlLength: typeof rawDataUrl === 'string' ? rawDataUrl.length : 0,
              rawDataUrlPrefix: typeof rawDataUrl === 'string' ? rawDataUrl.slice(0, 40) : ''
            })
          }

          return await processScreenshotForUpload(rawDataUrl, context);
        })
      );
    }

    screenshots = filterValidScreenshots(screenshots, 'capture')
    
    if (screenshots.length === 0) {
      log.warn('No screenshots captured');
      return [];
    }

    return screenshots;
  } catch (error) {
    log.error('Screenshot capture error:', error.message, error.stack);
    return [];
  }
}

// Simplified Linux screenshot function - only uses custom command
async function captureScreenshotsLinux() {
  try {
    if (!linuxScreenshotCommand) {
      await loadLinuxScreenshotCommand()
    }
    // If no Linux command available, abort
    if (!linuxScreenshotCommand) {
      log.error('No Linux screenshot command available')
      return []
    }
    
    const fs = require('fs')
    const os = require('os')
    const tempDir = os.tmpdir()
    const screenshotPath = path.join(tempDir, `screenshot-${Date.now()}.png`)
    
    // Only use Linux command
    try {
      const linuxCommand = linuxScreenshotCommand.replace('%s', `"${screenshotPath}"`);
      execSync(linuxCommand, { timeout: 5000, stdio: 'pipe' });
    } catch (e) {
      log.error(`Linux screenshot command failed: ${e.message}`)
      return []
    }
    
    // Process the screenshot if it was created successfully
    if (fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 0) {
      const screenshotData = fs.readFileSync(screenshotPath)
      const base64Data = `data:image/png;base64,${screenshotData.toString('base64')}`
      fs.unlinkSync(screenshotPath)
      
      // Process the merged screenshot (all monitors in one image)
      const processedImage = await processScreenshotForUpload(base64Data)
      return [processedImage]
    } else {
      log.error('Screenshot file was not created or is empty')
      return []
    }
  } catch (error) {
    log.error('Failed to capture Linux screenshot:', error)
    return []
  }
}


// Simplified function to process screenshots using only Electron's nativeImage
async function processScreenshotForUpload(dataUrl, context = null) {
  try {
    if (!isValidImageDataUrl(dataUrl)) {
      log.warn('[screen-capture] processScreenshotForUpload received invalid data URL', {
        ...(context || {}),
        reason: 'invalid_data_url',
        dataUrlLength: typeof dataUrl === 'string' ? dataUrl.length : 0,
        dataUrlPrefix: typeof dataUrl === 'string' ? dataUrl.slice(0, 40) : ''
      })
      return null
    }
    // Convert data URL to buffer
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    if (!base64Data || base64Data.length === 0) {
      log.warn('[screen-capture] Empty base64 payload after stripping data URL prefix', {
        ...(context || {}),
        reason: 'empty_base64_payload'
      })
      return null
    }
    const buffer = Buffer.from(base64Data, 'base64')
    if (!buffer || buffer.length === 0) {
      log.warn('[screen-capture] Decoded image buffer is empty', {
        ...(context || {}),
        reason: 'empty_decoded_buffer',
        base64Length: base64Data.length
      })
      return null
    }
    
    // Create native image from buffer
    let img = nativeImage.createFromBuffer(buffer)
    
    // Get original dimensions
    const { width, height } = img.getSize()
    if (!width || !height) {
      log.warn('[screen-capture] nativeImage created with empty dimensions', {
        ...(context || {}),
        reason: 'empty_native_image',
        decodedBufferLength: buffer.length
      })
      return null
    }
    
    // Calculate new dimensions with 819px constraint on shorter edge
    let newWidth = width
    let newHeight = height
    const targetShortEdge = 819
    
    if (width < height) {
      // Width is shorter
      if (width > targetShortEdge) {
        const aspectRatio = height / width
        newWidth = targetShortEdge
        newHeight = Math.round(newWidth * aspectRatio)
      }
    } else {
      // Height is shorter
      if (height > targetShortEdge) {
        const aspectRatio = width / height
        newHeight = targetShortEdge
        newWidth = Math.round(newHeight * aspectRatio)
      }
    }
    
    // Resize image if needed
    if (newWidth !== width || newHeight !== height) {
      img = img.resize({ width: newWidth, height: newHeight })
    }
    
    // Convert to JPEG with 70% quality
    const jpegOptions = { quality: 70 }
    const jpegBuffer = img.toJPEG(jpegOptions.quality)
    if (!jpegBuffer || jpegBuffer.length === 0) {
      log.warn('[screen-capture] JPEG conversion returned empty buffer', {
        ...(context || {}),
        reason: 'empty_jpeg_buffer',
        inputWidth: width,
        inputHeight: height
      })
      return null
    }
    
    // Convert back to data URL
    return `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`
  } catch (error) {
    log.warn('[screen-capture] Error processing screenshot for upload', {
      ...(context || {}),
      reason: 'process_exception',
      error: error?.message || String(error)
    })
    return null
  }
}

// Initialize screen capture permission handling
function initScreenCapturePermissionHandling(mainWindow, stateManager, checkAndAdjustRecording, sendOverlayState) {
  ipcMain.on('requestScreenCapturePermission', async (_event, shouldOpenSettings = true) => {
    // Never open system settings if permission is already granted.
    try {
      let alreadyGranted = await checkScreenCapturePermission('request');
      if (alreadyGranted === undefined) {
        alreadyGranted = stateManager?.hasScreenCapturePermission();
      }
      if (!alreadyGranted) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        let secondCheck = await checkScreenCapturePermission('request-recheck');
        if (secondCheck === undefined) {
          secondCheck = stateManager?.hasScreenCapturePermission();
        }
        alreadyGranted = !!(alreadyGranted || secondCheck);
      }
      if (alreadyGranted) {
        stateManager?.updateScreenCapturePermission(true);
        if (mainWindow) {
          mainWindow.webContents.send('screenCapturePermission', {
            hasPermission: true,
            source: 'request'
          });
        }
        return;
      }
    } catch (_) {}

    if (shouldOpenSettings !== true) {
      stateManager?.updateScreenCapturePermission(false);
      if (mainWindow) {
        mainWindow.webContents.send('screenCapturePermission', {
          hasPermission: false,
          source: 'request'
        });
      }
      return;
    }

    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    } else if (process.platform === 'win32') {
      shell.openExternal('ms-settings:privacy-graphicscaptureprogrammatic')
    } else {
      // Linux/other: no direct settings deep-link here. Report current denied state only.
      stateManager?.updateScreenCapturePermission(false);
      if (mainWindow) {
        mainWindow.webContents.send('screenCapturePermission', {
          hasPermission: false,
          source: 'request'
        });
      }
      return;
    }

    // After opening settings, we should check permission again when app regains focus
    if (screenPermissionFocusListener) {
      app.removeListener('browser-window-focus', screenPermissionFocusListener)
      screenPermissionFocusListener = null
    }

    const focusListener = async () => {
      // Remove listener immediately to prevent multiple triggers
      if (screenPermissionFocusListener === focusListener) {
        screenPermissionFocusListener = null
      }
      app.removeListener('browser-window-focus', focusListener);

      const oldPermission = stateManager?.hasScreenCapturePermission();
      const hasPermission = await checkScreenCapturePermission('focus-recheck');
      stateManager?.updateScreenCapturePermission(hasPermission);

      if (stateManager?.hasScreenCapturePermission() !== oldPermission && mainWindow) { // Check if permission *changed*
        mainWindow.webContents.send('screenCapturePermission', {
          hasPermission: stateManager?.hasScreenCapturePermission(),
          source: 'request'
        });

        // Re-evaluate recording state based on permission change
        if (checkAndAdjustRecording) checkAndAdjustRecording();
        if (sendOverlayState) sendOverlayState();
      }
    };

    screenPermissionFocusListener = focusListener
    app.on('browser-window-focus', focusListener);
  });

  // Test Linux screenshot command handler
  ipcMain.handle('test-linux-screenshot-command', async (event, command) => {
    try {
      if (!command || typeof command !== 'string') {
        throw new Error('Invalid command provided');
      }

      const fs = require('fs');
      const os = require('os');
      const path = require('path');

      // Create a temporary file for testing
      const tempDir = os.tmpdir();
      const testPath = path.join(tempDir, `test-screenshot-${Date.now()}.png`);

      try {
        // Replace %s placeholder with actual file path
        const testCommand = command.replace('%s', `"${testPath}"`);
        
        // Execute the command with a timeout
        execSync(testCommand, { timeout: 5000, stdio: 'pipe' });
        
        // Check if the file was created and has content
        if (fs.existsSync(testPath) && fs.statSync(testPath).size > 0) {
          // Clean up the test file
          fs.unlinkSync(testPath);
          return { success: true, message: 'Command test successful' };
        } else {
          return { success: false, message: 'Command executed but no screenshot file was created' };
        }
      } catch (execError) {
        // Clean up test file if it exists
        try {
          if (fs.existsSync(testPath)) {
            fs.unlinkSync(testPath);
          }
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
        
        return { 
          success: false, 
          message: `Command failed: ${execError.message}` 
        };
      }
    } catch (error) {
      log.error('Error testing Linux screenshot command:', error);
      return { success: false, message: error.message };
    }
  });
}

module.exports = {
  captureScreenshot,
  checkScreenCapturePermission,
  getPreviousScreenshots,
  saveCurrentScreenshot,
  scaleScreenshotToPreviousSize,
  PREVIOUS_SCREENSHOT_SCALE_FACTOR,
  initScreenCapturePermissionHandling,
  setLinuxScreenshotCommand,
  loadLinuxScreenshotCommand
} 
