#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'inherit', env: process.env });
  } catch (err) {
    console.error(`[build-os-helpers] Error running command: ${cmd}`, err);
    process.exit(1);
  }
}

function buildSwiftHelper({ sourcePath, outputPath, frameworks }) {
  const moduleCacheDir = path.join(process.cwd(), '.build/module-cache');
  fs.mkdirSync(moduleCacheDir, { recursive: true });
  const frameworkArgs = frameworks.map((fw) => `-framework ${fw}`).join(' ');
  const deploymentTarget = '11.0';
  const targetArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  run(`xcrun swiftc -O -module-cache-path "${moduleCacheDir}" -target ${targetArch}-apple-macos${deploymentTarget} ${frameworkArgs} "${sourcePath}" -o "${outputPath}"`);
  run(`chmod +x "${outputPath}"`);
}

function main() {
  const outputDir = path.join(process.cwd(), 'bin');
  fs.mkdirSync(outputDir, { recursive: true });

  if (process.platform === 'darwin') {
    const helper = {
      name: 'mic-monitor',
      sourcePath: path.join(process.cwd(), 'src-os/macos/active-mic.swift'),
      outputPath: path.join(outputDir, 'mic-monitor'),
      frameworks: ['CoreAudio', 'Foundation', 'AppKit']
    };

    if (!fs.existsSync(helper.sourcePath)) {
      console.error(`[build-os-helpers] Error: source file not found: ${helper.sourcePath}`);
      process.exit(1);
    }

    console.log(`[build-os-helpers] Building macOS helper: ${helper.name}`);
    buildSwiftHelper(helper);
    console.log(`[build-os-helpers] Built helper: ${helper.outputPath}`);
    return;
  }

  console.log('[build-os-helpers] No helper build needed on this platform.');
}

main();
