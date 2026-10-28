const fs = require('fs')
const path = require('path')
const {
  THEME_PREFERENCE_STORE_KEY,
  WINDOW_BACKGROUND,
  parseThemePreference,
  createThemeController
} = require('../theme')

const ROOT = path.join(__dirname, '..', '..')

function createMockStore(initial = {}) {
  const data = { ...initial }
  return {
    get: jest.fn((key) => data[key]),
    set: jest.fn((key, value) => { data[key] = value })
  }
}

function createNativeTheme() {
  const theme = { themeSource: 'system', shouldUseDarkColors: false }
  return theme
}

describe('theme', () => {
  test('anything but a known preference reads as system', () => {
    expect(parseThemePreference('dark')).toBe('dark')
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('purple')).toBe('system')
    expect(parseThemePreference(undefined)).toBe('system')
  })

  test('restore applies the stored preference to nativeTheme', () => {
    const nativeTheme = createNativeTheme()
    const store = createMockStore({ [THEME_PREFERENCE_STORE_KEY]: 'dark' })
    createThemeController({ nativeTheme, store }).restore()
    expect(nativeTheme.themeSource).toBe('dark')
  })

  test('restore falls back to system when the store is missing or broken', () => {
    const nativeTheme = createNativeTheme()
    nativeTheme.themeSource = 'light'
    const store = { get: () => { throw new Error('corrupt') } }
    createThemeController({ nativeTheme, store }).restore()
    expect(nativeTheme.themeSource).toBe('system')
  })

  test('set applies and stores a valid preference', () => {
    const nativeTheme = createNativeTheme()
    const store = createMockStore()
    const controller = createThemeController({ nativeTheme, store })
    expect(controller.set('light')).toBe(true)
    expect(nativeTheme.themeSource).toBe('light')
    expect(store.set).toHaveBeenCalledWith(THEME_PREFERENCE_STORE_KEY, 'light')
  })

  test('set ignores a malformed message from the webview', () => {
    const nativeTheme = createNativeTheme()
    const store = createMockStore()
    const controller = createThemeController({ nativeTheme, store })
    expect(controller.set({ theme: 'dark' })).toBe(false)
    expect(controller.set('__proto__')).toBe(false)
    expect(nativeTheme.themeSource).toBe('system')
    expect(store.set).not.toHaveBeenCalled()
  })

  test('the window background follows the resolved colours', () => {
    const nativeTheme = createNativeTheme()
    const controller = createThemeController({ nativeTheme, store: null })
    expect(controller.windowBackground()).toBe(WINDOW_BACKGROUND.light)
    nativeTheme.shouldUseDarkColors = true
    expect(controller.windowBackground()).toBe(WINDOW_BACKGROUND.dark)
  })

  test('the portal can send theme:set and the host advertises theme-sync', () => {
    // The web app only sends theme:set when `theme-sync` is advertised, and the
    // portal preload drops any channel not in its allowlist. Both must ship together.
    const portal = fs.readFileSync(path.join(ROOT, 'src', 'portal-preload.js'), 'utf8')
    const allow = portal.slice(portal.indexOf('ALLOWED_SEND_TO_HOST_CHANNELS'), portal.indexOf('];'))
    expect(allow).toContain("'theme:set'")
    expect(portal).toMatch(/HOST_CAPABILITIES = \[[^\]]*'theme-sync'/)

    // The host renderer forwards it to main through the main preload.
    const preload = fs.readFileSync(path.join(ROOT, 'src-main', 'preload.js'), 'utf8')
    const send = preload.slice(preload.indexOf('const validSendChannels'), preload.indexOf(']', preload.indexOf('const validSendChannels')))
    expect(send).toContain("'theme:set'")
  })
})
