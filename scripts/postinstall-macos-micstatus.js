#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'inherit', env: process.env });
  } catch (err) {
    console.error(`Error running command: ${cmd}`, err);
    process.exit(1);
  }
}

function buildSwiftHelper({ sourcePath, outputPath, frameworks }) {
  const moduleCacheDir = path.join(process.cwd(), '.build/module-cache');
  fs.mkdirSync(moduleCacheDir, { recursive: true });
  const frameworkArgs = frameworks.map((fw) => `-framework ${fw}`).join(' ');
  run(`xcrun swiftc -O -module-cache-path "${moduleCacheDir}" ${frameworkArgs} "${sourcePath}" -o "${outputPath}"`);
  run(`chmod +x "${outputPath}"`);
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('[postinstall-macos-micstatus] Non-macOS platform, skipping.');
    return;
  }

  const outputDir = path.join(process.cwd(), 'bin');
  fs.mkdirSync(outputDir, { recursive: true });

  const helperBuilds = [
    {
      name: 'mic-monitor',
      sourcePath: path.join(process.cwd(), 'src-os/macos/active-mic.swift'),
      outputPath: path.join(outputDir, 'mic-monitor'),
      frameworks: ['CoreAudio', 'Foundation', 'AppKit']
    }
  ];

  for (const helper of helperBuilds) {
    if (!fs.existsSync(helper.sourcePath)) {
      console.error(`[postinstall-macos-micstatus] Error: source file not found: ${helper.sourcePath}`);
      process.exit(1);
    }
    console.log(`[postinstall-macos-micstatus] Building Swift helper: ${helper.name}`);
    buildSwiftHelper(helper);
    console.log(`[postinstall-macos-micstatus] Built helper: ${helper.outputPath}`);
  }
}

main();
