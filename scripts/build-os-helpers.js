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

function runOptional(cmd) {
  try {
    execSync(cmd, { stdio: 'pipe', env: process.env });
    return true;
  } catch (_) {
    return false;
  }
}

function buildSwiftHelper({ sourcePath, outputPath, frameworks }) {
  const moduleCacheDir = path.join(process.cwd(), '.build/module-cache');
  fs.mkdirSync(moduleCacheDir, { recursive: true });
  const frameworkArgs = frameworks.map((fw) => `-framework ${fw}`).join(' ');
  run(`xcrun swiftc -O -module-cache-path "${moduleCacheDir}" ${frameworkArgs} "${sourcePath}" -o "${outputPath}"`);
  run(`chmod +x "${outputPath}"`);
}

function buildWindowsHelper({ sourcePath, outputPath }) {
  if (!runOptional('dotnet --version')) {
    throw new Error('dotnet SDK is required to build donethatmicmonitor.exe on Windows');
  }

  const workDir = path.join(process.cwd(), '.build', 'windows-mic-helper');
  fs.mkdirSync(workDir, { recursive: true });
  const runtimeArch = process.arch === 'arm64' ? 'arm64' : 'x64';

  const projectPath = path.join(workDir, 'donethatmicmonitor.csproj');
  const programPath = path.join(workDir, 'Program.cs');
  fs.writeFileSync(projectPath, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <OutputType>Exe</OutputType>',
    '    <TargetFramework>net8.0-windows</TargetFramework>',
    '    <UseWindowsForms>false</UseWindowsForms>',
    '    <ImplicitUsings>disable</ImplicitUsings>',
    '    <Nullable>disable</Nullable>',
    '  </PropertyGroup>',
    '</Project>'
  ].join('\n'));
  fs.copyFileSync(sourcePath, programPath);
  run(`dotnet publish "${projectPath}" -c Release -r win-${runtimeArch} --self-contained true -p:PublishSingleFile=true -o "${workDir}"`);
  const publishedExe = path.join(workDir, 'donethatmicmonitor.exe');
  if (!fs.existsSync(publishedExe)) {
    throw new Error(`dotnet publish completed but helper not found at ${publishedExe}`);
  }
  fs.copyFileSync(publishedExe, outputPath);
  return true;
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

  if (process.platform === 'win32') {
    const helper = {
      name: 'donethatmicmonitor.exe',
      sourcePath: path.join(process.cwd(), 'src-os/windows/donethatmicmonitor.cs'),
      outputPath: path.join(outputDir, 'donethatmicmonitor.exe')
    };

    if (!fs.existsSync(helper.sourcePath)) {
      console.error(`[build-os-helpers] Error: source file not found: ${helper.sourcePath}`);
      process.exit(1);
    }

    console.log(`[build-os-helpers] Building Windows helper: ${helper.name}`);
    buildWindowsHelper(helper);
    console.log(`[build-os-helpers] Built helper: ${helper.outputPath}`);
    return;
  }

  console.log('[build-os-helpers] No helper build needed on this platform.');
}

main();
