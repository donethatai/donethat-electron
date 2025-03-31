const { initializeApp } = require("firebase/app");
const { getFirestore, doc, onSnapshot } = require("@firebase/firestore");
const { getAuth } = require("firebase/auth");
const { getFunctions, httpsCallable } = require("firebase/functions");
const firebaseConfig = require("../firebase-config.js");
const { updateSlackUI, updateSlackInputState } = require('./slack');
const { updateNotificationUI } = require('./permissions');
const { logAnalyticsEvent } = require('./analytics.js');
const { ipcRenderer } = require("electron");

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, "europe-west1");
const functions = getFunctions(firebaseApp, "europe-west1");

// Create callable function references
const getUserSettingsFunction = httpsCallable(functions, "getUserSettings");
const updateUserSettingsFunction = httpsCallable(functions, "updateUserSettings");

// Module variables to store callbacks
let loadUserSettingsCallback = null;
let showSpinner = null;
let hideSpinner = null;
let navigateToView = null;
let settingsUnsubscribe = null;

// Settings state
let recipientEmails = [];
let summaryNotificationTime = "17:00"; // Default time (5:00 PM)

// Initialize settings management
function initializeSettings(onSettingsUpdate, showBlockingSpinner, hideBlockingSpinner, viewNavigator) {
  loadUserSettingsCallback = onSettingsUpdate;
  showSpinner = showBlockingSpinner;
  hideSpinner = hideBlockingSpinner;
  navigateToView = viewNavigator;

  // Set up Firestore listener for user settings
  const auth = getAuth();
  if (auth.currentUser) {
    setupSettingsListener(auth.currentUser.uid);
  } else {
    // Add auth state listener
    auth.onAuthStateChanged((user) => {
      if (user) {
        setupSettingsListener(user.uid);
      } else {
        stopSettingsListener();
      }
    });
  }
  
  // Set up version click handler
  setupVersionClickHandler();
}

// Set up version click handler
function setupVersionClickHandler() {
  const versionElement = document.querySelector('#appVersion');
  
  if (versionElement) {
    try {
      // Try to get version from package.json first
      const packageInfo = require('../package.json');
      versionElement.textContent = `v${packageInfo.version}`;
      
      // Add click handler for version number
      versionElement.style.cursor = 'pointer'; // Make it look clickable
      versionElement.addEventListener('click', (e) => {
        const screenshotsContainer = document.getElementById('screenshotsContainer');
        const screenshotsCheckbox = document.getElementById('screenshotsCheckbox');
        if (screenshotsContainer && screenshotsCheckbox && !screenshotsCheckbox.checked) {
          // Only toggle if checkbox is unchecked
          screenshotsContainer.classList.toggle('hidden');
        }
      });
    } catch (error) {
      // If we can't get the version, just show a placeholder
      versionElement.textContent = 'v?.?.?';
    }
  }
}

// Set up Firestore listener for user settings
function setupSettingsListener(userId) {
  // Stop any existing listener
  stopSettingsListener();
  
  const userDoc = doc(db, 'settings', userId);
  
  // Set up real-time listener
  settingsUnsubscribe = onSnapshot(userDoc, (doc) => {
    if (doc.exists()) {
      // Call the callback to update UI with new settings
      if (loadUserSettingsCallback) {
        loadUserSettingsCallback();
      }
    }
  }, (error) => {
    console.error("Error listening to settings changes:", error);
  });
}

// Stop the settings listener
function stopSettingsListener() {
  if (settingsUnsubscribe) {
    settingsUnsubscribe();
    settingsUnsubscribe = null;
  }
}

/**
 * Load user settings from Firebase
 */
async function loadUserSettings() {
  if (!getAuth().currentUser) return;

  try {
    const result = await getUserSettingsFunction();
    updateSettingsUI(result);
    return result;

  } catch (error) {
    console.error("Error loading settings:", error);
  }
}

/**
 * Save user settings to Firebase
 */
async function saveUserSettings(type, value) {
  if (!getAuth().currentUser) return;

  // Use the appropriate spinner based on the setting type
  if (type === 'emails' || type === 'name') {
    showSpinner();
  } else if (type === 'notificationTime') {
    const timeLoadingSpinner = document.getElementById("timeLoadingSpinner");
    if (timeLoadingSpinner) {
      timeLoadingSpinner.classList.remove("hidden");
    }
  }

  try {
    let settingsData = {};

    if (type === 'emails') {
      settingsData.emailRecipients = value;
      logAnalyticsEvent('settings_updated', {
        type: 'emails',
        recipient_count: value.length
      });
    } else if (type === 'name') {
      settingsData.name = value; // value is already null if empty
      logAnalyticsEvent('settings_updated', {
        type: 'name'
      });
    } else if (type === 'screenshots') {
      settingsData.storeScreenshots = value;
      logAnalyticsEvent('settings_updated', {
        type: 'screenshots',
        enabled: value
      });
    } else if (type === 'notificationTime') {
      settingsData.summaryNotificationTime = value;
      summaryNotificationTime = value;
      logAnalyticsEvent('settings_updated', {
        type: 'notification_time',
        time: value
      });
    }

    await updateUserSettingsFunction(settingsData);

  } catch (error) {
    logAnalyticsEvent('settings_update_error', {
      type: type,
      error_code: error.code,
      error_message: error.message
    });
    console.error("Error saving settings:", error);
    alert(`Error saving settings: ${error.message}`);
    throw error;
  } finally {
    // Hide the appropriate spinner
    if (type === 'emails' || type === 'name') {
      hideSpinner();
    } else if (type === 'notificationTime') {
      const timeLoadingSpinner = document.getElementById("timeLoadingSpinner");
      if (timeLoadingSpinner) {
        timeLoadingSpinner.classList.add("hidden");
      }
    }
  }
}

async function updateSettingsUI(result) {
  // Reset state
  recipientEmails = [];
  const emailTagsContainer = document.getElementById('emailTagsContainer');
  if (emailTagsContainer) {
    emailTagsContainer.innerHTML = "";
  }

  // Handle name
  if (result.data && result.data.name) {
    const nameInput = document.getElementById('nameInput');
    if (nameInput) {
      nameInput.value = result.data.name;
    }
  }

  // Handle screenshots setting
  if (result.data && typeof result.data.storeScreenshots === 'boolean') {
    const screenshotsCheckbox = document.getElementById('screenshotsCheckbox');
    const screenshotsContainer = document.getElementById('screenshotsContainer');
    if (screenshotsCheckbox) {
      screenshotsCheckbox.checked = result.data.storeScreenshots;
      // Show container if screenshots are enabled
      if (screenshotsContainer) {
        screenshotsContainer.classList.toggle('hidden', !result.data.storeScreenshots);
      }
    }
  }

  // Handle email recipients
  if (result.data &&
    result.data.emailRecipients &&
    Array.isArray(result.data.emailRecipients) &&
    result.data.emailRecipients.length > 0) {
    // Get unique emails from server response
    const uniqueEmails = [...new Set(result.data.emailRecipients)];

    // Set our internal state
    recipientEmails = uniqueEmails;

    // Render the email tags
    renderEmailTags();
  }
  
  // Handle Slack settings
  if (result.data.slack?.accessToken) {
    const slackInput = document.getElementById('slackInput');
    if (slackInput) {
      slackInput.value = result.data.slack.defaultChannel || '';
    }

    // Get team name from the first active team if available
    const teams = result.data.teams || {};
    const activeTeam = Object.values(teams).find(team => team.status === 'ACTIVE');
    const teamName = activeTeam?.name || result.data.slack.teamName;

    // Update Slack UI with the active team's name
    updateSlackUI(true, teamName);
    updateSlackInputState(true, teamName, result.data.slack.defaultChannel || '');
  } else {
    updateSlackUI(false);
    updateSlackInputState(false);
  }
  
  // Load notification time if available
  if (result.data && result.data.summaryNotificationTime) {
    summaryNotificationTime = result.data.summaryNotificationTime;
    const notificationTimeInput = document.getElementById("notificationTimeInput");
    if (notificationTimeInput) {
      notificationTimeInput.value = summaryNotificationTime;
    }
  }
  
  // Send the notification time to the main process
  ipcRenderer.send("updateSummaryNotificationTime", summaryNotificationTime);
  
  // Update notification UI based on permission
  await updateNotificationUI();
}

/**
 * Add a new email tag
 */
async function addEmailTag(email) {
  if (!email) return;

  email = email.trim();

  if (recipientEmails.includes(email)) {
    alert(`Email ${email} is already in the list.`);
    return;
  }

  if (!email.includes("@") || !email.includes(".")) {
    alert(`Invalid email format: ${email}`);
    return;
  }

  showSpinner();

  try {
    // Add to our local array
    recipientEmails.push(email);

    // Clear input field
    const emailInput = document.getElementById("emailInput");
    if (emailInput) {
      emailInput.value = "";
    }

    // Render the updated list
    renderEmailTags();

    // Save to server
    await saveUserSettings('emails', recipientEmails);

  } catch (error) {
    // If error, remove the email we just added
    recipientEmails = recipientEmails.filter(e => e !== email);
    renderEmailTags();

    console.error("Error saving settings:", error);
    alert(`Error saving: ${error.message}`);
  } finally {
    hideSpinner();
  }
}

/**
 * Remove an email tag
 */
async function removeEmailTag(email) {
  if (!email || !recipientEmails.includes(email)) return;

  showSpinner();

  try {
    // Create a backup of the current list
    const originalList = [...recipientEmails];

    // Update our local array
    recipientEmails = recipientEmails.filter(e => e !== email);

    // Render the updated list
    renderEmailTags();

    // Save to server
    await saveUserSettings('emails', recipientEmails);

  } catch (error) {
    // If error, restore original list
    recipientEmails = originalList;
    renderEmailTags();

    console.error("Error saving settings:", error);
    alert(`Error saving: ${error.message}`);
  } finally {
    hideSpinner();
  }
}

/**
 * Render email tags in the UI
 */
function renderEmailTags() {
  const emailTagsContainer = document.getElementById('emailTagsContainer');
  if (!emailTagsContainer) return;

  // Clear container first
  emailTagsContainer.innerHTML = "";

  // Render tags
  recipientEmails.forEach(email => {
    const tag = document.createElement("div");
    tag.className = "email-tag";
    tag.innerHTML = `
      <span class="email-text">${email}</span>
      <button data-email="${email}" class="remove-email remove-email-btn">
        &times;
      </button>
    `;
    emailTagsContainer.appendChild(tag);
  });

  // Add click handlers for remove buttons
  const removeButtons = emailTagsContainer.querySelectorAll('.remove-email-btn');
  removeButtons.forEach(button => {
    button.addEventListener('click', async (e) => {
      const email = e.target.getAttribute('data-email');
      if (email) {
        await removeEmailTag(email);
      }
    });
  });
}

// Add event listeners for name and screenshots
const nameInput = document.getElementById('nameInput');
if (nameInput) {
  nameInput.addEventListener('change', async (e) => {
    const newName = e.target.value.trim();
    try {
      await saveUserSettings('name', newName || null);
    } catch (error) {
      // If error occurs, revert to previous value
      e.target.value = getName();
    }
  });
}

const screenshotsCheckbox = document.getElementById('screenshotsCheckbox');
if (screenshotsCheckbox) {
  screenshotsCheckbox.addEventListener('change', async (e) => {
    try {
      await saveUserSettings('screenshots', e.target.checked);
      // Show/hide container based on checkbox state
      const screenshotsContainer = document.getElementById('screenshotsContainer');
      if (screenshotsContainer) {
        screenshotsContainer.classList.toggle('hidden', !e.target.checked);
      }
    } catch (error) {
      // If error occurs, revert to previous value
      e.target.checked = isStoreScreenshots();
    }
  });
}

// Add event listener for email input
const emailInput = document.getElementById('emailInput');
if (emailInput) {
  emailInput.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const email = emailInput.value.trim();
      if (email) {
        await addEmailTag(email);
      }
    }
  });
}

// Add event listener for notification time input
const notificationTimeInput = document.getElementById('notificationTimeInput');
if (notificationTimeInput) {
  notificationTimeInput.addEventListener('blur', async (e) => {
    const newTime = e.target.value;
    try {
      await saveUserSettings('notificationTime', newTime);
      // Update local state
      summaryNotificationTime = newTime;
      // Send the updated time to the main process
      ipcRenderer.send("updateSummaryNotificationTime", newTime);
    } catch (error) {
      // If error occurs, revert to previous value
      e.target.value = summaryNotificationTime;
    }
  });

  notificationTimeInput.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const newTime = e.target.value;
      try {
        await saveUserSettings('notificationTime', newTime);
        // Update local state
        summaryNotificationTime = newTime;
        // Send the updated time to the main process
        ipcRenderer.send("updateSummaryNotificationTime", newTime);
      } catch (error) {
        // If error occurs, revert to previous value
        e.target.value = summaryNotificationTime;
      }
    }
  });
}

module.exports = {
  initializeSettings,
  loadUserSettings,
  saveUserSettings
};