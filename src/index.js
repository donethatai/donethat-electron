const {
  onAuthStateChanged,
  onIdTokenChanged,
} = require("firebase/auth");
const { ipcRenderer } = require('electron');
const { shell } = require('electron');

const { auth } = require('./firebase.js');
const { subscriptionInitialize, subscriptionUpdateUI } = require('./subscription.js');
const { initializeSettings, loadUserSettings } = require('./settings.js');
const { initializeAuth } = require('./auth.js');
const { initializeDashboard, resetSummaryState, refreshDashboardNotes } = require('./dashboard.js');
const { initializePermissions } = require('./permissions.js');
const { initializeAnalytics, trackPageView } = require('./analytics.js');
const { 
  hasScreenCapturePermission,
  hasValidAccess,
  updateSubscriptionState,
  updateStoreScreenshots,
  updateCurrentView,
  getCurrentView,
  isAuthenticated,
  updatePauseState,
  updateDateCreated,
  initializeChat
} = require('./app-state.js');

require('./audio-recorder');

const coreViews = ['settings', 'dashboard'];

// Reference to embedded portal webview
let portalView = null;
let lastPortalTokenSent = null;
let lastPortalTokenTs = 0;

// Global updater for the Settings/Dashboard toggle button label
function updateSettingsToggleLabelGlobal() {
  try {
    const settingsToggleBtn = document.getElementById('openSettingsViewBtn');
    if (!settingsToggleBtn) return;
    const v = getCurrentView();
    if (v === 'settings') {
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
}, 1000);

// Get references to views and elements
const signInView = document.getElementById("signInView");
const signUpView = document.getElementById("signUpView");
const resetView = document.getElementById("resetView");
const dashboardView = document.getElementById("dashboardView");
  const settingsView = document.getElementById("settingsView");

  
  // Update the navigateToView function
function navigateToView(viewName) {
  const currentView = getCurrentView();

  
  // Only navigate to a core view if the current view is a core view
  // Eg prevent navigating to settings when signup not complete
  if (coreViews.includes(viewName) && !coreViews.includes(currentView)) {
    viewName = currentView;
  }

  // Handle 'signup-next' parameter
  if (viewName === 'signup-next') {
    // If not authenticated, always go to signin
    if (!isAuthenticated()) {
      viewName = 'signin';
    } else if (!hasScreenCapturePermission()) {
      viewName = 'settings';
    } else if (!hasValidAccess()) {
      viewName = 'subscription';
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
    case 'subscription':
      viewToShow = document.getElementById('subscriptionView');
      break;
    case 'permission':
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
      // Hide the entire topbar on auth screens or when screen permission is missing
      const shouldHideTopbar = isAuthScreen || !hasScreenCapturePermission();
      if (shouldHideTopbar) appTopbar.classList.add('hidden');
      else appTopbar.classList.remove('hidden');
    }
    // If opening dashboard, proactively attempt login message to portal
    if (viewName === 'dashboard') {
      sendPortalLoginIfPossible();
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
    
    // Check if user has any active teams
    const teams = result.data?.teams || {};
    
    // Use lowercase team status
    const hasActiveTeam = Object.values(teams).some(team => 
      team.status === 'active');
    
    const hasActiveSubscription = result.data?.subscription?.status === 'trialing' || result.data?.subscription?.status === 'active';

    // Update all relevant state
    updateSubscriptionState(result.data?.subscription?.status, hasActiveTeam);
    updateStoreScreenshots(result.data?.storeScreenshots || false);
    updateDateCreated(result.data?.analytics?.createdAt);

    // Update subscription UI with current data and wait for it to complete
    await subscriptionUpdateUI({
      active: hasActiveSubscription || hasActiveTeam,
      source: hasActiveTeam ? 'team' : 'individual',
      status: hasActiveTeam ? 'active' : result.data?.subscription?.status || null,
      trialActive: result.data?.subscription?.status === 'trialing',
      trialDaysRemaining: result.data?.subscription?.trialDaysRemaining,
      trialEndsAt: result.data?.subscription?.trialEndsAt,
      paidActive: result.data?.subscription?.status === 'active',
      currentPeriodEnd: result.data?.subscription?.currentPeriodEnd
    });

    // Fetch initial pause state from main process
    const initialIsPaused = await ipcRenderer.invoke('getInitialPauseState');
    
    // Update app-state with the initial value
    updatePauseState(initialIsPaused);

    // Refresh dashboard notes now that state is loaded
    refreshDashboardNotes();

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

// Update the document ready handler
document.addEventListener('DOMContentLoaded', () => {
  // Initialize all modules
  initializeAuth(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeDashboard(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  subscriptionInitialize(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeSettings(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializePermissions(navigateToView);
  initializeAnalytics();

  // Grab the portal webview if present
  portalView = document.getElementById('portalView');
  const openChatBtn = document.getElementById('openChatBtn');
  const openSettingsViewBtn = document.getElementById('openSettingsViewBtn');
  
  function activateSettingsSection(targetId) {
    const sections = [
      'section-recording',
      'section-schedule',
      'section-subscription',
      'section-advanced',
      'section-about'
    ];
    // Hide all
    sections.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    // Show target
    const target = document.getElementById(targetId);
    if (target) target.classList.remove('hidden');
    // Update active tab
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.classList.remove('active');
      const href = (tab.getAttribute('href') || '').replace('#','');
      if (href === targetId) tab.classList.add('active');
    });
  }
  
  function setupSettingsNav() {
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        const href = (tab.getAttribute('href') || '').replace('#','');
        if (href) activateSettingsSection(href);
      });
    });
  }
  if (openChatBtn) {
    try {
      const isMac = process.platform === 'darwin';
      openChatBtn.textContent = `Chat (${isMac ? 'Cmd' : 'Ctrl'}+Shift+D)`;
      openChatBtn.title = `Chat (${isMac ? 'Cmd' : 'Ctrl'}+Shift+D)`;
    } catch (e) {}
    
    openChatBtn.addEventListener('click', () => {
      // Only allow chat if authenticated
      if (!isAuthenticated()) {
        return;
      }
      try { ipcRenderer.send('overlay:toggle'); } catch (e) {}
    });
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

  // Enable/disable menu entries based on pause state
  function updateRecordingMenuState(isPaused) {
    if (!recordingMenu) return;
    // Disable resume when already recording; disable pause durations when paused
    recordingMenu.querySelectorAll('[data-pause]')?.forEach(el => {
      if (isPaused) el.classList.add('disabled'); else el.classList.remove('disabled');
    });
    if (resumeNowBtn) {
      if (isPaused) resumeNowBtn.classList.remove('disabled'); else resumeNowBtn.classList.add('disabled');
    }
    if (pauseTodayBtn) {
      if (isPaused) pauseTodayBtn.classList.add('disabled'); else pauseTodayBtn.classList.remove('disabled');
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
      const ms = Number(btn.getAttribute('data-pause')) || 0;
      if (ms > 0) ipcRenderer.send('pauseForMs', ms);
      toggleRecordingMenu(false);
    });
  });
  pauseTodayBtn?.addEventListener('click', () => { if (!pauseTodayBtn.classList.contains('disabled')) { ipcRenderer.send('pauseForToday'); toggleRecordingMenu(false); } });
  resumeNowBtn?.addEventListener('click', () => { if (!resumeNowBtn.classList.contains('disabled')) { ipcRenderer.send('resumeRecording'); toggleRecordingMenu(false); } });

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

  // Initialize settings nav handlers
  setupSettingsNav();

  // Sync initial labels
  updateSettingsToggleLabelGlobal();

  // Keep settings/back icon accurate on load
  updateSettingsIcon();

  if (portalView) {
    // When the webview is ready, optionally inject further config
    portalView.addEventListener('dom-ready', () => {
            // Proactively send login token whenever portal becomes ready
      sendPortalLoginIfPossible();
      
      // Inject the ipcRenderer bridge into the webapp's context
      try {
        portalView.executeJavaScript(`
          window.__electronIpcRenderer = {
            sendToHost: function(channel, data) {
              if (channel === 'auth:logout' && window.__realIpcRenderer) {
                window.__realIpcRenderer.sendToHost('portal:logout');
              }
            }
          };
        `);
      } catch (e) {
        console.error('[Portal] Failed to inject ipcRenderer:', e);
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

    // Also send token on internal navigations
    try { portalView.addEventListener('did-navigate', sendPortalLoginIfPossible); } catch (e) {}
    try { portalView.addEventListener('did-frame-finish-load', sendPortalLoginIfPossible); } catch (e) {}

    // Pipe webview console to renderer for visibility
    try {
      portalView.addEventListener('console-message', (e) => {
        console.log('[Webview]', e.level, e.message);
      });
    } catch (e) {}

    // Handle portal-initiated logout only; we broadcast auth state proactively
    portalView.addEventListener('ipc-message', async (event) => {
      if (event.channel === 'portal:logout') {
        // Web app initiated logout -> perform desktop logout flow
        try {
          const { performFullLogout } = require('./auth.js');
          await performFullLogout();
        } catch (e) {
          console.error('Error during portal-initiated logout:', e);
        }
      }
    });
  }

  // Add event listener for app settings link
  const appSettingsLink = document.querySelector('.app-settings-link');
  if (appSettingsLink) {
    appSettingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      shell.openExternal('https://app.donethat.ai/settings');
    });
  }

  // Add event listener for support link
  const supportLink = document.querySelector('.support-link');
  if (supportLink) {
    supportLink.addEventListener('click', (e) => {
      e.preventDefault();
      shell.openExternal('https://donethat.ai/support');
    });
  }
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

// Add IPC listener for navigation
ipcRenderer.on('navigate', (event, viewName) => {
  navigateToView(viewName);
});

// Add pause state handler
ipcRenderer.on('pauseStateChanged', (event, isPaused) => {
  updatePauseState(isPaused);
});

// Initialize centralized chat (state-managed)
initializeChat();