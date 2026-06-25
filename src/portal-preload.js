const { ipcRenderer, contextBridge } = require('electron');

const ALLOWED_SEND_TO_HOST_CHANNELS = ['auth:logout', 'auth:google-signin', 'auth:google-reauth'];
const TRUSTED_PORTAL_ORIGIN = 'https://app.donethat.ai';

function postDesktopMessage(message) {
  window.postMessage(message, TRUSTED_PORTAL_ORIGIN);
}

// Listen for messages from the host renderer (main window)
ipcRenderer.on('auth:setToken', (_event, token) => {
  postDesktopMessage({ source: 'donethat-desktop', type: 'auth:setToken', payload: { token } });
});

ipcRenderer.on('auth:logout', () => {
  postDesktopMessage({ source: 'donethat-desktop', type: 'auth:logout' });
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
});

ipcRenderer.on('auth:setCustomToken', (_event, payload) => {
  postDesktopMessage({ source: 'donethat-desktop', type: 'auth:setCustomToken', payload: payload || {} });
});

ipcRenderer.on('auth:reauth-result', (_event, payload) => {
  postDesktopMessage({ source: 'donethat-desktop', type: 'auth:reauth-result', payload: payload || {} });
});

// Securely expose APIs to the webview page
contextBridge.exposeInMainWorld('Donethat', {
  openLink: (url) => {
    try {
      ipcRenderer.sendToHost('portal:open-link', url);
    } catch (e) {}
  }
});

contextBridge.exposeInMainWorld('__electronIpcRenderer', {
  sendToHost: (channel, payload) => {
    if (ALLOWED_SEND_TO_HOST_CHANNELS.includes(channel)) {
      try {
        ipcRenderer.sendToHost(channel, payload);
      } catch (e) {}
    }
  }
});

// Backward compatibility: web app may call __realIpcRenderer.send('auth:logout')
contextBridge.exposeInMainWorld('__realIpcRenderer', {
  send: (channel, ...args) => {
    if (channel === 'auth:logout') {
      ipcRenderer.sendToHost('auth:logout');
    } else {
      console.warn(`Blocked unauthorized IPC send from portal: ${channel}`);
    }
  }
});
