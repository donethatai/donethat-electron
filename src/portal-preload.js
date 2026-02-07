const { ipcRenderer, contextBridge } = require('electron');

// Listen for messages from the host renderer (main window)
ipcRenderer.on('auth:setToken', (_event, token) => {
  // Forward to webview page via postMessage
  window.postMessage({ source: 'donethat-desktop', type: 'auth:setToken', payload: { token } }, '*');
});

ipcRenderer.on('auth:logout', () => {
  // Forward to webview page
  window.postMessage({ source: 'donethat-desktop', type: 'auth:logout' }, '*');
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
});

// Securely expose APIs to the webview page
contextBridge.exposeInMainWorld('Donethat', {
  openLink: (url) => {
    try {
      ipcRenderer.sendToHost('portal:open-link', url);
    } catch (e) {}
  }
});

// Expose a restricted mock of ipcRenderer for backward compatibility
contextBridge.exposeInMainWorld('__realIpcRenderer', {
  send: (channel, ...args) => {
    if (channel === 'auth:logout') {
      ipcRenderer.sendToHost('portal:logout');
    } else {
      console.warn(`Blocked unauthorized IPC send from portal: ${channel}`);
    }
  }
});

// Note: we intentionally do NOT expose a full ipcRenderer here to avoid
// collisions with any variables defined by the embedded web app.
