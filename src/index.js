const {
  onAuthStateChanged,
  onIdTokenChanged,
} = require("firebase/auth");
const ipcRenderer = window.electronAPI;

const { auth } = require('./firebase.js');

const { initializeSettings, loadUserSettings } = require('./settings.js');
const { initializeAuth } = require('./auth.js');
const { initializeDashboard, resetSummaryState } = require('./dashboard.js');
const { initializePermissions } = require('./permissions.js');
const { initializeAnalytics, trackPageView } = require('./analytics.js');
const { initializeFeedback } = require('./feedback.js');
const { routeLink } = require('./link-router.js');
const { showBanner } = require('./notify.js');
const { 
  hasScreenCapturePermission,
  hasWindowsPermission,
  isCaptureReadinessReady,
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
require('./linux-screenshot');



// Reference to embedded portal webview
let portalView = null;
let portalDomReady = false;
let lastPortalTokenSent = null;
let lastPortalTokenTs = 0;
// Webview load watchdog/retry state
let portalLoadTimer = null;
let portalLoadRetries = 0;
const PORTAL_LOAD_TIMEOUT_MS = 12000; // 12s timeout for slow networks
const PORTAL_MAX_RETRIES = 3;
let portalSpinnerTimer = null; // delay before showing dashboard spinner
const PORTAL_RELOAD_COOLDOWN_MS = 10000; // avoid reloads shortly after token delivery
const PORTAL_BLANK_URL = 'about:blank';
const PORTAL_DEFAULT_URL = 'https://app.donethat.ai';
let portalSuspendedForTray = false;
let portalSuspendInFlight = false;
let portalResumePendingAfterSuspend = false;

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
          clearPortalLoadWatchdog();
        }
      } else {
        clearPortalLoadWatchdog();
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
      settingsToggleBtn.textContent = 'Setup';
      settingsToggleBtn.className = 'btn-secondary topbar-btn'; // Normal style otherwise
    }
  } catch (_) {}
}

function updateTopbarReloadVisibility(viewName) {
  try {
    const reloadBtn = document.getElementById('reloadIframeBtn');
    if (!reloadBtn) return;
    if (viewName === 'dashboard') {
      reloadBtn.classList.remove('hidden');
      reloadBtn.style.display = '';
      reloadBtn.setAttribute('aria-hidden', 'false');
    } else {
      reloadBtn.classList.add('hidden');
      reloadBtn.style.display = 'none';
      reloadBtn.setAttribute('aria-hidden', 'true');
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

function canReloadPortalNow() {
  try {
    // Avoid reloads shortly after we just sent an auth token to the portal
    if (lastPortalTokenTs && (Date.now() - lastPortalTokenTs) < PORTAL_RELOAD_COOLDOWN_MS) {
      return false;
    }
  } catch (_) {}
  return true;
}

function safePortalReload(reason) {
  try {
    if (!portalView) return;
    if (portalSuspendedForTray) return;
    const currentSrc = portalView.getAttribute('src') || '';
    if (currentSrc === PORTAL_BLANK_URL) return;
    // Only reload once the webview has emitted dom-ready; calling reload too early
    // can throw “WebView must be attached to the DOM and dom-ready emitted”.
    if (!portalDomReady) return;
    if (!navigator.onLine) { showWebviewError(); return; }
    if (!canReloadPortalNow()) { return; }
    hideWebviewError();
    portalView.reload();
    startPortalLoadWatchdog(reason || 'safe-reload');
  } catch (e) {
    console.error('[Webview] Error in safePortalReload:', e);
  }
}

function setPortalSuspendedPlaceholderVisible(visible) {
  const placeholder = document.getElementById('portalSuspendedPlaceholder');
  if (!placeholder) return;
  if (visible) {
    placeholder.classList.remove('hidden');
  } else {
    placeholder.classList.add('hidden');
  }
}

function suspendPortalForTray() {
  if (!portalView) return;
  if (portalSuspendedForTray) return;
  try { clearPortalLoadWatchdog(); } catch (_) {}
  try { hidePortalSpinner(); } catch (_) {}
  portalDomReady = false;
  portalSuspendInFlight = true;
  portalResumePendingAfterSuspend = false;
  const currentSrc = portalView.getAttribute('src') || '';
  if (currentSrc && currentSrc !== PORTAL_BLANK_URL) {
    portalView.setAttribute('data-last-src', currentSrc);
  }
  if (currentSrc !== PORTAL_BLANK_URL) {
    try { portalView.setAttribute('src', PORTAL_BLANK_URL); } catch (_) {}
  }
  try { portalView.classList.add('hidden'); } catch (_) {}
  setPortalSuspendedPlaceholderVisible(true);
  portalSuspendedForTray = true;
}

function resumePortalFromTrayIfNeeded() {
  if (!portalView || !portalSuspendedForTray) return;
  if (portalSuspendInFlight) {
    portalResumePendingAfterSuspend = true;
    return;
  }
  if (!(getCurrentView && getCurrentView() === 'dashboard')) {
    return;
  }
  const targetSrc = portalView.getAttribute('data-last-src') || PORTAL_DEFAULT_URL;
  try { portalView.setAttribute('src', targetSrc); } catch (_) {}
  try { portalView.classList.remove('hidden'); } catch (_) {}
  setPortalSuspendedPlaceholderVisible(false);
  portalSuspendedForTray = false;
}



// Add a small delay to check initial auth state
setTimeout(() => {
  // Use the secure preload bridge instead of requiring electron in the renderer
  try {
    ipcRenderer.send('initialAuthCheck', !!auth.currentUser);
  } catch (_) {}
  // Windows needed 3s, 1s was enough for mac
}, 3000);

// Get references to views and elements
const signInView = document.getElementById("signInView");
const mfaChallengeView = document.getElementById("mfaChallengeView");
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
    } else {
      viewName = 'dashboard';
    }
  }

  // Protected views require authentication
  const protectedViews = ['dashboard', 'settings', 'permission', 'permissions'];
  if (protectedViews.includes(viewName) && !isAuthenticated()) {
    viewName = 'signin';
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
    case 'mfa':
      viewToShow = mfaChallengeView;
      break;
    case 'signup':
      viewToShow = signUpView;
      break;
    case 'reset':
      viewToShow = resetView;
      break;
    default:
      viewToShow = isAuthenticated() ? dashboardView : signInView;
  }

  // Check there is an actual change in view
  if (viewToShow && viewToShow != currentView) {
    // Hide all views first
    const allViews = document.querySelectorAll('.view-container');
    allViews.forEach(view => view.classList.add('hidden'));
    // Show the requested view
    viewToShow.classList.remove('hidden');
    // Ensure settings tiles are contained
    if (viewName === 'settings' || viewName === 'permissions') {
      try {
        const container = document.querySelector('#settingsView .auth-container');
        if (container) {
          const cards = Array.from(document.querySelectorAll('#settingsView .auth-card'));
          cards.forEach((el) => { if (!container.contains(el)) container.appendChild(el); });
        }
      } catch (_) {}
    }
    
    // Show custom screenshot section on Linux when settings view is displayed
    if ((viewName === 'settings' || viewName === 'permissions') && window.electronAPI && window.electronAPI.platform === 'linux') {
      const linuxInstallGuideNote = document.getElementById('linuxInstallGuideNote');
      if (linuxInstallGuideNote) {
        linuxInstallGuideNote.classList.remove('hidden');
      }
      const linuxScreenshotSection = document.getElementById('linuxScreenshotSection');
      if (linuxScreenshotSection) {
        linuxScreenshotSection.classList.remove('hidden');
      }
    }
    
    // Single shared topbar visibility
    const appTopbar = document.getElementById('appTopbar');
    const isAuthScreen = (viewName === 'signin' || viewName === 'signup' || viewName === 'reset' || viewName === 'mfa');
    if (appTopbar) {
      const shouldHideTopbar = isAuthScreen;
      if (shouldHideTopbar) appTopbar.classList.add('hidden');
      else appTopbar.classList.remove('hidden');
    }
    // If opening dashboard, proactively attempt login message to portal
    if (viewName === 'dashboard') {
      resumePortalFromTrayIfNeeded();
      sendPortalLoginIfPossible();
      // Refresh webview only when transitioning from a different view to dashboard
      try {
        if (currentView !== 'dashboard' && portalView) {
          safePortalReload('navigate-to-dashboard');
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
  updateTopbarReloadVisibility(viewName);
  
  // Track page view in analytics with all necessary details
  trackPageView(viewName);
  updateDashboardCaptureWarning();
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

    // Send user status to main process (via secure preload bridge)
    try {
      ipcRenderer.send('updateUserStatus', userStatus);
    } catch (_) {}
    
    // Fetch initial pause state from main process
    let initialIsPaused = false;
    try {
      initialIsPaused = await ipcRenderer.invoke('getInitialPauseState');
    } catch (_) {}
    
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
    let errorDiv = dashboardEmbed.querySelector('.runtime-webview-error');
    if (!errorDiv) {
      errorDiv = document.createElement('div');
      errorDiv.className = 'webview-error runtime-webview-error';
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
  const errorDiv = document.querySelector('.runtime-webview-error');
  if (errorDiv) {
    errorDiv.classList.add('hidden');
  }
  // Show the webview again
  try {
    if (portalView && !portalSuspendedForTray) portalView.classList.remove('hidden');
  } catch (_) {}
}

function updateDashboardCaptureWarning() {
  const warningEl = document.getElementById('dashboardCaptureWarning');
  const warningText = document.getElementById('dashboardCaptureWarningText');
  if (!warningEl || !warningText) return;

  if (!isCaptureReadinessReady()) {
    warningEl.classList.add('hidden');
    return;
  }

  const screenToggle = document.getElementById('screenCheckbox');
  const windowsToggle = document.getElementById('windowsCheckbox');
  const isWaylandLinux = window.electronAPI?.platform === 'linux' && !!window.electronAPI?.isWayland;

  const screenEnabledByToggle = !!screenToggle?.checked;
  const windowsEnabledByToggle = isWaylandLinux ? true : !!windowsToggle?.checked;
  const screenPermissionGranted = !!hasScreenCapturePermission();
  const windowsPermissionGranted = isWaylandLinux ? true : !!hasWindowsPermission();

  const screenEffective = screenEnabledByToggle && screenPermissionGranted;
  const windowsEffective = windowsEnabledByToggle && windowsPermissionGranted;

  if (screenEffective && windowsEffective) {
    warningEl.classList.add('hidden');
    return;
  }

  const issues = [];
  if (!screenEffective) {
    if (!screenEnabledByToggle) {
      issues.push('Screenshare is turned off in Setup');
    } else if (!screenPermissionGranted) {
      issues.push('Screenshare permission is missing');
    }
  }
  if (!windowsEffective && !isWaylandLinux) {
    if (!windowsEnabledByToggle) {
      issues.push('Active applications are turned off in Setup');
    } else if (!windowsPermissionGranted) {
      issues.push('Active applications permission is missing');
    }
  }

  const issueSummary = issues.join(' and ');
  warningText.textContent = `Capture is limited because ${issueSummary}.`;

  warningEl.classList.remove('hidden');
}

// Update the document ready handler
document.addEventListener('DOMContentLoaded', () => {
  // Initialize all modules
  initializeAuth(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeDashboard(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeSettings(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializePermissions(navigateToView, getCurrentView, updateTopbarVisibility);
  initializeFeedback();
  initializeAnalytics();
  document.addEventListener('capture-state-updated', updateDashboardCaptureWarning);

  // Grab the portal webview if present
  portalView = document.getElementById('portalView');
  const reloadSuspendedPortalBtn = document.getElementById('reloadSuspendedPortalBtn');

  // Respond to main process request to reload webview (throttled in main)
  try {
    ipcRenderer.on('webview:reload', () => {
      try {
        if (getCurrentView && getCurrentView() === 'dashboard' && portalView) {
          safePortalReload('ipc-reload');
          // Re-send token after reload (allowed to be no-op)
          sendPortalLoginIfPossible();
        }
      } catch (e) { console.error('[Webview] Error reloading on IPC webview:reload:', e); }
    });
  } catch (e) {}
  
  // Track when the webview is ready; avoid reload loops triggered before dom-ready
  if (portalView) {
    try {
      portalView.addEventListener('dom-ready', () => {
        portalDomReady = true;
      });
    } catch (e) {
      console.error('[Webview] Error attaching dom-ready listener:', e);
    }
    // Reload webview when window opens (only once)
    if (navigator.onLine) {
      safePortalReload('window-open');
    }
  }
  
  // Initial offline/online UI state
  if (!navigator.onLine) {
    showWebviewError();
  } else {
    hideWebviewError();
  }
  setPortalSuspendedPlaceholderVisible(false);

  if (reloadSuspendedPortalBtn) {
    reloadSuspendedPortalBtn.addEventListener('click', () => {
      portalSuspendedForTray = true;
      resumePortalFromTrayIfNeeded();
      if (portalSuspendInFlight) return;
      const currentSrc = portalView ? (portalView.getAttribute('src') || '') : '';
      if (!portalView || currentSrc === PORTAL_BLANK_URL) return;
      if (portalView && navigator.onLine) {
        try {
          hideWebviewError();
          if (typeof portalView.reloadIgnoringCache === 'function') {
            portalView.reloadIgnoringCache();
          } else {
            portalView.reload();
          }
          startPortalLoadWatchdog('manual-suspended-reload');
          sendPortalLoginIfPossible();
        } catch (e) {
          console.error('[Webview] Error reloading from suspended placeholder:', e);
        }
      }
    });
  }
  
  // Listen to connectivity changes
  window.addEventListener('offline', () => {
    showWebviewError();
    try { const s = document.getElementById('summaryLoadingSpinner'); if (s) s.classList.add('hidden'); } catch (_) {}
  });
  window.addEventListener('online', () => {
    hideWebviewError();
    try { if (portalView) { safePortalReload('online'); } } catch (e) { console.error('[Webview] reload on online failed', e); }
  });

  // Reloads on focus are coordinated via main process (webview:reload)
  const openChatBtn = document.getElementById('openChatBtn');
  const openSettingsViewBtn = document.getElementById('openSettingsViewBtn');
  

  if (openChatBtn) {
    const isWaylandLinux = window.electronAPI?.platform === 'linux' && !!window.electronAPI?.isWayland;
    const applyChatLabel = (label) => {
      const text = label ? `Chat (${label})` : 'Chat';
      openChatBtn.textContent = text;
      openChatBtn.title = text;
    };
    if (isWaylandLinux) {
      openChatBtn.textContent = 'Chat';
      openChatBtn.title = 'Chat';
    } else {
      applyChatLabel(null);
    }
    
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

    if (!isWaylandLinux) {
      // React to hotkey updates from main to refresh label
      try {
        ipcRenderer.on('hotkey:updated', (_event, payload) => {
          applyChatLabel(payload && payload.label ? payload.label : null);
        });
        // Also request current label once
        ipcRenderer.invoke('hotkey:get').then((res) => {
          applyChatLabel(res && res.success && res.label ? res.label : null);
        }).catch(() => {});
      } catch (_) {}
    }
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

  const dashboardCaptureWarningSetupBtn = document.getElementById('dashboardCaptureWarningSetupBtn');
  if (dashboardCaptureWarningSetupBtn) {
    dashboardCaptureWarningSetupBtn.addEventListener('click', () => {
      navigateToView('settings');
    });
  }

  // Reload iframe button (manually reload when dashboard goes blank)
  const reloadIframeBtn = document.getElementById('reloadIframeBtn');
  if (reloadIframeBtn) {
    reloadIframeBtn.addEventListener('click', () => {
      if (getCurrentView && getCurrentView() === 'dashboard' && portalView) {
        try {
          // Always perform a full reload of the portal webview,
          // ignoring any internal cooldowns/throttling.
          if (!navigator.onLine) {
            showWebviewError();
            return;
          }
          if (portalSuspendedForTray) {
            resumePortalFromTrayIfNeeded();
            if (portalSuspendInFlight) return;
          }
          const currentSrc = portalView.getAttribute('src') || '';
          if (currentSrc === PORTAL_BLANK_URL) return;
          hideWebviewError();
          if (typeof portalView.reloadIgnoringCache === 'function') {
            portalView.reloadIgnoringCache();
          } else {
            portalView.reload();
          }
          startPortalLoadWatchdog('manual-hard-reload');
          // Re-send token after reload (allowed to be no-op)
          sendPortalLoginIfPossible();
        } catch (e) {
          console.error('[Webview] Error in manual hard reload:', e);
        }
      }
    });
  }

  // Update button (only visible on Windows/Linux when update is available)
  const updateBtn = document.getElementById('updateBtn');
  if (updateBtn) {
    updateBtn.addEventListener('click', () => {
      try { ipcRenderer.send('update:install', { forceRunAfter: true }); } catch (e) {}
    });
  }

  // Handle update availability notifications
  ipcRenderer.on('update:available', () => {
    if (updateBtn) {
      updateBtn.classList.remove('hidden');
    }
  });

  ipcRenderer.on('update:not-available', () => {
    if (updateBtn) {
      updateBtn.classList.add('hidden');
    }
  });

  // Check update status on startup (only for Windows/Linux)
  (async () => {
    const platform = window.electronAPI?.platform || 'unknown';
    if (platform === 'win32' || platform === 'linux') {
      try {
        const status = await ipcRenderer.invoke('update:check-status');
        if (status && status.available) {
          if (updateBtn) {
            updateBtn.classList.remove('hidden');
          }
        } else {
          if (updateBtn) {
            updateBtn.classList.add('hidden');
          }
        }
      } catch (e) {
        // Hide button on error
        if (updateBtn) {
          updateBtn.classList.add('hidden');
        }
      }
    } else {
      // Hide button on macOS (uses silent updates)
      if (updateBtn) {
        updateBtn.classList.add('hidden');
      }
    }
  })();
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
  const recordingText = document.getElementById('recordingStateText');
  const recordingMenu = document.getElementById('recordingMenu');
  const pauseTodayBtn = document.getElementById('pauseTodayBtn');
  const resumeNowBtn = document.getElementById('resumeNowBtn');
  let lastKnownPauseState = false;

  function isManualPauseAllowed() {
    return document.body?.dataset?.manualPauseAllowed !== 'false';
  }

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
    const manualPauseAllowed = isManualPauseAllowed();
    
    // Disable all recording controls if user doesn't have valid access
    recordingMenu.querySelectorAll('[data-pause]')?.forEach(el => {
      if (isPaused || !userHasValidAccess || !manualPauseAllowed) el.classList.add('disabled'); else el.classList.remove('disabled');
    });
    if (resumeNowBtn) {
      if (isPaused && userHasValidAccess && manualPauseAllowed) resumeNowBtn.classList.remove('disabled'); else resumeNowBtn.classList.add('disabled');
    }
    if (pauseTodayBtn) {
      if (isPaused || !userHasValidAccess || !manualPauseAllowed) pauseTodayBtn.classList.add('disabled'); else pauseTodayBtn.classList.remove('disabled');
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
      if (!hasValidAccess() || !isManualPauseAllowed()) {
        return;
      }
      const ms = Number(btn.getAttribute('data-pause')) || 0;
      if (ms > 0) ipcRenderer.send('pauseForMs', ms);
      toggleRecordingMenu(false);
    });
  });
  pauseTodayBtn?.addEventListener('click', () => { 
    // Check if user has valid access before allowing pause
    if (!hasValidAccess() || !isManualPauseAllowed()) {
      return;
    }
    if (!pauseTodayBtn.classList.contains('disabled')) { 
      ipcRenderer.send('pauseForToday'); 
      toggleRecordingMenu(false); 
    } 
  });
  resumeNowBtn?.addEventListener('click', () => { 
    // Check if user has valid access before allowing resume
    if (!hasValidAccess() || !isManualPauseAllowed()) {
      return;
    }
    if (!resumeNowBtn.classList.contains('disabled')) { 
      ipcRenderer.send('resumeRecording'); 
      toggleRecordingMenu(false); 
    } 
  });

  // Update recording text on pause/resume changes
  function setRecordingIcon(isPaused) {
    if (!recordingText || !recordingBtn) return;
    lastKnownPauseState = !!isPaused;
    if (isPaused) {
      recordingText.textContent = 'Resume';
      recordingText.classList.remove('active');
      recordingBtn?.classList.remove('active');
      recordingBtn?.setAttribute('title', 'Resume');
    } else {
      recordingText.textContent = 'Pause';
      recordingText.classList.add('active'); // orange text when recording
      recordingBtn?.classList.add('active'); // orange border when recording
      recordingBtn?.setAttribute('title', 'Pause');
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

  document.addEventListener('manual-pause-policy-updated', () => {
    updateRecordingMenuState(lastKnownPauseState);
  });

  // Sync initial labels
  updateSettingsToggleLabelGlobal();
  updateDashboardCaptureWarning();

  // Keep settings/back icon accurate on load
  updateSettingsIcon();

  if (portalView) {
    // Handle webview load errors
    portalView.addEventListener('did-fail-load', (event) => {
      console.error('[Webview] Failed to load:', event);
      showWebviewError();
      clearPortalLoadWatchdog();
      hidePortalSpinner();
      if (portalSuspendInFlight) {
        portalSuspendInFlight = false;
        if (portalResumePendingAfterSuspend) {
          portalResumePendingAfterSuspend = false;
          resumePortalFromTrayIfNeeded();
        }
      }
    });
    try { portalView.addEventListener('did-fail-provisional-load', (event) => {
      console.error('[Webview] Provisional load failed:', event);
      showWebviewError();
      clearPortalLoadWatchdog();
      hidePortalSpinner();
      if (portalSuspendInFlight) {
        portalSuspendInFlight = false;
        if (portalResumePendingAfterSuspend) {
          portalResumePendingAfterSuspend = false;
          resumePortalFromTrayIfNeeded();
        }
      }
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
      if (portalSuspendInFlight) {
        portalSuspendInFlight = false;
        if (portalResumePendingAfterSuspend) {
          portalResumePendingAfterSuspend = false;
          resumePortalFromTrayIfNeeded();
        }
      }
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

    portalView.addEventListener('ipc-message', async (event) => {
      if (event.channel === 'portal:logout' || event.channel === 'auth:logout') {
        try {
          const { performFullLogout } = require('./auth.js');
          await performFullLogout();
        } catch (e) {
          console.error('Error during portal-initiated logout:', e);
        }
      } else if (event.channel === 'portal:open-link') {
        const url = event.args[0];
        if (url) routeLink(url, { source: 'webview' });
      } else if (event.channel === 'auth:google-signin') {
        const payload = event.args && event.args[0] || {};
        const requestCalendar = payload.requestCalendar === true;
        const openUrl = (url) => {
          if (url) window.electronAPI.invoke('open-external', url).catch(() => {});
        };
        window.electronAPI.invoke('auth:google-signin', { requestCalendar })
          .then((res) => { if (res && res.success && res.url) openUrl(res.url); })
          .catch(() => {});
      } else if (event.channel === 'auth:google-reauth') {
        const payload = event.args && event.args[0] || {};
        window.electronAPI.invoke('auth:google-reauth', {
          idToken: payload.idToken,
          requestCalendar: payload.requestCalendar === true,
        })
          .then((res) => {
            if (res && res.success && res.url) {
              window.electronAPI.invoke('open-external', res.url).catch(() => {});
            }
          })
          .catch(() => {});
      }
    });
  }

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;

    try {
      const url = new URL(link.href);
      const protocol = url.protocol.toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') return;

      e.preventDefault();
      routeLink(url.toString(), { source: 'index' });
    } catch (_) {}
  });

  // In-app notification logic moved to notify.js

  // Handle notification requests from main process - routes through showBanner()
  ipcRenderer.on('request-notification', (_event, payload) => {
    if (payload && payload.message) {
      showBanner(payload.message, {
        title: payload.title || null,
        sticky: payload.sticky || false,
        action: payload.action || null,
        id: payload.id || null,
        noFocus: payload.noFocus || false
      });
    }
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
  const isAuthScreen = (currentView === 'signin' || currentView === 'signup' || currentView === 'reset' || currentView === 'mfa');
  
  if (appTopbar) {
    const shouldHideTopbar = isAuthScreen;
    if (shouldHideTopbar) appTopbar.classList.add('hidden');
    else appTopbar.classList.remove('hidden');
  }
}

// Add IPC listener for navigation
ipcRenderer.on('navigate', (event, viewName) => {
  navigateToView(viewName);
});

ipcRenderer.on('app:window-hidden', () => {
  suspendPortalForTray();
});

ipcRenderer.on('app:window-shown', () => {
  resumePortalFromTrayIfNeeded();
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

// Calendar link success from desktop (donethat://auth?action=linked&success=true)
ipcRenderer.on('auth:calendar-linked', () => {
  try {
    if (portalView) {
      safePortalReload('calendar-linked');
    }
  } catch (_) {}
});

ipcRenderer.on('auth:custom-token-for-portal', (_event, payload) => {
  try {
    const wv = document.getElementById('portalView');
    if (wv && payload && payload.customToken) wv.send('auth:setCustomToken', payload);
  } catch (e) {}
});
ipcRenderer.on('auth:reauth-result-for-portal', (_event, payload) => {
  try {
    const wv = document.getElementById('portalView');
    if (wv && payload) wv.send('auth:reauth-result', payload);
  } catch (e) {}
});

// Initialize centralized chat (state-managed)
initializeChat();

// Export functions for use in other modules
module.exports = {
  updateTopbarVisibility
};
