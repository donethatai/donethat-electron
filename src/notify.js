const { ipcRenderer } = require('electron');

function showBanner(message, { title = null, sticky = false, action = null, id = null, noFocus = false } = {}) {
  try {
    ipcRenderer.send('inapp:notify', {
      id: id || ('banner-'+Date.now()),
      title,
      message,
      sticky,
      action,
      noFocus
    });
  } catch (_) {}
}

function hideBanner() {
  try { ipcRenderer.send('inapp:hide'); } catch (_) {}
}

module.exports = { showBanner, hideBanner };


