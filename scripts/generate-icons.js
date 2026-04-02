#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isElectronRuntime = Boolean(process.versions.electron);
const rootDir = path.resolve(__dirname, '..');
const resourcesDir = path.join(rootDir, 'resources');
const electronBinary = isElectronRuntime ? process.execPath : require('electron');

const inputs = {
  launcherPng: path.join(resourcesDir, 'icon-launcher.png'),
  recordingSvg: path.join(resourcesDir, 'icon_recording.svg'),
  pausedSvg: path.join(resourcesDir, 'icon_paused.svg'),
  recordingInverseSvg: path.join(resourcesDir, 'icon_recording_inverse.svg'),
  pausedInverseSvg: path.join(resourcesDir, 'icon_paused_inverse.svg')
};

const outputs = [
  path.join(resourcesDir, 'icon_recording.png'),
  path.join(resourcesDir, 'icon_paused.png'),
  path.join(resourcesDir, 'icon_recording.ico'),
  path.join(resourcesDir, 'icon_paused.ico'),
  path.join(resourcesDir, 'icon-launcher.ico'),
  path.join(resourcesDir, 'icon_recording_inverse.png'),
  path.join(resourcesDir, 'icon_paused_inverse.png')
];

function fail(message) {
  console.error(`[generate-icons] ${message}`);
  process.exit(1);
}

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing file: ${path.relative(rootDir, filePath)}`);
  }
}

function ensureCommand(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
  } catch (error) {
    fail(`Required command not found: ${command}`);
  }
}

function run(command, args, label, execOpts = {}) {
  try {
    execFileSync(command, args, { stdio: 'inherit', ...execOpts });
  } catch (error) {
    const renderedArgs = args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
    fail(`Command failed: ${label || command} ${renderedArgs}`);
  }
}

function rasterizeSvg(inputPath, outputPath) {
  // If ELECTRON_RUN_AS_NODE is set (e.g. by some dev tools), Electron runs as plain Node and
  // require('electron') returns the binary path string — SVG rasterization must run real Electron.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  run(electronBinary, [__filename, '--render-svg', inputPath, outputPath], 'electron', { env });
}

function renderTrayPng(inputPath, outputPath) {
  run(
    'magick',
    [
      inputPath,
      '-trim',
      '+repage',
      '-background',
      'none',
      '-resize',
      '32x32',
      '-gravity',
      'center',
      '-extent',
      '32x32',
      outputPath
    ],
    'magick'
  );
}

function renderIco(inputPath, outputPath, sizes) {
  run(
    'magick',
    [
      inputPath,
      '-background',
      'none',
      '-define',
      `icon:auto-resize=${sizes.join(',')}`,
      outputPath
    ],
    'magick'
  );
}

function parseViewport(svgText) {
  const viewBoxMatch = svgText.match(/viewBox="[^"]*?\s+[^"]*?\s+([0-9.]+)\s+([0-9.]+)"/i);
  if (viewBoxMatch) {
    return {
      width: Math.ceil(Number(viewBoxMatch[1])),
      height: Math.ceil(Number(viewBoxMatch[2]))
    };
  }

  const widthMatch = svgText.match(/width="([0-9.]+)"/i);
  const heightMatch = svgText.match(/height="([0-9.]+)"/i);
  if (widthMatch && heightMatch) {
    return {
      width: Math.ceil(Number(widthMatch[1])),
      height: Math.ceil(Number(heightMatch[1]))
    };
  }

  fail('Could not determine SVG viewport size.');
}

async function waitForSvgLoad(window) {
  await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const image = document.getElementById('svg');
      if (!image) {
        reject(new Error('SVG image element not found.'));
        return;
      }
      if (image.complete) {
        resolve();
        return;
      }
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => reject(new Error('Failed to load SVG image.')), { once: true });
    });
  `);
}

async function renderSvgWithElectron(inputPath, outputPath) {
  const { app, BrowserWindow } = require('electron');
  const absoluteInputPath = path.resolve(inputPath);
  const absoluteOutputPath = path.resolve(outputPath);

  if (!fs.existsSync(absoluteInputPath)) {
    fail(`Missing input SVG: ${absoluteInputPath}`);
  }

  const svgText = fs.readFileSync(absoluteInputPath, 'utf8');
  const { width, height } = parseViewport(svgText);
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}`;
  const html = `
    <!doctype html>
    <html>
      <body style="margin:0;background:transparent;overflow:hidden;">
        <img
          id="svg"
          src="${svgDataUrl}"
          style="display:block;width:${width}px;height:${height}px;"
        />
      </body>
    </html>
  `;

  const window = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      backgroundThrottling: false
    }
  });

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await waitForSvgLoad(window);

  const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
  fs.writeFileSync(absoluteOutputPath, image.toPNG());

  window.destroy();
  app.quit();
}

function generateTrayIcons() {
  ensureCommand('magick');
  ensureFile(electronBinary);
  Object.values(inputs).forEach(ensureFile);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donethat-icons-'));
  const recordingRasterPath = path.join(tempDir, 'icon_recording-raster.png');
  const pausedRasterPath = path.join(tempDir, 'icon_paused-raster.png');
  const recordingInverseRasterPath = path.join(tempDir, 'icon_recording_inverse-raster.png');
  const pausedInverseRasterPath = path.join(tempDir, 'icon_paused_inverse-raster.png');

  try {
    rasterizeSvg(inputs.recordingSvg, recordingRasterPath);
    rasterizeSvg(inputs.pausedSvg, pausedRasterPath);
    rasterizeSvg(inputs.recordingInverseSvg, recordingInverseRasterPath);
    rasterizeSvg(inputs.pausedInverseSvg, pausedInverseRasterPath);
    renderTrayPng(recordingRasterPath, outputs[0]);
    renderTrayPng(pausedRasterPath, outputs[1]);
    renderTrayPng(recordingInverseRasterPath, outputs[5]);
    renderTrayPng(pausedInverseRasterPath, outputs[6]);
    renderIco(outputs[0], outputs[2], [32, 24, 20, 16]);
    renderIco(outputs[1], outputs[3], [32, 24, 20, 16]);
    renderIco(inputs.launcherPng, outputs[4], [256, 128, 64, 48, 32, 24, 20, 16]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('[generate-icons] Generated assets:');
  outputs.forEach((outputPath) => {
    console.log(`- ${path.relative(rootDir, outputPath)}`);
  });
}

async function main() {
  const [mode, inputPath, outputPath] = process.argv.slice(2);

  if (mode === '--render-svg') {
    const { app } = require('electron');
    await app.whenReady();
    await renderSvgWithElectron(inputPath, outputPath);
    return;
  }

  generateTrayIcons();
}

main().catch((error) => fail(error.message));
