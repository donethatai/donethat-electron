const { ipcRenderer } = require('electron');

async function showBanner(message, { title = null, sticky = false, action = null, id = null, noFocus = false } = {}) {
  try {
    const payload = {
      id: id || ('banner-'+Date.now()),
      title,
      message,
      sticky,
      action,
      noFocus
    };

    // Check if main window is focused
    let useInApp = false;
    try {
      const focusState = await ipcRenderer.invoke('check-main-window-focus');
      useInApp = focusState.focused && focusState.visible;
    } catch (e) {
      // Fallback: check document focus as backup
      try {
        useInApp = document.hasFocus();
      } catch (_) {
        // If we can't determine, default to in-app
        useInApp = true;
      }
    }

    if (useInApp) {
      // App is focused - use in-app banner
      ipcRenderer.send('inapp:notify', payload);
    } else {
      // App is not focused - use background notification
      ipcRenderer.send('background:notify', payload);
    }
  } catch (_) {}
}

function hideBanner() {
  try { 
    ipcRenderer.send('inapp:hide'); 
    ipcRenderer.send('background:hide');
  } catch (_) {}
}

module.exports = { showBanner, hideBanner };


