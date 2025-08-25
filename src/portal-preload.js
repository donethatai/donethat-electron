const { ipcRenderer } = require('electron');

// Set up message listener for auth:logout messages
window.addEventListener('message', (event) => {
  if (event?.data && typeof event.data === 'object' && event.data.type === 'auth:logout') {
    ipcRenderer.sendToHost('portal:logout');
    return;
  }
});

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
      try { } catch (e) {}
      sendToPage('auth:setToken', { token });
      desktopAuthState = 'token';
    });

    // Receive logout command
    ipcRenderer.on('auth:logout', () => {
      try { } catch (e) {}
      sendToPage('auth:logout');
      try { localStorage.clear(); } catch (e) {}
      try { sessionStorage.clear(); } catch (e) {}
      desktopAuthState = 'logout';
    });

    // Also listen for direct IPC messages from the webapp
    ipcRenderer.on('auth:logout', () => {
      ipcRenderer.sendToHost('portal:logout');
    });

    // Expose a minimal safe API for opening links
    if (typeof window !== 'undefined') {
      window.Donethat = window.Donethat || {};
      window.Donethat.openLink = function(url) {
        try {
          ipcRenderer.sendToHost('portal:open-link', url);
        } catch (e) {}
      };
    }

    // Expose the real ipcRenderer to the webapp (needed for auth logout)
    if (typeof window !== 'undefined') {
      window.__realIpcRenderer = ipcRenderer;
    }

  } catch (e) {}
});


