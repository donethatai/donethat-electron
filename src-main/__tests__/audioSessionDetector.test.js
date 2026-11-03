jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('electron', () => ({
  webContents: { getAllWebContents: () => [] }
}))

jest.mock('../telemetry', () => ({
  recordSignal: jest.fn()
}))

let mockMicSessions = []
let mockExecutablePaths = {}

jest.mock('child_process', () => ({
  exec: jest.fn(),
  execFileSync: jest.fn(() => ''),
  execFile: jest.fn((file, args, callback) => {
    const done = typeof args === 'function' ? args : callback
    if (file === '/bin/ps') {
      const pid = args[args.length - 1]
      done(null, { stdout: `${mockExecutablePaths[pid] || ''}\n`, stderr: '' })
      return
    }
    done(null, { stdout: JSON.stringify(mockMicSessions), stderr: '' })
  })
}))

const { detectMacOSMicrophoneUsage } = require('../audioSessionDetector')

describe('detectMacOSMicrophoneUsage', () => {
  beforeEach(() => {
    mockMicSessions = []
    mockExecutablePaths = {}
  })

  test('ignores Apple system daemons that report an empty bundle ID', async () => {
    mockMicSessions = [{ pid: 51931, bundleId: '' }]
    mockExecutablePaths = { 51931: '/System/Library/PrivateFrameworks/CoreSpeech.framework/corespeechd' }

    await expect(detectMacOSMicrophoneUsage()).resolves.toBeNull()
  })

  test('still detects non-system binaries that report an empty bundle ID', async () => {
    mockMicSessions = [{ pid: 4242, bundleId: '' }]
    mockExecutablePaths = { 4242: '/opt/homebrew/bin/ffmpeg' }

    await expect(detectMacOSMicrophoneUsage()).resolves.toMatchObject({ isActive: true, pid: 4242 })
  })

  test('detects Safari calls captured by the WebKit GPU process', async () => {
    mockMicSessions = [{ pid: 26419, bundleId: 'com.apple.WebKit.GPU' }]

    await expect(detectMacOSMicrophoneUsage()).resolves.toMatchObject({ isActive: true, pid: 26419 })
  })

  test('ignores Apple system bundles that are not allowlisted', async () => {
    mockMicSessions = [{ pid: 18825, bundleId: 'com.apple.CoreSpeech' }]

    await expect(detectMacOSMicrophoneUsage()).resolves.toBeNull()
  })
})
