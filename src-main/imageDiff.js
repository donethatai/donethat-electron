const log = require('electron-log')
const { Jimp } = require('jimp')
const looksSame = require('looks-same')

const THICKNESS = 8
const RED = 0xff0000ff
const CLUSTERS_SIZE = 30
const TOLERANCE = 5

/**
 * Draw red border rectangles on image for each cluster
 * Draws INSIDE cluster bounds (original logic drew outside, yielding zero-sized bars when cluster touched edges)
 */
async function drawBordersOnImage(jimpImage, clusters) {
  if (!clusters || clusters.length === 0) return jimpImage

  const imageWidth = jimpImage.bitmap.width
  const imageHeight = jimpImage.bitmap.height

  for (const c of clusters) {
    const left = Math.max(0, c.left)
    const top = Math.max(0, c.top)
    const right = Math.min(imageWidth, c.right)
    const bottom = Math.min(imageHeight, c.bottom)
    const w = right - left
    const h = bottom - top
    if (w <= 0 || h <= 0) continue

    const t = Math.min(THICKNESS, Math.max(1, Math.floor(w / 2), Math.floor(h / 2)))
    const bars = [
      { x: left, y: top, w, h: t },
      { x: left, y: bottom - t, w, h: t },
      { x: left, y: top + t, w: t, h: Math.max(0, h - 2 * t) },
      { x: right - t, y: top + t, w: t, h: Math.max(0, h - 2 * t) }
    ]

    for (const bar of bars) {
      if (bar.w <= 0 || bar.h <= 0) continue
      const rect = new Jimp({ width: bar.w, height: bar.h, color: RED })
      jimpImage.composite(rect, bar.x, bar.y, { mode: 'srcOver' })
    }
  }

  return jimpImage
}

/**
 * Draw full-frame red border (used when no previous screenshot to compare)
 * Draws border INSIDE the image along the edges (cluster-based logic draws outside, which yields zero for full-frame)
 */
async function drawFullFrameBorder(jimpImage) {
  const w = jimpImage.bitmap.width
  const h = jimpImage.bitmap.height
  const t = THICKNESS
  const bars = [
    { x: 0, y: 0, w: w, h: t },
    { x: 0, y: h - t, w: w, h: t },
    { x: 0, y: t, w: t, h: h - 2 * t },
    { x: w - t, y: t, w: t, h: h - 2 * t }
  ]
  for (const bar of bars) {
    if (bar.w <= 0 || bar.h <= 0) continue
    const rect = new Jimp({ width: bar.w, height: bar.h, color: RED })
    jimpImage.composite(rect, bar.x, bar.y, { mode: 'srcOver' })
  }
  return jimpImage
}

/**
 * Apply image diff bounding boxes to screenshots
 * @param {Array<string>} screenshots Array of data URLs (current)
 * @param {Object} prevData { images: [{ base64Data, index }], timestamp }
 * @returns {Promise<Array<string>>} Screenshots with red boxes on changed regions
 */
async function applyImageDiffBoundingBoxes(screenshots, prevData) {
  try {
    if (!screenshots || screenshots.length === 0) return screenshots

    const prevImages = prevData?.images
    const hasPrev = prevImages && prevImages.length > 0

    if (!hasPrev) {
      const result = [...screenshots]
      for (let i = 0; i < screenshots.length; i++) {
        const currentShot = screenshots[i]
        const dataUrl = typeof currentShot === 'string' ? currentShot : currentShot?.base64Data
        if (!dataUrl || typeof dataUrl !== 'string') continue
        try {
          const currentImg = await Jimp.read(dataUrl)
          const withBorder = await drawFullFrameBorder(currentImg.clone())
          const jpegBuffer = await withBorder.getBuffer('image/jpeg', { quality: 70 })
          result[i] = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`
        } catch (err) {
          log.warn('Image diff failed (no prev) for index', i, err.message)
        }
      }
      return result
    }

    const result = [...screenshots]

    for (let i = 0; i < screenshots.length && i < prevImages.length; i++) {
      const currentShot = screenshots[i]
      const prevShot = prevImages[i]
      const prevBase64 = prevShot?.base64Data || prevShot

      if (!currentShot || !prevBase64) continue

      const currentDataUrl = typeof currentShot === 'string' ? currentShot : currentShot.base64Data
      const prevDataUrl = typeof prevBase64 === 'string' ? prevBase64 : prevBase64
      if (!currentDataUrl || !prevDataUrl) continue

      try {
        const currentImg = await Jimp.read(currentDataUrl)
        const prevImg = await Jimp.read(prevDataUrl)

        const currentW = currentImg.bitmap.width
        const currentH = currentImg.bitmap.height
        const prevW = prevImg.bitmap.width
        const prevH = prevImg.bitmap.height

        if (!currentW || !currentH || !prevW || !prevH) continue

        let prevPng
        if (currentW !== prevW || currentH !== prevH) {
          const resized = prevImg.clone().resize({ w: currentW, h: currentH })
          prevPng = await resized.getBuffer('image/png')
        } else {
          prevPng = await prevImg.clone().getBuffer('image/png')
        }

        const currentPng = await currentImg.clone().getBuffer('image/png')

        const { equal, diffClusters } = await looksSame(prevPng, currentPng, {
          shouldCluster: true,
          clustersSize: CLUSTERS_SIZE,
          tolerance: TOLERANCE
        })

        if (!equal && diffClusters && diffClusters.length > 0) {
          const withBorders = await drawBordersOnImage(currentImg.clone(), diffClusters)
          const jpegBuffer = await withBorders.getBuffer('image/jpeg', { quality: 70 })
          result[i] = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`
        }
      } catch (err) {
        log.warn('Image diff failed for pair', i, err.message)
      }
    }

    return result
  } catch (error) {
    log.error('Error in applyImageDiffBoundingBoxes:', error)
    return screenshots
  }
}

module.exports = {
  applyImageDiffBoundingBoxes
}
