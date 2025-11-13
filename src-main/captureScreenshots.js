const { desktopCapturer, nativeImage, screen, ipcMain, shell, app } = require('electron')
const { execSync } = require('child_process')
const path = require('path')
const log = require('electron-log')

// Store Linux screenshot command
let linuxScreenshotCommand = null

// Store the last captured screenshots for next upload
let lastScreenshots = null
let lastScreenshotTimestamp = null

// Scale factor for previous screenshot (25% = 0.25)
const PREVIOUS_SCREENSHOT_SCALE_FACTOR = 0.25
// Maximum age factor for previous screenshot (1.5x the capture interval)
const PREVIOUS_SCREENSHOT_MAX_AGE_FACTOR = 1.5

// Track if desktopCapturer.getSources() is currently in progress to prevent overlapping calls
let isGrabbingInProgress = false

///// UTILITIES /////
// Function to scale down a screenshot to the configured scale factor
function scaleScreenshotToPreviousSize(dataUrl) {
  try {
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
  
  // Only return the previous screenshots if they're not too old
  if (screenshotAge < maxAge) {
    // Return object with timestamp and scaled screenshots
    return {
      timestamp: lastScreenshotTimestamp,
      scale: PREVIOUS_SCREENSHOT_SCALE_FACTOR,
      images: lastScreenshots.map((screenshot, index) => ({
        base64Data: scaleScreenshotToPreviousSize(screenshot),
        index
      }))
    }
  }
  
  return null
}

// Function to save the current screenshots for next upload
function saveCurrentScreenshot(screenshots) {
  if (screenshots && screenshots.length > 0) {
    // Save all screenshots
    lastScreenshots = screenshots
    lastScreenshotTimestamp = Date.now()
  }
}



// Function to check screen capture permission
async function checkScreenCapturePermission() {
  try {
    // Linux-specific handling
    if (process.platform === 'linux') {    
      const hasPermission = await checkLinuxScreenCapturePermission()
      return hasPermission
    }
    
    // Skip if already grabbing (permission check should not block or interfere)
    if (isGrabbingInProgress) {
      // Return undefined/null to indicate "skipped" rather than false (which implies denied)
      // Caller should use cached state if this returns undefined
      return undefined
    }
    
    // For other platforms (macOS, Windows)
    // Set flag to prevent overlapping calls to desktopCapturer.getSources()
    isGrabbingInProgress = true
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      })
      return sources && sources.length > 0
    } finally {
      isGrabbingInProgress = false
    }
  } catch (error) {
    console.error('Error checking screen capture permission:', error)
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
    
    // If no custom command exists, set a default one based on takeGnomeScreenshot logic
    if (!customCommand) {
      // Create a default command that includes the full gsettings logic
      customCommand = `bash -c 'getOriginalAnimationSetting=$(gsettings get org.gnome.desktop.interface enable-animations); getOriginalSoundSetting=$(gsettings get org.gnome.desktop.sound event-sounds); gsettings set org.gnome.desktop.interface enable-animations false; gsettings set org.gnome.desktop.sound event-sounds false; gnome-screenshot -f "%s"; gsettings set org.gnome.desktop.interface enable-animations $getOriginalAnimationSetting; gsettings set org.gnome.desktop.sound event-sounds $getOriginalSoundSetting'`;
      
      // Save the default command to store
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
    
    // Only use Linux command - no fallback detection
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

// Helper function to wait with exponential backoff (total wait capped at 10 seconds)
async function waitWithBackoff(attempt, totalWaited) {
  const baseDelay = 1000 // 1 second
  const maxTotalWait = 10000 // 10 seconds total
  const remainingWait = maxTotalWait - totalWaited
  if (remainingWait <= 0) {
    return 0
  }
  const delay = Math.min(baseDelay * Math.pow(2, attempt), remainingWait)
  await new Promise(resolve => setTimeout(resolve, delay))
  return delay
}

// Use a single unified method for all platforms - only captures screenshots
async function captureScreenshot() {
  try {
    let screenshots = [];
    
    // Use Linux-specific method on Linux platforms
    if (process.platform === 'linux') {
      screenshots = await captureScreenshotsLinux();
    } else {
      // Wait with exponential backoff if already grabbing (max 10 seconds total)
      let attempt = 0
      let totalWaited = 0
      const maxTotalWait = 10000 // 10 seconds total
      while (isGrabbingInProgress && totalWaited < maxTotalWait) {
        const delay = await waitWithBackoff(attempt, totalWaited)
        if (delay === 0) break
        totalWaited += delay
        attempt++
      }
      
      // Give up if still grabbing after backoff
      if (isGrabbingInProgress) {
        log.warn('Screenshot capture skipped - grab still in progress after backoff')
        return []
      }
      
      // Use the standard Electron approach for other platforms
      isGrabbingInProgress = true
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 }
        });
        
        if (sources.length === 0) {
          log.warn('No screen sources found');
          return [];
        }      
        // Process each source
        screenshots = await Promise.all(
          sources.map(async source => {
            return await processScreenshotForUpload(source.thumbnail.toDataURL());
          })
        );
      } finally {
        isGrabbingInProgress = false
      }
    }
    
    if (screenshots.length === 0) {
      log.warn('No screenshots captured');
      return [];
    }

    // Save the current screenshot for next upload
    saveCurrentScreenshot(screenshots);

    return screenshots;
  } catch (error) {
    isGrabbingInProgress = false
    log.error('Screenshot capture error:', error.message, error.stack);
    return [];
  }
}

// Simplified Linux screenshot function - only uses custom command
async function captureScreenshotsLinux() {
  try {
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
async function processScreenshotForUpload(dataUrl) {
  try {
    // Convert data URL to buffer
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    const buffer = Buffer.from(base64Data, 'base64')
    
    // Create native image from buffer
    let img = nativeImage.createFromBuffer(buffer)
    
    // Get original dimensions
    const { width, height } = img.getSize()
    
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
    
    // Convert back to data URL
    return `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`
  } catch (error) {
    console.error('Error processing screenshot:', error)
    // Return original as fallback
    return dataUrl
  }
}

// Initialize screen capture permission handling
function initScreenCapturePermissionHandling(mainWindow, stateManager, checkAndAdjustRecording, sendOverlayState) {
  ipcMain.on('requestScreenCapturePermission', async () => {
    // On macOS this would open System Preferences > Security & Privacy > Screen Recording
    // On Windows there isn't a direct way to open system settings for this
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
      const hasPermission = await checkScreenCapturePermission();
      stateManager?.updateScreenCapturePermission(hasPermission);

      if (stateManager?.hasScreenCapturePermission() !== oldPermission && mainWindow) { // Check if permission *changed*
        mainWindow.webContents.send('screenCapturePermission', {
          hasPermission: stateManager?.hasScreenCapturePermission()
        });

        // Re-evaluate recording state based on permission change
        if (checkAndAdjustRecording) checkAndAdjustRecording();
        if (sendOverlayState) sendOverlayState();
      }
    };
    
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
  PREVIOUS_SCREENSHOT_SCALE_FACTOR,
  initScreenCapturePermissionHandling,
  setLinuxScreenshotCommand,
  loadLinuxScreenshotCommand
} 