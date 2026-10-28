// The light/dark preference, set from the portal.
//
// The web app owns the choice (Settings > Appearance) and sends it over the
// `theme:set` webview channel. Here it becomes `nativeTheme.themeSource`, which
// is what `prefers-color-scheme` reports to every renderer: this app's own
// chrome and chat overlay, and the portal webview itself. It is stored so the
// next launch opens in the right theme before the portal has loaded.

const THEME_PREFERENCE_STORE_KEY = 'themePreference'
const THEME_PREFERENCES = ['system', 'light', 'dark']

// Window backgrounds shown before content paints. Canvas values from
// ../donethat-webapp/design-system/tokens/colors.ts (light stays the white the
// window has always used).
const WINDOW_BACKGROUND = { light: '#ffffff', dark: '#111316' }

function parseThemePreference(value) {
  return THEME_PREFERENCES.includes(value) ? value : 'system'
}

function createThemeController({ nativeTheme, store, log }) {
  function read() {
    try {
      return parseThemePreference(store && store.get(THEME_PREFERENCE_STORE_KEY))
    } catch (error) {
      return 'system'
    }
  }

  function restore() {
    nativeTheme.themeSource = read()
  }

  // Returns false for anything that is not a known preference, so a malformed
  // message from the webview changes nothing.
  function set(value) {
    if (!THEME_PREFERENCES.includes(value)) return false
    nativeTheme.themeSource = value
    try {
      if (store) store.set(THEME_PREFERENCE_STORE_KEY, value)
    } catch (error) {
      if (log) log.warn('Unable to store theme preference:', error.message)
    }
    return true
  }

  function windowBackground() {
    return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
  }

  return { read, restore, set, windowBackground }
}

module.exports = {
  THEME_PREFERENCE_STORE_KEY,
  THEME_PREFERENCES,
  WINDOW_BACKGROUND,
  parseThemePreference,
  createThemeController
}
