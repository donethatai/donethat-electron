const log = require('electron-log')
const windowsCapture = require('./captureWindows')
const { shouldExcludeWindow } = windowsCapture

/**
 * Calculate visible region of a window (not covered by allowed windows)
 * Assumes allWindows is already sorted by z-order (topmost first)
 * @param {Object} window Window to check
 * @param {Array} allWindows All windows (already sorted: activity windows, then excluded no-activity, then non-excluded no-activity)
 * @param {Object} screenBounds Screen bounds
 * @returns {Array} Array of rectangles to mask [{x, y, width, height}]
 */
function calculateVisibleRegion(window, allWindows, screenBounds) {
  if (!window.bounds) {
    return []
  }
  
  const windowBounds = window.bounds
  const windowRect = {
    x: windowBounds.x,
    y: windowBounds.y,
    width: windowBounds.width,
    height: windowBounds.height
  }
  
  // Clamp window to screen bounds
  const clampedRect = {
    x: Math.max(windowRect.x, screenBounds.x),
    y: Math.max(windowRect.y, screenBounds.y),
    width: Math.min(windowRect.x + windowRect.width, screenBounds.x + screenBounds.width) - Math.max(windowRect.x, screenBounds.x),
    height: Math.min(windowRect.y + windowRect.height, screenBounds.y + screenBounds.height) - Math.max(windowRect.y, screenBounds.y)
  }
  
  if (clampedRect.width <= 0 || clampedRect.height <= 0) {
    log.warn(`Window clamped to zero size:`, { windowRect, screenBounds, clampedRect })
    return []
  }
  
  // Find the index of our window in the pre-sorted list (same object reference)
  const windowIndex = allWindows.indexOf(window)
  
  if (windowIndex === -1) {
    // Window not in list, mask entire region
    return [{
      x: clampedRect.x - screenBounds.x,
      y: clampedRect.y - screenBounds.y,
      width: clampedRect.width,
      height: clampedRect.height
    }]
  }
  
  // Get windows that are on top (earlier in array = higher z-order)
  const topWindows = allWindows.slice(0, windowIndex)
  
  // Start with full window region
  let visibleRegions = [clampedRect]
  
  // Subtract regions covered by windows on top
  for (const topWindow of topWindows) {
    if (!topWindow.bounds) continue
    
    const topBounds = topWindow.bounds
    const topRect = {
      x: topBounds.x,
      y: topBounds.y,
      width: topBounds.width,
      height: topBounds.height
    }
    
    // Check if top window overlaps with our window
    const noOverlap = topRect.x + topRect.width <= clampedRect.x ||
        topRect.x >= clampedRect.x + clampedRect.width ||
        topRect.y + topRect.height <= clampedRect.y ||
        topRect.y >= clampedRect.y + clampedRect.height
    
    if (noOverlap) {
      // No overlap
      continue
    }
    
    // Calculate overlap region
    const overlapX = Math.max(topRect.x, clampedRect.x)
    const overlapY = Math.max(topRect.y, clampedRect.y)
    const overlapWidth = Math.min(topRect.x + topRect.width, clampedRect.x + clampedRect.width) - overlapX
    const overlapHeight = Math.min(topRect.y + topRect.height, clampedRect.y + clampedRect.height) - overlapY
    
    if (overlapWidth <= 0 || overlapHeight <= 0) {
      continue
    }
    
    // Subtract overlap from visible regions
    const newVisibleRegions = []
    for (const region of visibleRegions) {
      // Check if overlap intersects with this region
      if (overlapX + overlapWidth <= region.x ||
          overlapX >= region.x + region.width ||
          overlapY + overlapHeight <= region.y ||
          overlapY >= region.y + region.height) {
        // No intersection, keep region
        newVisibleRegions.push(region)
        continue
      }
      
      // Split region around overlap
      // Top rectangle
      if (region.y < overlapY) {
        const topRegion = {
          x: region.x,
          y: region.y,
          width: region.width,
          height: overlapY - region.y
        }
        if (topRegion.width > 0 && topRegion.height > 0) {
          newVisibleRegions.push(topRegion)
        }
      }
      
      // Bottom rectangle
      if (region.y + region.height > overlapY + overlapHeight) {
        const bottomRegion = {
          x: region.x,
          y: overlapY + overlapHeight,
          width: region.width,
          height: (region.y + region.height) - (overlapY + overlapHeight)
        }
        if (bottomRegion.width > 0 && bottomRegion.height > 0) {
          newVisibleRegions.push(bottomRegion)
        }
      }
      
      // Left rectangle
      if (region.x < overlapX) {
        const leftRegion = {
          x: region.x,
          y: Math.max(region.y, overlapY),
          width: overlapX - region.x,
          height: Math.min(region.y + region.height, overlapY + overlapHeight) - Math.max(region.y, overlapY)
        }
        if (leftRegion.width > 0 && leftRegion.height > 0) {
          newVisibleRegions.push(leftRegion)
        }
      }
      
      // Right rectangle
      if (region.x + region.width > overlapX + overlapWidth) {
        const rightRegion = {
          x: overlapX + overlapWidth,
          y: Math.max(region.y, overlapY),
          width: (region.x + region.width) - (overlapX + overlapWidth),
          height: Math.min(region.y + region.height, overlapY + overlapHeight) - Math.max(region.y, overlapY)
        }
        if (rightRegion.width > 0 && rightRegion.height > 0) {
          newVisibleRegions.push(rightRegion)
        }
      }
    }
    
    visibleRegions = newVisibleRegions
  }
  
  // Filter out zero-size regions and adjust coordinates relative to screen
  const finalRegions = visibleRegions
    .filter(r => r.width > 0 && r.height > 0)
    .map(r => ({
      x: r.x - screenBounds.x,
      y: r.y - screenBounds.y,
      width: r.width,
      height: r.height
    }))
  
  // If no visible regions remain, fallback to masking entire window (for privacy)
  if (finalRegions.length === 0) {
    return [{
      x: clampedRect.x - screenBounds.x,
      y: clampedRect.y - screenBounds.y,
      width: clampedRect.width,
      height: clampedRect.height
    }]
  }
  
  return finalRegions
}

/**
 * Apply mask regions to an image
 * @param {string} imageDataUrl Image as data URL
 * @param {Array} maskRegions Array of rectangles to mask [{x, y, width, height}]
 * @param {Object} screenBounds Screen bounds with width and height
 * @returns {Promise<string>} Masked image as data URL
 */
async function applyMaskToImage(imageDataUrl, maskRegions, screenBounds) {
  try {
    if (!maskRegions || maskRegions.length === 0) {
      return imageDataUrl
    }
    
    // Convert data URL to buffer
    const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '')
    const buffer = Buffer.from(base64Data, 'base64')
    
    const sharp = require('sharp')
    
    // Convert to sharp image and get actual dimensions
    let sharpImg = sharp(buffer)
    const metadata = await sharpImg.metadata()
    const imageWidth = metadata.width
    const imageHeight = metadata.height
    
    // Calculate scale factors (screenshots are thumbnails, may be scaled)
    const screenWidth = screenBounds.width
    const screenHeight = screenBounds.height
    const scaleX = imageWidth / screenWidth
    const scaleY = imageHeight / screenHeight
    
    // Create a single mask image with all regions drawn as gray rectangles
    // This is more reliable than compositing multiple small images
    const maskImage = sharp({
      create: {
        width: imageWidth,
        height: imageHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 } // Transparent background
      }
    })
    
    // Draw all gray rectangles on the mask image
    const maskComposites = []
    for (const region of maskRegions) {
      // Scale region coordinates to match screenshot dimensions
      const x = Math.round(region.x * scaleX)
      const y = Math.round(region.y * scaleY)
      const regionWidth = Math.round(region.width * scaleX)
      const regionHeight = Math.round(region.height * scaleY)
      
      // Ensure region coordinates are within image bounds
      const clampedX = Math.max(0, Math.min(x, imageWidth - 1))
      const clampedY = Math.max(0, Math.min(y, imageHeight - 1))
      const clampedWidth = Math.max(1, Math.min(regionWidth, imageWidth - clampedX))
      const clampedHeight = Math.max(1, Math.min(regionHeight, imageHeight - clampedY))
      
      if (clampedWidth <= 0 || clampedHeight <= 0) {
        continue
      }
      
      // Create gray rectangle
      const grayRectBuffer = await sharp({
        create: {
          width: clampedWidth,
          height: clampedHeight,
          channels: 4,
          background: { r: 128, g: 128, b: 128, alpha: 1.0 }
        }
      }).png().toBuffer()
      
      maskComposites.push({
        input: grayRectBuffer,
        left: clampedX,
        top: clampedY,
        blend: 'over'
      })
    }
    
    if (maskComposites.length === 0) {
      log.warn('No valid mask regions after scaling/clamping')
      return imageDataUrl
    }
    
    // Create the complete mask image with all gray rectangles
    const maskBuffer = await maskImage
      .composite(maskComposites)
      .png()
      .toBuffer()
    
    // Now composite the mask onto the original image
    const maskedBuffer = await sharpImg
      .composite([{
        input: maskBuffer,
        left: 0,
        top: 0,
        blend: 'over'
      }])
      .jpeg({ quality: 70 })
      .toBuffer()
    
    return `data:image/jpeg;base64,${maskedBuffer.toString('base64')}`
  } catch (error) {
    log.error('Error in applyMaskToImage:', error)
    log.error('Error stack:', error.stack)
    return imageDataUrl
  }
}

/**
 * Mask excluded apps from screenshots (internal function with all parameters)
 * @param {Array} screenshots Array of screenshot data URLs
 * @param {Array} excludedApps Array of exclusion rules [{appName, titlePattern}]
 * @param {Array} windowData Array of window info with bounds, screen, app name, title (already sorted by z-order)
 * @param {Array} displayBounds Array of display bounds from screen.getAllDisplays()
 * @returns {Promise<Array>} Masked screenshots array
 */
async function maskExcludedApps(screenshots, excludedApps, windowData, displayBounds) {
  try {
    if (!excludedApps || excludedApps.length === 0) {
      return screenshots
    }
    
    if (!windowData || windowData.length === 0) {
      return screenshots
    }
    
    if (!displayBounds || displayBounds.length === 0) {
      return screenshots
    }
    
    // Process each screenshot
    const maskedScreenshots = []
    
    for (let i = 0; i < screenshots.length; i++) {
      const screenshot = screenshots[i]
      const display = displayBounds[i]
      
      if (!display || !display.bounds) {
        maskedScreenshots.push(screenshot)
        continue
      }
      
      const screenBounds = display.bounds
      
      // Filter windows that are on this screen
      const windowsOnScreen = windowData.filter(window => {
        if (!window.bounds || window.screen === undefined) return false
        return window.screen === i
      })
      
      // Find excluded windows
      const excludedWindows = windowsOnScreen.filter(window => {
        return shouldExcludeWindow(window, excludedApps)
      })
      
      if (excludedWindows.length === 0) {
        maskedScreenshots.push(screenshot)
        continue
      }
      
      // Reorder windows for z-order calculation:
      // 1. All windows with activity (both excluded and non-excluded) - keep original order
      // 2. All excluded windows without activity - keep original order
      // 3. All non-excluded windows without activity - keep original order
      // Helper to check if two windows are the same (for clarity and defensiveness)
      const isSameWindow = (w1, w2) => {
        if (!w1.bounds || !w2.bounds) return false
        return w1.appName === w2.appName &&
               w1.bounds.x === w2.bounds.x &&
               w1.bounds.y === w2.bounds.y &&
               w1.bounds.width === w2.bounds.width &&
               w1.bounds.height === w2.bounds.height
      }
      
      const windowsWithActivity = windowsOnScreen.filter(w => w.hasActivity === true)
      const excludedNoActivity = windowsOnScreen.filter(w => 
        w.hasActivity !== true && excludedWindows.some(ex => isSameWindow(ex, w))
      )
      const nonExcludedNoActivity = windowsOnScreen.filter(w => 
        w.hasActivity !== true && !excludedWindows.some(ex => isSameWindow(ex, w))
      )
      const reorderedWindows = [...windowsWithActivity, ...excludedNoActivity, ...nonExcludedNoActivity]
      
      // Calculate mask regions for each excluded window
      const allMaskRegions = []
      for (const excludedWindow of excludedWindows) {
        const regions = calculateVisibleRegion(excludedWindow, reorderedWindows, screenBounds)
        allMaskRegions.push(...regions)
      }
      
      // Apply masks to image
      if (allMaskRegions.length > 0) {
        // Screenshots from desktopCapturer are thumbnails (typically 1920x1080)
        // We need to scale the mask regions to match the actual screenshot dimensions
        const maskedImage = await applyMaskToImage(screenshot, allMaskRegions, screenBounds)
        maskedScreenshots.push(maskedImage)
      } else {
        log.warn(`Screen ${i}: No mask regions calculated, skipping masking`)
        maskedScreenshots.push(screenshot)
      }
    }
    
    return maskedScreenshots
  } catch (error) {
    log.error('Error masking excluded apps:', error)
    return screenshots
  }
}

/**
 * Apply app exclusions to screenshots (public API)
 * Handles loading exclusions from store, gathering window data, and applying masks
 * @param {Array} screenshots Array of screenshot data URLs
 * @returns {Promise<Array>} Masked screenshots array (or original if no exclusions or error)
 */
async function applyAppExclusions(screenshots) {
  try {
    if (!screenshots || screenshots.length === 0) {
      return screenshots
    }

    // Load exclusions from electron-store
    const { default: Store } = await import('electron-store')
    const { app } = require('electron')
    const store = new Store({ name: 'donethat-config', cwd: app.getPath('userData') })
    const exclusions = store.get('appExclusions') || []

    if (!exclusions || exclusions.length === 0) {
      return screenshots
    }

    // Get window data (already sorted by z-order) and display bounds
    const { screen } = require('electron')
    const windowData = await windowsCapture.getAllVisibleWindows()
    const displayBounds = screen.getAllDisplays()

    if (!windowData || windowData.length === 0 || !displayBounds || displayBounds.length === 0) {
      return screenshots
    }

    // Apply masking (windows are already sorted by z-order)
    return await maskExcludedApps(screenshots, exclusions, windowData, displayBounds)
  } catch (error) {
    log.error('Error applying app exclusions:', error)
    return screenshots
  }
}

module.exports = {
  applyAppExclusions
}

