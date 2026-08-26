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

function tryRun(cmd) {
  try {
    execSync(cmd, { stdio: 'inherit', env: process.env });
    return true;
  } catch (err) {
    console.warn(`[build-os-helpers] Command failed (continuing): ${cmd}`);
    return false;
  }
}

const HELPER_ARCHES = ['arm64', 'x86_64'];

function hostArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x86_64';
}

// Universal binaries, not host-arch only: a helper built for one slice is
// simply missing on the other architecture's build, and the app has no way to
// tell that apart from the helper failing at runtime.

// TCC's Location Services list falls back to the process basename when the
// helper is spawned as Contents/MacOS/<name>. Keep that basename DoneThat —
// matching CFBundleExecutable — so the row never reads as "wifi-scan".
function buildHelperIcns(sourcePng, destIcns) {
  // iconutil requires the directory name to end in ".iconset" (not ".icns.iconset").
  const iconsetDir = destIcns.replace(/\.icns$/i, '.iconset');
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });

  const sizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png']
  ];

  for (const [px, name] of sizes) {
    run(`sips -z ${px} ${px} "${sourcePng}" --out "${path.join(iconsetDir, name)}" > /dev/null`);
  }
  run(`iconutil --convert icns --output "${destIcns}" "${iconsetDir}"`);
  fs.rmSync(iconsetDir, { recursive: true, force: true });
}

function wrapHelperAsApp({ binaryPath, infoPlistPath, bundleId, executableName, iconSourcePng }) {
  const appPath = `${binaryPath}.app`;
  const contentsDir = path.join(appPath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const execName = executableName || path.basename(binaryPath);

  fs.rmSync(appPath, { recursive: true, force: true });
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.copyFileSync(binaryPath, path.join(macosDir, execName));
  fs.chmodSync(path.join(macosDir, execName), 0o755);
  fs.copyFileSync(infoPlistPath, path.join(contentsDir, 'Info.plist'));
  fs.writeFileSync(path.join(contentsDir, 'PkgInfo'), 'APPL????');

  if (iconSourcePng) {
    if (!fs.existsSync(iconSourcePng)) {
      console.error(`[build-os-helpers] Error: helper icon not found: ${iconSourcePng}`);
      process.exit(1);
    }
    buildHelperIcns(iconSourcePng, path.join(resourcesDir, 'AppIcon.icns'));
  }

  // Unsigned NSApplication.shared aborts in RegisterApplication. Ad-hoc sign
  // so Launch Services will treat this as an app; electron-builder re-signs
  // at package time.
  run(`codesign --force --sign - --identifier "${bundleId}" "${path.join(macosDir, execName)}"`);
  run(`codesign --force --sign - --identifier "${bundleId}" "${appPath}"`);
  run(`codesign --verify --strict "${appPath}"`);

  // The wrapper is what ships; the loose slice next to it would be an unsigned
  // second copy of the same helper inside the asar.
  fs.rmSync(binaryPath, { force: true });
  console.log(`[build-os-helpers] Wrapped helper as ${appPath}`);
}

function buildSwiftHelper({ name, sourcePath, outputPath, frameworks }) {
  const moduleCacheDir = path.join(process.cwd(), '.build/module-cache');
  fs.mkdirSync(moduleCacheDir, { recursive: true });
  const frameworkArgs = frameworks.map((fw) => `-framework ${fw}`).join(' ');
  const deploymentTarget = '11.0';

  const slices = [];
  for (const arch of HELPER_ARCHES) {
    const slicePath = `${outputPath}.${arch}`;
    const cmd = `xcrun swiftc -O -module-cache-path "${moduleCacheDir}" -target ${arch}-apple-macos${deploymentTarget} ${frameworkArgs} "${sourcePath}" -o "${slicePath}"`;
    // A missing cross-arch toolchain is survivable on a dev machine; on CI it
    // would ship a helper that is simply absent on the other architecture.
    const mustSucceed = arch === hostArch() || !!process.env.CI;
    const ok = mustSucceed ? (run(cmd), true) : tryRun(cmd);
    if (ok) slices.push(slicePath);
  }

  if (slices.length === 0) {
    console.error(`[build-os-helpers] Error: no slices built for ${name}`);
    process.exit(1);
  }

  if (slices.length === 1) {
    console.warn(`[build-os-helpers] ${name}: only ${slices.length} slice built; shipping non-universal binary`);
    fs.copyFileSync(slices[0], outputPath);
  } else {
    run(`lipo -create ${slices.map((p) => `"${p}"`).join(' ')} -output "${outputPath}"`);
  }

  slices.forEach((p) => {
    try { fs.rmSync(p, { force: true }); } catch (_) {}
  });
  run(`chmod +x "${outputPath}"`);
}

function main() {
  const outputDir = path.join(process.cwd(), 'bin');
  fs.mkdirSync(outputDir, { recursive: true });

  if (process.platform === 'darwin') {
    const helpers = [
      {
        name: 'mic-monitor',
        sourcePath: path.join(process.cwd(), 'src-os/macos/active-mic.swift'),
        outputPath: path.join(outputDir, 'mic-monitor'),
        frameworks: ['CoreAudio', 'Foundation', 'AppKit']
      },
      {
        name: 'wifi-scan',
        sourcePath: path.join(process.cwd(), 'src-os/macos/wifi-scan.swift'),
        outputPath: path.join(outputDir, 'wifi-scan'),
        frameworks: ['AppKit', 'CoreWLAN', 'CoreLocation', 'Foundation'],
        infoPlistPath: path.join(process.cwd(), 'src-os/macos/wifi-scan-Info.plist'),
        wrapAsApp: true,
        bundleId: 'com.donethat.app.wifi-scan',
        // Process name shown in Location Services when spawned via Contents/MacOS.
        executableName: 'DoneThat',
        iconSourcePng: path.join(process.cwd(), 'resources/icon-launcher.png')
      }
    ];

    for (const helper of helpers) {
      if (!fs.existsSync(helper.sourcePath)) {
        console.error(`[build-os-helpers] Error: source file not found: ${helper.sourcePath}`);
        process.exit(1);
      }

      if (helper.infoPlistPath && !fs.existsSync(helper.infoPlistPath)) {
        console.error(`[build-os-helpers] Error: Info.plist not found: ${helper.infoPlistPath}`);
        process.exit(1);
      }

      console.log(`[build-os-helpers] Building macOS helper: ${helper.name}`);
      buildSwiftHelper(helper);
      if (helper.wrapAsApp) {
        wrapHelperAsApp({
          binaryPath: helper.outputPath,
          infoPlistPath: helper.infoPlistPath,
          bundleId: helper.bundleId,
          executableName: helper.executableName,
          iconSourcePng: helper.iconSourcePng
        });
      }
      console.log(`[build-os-helpers] Built helper: ${helper.outputPath}`);
    }
    return;
  }

  console.log('[build-os-helpers] No helper build needed on this platform.');
}

main();
