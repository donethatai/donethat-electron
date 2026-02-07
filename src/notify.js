const ipcRenderer = window.electronAPI;

// In-app notification state and DOM elements
let inappEl = null;
let inTitle = null;
let inMsg = null;
let inAction = null;
let inClose = null;
let inappTimer = null;
let inappCurrent = null; // { id, sticky, action }

// Initialize DOM element references (called when DOM is ready)
function initializeInappNotification() {
  inappEl = document.getElementById('inappNotification');
  inTitle = document.getElementById('inappNotificationTitle');
  inMsg = document.getElementById('inappNotificationMessage');
  inAction = document.getElementById('inappNotificationAction');
  inClose = document.getElementById('inappNotificationClose');
  
  // Set up close button handler
  if (inClose) {
    inClose.onclick = () => hideInappNotification();
  }
}

function hideInappNotification() {
  if (inappTimer) { clearTimeout(inappTimer); inappTimer = null; }
  if (inappEl) inappEl.classList.add('hidden');
  inappCurrent = null;
}

function showInappNotification(opts) {
  // Initialize DOM elements if not already done
  if (!inappEl || !inTitle || !inMsg || !inClose || !inAction) {
    initializeInappNotification();
  }
  
  if (!inappEl || !inTitle || !inMsg || !inClose || !inAction) return;
  
  const { id, title, message, sticky, action } = opts || {};
  inappCurrent = { id, sticky: !!sticky, action: action || null };

  inTitle.textContent = title || '';
  inMsg.textContent = message || '';

  if (action && action.label && action.channel) {
    inAction.textContent = action.label;
    inAction.classList.remove('hidden');
    inAction.onclick = () => {
      try { ipcRenderer.send(action.channel, action.payload || null); } catch (e) {}
      hideInappNotification();
    };
  } else {
    inAction.classList.add('hidden');
    inAction.onclick = null;
  }

  if (inClose) {
    inClose.onclick = () => hideInappNotification();
  }
  
  inappEl.classList.remove('hidden');
  if (!sticky) {
    inappTimer = setTimeout(() => hideInappNotification(), 10000);
  }
}

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

    // If noFocus is true, always use in-app notification (never background)
    if (noFocus) {
      showInappNotification(payload);
    } else {
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
        showInappNotification(payload);
      } else {
        // App is not focused - use background notification
        ipcRenderer.send('background:notify', payload);
      }
    }
  } catch (_) {}
}

function hideBanner() {
  hideInappNotification();
  try { 
    ipcRenderer.send('background:hide');
  } catch (_) {}
}

// Listen for programmatic hide from other modules
ipcRenderer.on('inapp:hide', () => {
  hideInappNotification();
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeInappNotification);
} else {
  initializeInappNotification();
}

module.exports = { showBanner, hideBanner };


