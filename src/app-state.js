// Application state management
const state = {
  // Authentication state
  isAuthenticated: false,
  userIdToken: null,

  // Permission state
  hasScreenCapturePermission: false,

  // Subscription state
  hasValidAccess: false,
  subscriptionStatus: null,
  hasActiveTeam: false,

  // Settings state
  hasEmails: false,
  hasSlack: false,
  hasSlackToken: false,
  name: '',
  storeScreenshots: false,
  emailRecipients: [],
  slackChannel: null,
  summaryNotificationTime: "17:00", // Default time (5:00 PM)

  // Navigation state
  currentView: null
};

// Getters
function getState() {
  return { ...state }; // Return a copy to prevent direct mutation
}

function isAuthenticated() {
  return state.isAuthenticated;
}

function hasScreenCapturePermission() {
  return state.hasScreenCapturePermission;
}

function hasValidAccess() {
  return state.hasValidAccess;
}

function hasEmails() {
  return state.hasEmails;
}

function hasSlack() {
  return state.hasSlack;
}

function hasSlackToken() {
  return state.hasSlackToken;
}

function hasName() {
  return  state.name.length > 0;
}

function getName() {
  return state.name;
}

function isStoreScreenshots() {
  return state.storeScreenshots;
}

function getEmailRecipients() {
  return [...state.emailRecipients];
}

function getSlackChannel() {
  return state.slackChannel;
}

function getSummaryNotificationTime() {
  return state.summaryNotificationTime;
}

function getCurrentView() {
  return state.currentView;
}

// Setters
function updateAuthState(isAuthenticated, userIdToken) {
  state.isAuthenticated = isAuthenticated;
  state.userIdToken = userIdToken;
}

function updateScreenCapturePermission(hasPermission) {
  state.hasScreenCapturePermission = hasPermission;
}

function updateSubscriptionState(subscriptionStatus, activeTeam) {
  state.subscriptionStatus = subscriptionStatus;
  state.hasActiveTeam = activeTeam;
  state.hasValidAccess = activeTeam || 
                        subscriptionStatus === 'trialing' || 
                        subscriptionStatus === 'active';
}

function updateName(name) {
  state.name = name;
}

function updateStoreScreenshots(enabled) {
  state.storeScreenshots = enabled;
}

function updateEmailSettings(recipients) {
  state.emailRecipients = [...recipients];
  state.hasEmails = recipients.length > 0;
}

function updateSlackSettings(channel, hasToken = false) {
  state.slackChannel = channel;
  state.hasSlackToken = hasToken;
  state.hasSlack = !!channel;
}

function updateNotificationTime(time) {
  state.summaryNotificationTime = time;
}

function updateCurrentView(view) {
  state.currentView = view;
}

// Reset state (useful for logout)
function resetState() {
  Object.keys(state).forEach(key => {
    if (Array.isArray(state[key])) {
      state[key] = [];
    } else if (typeof state[key] === 'boolean') {
      state[key] = false;
    } else if (typeof state[key] === 'string') {
      state[key] = '';
    } else {
      state[key] = null;
    }
  });
}

module.exports = {
  getState,
  isAuthenticated,
  hasScreenCapturePermission,
  hasValidAccess,
  hasEmails,
  hasSlack,
  hasSlackToken,
  hasName,
  getName,
  isStoreScreenshots,
  getEmailRecipients,
  getSlackChannel,
  getSummaryNotificationTime,
  getCurrentView,
  updateAuthState,
  updateScreenCapturePermission,
  updateSubscriptionState,
  updateName,
  updateStoreScreenshots,
  updateEmailSettings,
  updateSlackSettings,
  updateNotificationTime,
  updateCurrentView,
  resetState
}; 