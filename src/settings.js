const { initializeApp } = require("firebase/app");
const { getFirestore, doc, onSnapshot } = require("@firebase/firestore");
const { getAuth } = require("firebase/auth");
const { getFunctions, httpsCallable } = require("firebase/functions");
const firebaseConfig = require("../firebase-config.js");
const { updateSlackUI, updateSlackInputState } = require('./slack');
const { logAnalyticsEvent } = require('./analytics.js');
const { ipcRenderer } = require("electron");
const { updateLastSummary, updateIsPublic } = require('./app-state.js');
const { requestAudioPermission, requestKeystrokesPermission, requestWindowsPermission } = require('./permissions.js');
const os = require('os');
const packageInfo = require('../package.json');

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
let userTimezone = "UTC"; // Default timezone
let workdays = [1, 2, 3, 4, 5]; // Default Mon-Fri (0=Sun, 6=Sat)
let inputData = {
  windows: false,
  keystrokes: false,
  audio: false
};

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
  // Setup workday click handler
  setupWorkdayClickHandler();
  // Set up event listeners for new checkboxes
  setupInputDataCheckboxListeners();
  // Set up permission result listener
  setupPermissionResultListener();
}

// Set up listener for permission check results
function setupPermissionResultListener() {
  document.addEventListener('permissionResult', async (event) => {
    const { type, hasPermission } = event.detail;
    
    // If permission was denied, update the corresponding checkbox and setting
    if (!hasPermission) {
      const checkboxMap = {
        'audio': 'audioCheckbox',
        'keystrokes': 'keystrokesCheckbox',
        'windows': 'windowsCheckbox'
      };
      
      const checkbox = document.getElementById(checkboxMap[type]);
      if (checkbox) {
        checkbox.checked = false;
        
        // Update our local state
        inputData[type] = false;
        
        // Save to server - no need to await
        try {
          await saveUserSettings('inputData', inputData);
          logAnalyticsEvent('permission_denied_setting_updated', {
            type: type,
            platform: process.platform
          });
        } catch (error) {
          console.error(`Error updating settings after ${type} permission denied:`, error);
        }
      }
    }
  });
}

// Helper function to update screenshots container visibility
function updateScreenshotsContainerVisibility(show) {
  const screenshotsContainer = document.getElementById('screenshotsContainer');
  if (screenshotsContainer) {
    if (show) {
      screenshotsContainer.classList.remove('hidden');
      screenshotsContainer.classList.add('flex');
    } else {
      screenshotsContainer.classList.add('hidden');
      screenshotsContainer.classList.remove('flex');
    }
  }
}

// Set up version click handler
function setupVersionClickHandler() {
  const versionElement = document.querySelector('#appVersion');
  
  if (versionElement) {
    try {
      // Try to get version from package.json first
      versionElement.textContent = `v${packageInfo.version}`;
      
      // Add click handler for version number
      versionElement.style.cursor = 'pointer'; // Make it look clickable
      versionElement.addEventListener('click', (e) => {
        const screenshotsCheckbox = document.getElementById('screenshotsCheckbox');
        if (screenshotsCheckbox && !screenshotsCheckbox.checked) {
          // Only toggle if checkbox is unchecked
          const isHidden = document.getElementById('screenshotsContainer').classList.contains('hidden');
          updateScreenshotsContainerVisibility(isHidden);
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
    updateSettingsUI(result.data);
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

  // Show spinner for all settings updates
  showSpinner();

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
    } else if (type === 'workdays') {
      settingsData.workdays = value;
      workdays = value; // Update local state immediately
      logAnalyticsEvent('settings_updated', {
        type: 'workdays',
        days: value.join(',') // Log the selected days
      });
    } else if (type === 'publicSummaries') {
      settingsData.public = value;
      logAnalyticsEvent('settings_updated', {
        type: 'publicSummaries',
        enabled: value
      });
    } else if (type === 'inputData') { // Renamed type
      settingsData.inputData = value; // Use inputData
      logAnalyticsEvent('settings_updated', {
        type: 'inputData',
        windows: value.windows,
        keystrokes: value.keystrokes,
        audio: value.audio
      });
    } else if (type === 'app') { // Add handling for 'app' type
      settingsData.app = value; // value should be { version: '...', osPlatform: '...', osRelease: '...' }
      logAnalyticsEvent('settings_updated', {
        type: 'app',
        version: value.version,
        osPlatform: value.osPlatform, // Updated field name
        osRelease: value.osRelease   // Added field
      });
    }

    await updateUserSettingsFunction(settingsData);

    // If save was successful, *now* send the update to main process for workdays
    if (type === 'workdays') {
      ipcRenderer.send('updateWorkdays', value);
    }

  } catch (error) {
    logAnalyticsEvent('settings_update_error', {
      type: type,
      error_code: error.code,
      error_message: error.message
    });
    console.error("Error saving settings:", error);
    alert(`Error saving settings: ${error.message}`);
    throw error; // Re-throw error so UI can react (e.g., revert input)
  } finally {
    // Hide spinner
    hideSpinner();
  }
}

async function updateSettingsUI(settings) {
  // Reset state
  recipientEmails = [];
  const emailTagsContainer = document.getElementById('emailTagsContainer');
  if (emailTagsContainer) {
    emailTagsContainer.innerHTML = "";
  }

  // Handle name
  const nameInput = document.getElementById('nameInput');
  if (nameInput) {
    nameInput.value = settings?.name || '';
  }

  // Handle screenshots setting
  if (settings && typeof settings.storeScreenshots === 'boolean') {
    const screenshotsCheckbox = document.getElementById('screenshotsCheckbox');
    if (screenshotsCheckbox) {
      screenshotsCheckbox.checked = settings.storeScreenshots;
      // Show container if screenshots are enabled
      updateScreenshotsContainerVisibility(settings.storeScreenshots);
    }
  }

  // Handle input data settings
  const loadedInputData = settings?.inputData || {}; // Use inputData
  inputData = {
    windows: !!loadedInputData.windows,         // Use windows key
    keystrokes: !!loadedInputData.keystrokes,
    audio: !!loadedInputData.audio
  };

  const windowsCheckbox = document.getElementById('windowsCheckbox'); // Updated ID
  const keystrokesCheckbox = document.getElementById('keystrokesCheckbox');
  const audioCheckbox = document.getElementById('audioCheckbox');

  if (windowsCheckbox) windowsCheckbox.checked = inputData.windows; // Use windows key
  if (keystrokesCheckbox) keystrokesCheckbox.checked = inputData.keystrokes;
  if (audioCheckbox) audioCheckbox.checked = inputData.audio; // Keep disabled state from HTML

  // Handle public summaries setting
  const publicSummariesCheckbox = document.getElementById('publicSummariesCheckbox');
  if (publicSummariesCheckbox) {
    const isPublicValue = settings?.public || false; // Default to false if not set
    publicSummariesCheckbox.checked = isPublicValue;
    updateIsPublic(isPublicValue);
  }

  // Handle email recipients
  if (settings &&
    settings.emailRecipients &&
    Array.isArray(settings.emailRecipients) &&
    settings.emailRecipients.length > 0) {
    // Get unique emails from server response
    const uniqueEmails = [...new Set(settings.emailRecipients)];

    // Set our internal state
    recipientEmails = uniqueEmails;

    // Render the email tags
    renderEmailTags();
  }

  // Handle lastSummary from activity data
  if (settings?.activity?.lastSummary) {
    const timestamp = settings.activity.lastSummary; // Store timestamp
    updateLastSummary(timestamp); // Update renderer state
    // Send the timestamp to the main process
    ipcRenderer.send('updateLastSummaryTimestamp', timestamp);
  } else {
     // Handle case where lastSummary might be explicitly null or undefined
     // Optionally send null to main process to clear stored value if needed
     ipcRenderer.send('updateLastSummaryTimestamp', null);
  }
  
  // Handle Slack settings
  if (settings.slack?.accessToken) {
    const slackInput = document.getElementById('slackInput');
    if (slackInput) {
      slackInput.value = settings.slack.defaultChannel || '';
    }

    // Get team name from the first active team if available
    const teams = settings.teams || {};
    const activeTeam = Object.values(teams).find(team => team.status === 'active');
    const teamName = activeTeam?.name || settings.slack.teamName;

    // Update Slack UI with the active team's name
    updateSlackUI(true, teamName);
    updateSlackInputState(true, teamName, settings.slack.defaultChannel || '');
  } else {
    updateSlackUI(false);
    updateSlackInputState(false);
  }
  
  // Handle timezone setting
  let fetchedTimezone = "UTC"; // Default to UTC if not set
  if (settings && settings.timezone) {
    fetchedTimezone = settings.timezone;
  }
  userTimezone = fetchedTimezone; // Store the fetched timezone

  // Check system timezone and update if different
  try {
    const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (systemTimezone && systemTimezone !== userTimezone) {
      console.log(`System timezone (${systemTimezone}) differs from saved timezone (${userTimezone}). Logging mismatch.`);
      // Log an analytics event for the mismatch instead of updating
      // Don't update here because also updating in webApp and potential
      // to cause a loop
      logAnalyticsEvent('timezone_mismatch', {
        system_timezone: systemTimezone,
        user_timezone: userTimezone
      });
    }
  } catch (error) {
    console.error("Could not determine system timezone:", error);
  }

  // Handle workdays
  const defaultWorkdays = [1, 2, 3, 4, 5]; // Mon-Fri
  let loadedWorkdays = defaultWorkdays;
  if (settings && Array.isArray(settings.workdays)) {
    // Validate days are numbers 0-6
    const validWorkdays = settings.workdays.filter(day =>
      typeof day === 'number' && day >= 0 && day <= 6
    );
    // Use Set to remove duplicates
    loadedWorkdays = [...new Set(validWorkdays)];
  } else {
    workdays = defaultWorkdays;
  }

  // Assign to module state AFTER processing
  workdays = loadedWorkdays;

  // Render the selectors
  renderWorkdaySelectors();

  // Send initial workdays to main process
  ipcRenderer.send('updateWorkdays', workdays);

  // --- Check and update App Version and OS ---
  try {
    const localVersion = packageInfo.version;
    const localOSPlatform = os.platform(); // Get platform
    const localOSRelease = os.release();   // Get release version
    const storedVersion = settings?.app?.version;
    const storedOSPlatform = settings?.app?.osPlatform; // Updated field name
    const storedOSRelease = settings?.app?.osRelease;   // Added field

    let needsUpdate = false;
    const appData = {
      version: storedVersion || localVersion,
      osPlatform: storedOSPlatform || localOSPlatform, // Use stored value as base if exists
      osRelease: storedOSRelease || localOSRelease    // Use stored value as base if exists
    };

    if (localVersion && localVersion !== storedVersion) {
      console.log(`Local app version (${localVersion}) differs from stored version (${storedVersion}). Updating.`);
      appData.version = localVersion;
      needsUpdate = true;
    }

    if (localOSPlatform && localOSPlatform !== storedOSPlatform) {
      console.log(`Local OS Platform (${localOSPlatform}) differs from stored OS Platform (${storedOSPlatform}). Updating.`);
      appData.osPlatform = localOSPlatform;
      needsUpdate = true;
    }

    if (localOSRelease && localOSRelease !== storedOSRelease) {
      console.log(`Local OS Release (${localOSRelease}) differs from stored OS Release (${storedOSRelease}). Updating.`);
      appData.osRelease = localOSRelease;
      needsUpdate = true;
    }

    if (needsUpdate) {
      // Call saveUserSettings without await to avoid blocking UI update
      // Spinner is already handled within saveUserSettings
      saveUserSettings('app', appData).catch(error => {
        // Log error if the background update fails, but don't block UI
        console.error("Background update of app version/OS failed:", error);
      });
    }
  } catch (error) {
    console.error("Error checking/updating app version and OS:", error);
  }
  // --- End Check and update App Version and OS ---
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
      <button data-email="${email}" class="remove-email remove-email-btn cursor-pointer">
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
      showSpinner();
      await saveUserSettings('name', newName || null);
    } catch (error) {
      // If error occurs, revert to previous value
      e.target.value = getName();
    } finally {
      hideSpinner();
    }
  });
}

const screenshotsCheckbox = document.getElementById('screenshotsCheckbox');
if (screenshotsCheckbox) {
  screenshotsCheckbox.addEventListener('change', async (e) => {
    try {
      showSpinner();
      await saveUserSettings('screenshots', e.target.checked);
      // Show/hide container based on checkbox state
      updateScreenshotsContainerVisibility(e.target.checked);
    } catch (error) {
      // If error occurs, revert to previous value
      e.target.checked = isStoreScreenshots();
    } finally {
      hideSpinner();
    }
  });
}

// Add event listener for public summaries checkbox
const publicSummariesCheckbox = document.getElementById('publicSummariesCheckbox');
if (publicSummariesCheckbox) {
  publicSummariesCheckbox.addEventListener('change', async (e) => {
    try {
      showSpinner();
      await saveUserSettings('publicSummaries', e.target.checked);
    } catch (error) {
      // If error occurs, revert to previous value
      e.target.checked = !e.target.checked;
    } finally {
      hideSpinner();
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

  // Add blur event listener to add email when focus leaves the input
  emailInput.addEventListener('blur', async (e) => {
    const email = emailInput.value.trim();
    if (email) {
      // Check if email is already added to prevent duplicates on Enter + Blur
      if (!recipientEmails.includes(email)) {
         await addEmailTag(email);
      } else {
        emailInput.value = ""; // Uncomment if desired
      }
    }
  });
}

// Helper function to get the first day of the week based on locale
function getFirstDayOfWeek() {
  try {
    // Use Intl.Locale if available (modern browsers/Node versions)
    if (typeof Intl !== 'undefined' && typeof Intl.Locale !== 'undefined') {
      // Use navigator.language for renderer process locale
      const locale = new Intl.Locale(navigator.language);
      // weekInfo is experimental but widely supported
      if (locale.weekInfo && typeof locale.weekInfo.firstDay === 'number') {
        // Intl.Locale returns 1 for Monday, 7 for Sunday. Convert Sunday to 0.
        return locale.weekInfo.firstDay % 7;
      }
    }
  } catch (e) {
    console.warn("Could not determine locale's first day of week, defaulting to Monday:", e);
  }
  // Default to Monday (1) if Intl.Locale is unavailable or doesn't provide weekInfo
  return 1;
}

// Function to render workday selectors
function renderWorkdaySelectors() {
  const container = document.getElementById('workdaysContainer');
  if (!container) return;

  container.innerHTML = ''; // Clear existing buttons

  const firstDay = getFirstDayOfWeek(); // 0 for Sunday, 1 for Monday
  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // Sun-Sat

  for (let i = 0; i < 7; i++) {
    const dayIndex = (firstDay + i) % 7; // The actual day number (0-6)
    const button = document.createElement('button');
    button.className = 'workday-selector flex-1 py-1 text-xs rounded border cursor-pointer'; // Base classes
    button.textContent = dayLabels[dayIndex];
    button.setAttribute('data-day', dayIndex.toString());

    if (workdays.includes(dayIndex)) {
      // Active state: Light gray background, dark gray text
      button.classList.add('bg-gray-200', 'text-gray-700', 'border-gray-300', 'hover:bg-gray-300');
      button.classList.remove('bg-white', 'text-gray-400', 'border-gray-200', 'hover:bg-gray-100');
    } else {
      // Inactive state: White background, light gray text
      button.classList.add('bg-white', 'text-gray-400', 'border-gray-200', 'hover:bg-gray-100');
      button.classList.remove('bg-gray-200', 'text-gray-700', 'border-gray-300', 'hover:bg-gray-300');
    }
    container.appendChild(button);
  }
}

// Set up click handler for workday selectors using event delegation
function setupWorkdayClickHandler() {
  const container = document.getElementById('workdaysContainer');
  if (container) {
    container.addEventListener('click', async (e) => {
      if (e.target && e.target.classList.contains('workday-selector')) {
        const dayIndex = parseInt(e.target.getAttribute('data-day'), 10);
        if (isNaN(dayIndex)) return;

        const originalWorkdays = [...workdays]; // Backup

        // Toggle the day
        let newWorkdays;
        if (workdays.includes(dayIndex)) {
          newWorkdays = workdays.filter(d => d !== dayIndex);
        } else {
          newWorkdays = [...workdays, dayIndex].sort((a, b) => a - b);
        }

        // Optimistically update UI
        workdays = newWorkdays;
        renderWorkdaySelectors();

        try {
          await saveUserSettings('workdays', newWorkdays);
          // If save successful, UI is already updated.
        } catch (error) {
          // Revert UI on error
          workdays = originalWorkdays;
          renderWorkdaySelectors();
          // Error already alerted in saveUserSettings
        }
      }
    });
  }
}

function setupInputDataCheckboxListeners() {
  const windowsCheckbox = document.getElementById('windowsCheckbox');
  const keystrokesCheckbox = document.getElementById('keystrokesCheckbox');
  const audioCheckbox = document.getElementById('audioCheckbox');

  const handleCheckboxChange = async (checkboxId, fieldName, permissionFunction) => {
    const checkbox = document.getElementById(checkboxId);
    if (!checkbox) return;

    const isChecked = checkbox.checked;
    const originalValue = inputData[fieldName];

    if (isChecked) {
      // If turning ON, request permission first
      permissionFunction();
      
      // Optimistically update state - permission result will be handled by the listener
      inputData[fieldName] = isChecked;
      
      try {
        // Save the entire inputData object
        await saveUserSettings('inputData', inputData);
      } catch (error) {
        // Revert UI and state on error with settings save
        inputData[fieldName] = originalValue;
        checkbox.checked = originalValue;
      }
    } else {
      // If turning OFF, just update setting - no permission needed
      inputData[fieldName] = false;
      
      try {
        await saveUserSettings('inputData', inputData);
      } catch (error) {
        // Revert UI and state on error
        inputData[fieldName] = originalValue;
        checkbox.checked = originalValue;
      }
    }
  };

  if (windowsCheckbox) {
    windowsCheckbox.addEventListener('change', () => {
      if (windowsCheckbox.checked) {
        handleCheckboxChange('windowsCheckbox', 'windows', requestWindowsPermission);
      } else {
        handleCheckboxChange('windowsCheckbox', 'windows', () => {});
      }
    });
  }
  
  if (keystrokesCheckbox) {
    keystrokesCheckbox.addEventListener('change', () => {
      if (keystrokesCheckbox.checked) {
        handleCheckboxChange('keystrokesCheckbox', 'keystrokes', requestKeystrokesPermission);
      } else {
        handleCheckboxChange('keystrokesCheckbox', 'keystrokes', () => {});
      }
    });
  }
  
  if (audioCheckbox) {
    audioCheckbox.addEventListener('change', () => {
      if (audioCheckbox.checked) {
        handleCheckboxChange('audioCheckbox', 'audio', requestAudioPermission);
      } else {
        handleCheckboxChange('audioCheckbox', 'audio', () => {});
      }
    });
  }
}

module.exports = {
  initializeSettings,
  loadUserSettings,
  saveUserSettings
};