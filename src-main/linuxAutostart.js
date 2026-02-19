const fs = require('fs')
const os = require('os')
const path = require('path')
const log = require('electron-log')

const DESKTOP_FILE_NAME = 'donethat.desktop'

function getAutostartFilePath() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
  const configRoot = xdgConfigHome || path.join(os.homedir(), '.config')
  return path.join(configRoot, 'autostart', DESKTOP_FILE_NAME)
}

function resolveExecBinaryPath() {
  const appImagePath = process.env.APPIMAGE && process.env.APPIMAGE.trim()
  return appImagePath || process.execPath
}

function escapeDesktopArg(value) {
  return String(value || '').replace(/(["\\$`])/g, '\\$1')
}

function buildExecLine() {
  return `"${escapeDesktopArg(resolveExecBinaryPath())}" --no-sandbox`
}

function buildDesktopEntry() {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=DoneThat',
    `Exec=${buildExecLine()}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'X-GNOME-Autostart-Delay=5',
    ''
  ].join('\n')
}

function writeDesktopEntry(filePath) {
  const folder = path.dirname(filePath)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(filePath, buildDesktopEntry(), 'utf8')
}

function removeDesktopEntry(filePath) {
  if (!fs.existsSync(filePath)) return
  fs.unlinkSync(filePath)
}

function setEnabled(enabled) {
  const filePath = getAutostartFilePath()
  if (enabled) {
    writeDesktopEntry(filePath)
  } else {
    removeDesktopEntry(filePath)
  }
  return getState(!!enabled)
}

function reconcile(enabled) {
  const filePath = getAutostartFilePath()
  const expected = buildDesktopEntry()

  if (!enabled) {
    removeDesktopEntry(filePath)
    return getState(false)
  }

  try {
    if (!fs.existsSync(filePath)) {
      writeDesktopEntry(filePath)
      return getState(true)
    }

    const existing = fs.readFileSync(filePath, 'utf8')
    if (existing !== expected) {
      writeDesktopEntry(filePath)
    }
    return getState(true)
  } catch (error) {
    log.error('Linux autostart reconcile failed:', error)
    return getState(true)
  }
}

function getState(enabledOverride = null) {
  const filePath = getAutostartFilePath()
  const expected = buildDesktopEntry()
  const exists = fs.existsSync(filePath)
  let isCurrent = false
  if (exists) {
    try {
      isCurrent = fs.readFileSync(filePath, 'utf8') === expected
    } catch (_) {
      isCurrent = false
    }
  }

  return {
    enabled: enabledOverride !== null ? !!enabledOverride : exists,
    filePath,
    execPath: resolveExecBinaryPath(),
    exists,
    isCurrent
  }
}

module.exports = {
  getAutostartFilePath,
  resolveExecBinaryPath,
  buildExecLine,
  buildDesktopEntry,
  setEnabled,
  reconcile,
  getState
}
