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
const { initializeDashboard, resetSummaryState } = require('./dashboard.js');
const { initializeAutoUpdate } = require('./autoupdate.js');
const { initializePermissions } = require('./permissions.js');
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
  hasEmails,
  hasSlack,
  hasName,
  isAuthenticated
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
    } else if (!hasName() || (!hasEmails() && !hasSlack())) {
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
  updateSlackSettings(result.data?.slack?.defaultChannel);
  updateName(result.data?.name || '');
  updateStoreScreenshots(result.data?.storeScreenshots || false);

  // Update subscription UI with current data
  subscriptionUpdateUI({
    active: hasActiveSubscription || hasActiveTeam,
    source: hasActiveTeam ? 'team' : 'individual',
    status: 'active', // Use lowercase status
    trialActive: result.data?.subscription?.status === 'trialing',
    trialEndsAt: result.data?.subscription?.trialEndsAt,
    trialDaysRemaining: result.data?.subscription?.trialDaysRemaining,
    paidActive: result.data?.subscription?.status === 'active',
    currentPeriodEnd: result.data?.subscription?.currentPeriodEnd
  });

  // Navigate to signup-next which will handle all navigation logic
  navigateToView('signup-next');
}

// Update the document ready handler
document.addEventListener('DOMContentLoaded', () => {
  // Initialize all modules
  initializeAuth(loadUserSettings, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeDashboard(loadUserSettings, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeSlack(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner);
  subscriptionInitialize(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeSettings(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeAutoUpdate(navigateToView);
  initializePermissions(navigateToView);
});

// Function to create an overlay that blocks interactions
function showBlockingSpinner() {
  const loadingSpinner = document.getElementById("loadingSpinner");
  if (loadingSpinner) {
    // Add classes to ensure it blocks interaction
    loadingSpinner.classList.remove("hidden");
    loadingSpinner.classList.add("fixed", "inset-0", "z-50", "bg-white", "bg-opacity-70");

    // Prevent scrolling while spinner is active
    document.body.style.overflow = "hidden";
  }
}

// Function to hide the blocking spinner
function hideBlockingSpinner() {
  const loadingSpinner = document.getElementById("loadingSpinner");
  if (loadingSpinner) {
    loadingSpinner.classList.add("hidden");
    loadingSpinner.classList.remove("fixed", "inset-0", "z-50", "bg-white", "bg-opacity-70");

    // Re-enable scrolling
    document.body.style.overflow = "";
  }
}

// Add IPC listener for navigation
ipcRenderer.on('navigate', (event, viewName) => {
  navigateToView(viewName);
});