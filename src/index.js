const {
  onAuthStateChanged,
  onIdTokenChanged,
} = require("firebase/auth");
const { ipcRenderer } = require('electron');

const { auth } = require('./firebase.js');

const { initializeSettings, loadUserSettings } = require('./settings.js');
const { initializeAuth } = require('./auth.js');
const { initializeDashboard, resetSummaryState } = require('./dashboard.js');
const { initializePermissions } = require('./permissions.js');
const { initializeAnalytics, trackPageView } = require('./analytics.js');
const { routeLink } = require('./link-router.js');
const { 
  hasScreenCapturePermission,
  hasWindowsPermission,
  updateStoreScreenshots,
  updateCurrentView,
  getCurrentView,
  isAuthenticated,
  hasValidAccess,
  updatePauseState,
  updateDateCreated,
  initializeChat,
  updateUserStatus
} = require('./app-state.js');

require('./audio-recorder');



// Reference to embedded portal webview
let portalView = null;
let lastPortalTokenSent = null;
let lastPortalTokenTs = 0;
// Webview load watchdog/retry state
let portalLoadTimer = null;
let portalLoadRetries = 0;
const PORTAL_LOAD_TIMEOUT_MS = 12000; // 12s timeout for slow networks
const PORTAL_MAX_RETRIES = 3;
let portalSpinnerTimer = null; // delay before showing dashboard spinner

// Inform main that renderer is ready to receive auth tokens as early as possible
try { ipcRenderer.send('renderer:ready-for-auth'); } catch (_) {}

function hidePortalSpinner() {
  try {
    if (portalSpinnerTimer) { clearTimeout(portalSpinnerTimer); portalSpinnerTimer = null; }
    const s = document.getElementById('summaryLoadingSpinner');
    if (s) s.classList.add('hidden');
  } catch (_) {}
}

function showPortalSpinnerDelayed() {
  try {
    if (portalSpinnerTimer) { clearTimeout(portalSpinnerTimer); portalSpinnerTimer = null; }
    portalSpinnerTimer = setTimeout(() => {
      try {
        const s = document.getElementById('summaryLoadingSpinner');
        if (s) s.classList.remove('hidden');
      } catch (_) {}
    }, 1000); // 1s delay to avoid flicker on fast loads
  } catch (_) {}
}

function clearPortalLoadWatchdog() {
  if (portalLoadTimer) {
    clearTimeout(portalLoadTimer);
    portalLoadTimer = null;
  }
}

function startPortalLoadWatchdog(reason) {
  try { clearPortalLoadWatchdog(); } catch (_) {}
  try {
    // Reuse summary spinner as a generic dashboard overlay while webview loads (only when online)
    if (navigator.onLine) {
      showPortalSpinnerDelayed();
    }
    portalLoadTimer = setTimeout(() => {
      // If we timed out waiting for load, show error and optionally retry
      try { console.warn('[Webview] load timeout (' + (reason || 'unknown') + '), retries:', portalLoadRetries); } catch (_) {}
      showWebviewError();
      // Retry only if we appear to be online and under retry limit
      if (navigator.onLine && portalView && portalLoadRetries < PORTAL_MAX_RETRIES) {
        portalLoadRetries += 1;
        try {
          if (navigator.onLine) hideWebviewError();
          portalView.reload();
          startPortalLoadWatchdog('timeout-retry-' + portalLoadRetries);
        } catch (e) {
          console.error('[Webview] Error reloading after timeout:', e);
        }
      }
    }, PORTAL_LOAD_TIMEOUT_MS);
  } catch (_) {}
}

// Global updater for the Settings/Dashboard toggle button label
function updateSettingsToggleLabelGlobal() {
  try {
    const settingsToggleBtn = document.getElementById('openSettingsViewBtn');
    if (!settingsToggleBtn) return;
    const v = getCurrentView();
    if (v === 'settings' || v === 'permissions') {
      settingsToggleBtn.textContent = 'Dashboard';
      settingsToggleBtn.className = 'btn-primary topbar-btn'; // Bright orange when on permissions
    } else {
      settingsToggleBtn.textContent = 'Permissions';
      settingsToggleBtn.className = 'btn-secondary topbar-btn'; // Normal style otherwise
    }
  } catch (_) {}
}

// Proactively send token to the embedded portal when available
async function sendPortalLoginIfPossible() {
  try {
    if (!portalView) return;
    if (!isAuthenticated() || !auth?.currentUser?.getIdToken) return;
    const token = await auth.currentUser.getIdToken();
    // Debounce: avoid spamming the portal with the same token too frequently
    const now = Date.now();
    const sameToken = lastPortalTokenSent && lastPortalTokenSent === token;
    const withinCooldown = now - lastPortalTokenTs < 10000; // 10s
    if (sameToken && withinCooldown) {
      return;
    }
    try { portalView.send('auth:setToken', token); } catch (e) { console.error('[PortalSync] Error sending token', e); }
    lastPortalTokenSent = token;
    lastPortalTokenTs = now;
    lastPortalAuthResponseType = 'token';
    lastPortalAuthResponseTs = now;
  } catch (e) {}
}



// Add a small delay to check initial auth state
setTimeout(() => {
  const { ipcRenderer } = require('electron');
  ipcRenderer.send('initialAuthCheck', !!auth.currentUser);
  // Windows needed 3s, 1s was enough for mac
}, 3000);

// Get references to views and elements
const signInView = document.getElementById("signInView");
const signUpView = document.getElementById("signUpView");
const resetView = document.getElementById("resetView");
const dashboardView = document.getElementById("dashboardView");
  const settingsView = document.getElementById("settingsView");

  
  // Update the navigateToView function
function navigateToView(viewName) {
  const currentView = getCurrentView();



  // Handle 'signup-next' parameter
  if (viewName === 'signup-next') {
    // If not authenticated, always go to signin
    if (!isAuthenticated()) {
      viewName = 'signin';
    } else if (!hasScreenCapturePermission() || !hasWindowsPermission()) {
      viewName = 'settings';
    } else {
      viewName = 'dashboard';
    }
  }

  // Show the requested view
  let viewToShow;
  switch (viewName) {
    case 'dashboard':
      viewToShow = dashboardView;
      break;
    case 'settings':
      resetSummaryState();
      viewToShow = settingsView;
      break;

    case 'permission':
    case 'permissions':
      viewToShow = settingsView;
      break;

    case 'signin':
      viewToShow = signInView;
      break;
    case 'signup':
      viewToShow = signUpView;
      break;
    case 'reset':
      viewToShow = resetView;
      break;
    default:
      viewToShow = dashboardView;
  }

  // Check there is an actual change in view
  if (viewToShow && viewToShow != currentView) {
    // Hide all views first
    const allViews = document.querySelectorAll('.view-container');
    allViews.forEach(view => view.classList.add('hidden'));
    // Show the requested view
    viewToShow.classList.remove('hidden');
    // Single shared topbar visibility
    const appTopbar = document.getElementById('appTopbar');
    const isAuthScreen = (viewName === 'signin' || viewName === 'signup' || viewName === 'reset');
    if (appTopbar) {
      // Hide the entire topbar on auth screens or when screen permission or windows permission is missing
      const shouldHideTopbar = isAuthScreen || !hasScreenCapturePermission() || !hasWindowsPermission();
      if (shouldHideTopbar) appTopbar.classList.add('hidden');
      else appTopbar.classList.remove('hidden');
    }
    // If opening dashboard, proactively attempt login message to portal
    if (viewName === 'dashboard') {
      sendPortalLoginIfPossible();
      // Refresh webview only when transitioning from a different view to dashboard
      try {
        if (currentView !== 'dashboard' && portalView) {
          if (navigator.onLine) {
            hideWebviewError();
            portalView.reload();
            startPortalLoadWatchdog('navigate-to-dashboard');
          } else {
            showWebviewError();
          }
        }
      } catch (e) { console.error('[Webview] Error reloading on navigateToView(dashboard):', e); }
    }
    // Update the current view state
    updateCurrentView(viewName);

      // Update labels for settings button (global updater)
  updateSettingsToggleLabelGlobal();
  
  // Ensure topbar actions are visible by default (unless on settings without permission)
  const topbarActionsElement = document.querySelector('.topbar-actions');
  if (topbarActionsElement && viewName !== 'settings') {
    topbarActionsElement.classList.remove('hidden');
  }
  
  // Track page view in analytics with all necessary details
  trackPageView(viewName);
  } else {
    console.error('View not found:', viewName);
  }
}

async function loadUserSettingsCallback() {
  // Keep spinner visible during the entire process - no need to call showBlockingSpinner() again
  try {
    const result = await loadUserSettings();
    if (!result) {
      hideBlockingSpinner();
      return; // Exit if no result (user not logged in)
    }
    
    // Use the status directly from settings - backend should send the correct status
    const userStatus = result.data?.status || 'inactive';

    // Update all relevant state
    updateUserStatus(userStatus);
    updateStoreScreenshots(result.data?.storeScreenshots || false);
    updateDateCreated(result.data?.analytics?.createdAt);

    // Send user status to main process
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('updateUserStatus', userStatus);

    // Fetch initial pause state from main process
    const initialIsPaused = await ipcRenderer.invoke('getInitialPauseState');
    
    // Update app-state with the initial value
    updatePauseState(initialIsPaused);

    // Only navigate if we're not already in the settings view
    if (getCurrentView() !== 'settings') {
      // Now hide spinner only after we've prepared everything for navigation
      navigateToView('signup-next');
    }
    
    // Hide spinner after everything is complete, including view transition
    hideBlockingSpinner();
  } catch (error) {
    console.error("Error loading user settings:", error);
    hideBlockingSpinner();
  }
}

// Function to show webview error message
function showWebviewError() {
  const dashboardEmbed = document.querySelector('.dashboard-embed');
  // Hide the webview while showing the error overlay
  try {
    if (portalView) portalView.classList.add('hidden');
  } catch (_) {}
  if (dashboardEmbed) {
    // Create error message if it doesn't exist
    let errorDiv = dashboardEmbed.querySelector('.webview-error');
    if (!errorDiv) {
      errorDiv = document.createElement('div');
      errorDiv.className = 'webview-error';
      errorDiv.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full p-8 text-center">
          <div class="text-gray-500 mb-4">
            <svg class="w-12 h-12 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <!-- Balanced, non-tilted no-wifi icon: wifi arcs + small X -->
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.004 11.803A15.5 15.5 0 0122 11.803"></path>
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.05 14.753a10.5 10.5 0 0113.9 0"></path>
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.111 17.804a5.5 5.5 0 017.778 0"></path>
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.75 19.25l2.5 2.5M13.25 19.25l-2.5 2.5"></path>
            </svg>
            <p class="text-lg font-medium mb-2">You seem to be offline</p>
            <p class="text-sm text-gray-400 mb-4">Check your connection and try again</p>
            <button id="webviewRetryBtn" class="btn-primary px-4 py-2 rounded-lg text-sm">
              Try again
            </button>
          </div>
        </div>
      `;
      dashboardEmbed.appendChild(errorDiv);
      
      // Add event listener for retry button
      const retryBtn = errorDiv.querySelector('#webviewRetryBtn');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          // Only attempt reload if back online
          if (!navigator.onLine) return;
          if (portalView) {
            try {
              hideWebviewError();
              portalView.reload();
            } catch (e) {
              console.error('[Webview] Error reloading:', e);
            }
          }
        });
      }
    }
    errorDiv.classList.remove('hidden');
  }
}

// Function to hide webview error message
function hideWebviewError() {
  const errorDiv = document.querySelector('.webview-error');
  if (errorDiv) {
    errorDiv.classList.add('hidden');
  }
  // Show the webview again
  try {
    if (portalView) portalView.classList.remove('hidden');
  } catch (_) {}
}

// Update the document ready handler
document.addEventListener('DOMContentLoaded', () => {
  // Initialize all modules
  initializeAuth(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeDashboard(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeSettings(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializePermissions(navigateToView, getCurrentView, updateTopbarVisibility);
  initializeAnalytics();

  // Grab the portal webview if present
  portalView = document.getElementById('portalView');

  // Respond to main process request to reload webview (throttled in main)
  try {
    ipcRenderer.on('webview:reload', () => {
      try {
        if (getCurrentView && getCurrentView() === 'dashboard' && portalView) {
          if (navigator.onLine) {
            hideWebviewError();
            portalView.reload();
            startPortalLoadWatchdog('ipc-reload');
          } else {
            showWebviewError();
          }
          // Re-send token after reload
          sendPortalLoginIfPossible();
        }
      } catch (e) { console.error('[Webview] Error reloading on IPC webview:reload:', e); }
    });
  } catch (e) {}
  
  // Reload webview when window opens (only once)
  if (portalView) {
    try {
      if (navigator.onLine) {
        portalView.reload();
        startPortalLoadWatchdog('window-open');
      }
    } catch (e) {
      console.error('[Webview] Error reloading on window open:', e);
    }
  }
  
  // Initial offline/online UI state
  if (!navigator.onLine) {
    showWebviewError();
  } else {
    hideWebviewError();
  }
  
  // Listen to connectivity changes
  window.addEventListener('offline', () => {
    showWebviewError();
    try { const s = document.getElementById('summaryLoadingSpinner'); if (s) s.classList.add('hidden'); } catch (_) {}
  });
  window.addEventListener('online', () => {
    hideWebviewError();
    try { if (portalView) { portalView.reload(); startPortalLoadWatchdog('online'); } } catch (e) { console.error('[Webview] reload on online failed', e); }
  });

  // Reloads on focus are coordinated via main process (webview:reload)
  const openChatBtn = document.getElementById('openChatBtn');
  const openSettingsViewBtn = document.getElementById('openSettingsViewBtn');
  

  if (openChatBtn) {
    try {
      const isMac = process.platform === 'darwin';
      openChatBtn.textContent = `Chat (${isMac ? 'Cmd' : 'Ctrl'}+Shift+D)`;
      openChatBtn.title = `Chat (${isMac ? 'Cmd' : 'Ctrl'}+Shift+D)`;
    } catch (e) {}
    
    openChatBtn.addEventListener('click', () => {
      // Only allow chat if authenticated and has valid access
      if (!isAuthenticated()) {
        return;
      }
      if (!hasValidAccess()) {
        return;
      }
      try { ipcRenderer.send('overlay:toggle'); } catch (e) {}
    });

    // React to hotkey updates from main to refresh label
    try {
      ipcRenderer.on('hotkey:updated', (_event, payload) => {
        if (!payload || !payload.label) return;
        openChatBtn.textContent = `Chat (${payload.label})`;
        openChatBtn.title = `Chat (${payload.label})`;
      });
      // Also request current label once
      ipcRenderer.invoke('hotkey:get').then((res) => {
        if (res && res.success && res.label) {
          openChatBtn.textContent = `Chat (${res.label})`;
          openChatBtn.title = `Chat (${res.label})`;
        }
      }).catch(() => {});
    } catch (_) {}
  }
  if (openSettingsViewBtn) {
    openSettingsViewBtn.addEventListener('click', () => {
      const current = getCurrentView();
      if (current === 'settings') {
        navigateToView('dashboard');
      } else {
        // When not on settings, navigate to settings
        navigateToView('settings');
      }
    });
  }
  // Settings/back icon swap
  const settingsOrBackBtn = document.getElementById('settingsOrBackBtn');
  const settingsOrBackIcon = document.getElementById('settingsOrBackIcon');
  function updateSettingsIcon() {
    const v = getCurrentView();
    if (v === 'settings') {
      settingsOrBackBtn?.setAttribute('title', 'Back');
      if (settingsOrBackIcon) settingsOrBackIcon.textContent = '←';
    } else {
      settingsOrBackBtn?.setAttribute('title', 'Settings');
      if (settingsOrBackIcon) settingsOrBackIcon.textContent = '⚙︎';
    }
  }
  settingsOrBackBtn?.addEventListener('click', () => {
    const v = getCurrentView();
    if (v === 'settings') navigateToView('dashboard'); else navigateToView('settings');
  });

  // Recording dropdown
  const recordingBtn = document.getElementById('recordingStateBtn');
  const recordingIcon = document.getElementById('recordingStateIcon');
  const recordingMenu = document.getElementById('recordingMenu');
  const pauseTodayBtn = document.getElementById('pauseTodayBtn');
  const resumeNowBtn = document.getElementById('resumeNowBtn');

  function toggleRecordingMenu(open) {
    if (!recordingMenu) return;
    if (open === true) recordingMenu.classList.remove('hidden');
    else if (open === false) recordingMenu.classList.add('hidden');
    else recordingMenu.classList.toggle('hidden');
  }

  // Enable/disable menu entries based on pause state and valid access
  function updateRecordingMenuState(isPaused) {
    if (!recordingMenu) return;
    
    // Check if user has valid access
    const userHasValidAccess = hasValidAccess();
    
    // Disable all recording controls if user doesn't have valid access
    recordingMenu.querySelectorAll('[data-pause]')?.forEach(el => {
      if (isPaused || !userHasValidAccess) el.classList.add('disabled'); else el.classList.remove('disabled');
    });
    if (resumeNowBtn) {
      if (isPaused && userHasValidAccess) resumeNowBtn.classList.remove('disabled'); else resumeNowBtn.classList.add('disabled');
    }
    if (pauseTodayBtn) {
      if (isPaused || !userHasValidAccess) pauseTodayBtn.classList.add('disabled'); else pauseTodayBtn.classList.remove('disabled');
    }
  }

  recordingBtn?.addEventListener('click', () => toggleRecordingMenu());
  document.addEventListener('click', (e) => {
    if (!recordingMenu || !recordingBtn) return;
    if (!recordingMenu.contains(e.target) && !recordingBtn.contains(e.target)) {
      recordingMenu.classList.add('hidden');
    }
  });
  // Pause durations
  recordingMenu?.querySelectorAll('[data-pause]')?.forEach(btn => {
    btn.addEventListener('click', () => {
      // Check if user has valid access before allowing pause
      if (!hasValidAccess()) {
        return;
      }
      const ms = Number(btn.getAttribute('data-pause')) || 0;
      if (ms > 0) ipcRenderer.send('pauseForMs', ms);
      toggleRecordingMenu(false);
    });
  });
  pauseTodayBtn?.addEventListener('click', () => { 
    // Check if user has valid access before allowing pause
    if (!hasValidAccess()) {
      return;
    }
    if (!pauseTodayBtn.classList.contains('disabled')) { 
      ipcRenderer.send('pauseForToday'); 
      toggleRecordingMenu(false); 
    } 
  });
  resumeNowBtn?.addEventListener('click', () => { 
    // Check if user has valid access before allowing resume
    if (!hasValidAccess()) {
      return;
    }
    if (!resumeNowBtn.classList.contains('disabled')) { 
      ipcRenderer.send('resumeRecording'); 
      toggleRecordingMenu(false); 
    } 
  });

  // Update recording icon on pause/resume changes
  function setRecordingIcon(isPaused) {
    if (!recordingIcon || !recordingBtn) return;
    if (isPaused) {
      recordingIcon.textContent = '||';
      recordingIcon.classList.remove('active');
      recordingBtn?.setAttribute('title', 'Paused');
    } else {
      recordingIcon.textContent = '●';
      recordingIcon.classList.add('active'); // orange dot when recording
      recordingBtn?.setAttribute('title', 'Recording');
    }
    updateRecordingMenuState(isPaused);
  }
  // Get initial recording state from main process
  ipcRenderer.invoke('getInitialPauseState').then((isPaused) => {
    setRecordingIcon(isPaused);
  }).catch(() => {
    // Fallback: assume recording unless told otherwise
    setRecordingIcon(false);
  });

  // Change settings button label on view change
  // use global updater

  ipcRenderer.on('pauseStateChanged', (event, isPaused) => {
    setRecordingIcon(isPaused);
  });

  // Sync initial labels
  updateSettingsToggleLabelGlobal();

  // Keep settings/back icon accurate on load
  updateSettingsIcon();

  if (portalView) {
    // Handle webview load errors
    portalView.addEventListener('did-fail-load', (event) => {
      console.error('[Webview] Failed to load:', event);
      showWebviewError();
      clearPortalLoadWatchdog();
      hidePortalSpinner();
    });
    try { portalView.addEventListener('did-fail-provisional-load', (event) => {
      console.error('[Webview] Provisional load failed:', event);
      showWebviewError();
      clearPortalLoadWatchdog();
      hidePortalSpinner();
    }); } catch (_) {}

    try { portalView.addEventListener('did-start-loading', () => {
      if (navigator.onLine) {
        hideWebviewError();
        startPortalLoadWatchdog('did-start-loading');
      } else {
        showWebviewError();
      }
    }); } catch (_) {}

    try { portalView.addEventListener('did-stop-loading', () => {
      clearPortalLoadWatchdog();
      hidePortalSpinner();
    }); } catch (_) {}

    // When the webview is ready, send login token and optionally open devtools
    portalView.addEventListener('dom-ready', () => {
      // Only hide error when online; keep offline overlay visible when offline
      if (navigator.onLine) {
        hideWebviewError();
      }
      portalLoadRetries = 0;
      clearPortalLoadWatchdog();
      hidePortalSpinner();
      // Proactively send login token whenever portal becomes ready
      sendPortalLoginIfPossible();
      
      // Inject the ipcRenderer bridge and link processing into the webapp's context
      try {
        portalView.executeJavaScript(`
          window.__electronIpcRenderer = {
            sendToHost: function(channel, data) {
              if (channel === 'auth:logout' && window.__realIpcRenderer) {
                window.__realIpcRenderer.sendToHost('portal:logout');
              }
            }
          };
          
          // Add link processing API
          window.Donethat = window.Donethat || {};
          window.Donethat.openLink = function(url) {
            console.log('[WEBVIEW] openLink called with URL:', url);
            try {
              if (window.__realIpcRenderer) {
                window.__realIpcRenderer.sendToHost('portal:open-link', url);
              }
            } catch (e) {
              console.error('[WEBVIEW] Error sending portal:open-link:', e);
            }
          };
          
          // Return a simple value to avoid cloning issues
          true;
        `);
      } catch (e) {
        console.error('[Portal] Failed to inject ipcRenderer and link processing:', e);
      }
      
      // Open devtools only when DEBUG flag is true
      (async () => {
        try {
          const isDebug = await ipcRenderer.invoke('get-debug-flag');
          if (isDebug) {
            try { portalView.openDevTools(); } catch (e) {}
          }
        } catch (e) {}
      })();
    });

    try { portalView.addEventListener('did-finish-load', () => {
      portalLoadRetries = 0;
      clearPortalLoadWatchdog();
      hidePortalSpinner();
    }); } catch (_) {}

    // Also send token on internal navigations
    try { portalView.addEventListener('did-navigate', sendPortalLoginIfPossible); } catch (e) {}
    try { portalView.addEventListener('did-frame-finish-load', sendPortalLoginIfPossible); } catch (e) {}

    // Pipe webview console to renderer for visibility (only in debug mode)
    (async () => {
      try {
        const isDebug = await ipcRenderer.invoke('get-debug-flag');
        if (isDebug) {
          try {
            portalView.addEventListener('console-message', (e) => {
              console.log('[Webview]', e.level, e.message);
            });
          } catch (e) {}
        }
      } catch (e) {}
    })();

    // Handle messages from webview (logout and link routing)
    portalView.addEventListener('ipc-message', async (event) => {
      if (event.channel === 'portal:logout') {
        // Web app initiated logout -> perform desktop logout flow
        try {
          const { performFullLogout } = require('./auth.js');
          await performFullLogout();
        } catch (e) {
          console.error('Error during portal-initiated logout:', e);
        }
      } else if (event.channel === 'portal:open-link') {
        const url = event.args[0];
        if (url) {
          routeLink(url, { source: 'webview' });
        }
      }
    });
  }

  // Add event listener for app settings link
  const appSettingsLink = document.querySelector('.app-settings-link');
  if (appSettingsLink) {
    appSettingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      routeLink('https://app.donethat.ai/settings', { source: 'index' });
    });
  }

  // Add event listener for support link
  const supportLink = document.querySelector('.support-link');
  if (supportLink) {
    supportLink.addEventListener('click', (e) => {
      e.preventDefault();
      routeLink('https://donethat.ai/support', { source: 'index' });
    });
  }

  // In-app notification wiring
  const inappEl = document.getElementById('inappNotification');
  const inTitle = document.getElementById('inappNotificationTitle');
  const inMsg = document.getElementById('inappNotificationMessage');
  const inAction = document.getElementById('inappNotificationAction');
  const inClose = document.getElementById('inappNotificationClose');
  let inappTimer = null;
  let inappCurrent = null; // { id, sticky, action }

  function hideInappNotification() {
    if (inappTimer) { clearTimeout(inappTimer); inappTimer = null; }
    if (inappEl) inappEl.classList.add('hidden');
    inappCurrent = null;
  }

  function showInappNotification(opts) {
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

    inClose.onclick = () => hideInappNotification();
    inappEl.classList.remove('hidden');
    if (!sticky) {
      inappTimer = setTimeout(() => hideInappNotification(), 10000);
    }
  }

  ipcRenderer.on('inapp:notify', (_event, payload) => {
    try { ipcRenderer.send('focus-app-window'); } catch (e) {}
    showInappNotification(payload);
  });

  // Allow programmatic hide from other modules
  ipcRenderer.on('inapp:hide', () => {
    hideInappNotification();
  });
});

// Keep portal session in sync with desktop auth
onAuthStateChanged(auth, async (user) => {
  if (!portalView) return;
  if (user) {
    try {
      const token = await user.getIdToken();
      // Send token via IPC to the webview; web app will handle login via message
      try { portalView.send('auth:setToken', token); } catch (e) { console.error('[PortalSync] Error sending token', e); }
      lastPortalTokenSent = token;
      lastPortalTokenTs = Date.now();
      lastPortalAuthResponseType = 'token';
      lastPortalAuthResponseTs = Date.now();
    } catch (e) {}
  } else {
    // Notify webview to clear client-side session via message
    try { portalView.send('auth:logout'); } catch (e) { console.error('[PortalSync] Error sending logout', e); }
    lastPortalTokenSent = null;
    lastPortalTokenTs = 0;
    lastPortalAuthResponseType = 'logout';
    lastPortalAuthResponseTs = Date.now();
  }
});

onIdTokenChanged(auth, async (user) => {
  if (!portalView) return;
  if (user) {
    try {
      const token = await user.getIdToken();
      portalView.send('auth:setToken', token);
      lastPortalTokenSent = token;
      lastPortalTokenTs = Date.now();
      lastPortalAuthResponseType = 'token';
      lastPortalAuthResponseTs = Date.now();
    } catch (e) {}
  }
});

// Function to create an overlay that blocks interactions
function showBlockingSpinner() {
  const globalSpinner = document.getElementById("globalSpinner");
  if (globalSpinner) {
    // Show the spinner without affecting layout
    globalSpinner.classList.remove("hidden");
    // Ensure content remains visible
    globalSpinner.style.opacity = "1";
    globalSpinner.style.transition = "opacity 0.2s ease-in-out";
  }
}

// Function to hide the blocking spinner
function hideBlockingSpinner() {
  const globalSpinner = document.getElementById("globalSpinner");
  if (globalSpinner) {
    // Hide the spinner
    globalSpinner.classList.add("hidden");
    // Reset opacity
    globalSpinner.style.opacity = "0";
  }
}

// Function to update topbar visibility based on permissions
function updateTopbarVisibility() {
  const appTopbar = document.getElementById('appTopbar');
  const currentView = getCurrentView();
  const isAuthScreen = (currentView === 'signin' || currentView === 'signup' || currentView === 'reset');
  
  if (appTopbar) {
    // Hide the entire topbar on auth screens or when screen permission or windows permission is missing
    const shouldHideTopbar = isAuthScreen || !hasScreenCapturePermission() || !hasWindowsPermission();
    if (shouldHideTopbar) appTopbar.classList.add('hidden');
    else appTopbar.classList.remove('hidden');
  }
}

// Add IPC listener for navigation
ipcRenderer.on('navigate', (event, viewName) => {
  navigateToView(viewName);
});

// Add pause state handler
ipcRenderer.on('pauseStateChanged', (event, isPaused) => {
  updatePauseState(isPaused);
});

// Handle donethat:// forwarded from main as internal navigation
ipcRenderer.on('router:open-link', (event, url) => {
  try {
    if (url) {
      routeLink(url, { source: 'main' });
    }
  } catch (e) {}
});

// Initialize centralized chat (state-managed)
initializeChat();

// Export functions for use in other modules
module.exports = {
  updateTopbarVisibility
};