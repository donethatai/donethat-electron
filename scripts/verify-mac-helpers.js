import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// The native helpers are gitignored build output, so nothing in review catches
// a helper that silently stopped being built, stopped being signed, or lost the
// entitlement it needs at runtime. This runs on the packaged app, before
// notarization, and fails the build instead of shipping a broken helper.

const HELPERS = [
  { relativePath: 'mic-monitor' },
  {
    relativePath: 'wifi-scan.app',
    bundleId: 'com.donethat.app.wifi-scan',
    // CoreWLAN returns no SSIDs without this, and the prompt needs the string.
    entitlements: ['com.apple.security.personal-information.location'],
    infoPlistKeys: ['NSLocationWhenInUseUsageDescription']
  }
];

// Built as an intermediate and deleted after wrapping; if it reappears in the
// package it is an unsigned duplicate of the helper.
const FORBIDDEN = ['wifi-scan'];

function codesign(args) {
  // codesign writes everything to stderr, including success output.
  return execFileSync('codesign', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function signatureInfo(target) {
  // codesign prints the signature details to stderr and the entitlements to
  // stdout, so both streams matter here.
  const result = spawnSync('codesign', ['-dvvv', '--entitlements', ':-', target], { encoding: 'utf8' });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function isDeveloperIdSigned(target) {
  return signatureInfo(target).includes('Authority=Developer ID Application');
}

function plistValue(plistPath, key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (_) {
    return '';
  }
}

export default function verifyMacHelpers(appPath) {
  const binDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'bin');
  const problems = [];

  if (!fs.existsSync(binDir)) {
    throw new Error(`[verify-mac-helpers] No helper directory in packaged app: ${binDir}`);
  }

  // An unsigned local build should still be checked for structure, but cannot
  // be held to Developer ID.
  const signedBuild = isDeveloperIdSigned(appPath);
  if (!signedBuild) {
    console.warn('[verify-mac-helpers] App is not Developer ID signed; checking helper structure only.');
  }

  for (const name of FORBIDDEN) {
    if (fs.existsSync(path.join(binDir, name))) {
      problems.push(`${name} should not ship; it is a build intermediate`);
    }
  }

  for (const helper of HELPERS) {
    const target = path.join(binDir, helper.relativePath);
    if (!fs.existsSync(target)) {
      problems.push(`${helper.relativePath} is missing from the package`);
      continue;
    }

    try {
      codesign(['--verify', '--strict', '--deep', target]);
    } catch (error) {
      problems.push(`${helper.relativePath} fails codesign --verify: ${(error.stderr || '').trim()}`);
      continue;
    }

    const info = signatureInfo(target);

    if (signedBuild && !info.includes('Authority=Developer ID Application')) {
      problems.push(`${helper.relativePath} is not Developer ID signed`);
    }
    if (signedBuild && !info.includes('flags=0x10000(runtime)')) {
      problems.push(`${helper.relativePath} is missing the hardened runtime`);
    }
    if (helper.bundleId && !info.includes(`Identifier=${helper.bundleId}`)) {
      problems.push(`${helper.relativePath} has the wrong signing identifier (expected ${helper.bundleId})`);
    }
    for (const entitlement of helper.entitlements || []) {
      if (!info.includes(entitlement)) {
        problems.push(`${helper.relativePath} is missing entitlement ${entitlement}`);
      }
    }

    const infoPlist = path.join(target, 'Contents', 'Info.plist');
    for (const key of helper.infoPlistKeys || []) {
      if (!plistValue(infoPlist, key)) {
        problems.push(`${helper.relativePath} Info.plist is missing ${key}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`[verify-mac-helpers] Packaged helpers are not shippable:\n  - ${problems.join('\n  - ')}`);
  }

  console.log(`[verify-mac-helpers] Verified ${HELPERS.length} macOS helper(s).`);
}
