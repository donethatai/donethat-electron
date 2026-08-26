const { app } = require('electron');
const log = require('electron-log');

/**
 * Re-check a permission after the user goes to System Settings.
 *
 * Two failure modes shaped this. Watching only the main window's own `focus`
 * missed a user who came back through the overlay, the tray, or a hotkey — the
 * grant landed and the UI stayed stale until the next capture cycle noticed.
 * Watching the app-wide event but firing once was worse: the overlay taking
 * focus burned the single shot before the user had even reached Settings, so
 * the real return did nothing.
 *
 * So: listen app-wide, and let the recheck decide whether the question is
 * answered. A recheck that returns falsy re-arms until the timeout drops it.
 * One watcher per permission — asking again replaces the pending watch rather
 * than stacking a second listener.
 */

const DEFAULT_RETURN_TIMEOUT_MS = 10 * 60 * 1000;

/** @type {Map<string, () => void>} type → dispose */
const activeWatchers = new Map();

/**
 * @param {string} type - Permission name, used as the registry key.
 * @param {Electron.BrowserWindow} mainWindow - Disposes the watch when closed.
 * @param {() => Promise<boolean>|boolean} onReturn - Truthy means settled; falsy re-arms.
 * @param {{timeoutMs?: number}} [options]
 * @returns {() => void} dispose
 */
function watchForPermissionReturn(type, mainWindow, onReturn, options = {}) {
  if (!mainWindow || mainWindow.isDestroyed?.()) return () => {};

  cancelPermissionReturnWatch(type);

  const timeoutMs = options.timeoutMs || DEFAULT_RETURN_TIMEOUT_MS;
  const timeoutId = setTimeout(() => dispose(), timeoutMs);

  let inFlight = false;
  let disposed = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(timeoutId);
    app.removeListener('browser-window-focus', onFocus);
    if (!mainWindow.isDestroyed?.()) {
      mainWindow.removeListener('closed', dispose);
    }
    if (activeWatchers.get(type) === dispose) {
      activeWatchers.delete(type);
    }
  }

  async function onFocus() {
    // A probe already running must not be joined by a second one; the focus
    // that arrives while Settings is closing is the same return event.
    if (inFlight || disposed) return;
    inFlight = true;

    try {
      const settled = await onReturn();
      if (settled) dispose();
    } catch (error) {
      log.error(`[permission] ${type} recheck on settings return failed:`, error?.message || error);
    } finally {
      inFlight = false;
    }
  }

  activeWatchers.set(type, dispose);
  app.on('browser-window-focus', onFocus);
  mainWindow.once('closed', dispose);

  return dispose;
}

/** Drop a pending watch without running its recheck. */
function cancelPermissionReturnWatch(type) {
  const dispose = activeWatchers.get(type);
  if (dispose) dispose();
}

module.exports = {
  watchForPermissionReturn,
  cancelPermissionReturnWatch,
  __test__: {
    activeWatchers,
    DEFAULT_RETURN_TIMEOUT_MS
  }
};
