const {
  browserLocalPersistence,
  setPersistence,
} = require("firebase/auth");
const { ipcRenderer } = require('electron');

const { auth } = require('./firebase.js');
const { initializeSlack} = require('./slack');
const { subscriptionInitialize, subscriptionUpdateUI } = require('./subscription.js');
const { initializeSettings, loadUserSettings } = require('./settings.js');
const { initializeAuth } = require('./auth.js');
const { initializeDashboard, resetSummaryState, refreshDashboardNotes } = require('./dashboard.js');
const { initializeAutoUpdate } = require('./autoupdate.js');
const { initializePermissions } = require('./permissions.js');
const { initializeAnalytics, trackPageView } = require('./analytics.js');
const { 
  hasScreenCapturePermission,
  hasValidAccess,
  updateSubscriptionState,
  updateEmailSettings,
  updateSlackSettings,
  updateName,
  updateStoreScreenshots,
  updateCurrentView,
  getCurrentView,
  isAuthenticated,
  updatePauseState,
  updateDateCreated
} = require('./app-state.js');

const coreViews = ['settings', 'dashboard'];

// Set persistence to browser local storage
setPersistence(auth, browserLocalPersistence)
  .then(() => {
  })
  .catch((error) => {
    console.error("Error setting persistence:", error);
  });

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
const permissionView = document.getElementById("permissionView");
const updateView = document.getElementById("updateView");

// Update the navigateToView function
function navigateToView(viewName) {
  const currentView = getCurrentView();

  // If the current view is update, don't let people navigate
  // View will change on app restart 
  if(currentView === 'update') {
    return;
  }
  
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
      viewName = 'permission';
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
      viewToShow = permissionView;
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
    case 'update':
      viewToShow = updateView;
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
    // Update the current view state
    updateCurrentView(viewName);
    
    // Track page view in analytics with all necessary details
    trackPageView(viewName);
  } else {
    console.error('View not found:', viewName);
  }
}

async function loadUserSettingsCallback() {
  const result = await loadUserSettings();
  if (!result) return; // Exit if no result (user not logged in)
  
  // Check if user has any active teams
  const teams = result.data?.teams || {};
  
  // Use lowercase team status
  const hasActiveTeam = Object.values(teams).some(team => 
    team.status === 'active');
  
  const hasActiveSubscription = result.data?.subscription?.status === 'trialing' || result.data?.subscription?.status === 'active';

  // Update all relevant state
  updateSubscriptionState(result.data?.subscription?.status, hasActiveTeam);
  updateEmailSettings(result.data?.emailRecipients || []);
  updateSlackSettings(
    result.data?.slack?.defaultChannel,
    !!result.data?.slack?.accessToken
  );
  updateName(result.data?.name);
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
    navigateToView('signup-next');
  }
}

// Update the document ready handler
document.addEventListener('DOMContentLoaded', () => {
  // Initialize all modules
  initializeAuth(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeDashboard(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeSlack(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner);
  subscriptionInitialize(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeSettings(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeAutoUpdate(navigateToView);
  initializePermissions(navigateToView);
  initializeAnalytics();
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