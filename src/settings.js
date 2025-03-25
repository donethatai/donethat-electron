const { initializeApp } = require("firebase/app");
const { getFirestore, doc, onSnapshot } = require("@firebase/firestore");
const { getAuth } = require("firebase/auth");
const { getFunctions, httpsCallable } = require("firebase/functions");
const firebaseConfig = require("../firebase-config.js");
const { updateSlackUI, updateSlackInputState } = require('./slack');
const { updateNotificationUI } = require('./permissions');
const { resetSummaryState } = require('./dashboard.js');

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
  if (type === 'emails') {
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
    } else if (type === 'notificationTime') {
      settingsData.summaryNotificationTime = value;
      summaryNotificationTime = value;

      // Send the updated time to the main process
      const { ipcRenderer } = require('electron');
      ipcRenderer.send("updateSummaryNotificationTime", value);
    }

    await updateUserSettingsFunction(settingsData);

  } catch (error) {
    console.error("Error saving settings:", error);
    alert(`Error saving settings: ${error.message}`);
    throw error;
  } finally {
    // Hide the appropriate spinner
    if (type === 'emails') {
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

        // Update Slack UI
        updateSlackUI(true, result.data.slack.teamName);
        updateSlackInputState(true, result.data.slack.teamName, result.data.slack.defaultChannel || '');
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
      const { ipcRenderer } = require('electron');
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
}

// Settings button
if (settingsBtn) {
    settingsBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      navigateToView('settings');
  
      // Reset summary state when leaving dashboard
      resetSummaryState();
  
      // Load settings which will handle back button visibility
      await loadUserSettings();
    });
  } else {
    console.error("Settings button not found");
  }
  
  // Back to dashboard button
  if (backToDashboardBtn) {
    backToDashboardBtn.addEventListener('click', (e) => {
      e.preventDefault();
      navigateToView('dashboard');
    });
  } else {
    console.error("Back to dashboard button not found");
  }
  
  // Email management
  if (addEmailBtn) {
    addEmailBtn.addEventListener('click', () => {
      const email = emailInput.value.trim();
      if (email) {
        addEmailTag(email);
      }
    });
  } else {
    console.error("Add email button not found");
  }
  
  // Email input handling
  if (emailInput) {
    emailInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const email = emailInput.value.trim();
        if (email) {
          addEmailTag(email);
        }
      }
    });
  }
  
  // Event delegation for removing emails
  if (emailTagsContainer) {
    emailTagsContainer.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-email')) {
        const email = e.target.dataset.email;
        removeEmailTag(email);
      }
    });
  } else {
    console.error("Email tags container not found");
  }
  
  // Add event listener for notification time changes
  const notificationTimeInput = document.getElementById("notificationTimeInput");
  if (notificationTimeInput) {
    // Make the input readonly to prevent typing and force using the picker
    notificationTimeInput.setAttribute("readonly", "readonly");
  
    // When clicked, force the time picker to open
    notificationTimeInput.addEventListener('click', (e) => {
      e.preventDefault();
  
      // Remove readonly temporarily to allow the picker to work
      e.target.removeAttribute("readonly");
  
      // Focus the input
      e.target.focus();
  
      // Try to show the time picker using various methods
      // Modern browsers support showPicker()
      if (typeof e.target.showPicker === 'function') {
        try {
          e.target.showPicker();
        } catch (err) {
        }
      }
  
      // Add readonly back after a short delay
      setTimeout(() => {
        e.target.setAttribute("readonly", "readonly");
      }, 100);
    });
  
    // Also add a click handler to the parent container to catch clicks
    // on the time picker icon that some browsers show
    const timeInputContainer = notificationTimeInput.parentElement;
    if (timeInputContainer) {
      timeInputContainer.addEventListener('click', (e) => {
        // Don't trigger if we clicked directly on the input (it has its own handler)
        if (e.target !== notificationTimeInput) {
          // Simulate a click on the input
          notificationTimeInput.click();
        }
      });
    }
  
    notificationTimeInput.addEventListener('change', async (e) => {
      const newTime = e.target.value;
  
      try {
        await saveUserSettings('notificationTime', newTime);
      } catch (error) {
        // If error occurs, revert to previous value
        e.target.value = summaryNotificationTime;
      }
    });
  }

module.exports = {
  initializeSettings,
  loadUserSettings
};
