const fs = require('fs')
const os = require('os')
const path = require('path')

jest.mock('child_process', () => ({ execFileSync: jest.fn(() => '') }))

const { execFileSync } = require('child_process')
const { signFile, isWindowsBinary } = require('../../scripts/azure-sign-windows')

let dir

function writeFile(name, bytes) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, Buffer.from(bytes))
  return file
}

beforeEach(() => {
  jest.clearAllMocks()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-sign-'))
  process.env.AZURE_SIGN_DLIB = writeFile('dlib.dll', [0x4d, 0x5a])
  process.env.AZURE_SIGN_METADATA = writeFile('metadata.json', [0x7b, 0x7d])
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  console.log.mockRestore()
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.AZURE_SIGN_DLIB
  delete process.env.AZURE_SIGN_METADATA
})

test('recognizes Windows PE files by their MZ header', () => {
  expect(isWindowsBinary(writeFile('win.node', [0x4d, 0x5a, 0x90, 0x00]))).toBe(true)
  expect(isWindowsBinary(writeFile('mac.node', [0xcf, 0xfa, 0xed, 0xfe]))).toBe(false)
  expect(isWindowsBinary(writeFile('linux.node', [0x7f, 0x45, 0x4c, 0x46]))).toBe(false)
  expect(isWindowsBinary(writeFile('empty.node', []))).toBe(false)
})

test('signs and verifies a Windows binary', () => {
  const file = writeFile('addon.node', [0x4d, 0x5a, 0x90, 0x00])
  signFile(file)
  expect(execFileSync).toHaveBeenCalledTimes(2)
  expect(execFileSync.mock.calls[0][1]).toContain(file)
})

test('skips a native module built for another OS instead of failing the build', () => {
  const file = writeFile('node-get-windows.node', [0xcf, 0xfa, 0xed, 0xfe])
  expect(() => signFile(file)).not.toThrow()
  expect(execFileSync).not.toHaveBeenCalled()
})
