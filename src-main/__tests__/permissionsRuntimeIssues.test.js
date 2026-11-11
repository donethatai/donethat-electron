/**
 * Covers which runtime issues mark the Active applications (Accessibility) indicator denied.
 */

jest.mock('../../src/app-state.js', () => ({}))
jest.mock('../../src/analytics.js', () => ({ logAnalyticsEvent: jest.fn() }))
jest.mock('../../src/settings.js', () => ({ handleCaptureToggleIntent: jest.fn() }))

global.window = { electronAPI: { platform: 'darwin', on: jest.fn(), send: jest.fn() } }

const { shouldFlagWindowsPermission } = require('../../src/permissions.js').__test__

afterAll(() => {
  delete global.window
})

test('a windows runtime issue always flags the indicator', () => {
  expect(shouldFlagWindowsPermission({ windows: { status: 'degraded' } }, 'win32')).toBe(true)
})

test('window text flags it on macOS only when Accessibility is not trusted', () => {
  expect(shouldFlagWindowsPermission({ uiText: { status: 'degraded', reason: 'accessibility' } }, 'darwin')).toBe(true)
})

test.each(['read-failed', 'app-refused', 'unavailable', undefined])(
  'window text failing for reason %s leaves the indicator alone',
  (reason) => {
    expect(shouldFlagWindowsPermission({ uiText: { status: 'degraded', reason } }, 'darwin')).toBe(false)
  }
)

test('window text never flags it outside macOS', () => {
  expect(shouldFlagWindowsPermission({ uiText: { status: 'degraded', reason: 'accessibility' } }, 'win32')).toBe(false)
})
