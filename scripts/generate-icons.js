#!/usr/bin/env node
const { execFileSync } = require('child_process');
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const resourcesDir = path.join(rootDir, 'resources');

const inputs = {
  launcherSvg: path.join(resourcesDir, 'icon.svg'),
  recordingSvg: path.join(resourcesDir, 'icon_recording.svg'),
  pausedSvg: path.join(resourcesDir, 'icon_paused.svg'),
  recordingInverseSvg: path.join(resourcesDir, 'icon_recording_inverse.svg'),
  pausedInverseSvg: path.join(resourcesDir, 'icon_paused_inverse.svg')
};

const outputs = {
  launcherPng: path.join(resourcesDir, 'icon-launcher.png'),
  launcherIco: path.join(resourcesDir, 'icon-launcher.ico'),
  recordingPng: path.join(resourcesDir, 'icon_recording.png'),
  pausedPng: path.join(resourcesDir, 'icon_paused.png'),
  recordingIco: path.join(resourcesDir, 'icon_recording.ico'),
  pausedIco: path.join(resourcesDir, 'icon_paused.ico'),
  recordingInversePng: path.join(resourcesDir, 'icon_recording_inverse.png'),
  pausedInversePng: path.join(resourcesDir, 'icon_paused_inverse.png')
};

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
  // Use resvg directly. Electron crashes in this helper context, and ImageMagick drops the mouth path.
  const svg = fs.readFileSync(inputPath);
  const pngBuffer = new Resvg(svg).render().asPng();
  fs.writeFileSync(outputPath, pngBuffer);
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

function renderLauncherBackground(outputPath) {
  run(
    'magick',
    [
      '-size',
      '904x904',
      'xc:#ebebeb',
      '(',
      '-size',
      '904x904',
      'xc:none',
      '-fill',
      'white',
      '-draw',
      'roundrectangle 0,0 903,903 180,180',
      ')',
      '-alpha',
      'off',
      '-compose',
      'CopyOpacity',
      '-composite',
      `PNG32:${outputPath}`
    ],
    'magick'
  );
}

function renderLauncherPng(facePath, outputPath, tempDir) {
  const backgroundPath = path.join(tempDir, 'icon-launcher-background.png');

  renderLauncherBackground(backgroundPath);

  run(
    'magick',
    [
      '-size',
      '1024x1024',
      'xc:none',
      '(',
      backgroundPath,
      ')',
      '-geometry',
      '+60+48',
      '-composite',
      '(',
      facePath,
      '-resize',
      '809x809',
      ')',
      '-gravity',
      'center',
      '-composite',
      `PNG32:${outputPath}`
    ],
    'magick'
  );
}

function generateTrayIcons() {
  ensureCommand('magick');
  Object.values(inputs).forEach(ensureFile);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donethat-icons-'));
  const launcherFacePath = path.join(tempDir, 'icon-launcher-face.png');
  const recordingRasterPath = path.join(tempDir, 'icon_recording-raster.png');
  const pausedRasterPath = path.join(tempDir, 'icon_paused-raster.png');
  const recordingInverseRasterPath = path.join(tempDir, 'icon_recording_inverse-raster.png');
  const pausedInverseRasterPath = path.join(tempDir, 'icon_paused_inverse-raster.png');

  try {
    rasterizeSvg(inputs.launcherSvg, launcherFacePath);
    rasterizeSvg(inputs.recordingSvg, recordingRasterPath);
    rasterizeSvg(inputs.pausedSvg, pausedRasterPath);
    rasterizeSvg(inputs.recordingInverseSvg, recordingInverseRasterPath);
    rasterizeSvg(inputs.pausedInverseSvg, pausedInverseRasterPath);
    renderLauncherPng(launcherFacePath, outputs.launcherPng, tempDir);
    renderTrayPng(recordingRasterPath, outputs.recordingPng);
    renderTrayPng(pausedRasterPath, outputs.pausedPng);
    renderTrayPng(recordingInverseRasterPath, outputs.recordingInversePng);
    renderTrayPng(pausedInverseRasterPath, outputs.pausedInversePng);
    renderIco(outputs.recordingPng, outputs.recordingIco, [32, 24, 20, 16]);
    renderIco(outputs.pausedPng, outputs.pausedIco, [32, 24, 20, 16]);
    renderIco(outputs.launcherPng, outputs.launcherIco, [256, 128, 64, 48, 32, 24, 20, 16]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('[generate-icons] Generated assets:');
  Object.values(outputs).forEach((outputPath) => {
    console.log(`- ${path.relative(rootDir, outputPath)}`);
  });
}

function main() {
  generateTrayIcons();
}

try {
  main();
} catch (error) {
  fail(error.message);
}
