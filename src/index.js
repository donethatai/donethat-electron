const {
  browserLocalPersistence,
  setPersistence,
} = require("firebase/auth");
const { auth } = require('./firebase.js');
const { initializeSlack} = require('./slack');
const { subscriptionInitialize, subscriptionUpdateUI } = require('./subscription.js');
const { initializeSettings, loadUserSettings } = require('./settings.js');
const { initializeAuth } = require('./auth.js');
const { initializeDashboard } = require('./dashboard.js');
const { initializeAutoUpdate } = require('./autoupdate.js');
const { initializePermissions } = require('./permissions.js');
const { 
  hasScreenCapturePermission,
  hasValidAccess,
  hasEmails,
  hasSlack,
  updateSubscriptionState,
  updateEmailSettings,
  updateSlackSettings
} = require('./app-state.js');

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
const backToDashboardBtn = document.getElementById("backToDashboardBtn");

// Update the navigateToView function to handle all views
function navigateToView(viewName) {
  console.log('Navigating to view:', viewName);
  
  // Hide all views first
  const allViews = document.querySelectorAll('.view-container');
  allViews.forEach(view => view.classList.add('hidden'));

  // Show the requested view
  let viewToShow;
  switch (viewName) {
    case 'dashboard':
      viewToShow = dashboardView;
      break;
    case 'settings':
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

  if (viewToShow) {
    viewToShow.classList.remove('hidden');
  } else {
    console.error('View not found:', viewName);
  }

  // Handle back button visibility
  if (backToDashboardBtn) {
    if (viewName === 'settings' && hasValidAccess() && (hasEmails() || hasSlack())) {
      backToDashboardBtn.classList.remove('hidden');
    } else {
      backToDashboardBtn.classList.add('hidden');
    }
  }
}

async function loadUserSettingsCallback() {
  const result = await loadUserSettings();
  if (!result) return; // Exit if no result (user not logged in)

  // Update app state with settings
  const hasEmails = result.data?.emailRecipients?.length > 0;
  const hasSlack = result.data?.slack?.defaultChannel;
  const hasActiveCompany = result.data?.company?.status === 'ACTIVE';
  const hasActiveSubscription = result.data?.subscription?.status === 'trialing' || result.data?.subscription?.status === 'active';

  // Update all relevant state
  updateSubscriptionState(result.data?.subscription?.status, result.data?.company?.status);
  updateEmailSettings(result.data?.emailRecipients || []);
  updateSlackSettings(result.data?.slack?.defaultChannel);

  // Navigate based on state
  if (!hasEmails && !hasSlack) {
    navigateToView('settings');
  } else if (!hasValidAccess()) {
    console.log('No valid subscription, showing subscription page');
    navigateToView('subscription');
    subscriptionUpdateUI({ shouldPromptForSubscription: true });
  } else if (!hasScreenCapturePermission()) {
    navigateToView('permission');
  } else {
    navigateToView('dashboard');
  }
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