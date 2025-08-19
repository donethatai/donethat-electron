const { ipcRenderer } = require('electron');

// Listen for auth messages from the host renderer
window.addEventListener('DOMContentLoaded', () => {
  try {
    let desktopAuthState = 'unknown'; // 'unknown' | 'token' | 'logout'

    // Provide a minimal bridge inside the webview page via postMessage
    const sendToPage = (type, payload) => {
      try {
        window.postMessage({ source: 'donethat-desktop', type, payload }, '*');
      } catch (e) {}
    };

    // Receive token updates
    ipcRenderer.on('auth:setToken', (_event, token) => {
      try { console.log('[Preload] Received auth:setToken'); } catch (e) {}
      sendToPage('auth:setToken', { token });
      desktopAuthState = 'token';
    });

    // Receive logout command
    ipcRenderer.on('auth:logout', () => {
      try { console.log('[Preload] Received auth:logout'); } catch (e) {}
      sendToPage('auth:logout');
      try { localStorage.clear(); } catch (e) {}
      try { sessionStorage.clear(); } catch (e) {}
      desktopAuthState = 'logout';
    });

    // Allow the embedded page to request current auth state
    window.addEventListener('message', (event) => {
      if (!event?.data || typeof event.data !== 'object') return;
      if (event.data.type === 'auth:logout') {
        try { console.log('[Preload] auth:logout from page'); } catch (e) {}
        ipcRenderer.sendToHost('portal:logout');
      }
    });
  } catch (e) {}
});


