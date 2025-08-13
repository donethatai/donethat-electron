#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', env: process.env });
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('[postinstall-macos-micstatus] Non-macOS platform, skipping.');
    return;
  }

  console.log('[postinstall-macos-micstatus] Building Swift micstatus helper...');
  run('mkdir -p bin tools/macos');

  const swiftPath = path.join(process.cwd(), 'tools/macos/micstatus.swift');
  const swiftSource = `import Foundation\nimport CoreAudio\nimport AudioToolbox\n\nfunc getAudioDeviceIDs() -> [AudioDeviceID] {\n    var address = AudioObjectPropertyAddress(\n        mSelector: kAudioHardwarePropertyDevices,\n        mScope: kAudioObjectPropertyScopeGlobal,\n        mElement: kAudioObjectPropertyElementMaster\n    )\n    var dataSize: UInt32 = 0\n    let sysObj = AudioObjectID(kAudioObjectSystemObject)\n    guard AudioObjectGetPropertyDataSize(sysObj, &address, 0, nil, &dataSize) == noErr else { return [] }\n    let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size\n    var deviceIDs = Array(repeating: AudioDeviceID(0), count: count)\n    guard AudioObjectGetPropertyData(sysObj, &address, 0, nil, &dataSize, &deviceIDs) == noErr else { return [] }\n    return deviceIDs\n}\n\nfunc deviceHasInput(_ deviceID: AudioDeviceID) -> Bool {\n    var address = AudioObjectPropertyAddress(\n        mSelector: kAudioDevicePropertyStreamConfiguration,\n        mScope: kAudioDevicePropertyScopeInput,\n        mElement: kAudioObjectPropertyElementMaster\n    )\n    var dataSize: UInt32 = 0\n    if AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &dataSize) != noErr || dataSize == 0 {\n        return false\n    }\n    let bufferListPointer = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(dataSize))\n    defer { bufferListPointer.deallocate() }\n    if AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, bufferListPointer) != noErr {\n        return false\n    }\n    let mNumberBuffers = bufferListPointer.pointee.mNumberBuffers\n    return mNumberBuffers > 0\n}\n\nfunc deviceIsRunningSomewhere(_ deviceID: AudioDeviceID) -> Bool {\n    var address = AudioObjectPropertyAddress(\n        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,\n        mScope: kAudioObjectPropertyScopeGlobal,\n        mElement: kAudioObjectPropertyElementMaster\n    )\n    var value: UInt32 = 0\n    var dataSize = UInt32(MemoryLayout<UInt32>.size)\n    if AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, &value) != noErr {\n        return false\n    }\n    return value != 0\n}\n\nlet devices = getAudioDeviceIDs()\nfor dev in devices {\n    if deviceHasInput(dev) && deviceIsRunningSomewhere(dev) {\n        print(\"1\")\n        exit(0)\n    }\n}\nprint(\"0\")\n`;

  fs.writeFileSync(swiftPath, swiftSource);
  run('xcrun swiftc tools/macos/micstatus.swift -framework CoreAudio -framework AudioToolbox -o bin/micstatus');
  run('chmod +x bin/micstatus');
  console.log('[postinstall-macos-micstatus] Swift micstatus helper built.');
}

main();


