const { desktopCapturer, nativeImage, screen } = require('electron')
const { execSync } = require('child_process')
const path = require('path')
const log = require('electron-log')

// Store tool and session state
let linuxScreenshotTool = null
let isWaylandSession = null

// Store the last captured screenshots for next upload
let lastScreenshots = null
let lastScreenshotTimestamp = null

// Scale factor for previous screenshot (25% = 0.25)
const PREVIOUS_SCREENSHOT_SCALE_FACTOR = 0.25
// Maximum age factor for previous screenshot (1.5x the capture interval)
const PREVIOUS_SCREENSHOT_MAX_AGE_FACTOR = 1.5

///// UTILITIES /////

// Wayland vs X11 for linux
function _checkSessionType() {
  // Check if running on Wayland
  isWaylandSession = process.env.XDG_SESSION_TYPE === 'wayland'
  return isWaylandSession
}

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
    
    // For other platforms (macOS, Windows)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 }
    })
    
    return sources && sources.length > 0
  } catch (error) {
    console.error('Error checking screen capture permission:', error)
    return false
  }
}

// Helper function to handle gnome-screenshot with animations disabled
async function takeGnomeScreenshot(outputPath) {
  // Save original animation and sound settings to restore later
  const getOriginalAnimationSetting = execSync('gsettings get org.gnome.desktop.interface enable-animations').toString().trim()
  const getOriginalSoundSetting = execSync('gsettings get org.gnome.desktop.sound event-sounds').toString().trim()

  try {
    // Disable animations and sounds
    execSync('gsettings set org.gnome.desktop.interface enable-animations false')
    execSync('gsettings set org.gnome.desktop.sound event-sounds false')
    
    // Take screenshot with gnome-screenshot
    execSync(`gnome-screenshot -f "${outputPath}"`, { timeout: 5000 })
  } finally {
    // Restore original settings (even if screenshot fails)
    execSync(`gsettings set org.gnome.desktop.interface enable-animations ${getOriginalAnimationSetting}`)
    execSync(`gsettings set org.gnome.desktop.sound event-sounds ${getOriginalSoundSetting}`)
  }
}

// Linux-specific permission checking and tool detection
async function checkLinuxScreenCapturePermission() {
  _checkSessionType() // Use the renamed internal function
  // Session type already checked by parent function
  try {

    const fs = require('fs')
    const os = require('os')
    const tempDir = os.tmpdir()
    const testPath = path.join(tempDir, `test-screenshot-${Date.now()}.png`)
        
    // Check available tools based on the environment
    if (isWaylandSession) {
      // For Wayland, check if gnome-screenshot is available
      try {
        execSync('which gnome-screenshot', { stdio: 'ignore' })
        
        // Try to take a test screenshot with animations disabled
        await takeGnomeScreenshot(testPath)
        
        if (fs.existsSync(testPath)) {
          fs.unlinkSync(testPath)
          linuxScreenshotTool = 'gnome-screenshot'
          return true
        }
      } catch (e) {
      }
      
      linuxScreenshotTool = null
      return false
    } else {
      // For X11, try scrot first, then maim
      try {
        execSync('which scrot', { stdio: 'ignore' })
        
        execSync(`scrot -z "${testPath}"`, { timeout: 3000 })
        
        if (fs.existsSync(testPath)) {
          fs.unlinkSync(testPath)
          linuxScreenshotTool = 'scrot'
          return true
        }
      } catch (e) {
      }
      
      // Try maim as alternative
      try {
        execSync('which maim', { stdio: 'ignore' })

        execSync(`maim "${testPath}"`, { timeout: 3000 })
        
        if (fs.existsSync(testPath)) {
          fs.unlinkSync(testPath)
          linuxScreenshotTool = 'maim'
          return true
        }
      } catch (e) {
      }
      
      linuxScreenshotTool = null
      return false
    }
  } catch (error) {
    log.error('Linux screenshot permission check failed:', error)
    linuxScreenshotTool = null
    return false
  }
}

///// MAIN /////

// Use a single unified method for all platforms - only captures screenshots
async function captureScreenshot() {
  try {
    let screenshots = [];
    
    // Use Linux-specific method on Linux platforms
    if (process.platform === 'linux') {
      screenshots = await captureScreenshotsLinux();
    } else {
      // Use the standard Electron approach for other platforms
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
    }
    
    if (screenshots.length === 0) {
      log.warn('No screenshots captured');
      return [];
    }

    // Save the current screenshot for next upload
    saveCurrentScreenshot(screenshots);

    return screenshots;
  } catch (error) {
    log.error('Screenshot capture error:', error.message, error.stack);
    return [];
  }
}

// Simplified Linux screenshot function using the detected tool
async function captureScreenshotsLinux() {
  try {
    // If no tool was found during permission check, abort
    if (!linuxScreenshotTool) {
      log.error('No screenshot tool available for Linux')
      return []
    }
    
    const fs = require('fs')
    const os = require('os')
    const tempDir = os.tmpdir()
    const screenshotPath = path.join(tempDir, `screenshot-${Date.now()}.png`)
    
    // Use the appropriate tool based on what was detected
    if (linuxScreenshotTool === 'gnome-screenshot') {
      // For Wayland with gnome-screenshot
      try {
        await takeGnomeScreenshot(screenshotPath)
      } catch (e) {
        log.error(`gnome-screenshot failed: ${e.message}`)
        return []
      }
    } else if (linuxScreenshotTool === 'scrot') {
      // For X11 with scrot
      try {
        execSync(`scrot -z "${screenshotPath}"`, { timeout: 5000 })
      } catch (e) {
        log.error(`scrot failed: ${e.message}`)
        return []
      }
    } else if (linuxScreenshotTool === 'maim') {
      // For X11 with maim
      try {
        execSync(`maim "${screenshotPath}"`, { timeout: 5000 })
      } catch (e) {
        log.error(`maim failed: ${e.message}`)
        return []
      }
    } else {
      log.error(`Unknown screenshot tool: ${linuxScreenshotTool}`)
      return []
    }
    
    // Process the screenshot if it was created successfully
    if (fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 0) {
      const screenshotData = fs.readFileSync(screenshotPath)
      const base64Data = `data:image/png;base64,${screenshotData.toString('base64')}`
      fs.unlinkSync(screenshotPath)
      
      // For multi-monitor setups
      if (linuxScreenshotTool === 'gnome-screenshot') {
        // Process for all displays if needed
        const displays = await getLinuxDisplays()
        
        if (displays.length <= 1) {
          // If only one display, just process the whole image
          const processedImage = await processScreenshotForUpload(base64Data)
          return [processedImage]
        } else {
          // For multiple displays, crop the image for each display
          return await cropScreenshots(
            Buffer.from(base64Data.split(',')[1], 'base64'),
            displays.map(d => d.bounds)
          )
        }
      } else {
        // For scrot and maim, just process the whole image
        const processedImage = await processScreenshotForUpload(base64Data)
        return [processedImage]
      }
    } else {
      log.error('Screenshot file was not created or is empty')
      return []
    }
  } catch (error) {
    log.error('Failed to capture Linux screenshot:', error)
    return []
  }
}

// Helper function to get Linux display information for multi-monitor setups
async function getLinuxDisplays() {
  try {
    // For X11, we can use xrandr to get display information
    if (process.env.XDG_SESSION_TYPE !== 'wayland') {
      const { execSync } = require('child_process')
      const xrandrOutput = execSync('xrandr --current').toString()
      
      // Parse the output to get display information
      const displays = []
      const displayRegex = /(\S+) connected (\d+)x(\d+)\+(\d+)\+(\d+)/g
      let match
      
      while ((match = displayRegex.exec(xrandrOutput)) !== null) {
        const [, name, width, height, x, y] = match
        displays.push({
          name,
          bounds: {
            x: parseInt(x),
            y: parseInt(y),
            width: parseInt(width),
            height: parseInt(height)
          }
        })
      }
      
      if (displays.length > 0) {
        return displays
      }
    }
    
    // Fallback to electron's screen module
    const displays = screen.getAllDisplays().map(display => ({
      name: `Display ${display.id}`,
      bounds: display.bounds
    }))
    
    return displays
  } catch (error) {
    log.error('Failed to get Linux displays:', error)
    // Default to the primary display
    const primaryDisplay = screen.getPrimaryDisplay()
    return [{
      name: 'Primary Display',
      bounds: primaryDisplay.bounds
    }]
  }
}

// Modified function to crop screenshots using Electron's nativeImage
async function cropScreenshots(imageBuffer, displays) {
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

module.exports = {
  captureScreenshot,
  checkScreenCapturePermission,
  getWaylandStatus: () => isWaylandSession,
  getPreviousScreenshots,
  saveCurrentScreenshot,
  PREVIOUS_SCREENSHOT_SCALE_FACTOR
} 