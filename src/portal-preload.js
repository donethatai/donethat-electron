const { ipcRenderer, contextBridge } = require('electron');

const ALLOWED_SEND_TO_HOST_CHANNELS = [
  'auth:logout',
  'auth:google-signin',
  'auth:google-reauth',
  'desktop:open-setup',
  // Sent by the portal's Recording settings. It was missing here, so every
  // interval change the web app made was dropped before reaching the host.
  'updateCaptureInterval'
];
const TRUSTED_PORTAL_ORIGIN = 'https://app.donethat.ai';

/**
 * What this build can do, for the portal to gate its UI on.
 *
 * This file ships inside the app, so what it advertises is an exact statement
 * about the running binary. That is what lets the web app deploy ahead of the
 * desktop app: an older build exposes no `host` at all, so portal surfaces that
 * need one stay hidden until the app that can serve them is installed. Only
 * list a capability once the host actually implements it - the portal trusts
 * this list and will not feature-detect any further.
 */
const HOST_CAPABILITIES = ['setup-overlay', 'masking-sync'];

function getAppVersion() {
  try {
    return require('../package.json').version || null;
  } catch (e) {
    return null;
  }
}

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

// Host -> portal: open the web app's Log time dialog on the current page.
ipcRenderer.on('desktop:log-time', () => {
  postDesktopMessage({ source: 'donethat-desktop', type: 'desktop:log-time' });
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
  },
  host: {
    appVersion: getAppVersion(),
    platform: process.platform,
    capabilities: HOST_CAPABILITIES.slice()
  }
});

contextBridge.exposeInMainWorld('__electronIpcRenderer', {
  /**
   * @returns {boolean} whether the message was actually handed to the host.
   *
   * The portal gates its UI on `host.capabilities`, but that list and the
   * allowlist above are two arrays that can disagree. Reporting the drop is what
   * lets the caller say so instead of leaving a control that does nothing.
   */
  sendToHost: (channel, payload) => {
    if (!ALLOWED_SEND_TO_HOST_CHANNELS.includes(channel)) return false;
    try {
      ipcRenderer.sendToHost(channel, payload);
      return true;
    } catch (e) {
      return false;
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
