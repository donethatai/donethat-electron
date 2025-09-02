const { getFirestore, doc, onSnapshot } = require("@firebase/firestore");
const { getAuth } = require("firebase/auth");
const { httpsCallable } = require("firebase/functions");
const { firebaseApp, functions } = require("./firebase.js");
const { logAnalyticsEvent } = require('./analytics.js');
const { ipcRenderer } = require("electron");

const { refreshAuthToken } = require('./auth.js');
const os = require('os');
const packageInfo = require('../package.json');
const { showBanner } = require('./notify.js');

// Use shared Firebase app (with App Check) and regioned services
const db = getFirestore(firebaseApp, "europe-west1");

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
let userTimezone = "UTC"; // Default timezone
let workdays = [1, 2, 3, 4, 5]; // Default Mon-Fri (0=Sun, 6=Sat)
let workhours = { start: "09:00", end: "17:00" }; // Default 9 AM to 5 PM
let inputData = {
  windows: false,
  keystrokes: false,
  audio: false
};

// Function to check and update app version
async function checkAndUpdateAppVersion() {
  const currentVersion = packageInfo.version;
  const lastVersion = localStorage.getItem('lastAppVersion');
  
  if (lastVersion !== currentVersion) {
    try {
      await saveUserSettings('app', {
        version: currentVersion,
        osPlatform: os.platform(),
        osRelease: os.release()
      });
      localStorage.setItem('lastAppVersion', currentVersion);
    } catch (error) {
      console.error('Error updating app version:', error);
    }
  }
}

// Initialize settings management
function initializeSettings(onSettingsUpdate, showBlockingSpinner, hideBlockingSpinner, viewNavigator) {
  loadUserSettingsCallback = onSettingsUpdate;
  showSpinner = showBlockingSpinner;
  hideSpinner = hideBlockingSpinner;
  navigateToView = viewNavigator;

  // Set up Firestore listener for user settings
  const auth = getAuth();
  if (auth.currentUser) {
    const userId = auth.currentUser.uid;
    setupSettingsListener(userId);
    checkAndUpdateAppVersion();
  } else {
    // Add auth state listener
    auth.onAuthStateChanged((user) => {
      if (user) {
        const userId = user.uid;
        setupSettingsListener(userId);
        checkAndUpdateAppVersion();
      } else {
        stopSettingsListener();
      }
    });
  }
  
  // Set up version click handler
  setupVersionClickHandler();
  // Set up permission result listener
  setupPermissionResultListener();
  // Note: Screen capture toggle behavior is now handled in permissions.js
  // Set up listener for disable-capture-features message
  setupDisableCaptureListener();

  // Set up Gemini API key listeners
  setupGeminiApiKeyListeners();
  // Set up dependency: disable screenshots in meetings requires microphone enabled
  setupMeetingScreenshotsDependency();
}
// Note: Screen capture checkbox behavior is now handled in permissions.js


// Set up listener for errors from main process
function setupDisableCaptureListener() {
  ipcRenderer.on('disable-capture-features', async (event, disabledSettings) => {
    
    // Update checkbox UI based on the settings
    if (disabledSettings.audio === false) {
      const audioCheckbox = document.getElementById('audioCheckbox');
      if (audioCheckbox && audioCheckbox.checked) {
        audioCheckbox.checked = false;
        // Update local state
        inputData.audio = false;
      }
    }
    
    if (disabledSettings.keystrokes === false) {
      const keystrokesCheckbox = document.getElementById('keystrokesCheckbox');
      if (keystrokesCheckbox && keystrokesCheckbox.checked) {
        keystrokesCheckbox.checked = false;
        // Update local state
        inputData.keystrokes = false;
      }
    }
    
    if (disabledSettings.windows === false) {
      const windowsCheckbox = document.getElementById('windowsCheckbox');
      if (windowsCheckbox && windowsCheckbox.checked) {
        windowsCheckbox.checked = false;
        // Update local state
        inputData.windows = false;
      }
    }
    
    // Save the updated settings - only if changes were made
    if (disabledSettings.audio === false || disabledSettings.keystrokes === false || disabledSettings.windows === false) {
      try {
        await saveUserSettings('inputData', inputData);
      } catch (error) {
        console.error('Error updating settings after feature disabled:', error);
      }
    }
  });
}

// Set up listener for permission check results
function setupPermissionResultListener() {
  document.addEventListener('permissionResult', async (event) => {
    const { type, hasPermission } = event.detail;
    
    const checkboxMap = {
      'audio': 'audioCheckbox',
      'keystrokes': 'keystrokesCheckbox',
      'windows': 'windowsCheckbox'
    };
    
    const checkbox = document.getElementById(checkboxMap[type]);
    if (!checkbox) return;
    
    // Set checkbox and local state according to permission result
    checkbox.checked = hasPermission;
    inputData[type] = hasPermission;

    // Keep Active applications non-revokable once enabled
    if (type === 'windows') {
      checkbox.disabled = !!hasPermission;
    }
    
    // Save to server
    try {
      await saveUserSettings('inputData', inputData);
      
      // Send updated input data to main process
      ipcRenderer.send('updateInputDataSettings', inputData);
      
      logAnalyticsEvent(`permission_${hasPermission ? 'granted' : 'denied'}_setting_updated`, {
        type: type,
        platform: process.platform
      });
    } catch (error) {
      console.error(`Error updating settings after ${type} permission ${hasPermission ? 'granted' : 'denied'}:`, error);
      if (hasPermission) {
        // Only need to revert UI state on error if we were trying to enable
        checkbox.checked = false;
        inputData[type] = false;
      }
    }
  });
}

// Helper function to update screenshots container visibility
function updateScreenshotsContainerVisibility(show) {
  // No-op: screenshots/local processing row removed
}

// Set up version click handler
function setupVersionClickHandler() {
  const versionElement = document.querySelector('#appVersion');
  
  if (versionElement) {
    try {
      // Try to get version from package.json first
      versionElement.textContent = `v${packageInfo.version}`;
      // Remove click easter egg
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
    } else {
        // Handle case where settings doc doesn't exist (e.g., new user)
    }
  }, (error) => {
    console.error("Error listening to settings changes:", error);
    // Check if the error is likely auth-related
    if (error.code === 'permission-denied' || error.code === 'unauthenticated') {
        console.warn('Firestore settings listener failed due to auth error. Attempting token refresh...');
        logAnalyticsEvent('firestore_listener_auth_error', { error_code: error.code });
        // Attempt to refresh the token
        refreshAuthToken().catch(refreshError => {
            console.error("Error attempting token refresh after listener failure:", refreshError);
        });
    }
    // Note: The listener might automatically retry after a successful refresh,
    // or might need to be explicitly restarted depending on Firestore SDK behavior.
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

    if (type === 'screenshots') {
      settingsData.storeScreenshots = value;
      logAnalyticsEvent('settings_updated', {
        type: 'screenshots',
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
    } else if (type === 'timezone') {
      settingsData.timezone = value;
      logAnalyticsEvent('settings_updated', {
        type: 'timezone',
        timezone: value
      });
    } else if (type === 'disableScreenshotsInMeetings') {
      settingsData.disableScreenshotsInMeetings = value;
      logAnalyticsEvent('settings_updated', {
        type: 'disableScreenshotsInMeetings',
        enabled: value
      });
    }

    // Check if we need to include OS info (only when saving other settings, not app)
    if (type !== 'app') {
      try {
        // Get the latest settings to have the current stored values
        const result = await getUserSettingsFunction();
        const settings = result.data;
        
        const localOSPlatform = os.platform();
        const localOSRelease = os.release();
        const storedOSPlatform = settings?.app?.osPlatform;
        const storedOSRelease = settings?.app?.osRelease;
        
        // Check if OS values are different
        if ((localOSPlatform && localOSPlatform !== storedOSPlatform) ||
            (localOSRelease && localOSRelease !== storedOSRelease)) {
          
          // Include app data in this settings update
          settingsData.app = {
            version: settings?.app?.version || packageInfo.version, // Keep existing version
            osPlatform: localOSPlatform || storedOSPlatform,
            osRelease: localOSRelease || storedOSRelease
          };
        }
      } catch (error) {
        // Non-critical error, just log it
        console.warn('Could not check OS info during settings update:', error);
      }
    }

    await updateUserSettingsFunction(settingsData);

  } catch (error) {
    logAnalyticsEvent('settings_update_error', {
      type: type,
      error_code: error.code,
      error_message: error.message
    });
    console.error("Error saving settings:", error);
    showBanner(`Error saving settings: ${error.message}`, { title: 'Settings', sticky: true });
    throw error; // Re-throw error so UI can react (e.g., revert input)
  } finally {
    // Hide spinner
    hideSpinner();
  }
}

async function updateSettingsUI(settings) {
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

  // Send current input data settings to main process
  ipcRenderer.send('updateInputDataSettings', inputData);

  const keystrokesCheckbox = document.getElementById('keystrokesCheckbox');
  const audioCheckbox = document.getElementById('audioCheckbox');

  // Do not set windowsCheckbox state here; permissions.js updates checked/disabled based on system permission
  if (keystrokesCheckbox) keystrokesCheckbox.checked = inputData.keystrokes;
  if (audioCheckbox) audioCheckbox.checked = inputData.audio; // Keep disabled state from HTML

  // Recompute dependency for meeting screenshots toggle now that audio state is applied
  try { recomputeMeetingScreenshotsDependency(); } catch (_) {}

  // Handle disable screenshots in meetings setting
  if (settings && typeof settings.disableScreenshotsInMeetings === 'boolean') {
    const disableScreenshots = document.getElementById('disableScreenshotsInMeetings');
    if (disableScreenshots) {
      disableScreenshots.checked = settings.disableScreenshotsInMeetings;
      // Send to main process
      ipcRenderer.send('updateDisableScreenshotsInMeetings', settings.disableScreenshotsInMeetings);
    }
  }

  // Handle workhours setting
  if (settings && settings.workhours) {
    workhours = {
      start: settings.workhours.start || "09:00", // Default to 9 AM if missing
      end: settings.workhours.end || "17:00"      // Default to 5 PM if missing
    };
  } else {
    // Use defaults if not set
    workhours = { start: "09:00", end: "17:00" };
  }
  
  // Send workhours to main process
  ipcRenderer.send('updateWorkhours', workhours);
  
  // Handle timezone setting
  let fetchedTimezone = "UTC"; // Default to UTC if not set
  if (settings && settings.timezone) {
    fetchedTimezone = settings.timezone;
  } else {
    // No timezone in settings, try to add the local one
    // Don't check for updates as that's also done in webapp
    try {
      const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (systemTimezone) {
        fetchedTimezone = systemTimezone;
        // Save the system timezone to user settings
        saveUserSettings('timezone', systemTimezone).catch(error => {
          console.error("Error saving system timezone:", error);
        });
        console.log(`No timezone in settings. Adding local timezone: ${systemTimezone}`);
      }
    } catch (error) {
      console.error("Could not determine system timezone:", error);
    }
  }
  userTimezone = fetchedTimezone; // Store the fetched timezone

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

  // Send initial workdays to main process
  ipcRenderer.send('updateWorkdays', workdays);
}

// Disable "Disable screenshots in meetings" unless microphone is enabled
function setupMeetingScreenshotsDependency() {
  const audioCheckbox = document.getElementById('audioCheckbox');
  const disableScreenshots = document.getElementById('disableScreenshotsInMeetings');
  if (!disableScreenshots) return;

  const applyState = () => {
    const micOn = !!(audioCheckbox && audioCheckbox.checked);
    disableScreenshots.disabled = !micOn;
    if (!micOn) {
      // Don't uncheck if we're just temporarily disabling due to no audio
      // The setting will be restored when audio is re-enabled
    }
  };

  // Initial application
  applyState();
  // React to microphone toggle changes
  if (audioCheckbox) {
    audioCheckbox.addEventListener('change', applyState);
  }

  // Add event listener for the disable screenshots toggle
  disableScreenshots.addEventListener('change', async () => {
    const isChecked = disableScreenshots.checked;
    try {
      await saveUserSettings('disableScreenshotsInMeetings', isChecked);
      // Send to main process
      ipcRenderer.send('updateDisableScreenshotsInMeetings', isChecked);
    } catch (error) {
      // Revert on error
      disableScreenshots.checked = !isChecked;
      console.error('Error saving disable screenshots setting:', error);
    }
  });
}

// Standalone recompute that can be called after async settings load
function recomputeMeetingScreenshotsDependency() {
  const audioCheckbox = document.getElementById('audioCheckbox');
  const disableScreenshots = document.getElementById('disableScreenshotsInMeetings');
  if (!disableScreenshots) return;
  const micOn = !!(audioCheckbox && audioCheckbox.checked);
  disableScreenshots.disabled = !micOn;
  if (!micOn) {
    // Don't uncheck if we're just temporarily disabling due to no audio
    // The setting will be restored when audio is re-enabled
  }
}



// Set up Gemini API key listeners
function setupGeminiApiKeyListeners() {
  const geminiApiKeyInput = document.getElementById('geminiApiKeyInput');
  const toggleGeminiKeyBtn = document.getElementById('toggleGeminiKeyBtn');
  const clearGeminiKeyBtn = document.getElementById('clearGeminiKeyBtn');
  const MASK = '************************'; // long placeholder for masked key
  let hasStoredKey = false;
  let isShowing = false;
  
  if (geminiApiKeyInput) {
    // On mount, check if a key exists and show masked
    (async () => {
      try {
        const result = await ipcRenderer.invoke('get-gemini-api-key');
        hasStoredKey = !!(result && result.success && result.apiKey);
        if (hasStoredKey) {
          storedKeyCached = result.apiKey || '';
        }
        if (hasStoredKey) {
          geminiApiKeyInput.value = MASK;
          geminiApiKeyInput.type = 'password';
        }
      } catch (error) {
        console.error('Error checking Gemini API key:', error);
      }
    })();
    
    // If user focuses and currently masked, temporarily reveal only when toggled via button
    geminiApiKeyInput.addEventListener('focus', async () => {
      if (!isShowing && hasStoredKey) {
        // Keep masked on focus; do nothing
      }
    });
    
    // Save API key on blur
    geminiApiKeyInput.addEventListener('blur', async () => {
      const raw = geminiApiKeyInput.value.trim();
      if (hasStoredKey && !isShowing && raw === MASK) {
        // Still masked, don't save
        return;
      }
      const apiKey = raw;
      
      try {
        if (apiKey) {
          await ipcRenderer.invoke('save-gemini-api-key', apiKey);
          logAnalyticsEvent('gemini_api_key_saved', {
            has_key: true
          });
          hasStoredKey = true;
          storedKeyCached = apiKey;
          if (!isShowing) {
            geminiApiKeyInput.value = MASK;
            geminiApiKeyInput.type = 'password';
          }
        } else {
          await ipcRenderer.invoke('clear-gemini-api-key');
          logAnalyticsEvent('gemini_api_key_cleared', {
            has_key: false
          });
          hasStoredKey = false;
          storedKeyCached = '';
        }
      } catch (error) {
        console.error('Error saving Gemini API key:', error);
        showBanner(`Error saving API key: ${error.message}`, { title: 'Settings', sticky: true });
      }
    });
  }
  
  if (toggleGeminiKeyBtn) {
    toggleGeminiKeyBtn.addEventListener('click', () => {
      const input = geminiApiKeyInput;
      if (input.type === 'password') {
        input.type = 'text';
        isShowing = true;
        // Populate with real key if we have a stored one and field currently masked
        if (hasStoredKey && input.value === MASK) {
          // Always refetch to ensure fresh value
          ipcRenderer.invoke('get-gemini-api-key').then((res) => {
            if (res && res.success && res.apiKey) {
              storedKeyCached = res.apiKey;
              input.value = res.apiKey;
            } else {
              input.value = '';
            }
          }).catch(() => { input.value = ''; });
        }
        toggleGeminiKeyBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
          </svg>
        `;
      } else {
        input.type = 'password';
        isShowing = false;
        if (hasStoredKey) {
          input.value = MASK;
        }
        toggleGeminiKeyBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        `;
      }
    });
  }
  
  if (clearGeminiKeyBtn) {
    clearGeminiKeyBtn.addEventListener('click', async () => {
      try {
        await ipcRenderer.invoke('clear-gemini-api-key');
        geminiApiKeyInput.value = '';
        hasStoredKey = false;
        isShowing = false;
        storedKeyCached = '';
        logAnalyticsEvent('gemini_api_key_cleared', {
          has_key: false
        });
      } catch (error) {
        console.error('Error clearing Gemini API key:', error);
        showBanner(`Error clearing API key: ${error.message}`, { title: 'Settings', sticky: true });
      }
    });
  }
}

module.exports = {
  initializeSettings,
  loadUserSettings,
  saveUserSettings
};