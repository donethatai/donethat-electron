const { getFirestore, doc, onSnapshot } = require("@firebase/firestore");
const { getAuth } = require("firebase/auth");
const { httpsCallable } = require("firebase/functions");
const { firebaseApp, functions } = require("./firebase.js");
const { logAnalyticsEvent } = require('./analytics.js');
const { hasWindowsPermission } = require('./app-state.js');
const ipcRenderer = window.electronAPI;

const { refreshAuthToken } = require('./auth.js');
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
  audio: false,
  systemAudio: false,
  screen: true
};



async function forceDisableSystemAudio() {
  try {
    const el = document.getElementById('systemAudioCheckbox');
    if (el && el.checked) {
      el.checked = false;
      // Build a partial update for inputData
      inputData.systemAudio = false;
      await saveUserSettings('inputData', { systemAudio: false, __partial: true });
      ipcRenderer.send('updateInputDataSettings', { systemAudio: false });
    }
  } catch (error) {
    console.error('Error forcing disable of system audio:', error);
  }
}


// Function to check and update app version
async function checkAndUpdateAppVersion() {
  const currentVersion = packageInfo.version;
  const lastVersion = localStorage.getItem('lastAppVersion');
  
  if (lastVersion !== currentVersion) {
    try {
      const platformInfo = await ipcRenderer.invoke('get-platform-info');
      await saveUserSettings('app', {
        version: currentVersion,
        osPlatform: platformInfo?.os_name ?? window.electronAPI?.platform ?? 'unknown',
        osRelease: platformInfo?.os_version ?? 'unknown'
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
  // Set up OpenAI-compatible config listeners
  setupOpenAICompatibleListeners();
  // Set up hotkey configuration UI
  setupHotkeyConfiguration();
  // Set up test local processing button
  setupTestLocalProcessing();

  setupSystemAudioDependency();
  // Set up app exclusions listeners
  setupAppExclusionsListeners();
  // Set up context capture (experimental) listeners
  setupContextCaptureListeners();
  setupSaveCaptureDataListeners();

  // Set up Wayland detection
  setupWaylandDetection();
  
  // Set up finish button (only when settings view is loaded)
  setTimeout(() => {
    try {
      const { updateFinishButtonVisibility } = require('./permissions.js');
      if (updateFinishButtonVisibility) {
        updateFinishButtonVisibility();
      }
    } catch (error) {
      console.error('Error setting up finish button:', error);
    }
  }, 100);
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
      // Also disable System Audio if mic is off
      await forceDisableSystemAudio();
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
    if (disabledSettings.audio === false || disabledSettings.windows === false) {
      try {
        await saveUserSettings('inputData', inputData);
      } catch (error) {
        console.error('Error updating settings after feature disabled:', error);
      }
    }

    // After updating state and persisting, bring app to front and navigate to Settings
    // Fail silently
    // try { ipcRenderer.send('focus-app-window'); } catch (_) {}
    try { if (navigateToView) navigateToView('settings'); } catch (_) {}
  });
}

// Set up listener for permission check results
function setupPermissionResultListener() {
  document.addEventListener('permissionResult', async (event) => {
    const { type, hasPermission } = event.detail;
    
    const checkboxMap = {
      'audio': 'audioCheckbox',
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
    // If audio permission was revoked, also disable system audio and persist
    if (type === 'audio' && !hasPermission) {
      await forceDisableSystemAudio();
    }
    
    // Save to server
    try {
      const partial = { [type]: hasPermission, __partial: true };
      await saveUserSettings('inputData', partial);
      
      // Send only the changed flag to main process to avoid clobbering other states
      ipcRenderer.send('updateInputDataSettings', { [type]: hasPermission });
      
      logAnalyticsEvent(`permission_${hasPermission ? 'granted' : 'denied'}_setting_updated`, {
        type: type,
        platform: window.electronAPI.platform
      });
    } catch (error) {
      console.error(`Error updating settings after ${type} permission ${hasPermission ? 'granted' : 'denied'}:`, error);
      if (hasPermission) {
        // Only need to revert UI state on error if we were trying to enable
        checkbox.checked = false;
        inputData[type] = false;
      }
    }

    // If permission was denied, bring app to front and navigate to Settings after state persisted
    if (!hasPermission) {
      // Fail silently
      // try { ipcRenderer.send('focus-app-window'); } catch (_) {}
      try { if (navigateToView) navigateToView('settings'); } catch (_) {}
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
      // Support partial updates to avoid clobbering concurrent permission states
      if (value && value.__partial) {
        try {
          const result = await getUserSettingsFunction();
          const current = result?.data?.inputData || {};
          const partial = { ...value };
          delete partial.__partial;
          const merged = {
            windows: partial.windows != null ? !!partial.windows : (current.windows != null ? !!current.windows : false),
            audio: partial.audio != null ? !!partial.audio : (current.audio != null ? !!current.audio : false),
            systemAudio: partial.systemAudio != null ? !!partial.systemAudio : (current.systemAudio != null ? !!current.systemAudio : false),
            screen: partial.screen != null ? !!partial.screen : (current.screen != null ? !!current.screen : true)
          };
          settingsData.inputData = merged;
          logAnalyticsEvent('settings_updated', {
            type: 'inputData',
            windows: merged.windows,
            audio: merged.audio,
            screen: merged.screen,
            mode: 'partial-merge'
          });
        } catch (mergeErr) {
          console.warn('Partial inputData merge failed, falling back to local value:', mergeErr);
          const fallback = { ...value };
          delete fallback.__partial;
          settingsData.inputData = {
            windows: fallback.windows != null ? !!fallback.windows : false,
            audio: fallback.audio != null ? !!fallback.audio : false,
            systemAudio: fallback.systemAudio != null ? !!fallback.systemAudio : false,
            screen: fallback.screen != null ? !!fallback.screen : true
          };
          logAnalyticsEvent('settings_updated', {
            type: 'inputData',
            windows: settingsData.inputData.windows,
            audio: settingsData.inputData.audio,
            screen: settingsData.inputData.screen,
            mode: 'partial-fallback'
          });
        }
      } else {
        const fullValue = {
          windows: value.windows != null ? !!value.windows : false,
          audio: value.audio != null ? !!value.audio : false,
          systemAudio: value.systemAudio != null ? !!value.systemAudio : false,
          screen: value.screen != null ? !!value.screen : true
        };
        settingsData.inputData = fullValue;
        logAnalyticsEvent('settings_updated', {
          type: 'inputData',
          windows: fullValue.windows,
          audio: fullValue.audio,
          systemAudio: fullValue.systemAudio,
          screen: fullValue.screen,
          mode: 'full'
        });
      }
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
    }


    // Check if we need to include OS info (only when saving other settings, not app)
    if (type !== 'app') {
      try {
        // Get the latest settings to have the current stored values
        const result = await getUserSettingsFunction();
        const settings = result.data;
        
        const platformInfo = await ipcRenderer.invoke('get-platform-info');
        const localOSPlatform = platformInfo?.os_name ?? window.electronAPI?.platform;
        const localOSRelease = platformInfo?.os_version;
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
  const loadedInputData = settings?.inputData || {};
  const prevInputData = { ...inputData };
  // Passive windows: do not read persisted windows; use live OS permission for local state only
  // Defaults: screen=true, systemAudio=false
  inputData = {
    windows: (typeof hasWindowsPermission === 'function') ? hasWindowsPermission() : prevInputData.windows,
    audio: loadedInputData.audio != null ? !!loadedInputData.audio : false,
    systemAudio: loadedInputData.systemAudio != null ? !!loadedInputData.systemAudio : false,
    screen: loadedInputData.screen != null ? !!loadedInputData.screen : true
  };

  // Compute and send only changed flags to main to avoid clobbering
  const delta = {};
  // IMPORTANT: Do not include windows in delta from settings load.
  // Windows permission state is managed by permissions.js via system events.
  if (prevInputData.audio !== inputData.audio) delta.audio = inputData.audio;
  if (prevInputData.systemAudio !== inputData.systemAudio) delta.systemAudio = inputData.systemAudio;
  if (prevInputData.screen !== inputData.screen) delta.screen = inputData.screen;
  
  if (Object.keys(delta).length > 0) {
    console.log('[Settings] sending updateInputDataSettings delta:', delta);
    ipcRenderer.send('updateInputDataSettings', delta);
  }

  const audioCheckbox = document.getElementById('audioCheckbox');
  const systemAudioCheckbox = document.getElementById('systemAudioCheckbox');
  const screenCheckbox = document.getElementById('screenCheckbox');

  // Do not set windowsCheckbox state here; permissions.js updates checked/disabled based on system permission
  if (audioCheckbox) audioCheckbox.checked = inputData.audio; 
  if (screenCheckbox) screenCheckbox.checked = inputData.screen;
  if (systemAudioCheckbox) {
    systemAudioCheckbox.checked = inputData.systemAudio;
    // Visually disable if audio is off
    systemAudioCheckbox.disabled = !inputData.audio;
  }

  try { recomputeSystemAudioDependency(); } catch (_) {}



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



// Disable "System audio" unless microphone is enabled
function setupSystemAudioDependency() {
  const audioCheckbox = document.getElementById('audioCheckbox');
  const systemAudioCheckbox = document.getElementById('systemAudioCheckbox');
  if (!systemAudioCheckbox) return;

  const applyState = async () => {
    // Check both DOM and memory state to avoid race conditions during init
    const micOn = !!(audioCheckbox && audioCheckbox.checked) || !!inputData.audio;


    // If mic turns off, system audio must turn off
    if (!micOn && systemAudioCheckbox.checked) {
       console.warn('[Settings] setupSystemAudioDependency: Force disabling System Audio because Mic is OFF');
       await forceDisableSystemAudio();
    }
    systemAudioCheckbox.disabled = !micOn;
  };

  // Initial application
  applyState();
  
  // React to microphone toggle changes
  if (audioCheckbox) {
    audioCheckbox.addEventListener('change', applyState);
  }

  // Add event listener for screenshare toggle
  if (screenCheckbox) {
    screenCheckbox.addEventListener('change', async () => {
      const isChecked = screenCheckbox.checked;
      try {
        inputData.screen = isChecked;
        await saveUserSettings('inputData', { screen: isChecked, __partial: true });
        ipcRenderer.send('updateInputDataSettings', { screen: isChecked });
      } catch (error) {
        screenCheckbox.checked = !isChecked;
        inputData.screen = !isChecked;
      }
    });
  }

  // Add event listener for system audio toggle
  if (systemAudioCheckbox) {
    systemAudioCheckbox.addEventListener('change', async () => {
      const isChecked = systemAudioCheckbox.checked;
      try {
        // Use helper to save setting
        inputData.systemAudio = isChecked;
        await saveUserSettings('inputData', { systemAudio: isChecked, __partial: true });
        ipcRenderer.send('updateInputDataSettings', { systemAudio: isChecked });
      } catch (error) {
        // Revert on error
        systemAudioCheckbox.checked = !isChecked;
        inputData.systemAudio = !isChecked;
      }
    });
  }
}

function recomputeSystemAudioDependency() {
  const audioCheckbox = document.getElementById('audioCheckbox');
  const systemAudioCheckbox = document.getElementById('systemAudioCheckbox');
  if (!systemAudioCheckbox) return;

  // Check both DOM and memory state to avoid race conditions during init
  const micOn = !!(audioCheckbox && audioCheckbox.checked) || !!inputData.audio;
  
  systemAudioCheckbox.disabled = !micOn;
  if (!micOn && systemAudioCheckbox.checked) {
    forceDisableSystemAudio();
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

// Set up OpenAI-compatible config listeners
function setupOpenAICompatibleListeners() {
  const openaiEndpointInput = document.getElementById('openaiEndpointInput');
  const openaiModelInput = document.getElementById('openaiModelInput');
  const openaiApiKeyInput = document.getElementById('openaiApiKeyInput');
  const toggleOpenaiKeyBtn = document.getElementById('toggleOpenaiKeyBtn');
  const clearOpenaiConfigBtn = document.getElementById('clearOpenaiConfigBtn');
  const MASK = '************************';
  let hasStoredConfig = false;
  let isShowingKey = false;
  let storedConfig = { endpoint: null, model: null, apiKey: null };

  if (openaiEndpointInput && openaiApiKeyInput) {
    // On mount, load existing config
    (async () => {
      try {
        const result = await ipcRenderer.invoke('get-openai-compatible-config');
        if (result && result.success && result.config) {
          storedConfig = result.config;
          hasStoredConfig = !!(storedConfig.endpoint || storedConfig.model || storedConfig.apiKey);
          if (storedConfig.endpoint) {
            openaiEndpointInput.value = storedConfig.endpoint;
          }
          if (storedConfig.model) {
            openaiModelInput.value = storedConfig.model;
          }
          if (storedConfig.apiKey) {
            openaiApiKeyInput.value = MASK;
            openaiApiKeyInput.type = 'password';
          }
        }
      } catch (error) {
        console.error('Error loading OpenAI-compatible config:', error);
      }
    })();

    // Save config on blur for all fields
    const saveConfig = async () => {
      const endpoint = openaiEndpointInput.value.trim();
      const model = openaiModelInput.value.trim();
      const rawApiKey = openaiApiKeyInput.value.trim();

      let apiKey = null;
      if (hasStoredConfig && !isShowingKey && rawApiKey === MASK) {
        // Still masked, keep existing key
        apiKey = storedConfig.apiKey;
      } else if (rawApiKey) {
        apiKey = rawApiKey;
      }

      try {
        if (endpoint || model || apiKey) {
          await ipcRenderer.invoke('save-openai-compatible-config', { endpoint, model, apiKey });
          logAnalyticsEvent('openai_config_saved', {
            has_endpoint: !!endpoint,
            has_model: !!model,
            has_key: !!apiKey
          });
          hasStoredConfig = true;
          storedConfig = { endpoint, model, apiKey };
          if (apiKey && !isShowingKey) {
            openaiApiKeyInput.value = MASK;
            openaiApiKeyInput.type = 'password';
          }
        } else {
          await ipcRenderer.invoke('clear-openai-compatible-config');
          logAnalyticsEvent('openai_config_cleared', {});
          hasStoredConfig = false;
          storedConfig = { endpoint: null, model: null, apiKey: null };
        }
      } catch (error) {
        console.error('Error saving OpenAI-compatible config:', error);
        showBanner(`Error saving configuration: ${error.message}`, { title: 'Settings', sticky: true });
      }
    };

    openaiEndpointInput.addEventListener('blur', saveConfig);
    openaiModelInput.addEventListener('blur', saveConfig);
    openaiApiKeyInput.addEventListener('blur', saveConfig);
  }

  if (toggleOpenaiKeyBtn) {
    toggleOpenaiKeyBtn.addEventListener('click', () => {
      const input = openaiApiKeyInput;
      if (input.type === 'password') {
        input.type = 'text';
        isShowingKey = true;
        // Populate with real key if we have a stored one and field currently masked
        if (hasStoredConfig && storedConfig.apiKey && input.value === MASK) {
          input.value = storedConfig.apiKey;
        }
        toggleOpenaiKeyBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
          </svg>
        `;
      } else {
        input.type = 'password';
        isShowingKey = false;
        if (hasStoredConfig && storedConfig.apiKey) {
          input.value = MASK;
        }
        toggleOpenaiKeyBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        `;
      }
    });
  }

  if (clearOpenaiConfigBtn) {
    clearOpenaiConfigBtn.addEventListener('click', async () => {
      try {
        await ipcRenderer.invoke('clear-openai-compatible-config');
        openaiEndpointInput.value = '';
        openaiModelInput.value = '';
        openaiApiKeyInput.value = '';
        hasStoredConfig = false;
        isShowingKey = false;
        storedConfig = { endpoint: null, model: null, apiKey: null };
        logAnalyticsEvent('openai_config_cleared', {});
      } catch (error) {
        console.error('Error clearing OpenAI-compatible config:', error);
        showBanner(`Error clearing configuration: ${error.message}`, { title: 'Settings', sticky: true });
      }
    });
  }
}

module.exports = {
  initializeSettings,
  loadUserSettings,
  saveUserSettings
};

// --- Hotkey configuration ---
function setupHotkeyConfiguration() {
  const input = document.getElementById('hotkeyLetterInput');
  const cmdCap = document.getElementById('hotkeyCmdCap');
  const shiftCap = document.getElementById('hotkeyShiftCap');
  if (!input || !cmdCap || !shiftCap) return;

  // Load current from main
  ipcRenderer.invoke('hotkey:get').then((res) => {
    if (res && res.success) {
      try { input.value = (res.suffix || 'D'); } catch (_) {}
      // Update Cmd/Ctrl label depending on platform
      try { cmdCap.textContent = (window.electronAPI.platform === 'darwin' ? 'Cmd' : 'Ctrl'); } catch (_) {}
    }
  }).catch(() => {});

  // Sanitize input and save on blur
  input.addEventListener('input', (e) => {
    let v = String(e.target.value || '').toUpperCase();
    // Keep only last A-Z character
    const m = v.match(/[A-Z]/g);
    v = m ? m[m.length - 1] : '';
    e.target.value = v;
  });

  input.addEventListener('blur', async (e) => {
    const v = String(e.target.value || '').toUpperCase();
    if (!v || !/^[A-Z]$/.test(v)) {
      // Revert to current from main
      try {
        const res = await ipcRenderer.invoke('hotkey:get');
        if (res && res.success) {
          input.value = res.suffix || 'D';
        }
      } catch (_) {}
      return;
    }
    try {
      const res = await ipcRenderer.invoke('hotkey:set', { suffix: v });
      if (res && res.success) {
        input.value = res.suffix || v;
        logAnalyticsEvent('hotkey_updated', { suffix: res.suffix });
      }
    } catch (error) {
      console.error('Failed to set hotkey:', error);
    }
  });
}

// Set up app exclusions listeners
function setupAppExclusionsListeners() {
  const exclusionsList = document.getElementById('appExclusionsList');
  const addBtn = document.getElementById('addAppExclusionBtn');
  const testBtn = document.getElementById('testAppExclusions');
  const testResult = document.getElementById('appExclusionsTestResult');
  const testIcon = document.getElementById('appExclusionsTestIcon');
  const testMessage = document.getElementById('appExclusionsTestMessage');
  const testScreenshots = document.getElementById('appExclusionsTestScreenshots');
  let testResultHideTimer = null;
  
  if (!exclusionsList || !addBtn) return;
  
  let exclusions = [];
  
  // Load exclusions on mount
  (async () => {
    try {
      const result = await ipcRenderer.invoke('get-app-exclusions');
      if (result && result.success) {
        // Migrate old format (titlePattern) to new format (titlePatterns)
        exclusions = (result.exclusions || []).map(exclusion => {
          if (exclusion.titlePattern && !exclusion.titlePatterns) {
            exclusion.titlePatterns = [exclusion.titlePattern];
            delete exclusion.titlePattern;
          } else if (!exclusion.titlePatterns) {
            exclusion.titlePatterns = [];
          }
          // Ensure ignoreActivity field exists (default to false for backward compatibility)
          if (exclusion.ignoreActivity === undefined) {
            exclusion.ignoreActivity = false;
          }
          return exclusion;
        });
        renderExclusionsList();
      }
    } catch (error) {
      console.error('Error loading app exclusions:', error);
    }
  })();
  
  // Render exclusions list
  function renderExclusionsList() {
    exclusionsList.innerHTML = '';
    exclusions.forEach((exclusion, index) => {
      const entry = document.createElement('div');
      entry.className = 'space-y-3 p-4 border border-gray-200 rounded-lg bg-white mb-3';
      
      const appNameRow = document.createElement('div');
      appNameRow.className = '';
      const appNameLabel = document.createElement('label');
      appNameLabel.className = 'block text-sm font-medium text-gray-700 mb-1';
      appNameLabel.textContent = 'App name';
      
      // Container for input and remove button
      const appNameInputContainer = document.createElement('div');
      appNameInputContainer.className = 'relative';
      
      const appNameInput = document.createElement('input');
      appNameInput.type = 'text';
      appNameInput.className = 'form-input text-xs py-1.5 pr-8';
      appNameInput.placeholder = 'e.g., Slack, Chrome, Candy Crush';
      appNameInput.value = exclusion.appName || '';
      appNameInput.dataset.index = index;
      appNameInput.dataset.field = 'appName';
      
      // Remove button (x) on the right
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 w-4 h-4 flex items-center justify-center text-sm';
      removeBtn.dataset.index = index;
      removeBtn.innerHTML = '×';
      removeBtn.title = 'Remove exclusion';
      
      appNameInputContainer.appendChild(appNameInput);
      appNameInputContainer.appendChild(removeBtn);
      appNameRow.appendChild(appNameLabel);
      appNameRow.appendChild(appNameInputContainer);
      
      const titlePatternRow = document.createElement('div');
      titlePatternRow.className = '';
      const titlePatternLabel = document.createElement('label');
      titlePatternLabel.className = 'block text-sm font-medium text-gray-700 mb-1';
      titlePatternLabel.textContent = 'Window name keywords (optional)';
      
      // Convert old format (single string) to new format (array)
      let titlePatterns = exclusion.titlePatterns || [];
      if (exclusion.titlePattern && !titlePatterns.length) {
        titlePatterns = [exclusion.titlePattern];
      }
      if (!Array.isArray(titlePatterns)) {
        titlePatterns = [];
      }
      
      // Container for chips and input
      const titlePatternContainer = document.createElement('div');
      titlePatternContainer.className = 'flex flex-wrap gap-2 p-1.5 border border-gray-300 rounded min-h-[32px] items-center';
      titlePatternContainer.dataset.index = index;
      
      // Render chips
      const renderChips = () => {
        // Clear existing chips (but keep input)
        const existingChips = titlePatternContainer.querySelectorAll('.title-pattern-chip');
        existingChips.forEach(chip => chip.remove());
        
        // Add chips
        titlePatterns.forEach((pattern, patternIndex) => {
          if (!pattern || !pattern.trim()) return;
          
          const chip = document.createElement('div');
          chip.className = 'title-pattern-chip inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 rounded text-sm';
          
          const chipText = document.createElement('span');
          chipText.textContent = pattern;
          
          const chipRemove = document.createElement('button');
          chipRemove.type = 'button';
          chipRemove.className = 'text-gray-500 hover:text-gray-700 ml-1';
          chipRemove.innerHTML = '×';
          chipRemove.addEventListener('click', () => {
            // Find the current index of this pattern (in case array changed)
            const currentIndex = titlePatterns.indexOf(pattern);
            if (currentIndex !== -1) {
              titlePatterns.splice(currentIndex, 1);
              exclusions[index].titlePatterns = titlePatterns.filter(p => p && p.trim());
              renderChips();
              saveExclusions();
            }
          });
          
          chip.appendChild(chipText);
          chip.appendChild(chipRemove);
          titlePatternContainer.insertBefore(chip, titlePatternInput);
        });
      };
      
      // Input for adding new patterns
      const titlePatternInput = document.createElement('input');
      titlePatternInput.type = 'text';
      titlePatternInput.className = 'flex-1 min-w-[120px] border-0 outline-none bg-transparent text-xs';
      titlePatternInput.placeholder = titlePatterns.length === 0 ? 'e.g. budget, John, incognito' : 'Add another keyword...';
      titlePatternInput.dataset.index = index;
      
      titlePatternInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && titlePatternInput.value.trim()) {
          e.preventDefault();
          const newPattern = titlePatternInput.value.trim();
          if (!titlePatterns.includes(newPattern)) {
            titlePatterns.push(newPattern);
            exclusions[index].titlePatterns = titlePatterns;
            titlePatternInput.value = '';
            renderChips();
            await saveExclusions();
          }
        }
      });
      
      titlePatternInput.addEventListener('blur', async () => {
        // Also add on blur if there's a value
        if (titlePatternInput.value.trim() && !titlePatterns.includes(titlePatternInput.value.trim())) {
          titlePatterns.push(titlePatternInput.value.trim());
          exclusions[index].titlePatterns = titlePatterns;
          titlePatternInput.value = '';
          renderChips();
          await saveExclusions();
        }
      });
      
      titlePatternContainer.appendChild(titlePatternInput);
      titlePatternRow.appendChild(titlePatternLabel);
      titlePatternRow.appendChild(titlePatternContainer);
      
      // Initial render of chips
      renderChips();
      
      // Ignore activity toggle row
      const ignoreActivityRow = document.createElement('div');
      ignoreActivityRow.className = 'flex items-center justify-between';
      const ignoreActivityLabel = document.createElement('label');
      ignoreActivityLabel.className = 'block text-sm font-medium text-gray-700';
      ignoreActivityLabel.textContent = 'Ignore activity';
      const ignoreActivityToggle = document.createElement('label');
      ignoreActivityToggle.className = 'toggle';
      const ignoreActivityCheckbox = document.createElement('input');
      ignoreActivityCheckbox.type = 'checkbox';
      ignoreActivityCheckbox.checked = exclusion.ignoreActivity === true;
      ignoreActivityCheckbox.dataset.index = index;
      ignoreActivityToggle.appendChild(ignoreActivityCheckbox);
      const toggleSlider = document.createElement('span');
      toggleSlider.className = 'slider';
      ignoreActivityToggle.appendChild(toggleSlider);
      
      ignoreActivityCheckbox.addEventListener('change', async () => {
        const idx = parseInt(ignoreActivityCheckbox.dataset.index);
        if (exclusions[idx]) {
          exclusions[idx].ignoreActivity = ignoreActivityCheckbox.checked;
          await saveExclusions();
        }
      });
      
      ignoreActivityRow.appendChild(ignoreActivityLabel);
      ignoreActivityRow.appendChild(ignoreActivityToggle);
      
      entry.appendChild(appNameRow);
      entry.appendChild(titlePatternRow);
      entry.appendChild(ignoreActivityRow);
      exclusionsList.appendChild(entry);
    });
    
    // Add event listeners for app name inputs only (title patterns handled separately)
    exclusionsList.querySelectorAll('input[data-field="appName"]').forEach(input => {
      input.addEventListener('blur', async () => {
        const index = parseInt(input.dataset.index);
        if (exclusions[index]) {
          exclusions[index].appName = input.value.trim() || null;
          if (!exclusions[index].appName) {
            // Remove if app name is empty
            exclusions.splice(index, 1);
            renderExclusionsList();
          } else {
            await saveExclusions();
          }
        }
      });
    });
    
    // Add event listeners for remove buttons (x buttons in app name inputs)
    exclusionsList.querySelectorAll('button[data-index]').forEach(btn => {
      if (btn.textContent === '×') {
        btn.addEventListener('click', async () => {
          const index = parseInt(btn.dataset.index);
          exclusions.splice(index, 1);
          renderExclusionsList();
          await saveExclusions();
        });
      }
    });
  }
  
  // Save exclusions
  async function saveExclusions() {
    try {
      const result = await ipcRenderer.invoke('save-app-exclusions', exclusions);
      if (!result || !result.success) {
        console.error('Error saving app exclusions:', result?.error);
        showBanner(`Error saving exclusions: ${result?.error || 'Unknown error'}`, { title: 'Settings', sticky: true });
      }
    } catch (error) {
      console.error('Error saving app exclusions:', error);
      showBanner(`Error saving exclusions: ${error.message}`, { title: 'Settings', sticky: true });
    }
  }
  
  // Add new exclusion
  addBtn.addEventListener('click', () => {
    exclusions.push({ appName: '', titlePatterns: [], ignoreActivity: false });
    renderExclusionsList();
    // Focus the new app name input
    const newInput = exclusionsList.querySelector(`input[data-index="${exclusions.length - 1}"][data-field="appName"]`);
    if (newInput) {
      newInput.focus();
    }
  });
  
  // Test button
  if (testBtn && testResult && testIcon && testMessage && testScreenshots) {
    testBtn.addEventListener('click', async () => {
      try {
        testBtn.disabled = true;
        testBtn.textContent = 'Testing...';
        testResult.classList.add('hidden');
        testScreenshots.innerHTML = '';
        if (testResultHideTimer) { 
          clearTimeout(testResultHideTimer); 
          testResultHideTimer = null; 
        }
        
        const result = await ipcRenderer.invoke('test-app-exclusions');
        const success = result && result.success;
        
        // Update test result display
        testIcon.innerHTML = success
          ? '<svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>'
          : '<svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
        
        testResult.classList.remove('border-gray-300', 'border-green-200', 'border-red-200');
        testResult.classList.add(success ? 'border-green-200' : 'border-red-200');
        
        testMessage.textContent = result?.message || (success ? 'Test successful' : 'Test failed');
        
        // Display screenshot thumbnails if available
        if (success && result.screenshots && result.screenshots.length > 0) {
          result.screenshots.forEach((screenshot, index) => {
            const img = document.createElement('img');
            img.src = screenshot;
            img.className = 'max-w-[200px] max-h-[150px] border border-gray-300 rounded';
            img.alt = `Screenshot ${index + 1}`;
            testScreenshots.appendChild(img);
          });
        }
        
        testResult.classList.remove('hidden');
        // Auto-hide after 30 seconds (longer for screenshots)
        testResultHideTimer = setTimeout(() => {
          try { testResult.classList.add('hidden'); } catch (_) {}
          testResultHideTimer = null;
        }, 30000);
        
      } catch (error) {
        console.error('Error testing app exclusions:', error);
        
        testIcon.innerHTML = '<svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
        testResult.classList.remove('border-gray-300', 'border-green-200', 'border-red-200');
        testResult.classList.add('border-red-200');
        testMessage.textContent = `Error: ${error.message}`;
        testResult.classList.remove('hidden');
        // Auto-hide after 10 seconds
        testResultHideTimer = setTimeout(() => {
          try { testResult.classList.add('hidden'); } catch (_) {}
          testResultHideTimer = null;
        }, 10000);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Test';
      }
    });
  }
}

// Set up context capture (experimental) listeners
function setupContextCaptureListeners() {
  const enabledCheckbox = document.getElementById('contextCaptureEnabled');
  const appsSection = document.getElementById('contextAppsSection');
  const appsList = document.getElementById('contextAppsList');
  const addBtn = document.getElementById('addContextAppBtn');

  if (!enabledCheckbox || !appsSection || !appsList || !addBtn) return;

  let contextApps = [];

  async function loadContextCaptureState() {
    try {
      const enabledResult = await ipcRenderer.invoke('get-context-capture-enabled');
      const appsResult = await ipcRenderer.invoke('get-context-apps');
      if (enabledResult?.success) {
        enabledCheckbox.checked = !!enabledResult.enabled;
      }
      if (appsResult?.success && Array.isArray(appsResult.apps)) {
        contextApps = appsResult.apps.map((app) => ({
          appName: app.appName || '',
          titlePatterns: app.titlePatterns || []
        }));
      }
      appsSection.classList.toggle('hidden', !enabledCheckbox.checked);
      renderContextAppsList();
    } catch (error) {
      console.error('Error loading context capture state:', error);
    }
  }

  function renderContextAppsList() {
    appsList.innerHTML = '';
    contextApps.forEach((app, index) => {
      const entry = document.createElement('div');
      entry.className = 'space-y-3 p-4 border border-gray-200 rounded-lg bg-white mb-3';

      const appNameRow = document.createElement('div');
      const appNameLabel = document.createElement('label');
      appNameLabel.className = 'block text-sm font-medium text-gray-700 mb-1';
      appNameLabel.textContent = 'App name';
      const appNameInputContainer = document.createElement('div');
      appNameInputContainer.className = 'relative';
      const appNameInput = document.createElement('input');
      appNameInput.type = 'text';
      appNameInput.className = 'form-input text-xs py-1.5 pr-8';
      appNameInput.placeholder = 'e.g., Notion, Google Chrome, Calendar';
      appNameInput.value = app.appName || '';
      appNameInput.dataset.index = index;
      appNameInput.dataset.field = 'appName';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 w-4 h-4 flex items-center justify-center text-sm';
      removeBtn.dataset.index = index;
      removeBtn.innerHTML = '×';
      removeBtn.title = 'Remove';
      appNameInputContainer.appendChild(appNameInput);
      appNameInputContainer.appendChild(removeBtn);
      appNameRow.appendChild(appNameLabel);
      appNameRow.appendChild(appNameInputContainer);

      const titlePatternRow = document.createElement('div');
      const titlePatternLabel = document.createElement('label');
      titlePatternLabel.className = 'block text-sm font-medium text-gray-700 mb-1';
      titlePatternLabel.textContent = 'Window name keywords (optional)';
      let titlePatterns = app.titlePatterns || [];
      if (!Array.isArray(titlePatterns)) titlePatterns = [];
      const titlePatternContainer = document.createElement('div');
      titlePatternContainer.className = 'flex flex-wrap gap-2 p-1.5 border border-gray-300 rounded min-h-[32px] items-center';
      titlePatternContainer.dataset.index = index;

      const renderChips = () => {
        titlePatternContainer.querySelectorAll('.context-pattern-chip').forEach((c) => c.remove());
        titlePatterns.forEach((pattern) => {
          if (!pattern || !pattern.trim()) return;
          const chip = document.createElement('div');
          chip.className = 'context-pattern-chip inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 rounded text-sm';
          chip.innerHTML = `<span>${pattern}</span><button type="button" class="text-gray-500 hover:text-gray-700 ml-1 chip-remove">×</button>`;
          chip.querySelector('.chip-remove').addEventListener('click', () => {
            const i = titlePatterns.indexOf(pattern);
            if (i !== -1) {
              titlePatterns.splice(i, 1);
              contextApps[index].titlePatterns = titlePatterns.filter((p) => p && p.trim());
              renderChips();
              saveContextApps();
            }
          });
          titlePatternContainer.insertBefore(chip, titlePatternInput);
        });
      };
      const titlePatternInput = document.createElement('input');
      titlePatternInput.type = 'text';
      titlePatternInput.className = 'flex-1 min-w-[120px] border-0 outline-none bg-transparent text-xs';
      titlePatternInput.placeholder = titlePatterns.length === 0 ? 'e.g. todos, projects' : 'Add another...';
      titlePatternInput.dataset.index = index;
      titlePatternInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && titlePatternInput.value.trim()) {
          e.preventDefault();
          const newPattern = titlePatternInput.value.trim();
          if (!titlePatterns.includes(newPattern)) {
            titlePatterns.push(newPattern);
            contextApps[index].titlePatterns = titlePatterns;
            titlePatternInput.value = '';
            renderChips();
            await saveContextApps();
          }
        }
      });
      titlePatternInput.addEventListener('blur', async () => {
        if (titlePatternInput.value.trim() && !titlePatterns.includes(titlePatternInput.value.trim())) {
          titlePatterns.push(titlePatternInput.value.trim());
          contextApps[index].titlePatterns = titlePatterns;
          titlePatternInput.value = '';
          renderChips();
          await saveContextApps();
        }
      });
      titlePatternContainer.appendChild(titlePatternInput);
      renderChips();
      titlePatternRow.appendChild(titlePatternLabel);
      titlePatternRow.appendChild(titlePatternContainer);

      entry.appendChild(appNameRow);
      entry.appendChild(titlePatternRow);
      appsList.appendChild(entry);
    });

    appsList.querySelectorAll('input[data-field="appName"]').forEach((input) => {
      input.addEventListener('blur', async () => {
        const index = parseInt(input.dataset.index);
        if (contextApps[index]) {
          contextApps[index].appName = input.value.trim() || '';
          if (!contextApps[index].appName) {
            contextApps.splice(index, 1);
            renderContextAppsList();
          } else {
            await saveContextApps();
          }
        }
      });
    });
    appsList.querySelectorAll('button[data-index]').forEach((btn) => {
      if (btn.textContent === '×') {
        btn.addEventListener('click', async () => {
          const index = parseInt(btn.dataset.index);
          contextApps.splice(index, 1);
          renderContextAppsList();
          await saveContextApps();
        });
      }
    });
  }

  async function saveContextApps() {
    try {
      const result = await ipcRenderer.invoke('save-context-apps', contextApps);
      if (!result?.success) {
        showBanner(`Error saving context apps: ${result?.error || 'Unknown error'}`, { title: 'Settings', sticky: true });
      }
    } catch (error) {
      console.error('Error saving context apps:', error);
      showBanner(`Error saving context apps: ${error.message}`, { title: 'Settings', sticky: true });
    }
  }

  enabledCheckbox.addEventListener('change', async () => {
    ipcRenderer.send('update-context-capture-enabled', enabledCheckbox.checked);
    appsSection.classList.toggle('hidden', !enabledCheckbox.checked);
  });

  addBtn.addEventListener('click', () => {
    contextApps.push({ appName: '', titlePatterns: [] });
    renderContextAppsList();
    const newInput = appsList.querySelector(`input[data-index="${contextApps.length - 1}"][data-field="appName"]`);
    if (newInput) newInput.focus();
  });

  loadContextCaptureState();
}

// Set up Wayland detection and show note if on Wayland
function setupWaylandDetection() {
  // Only check on Linux
  if (window.electronAPI.platform !== 'linux') return;
  
  const waylandNote = document.getElementById('waylandNote');
  if (!waylandNote) return;
  
  // Check for Wayland via environment variables (standard detection methods)
  // WAYLAND_DISPLAY is set when running on Wayland
  // XDG_SESSION_TYPE is also commonly set to 'wayland' on Wayland sessions
  const isWayland = window.electronAPI.isWayland;
  
  if (isWayland) {
    waylandNote.classList.remove('hidden');
  } else {
    waylandNote.classList.add('hidden');
  }
}

// Set up save capture data to folder toggle and path (same pattern as other main-process settings)
function setupSaveCaptureDataListeners() {
  const checkbox = document.getElementById('saveCaptureDataCheckbox');
  const pathSection = document.getElementById('saveCaptureDataPathSection');
  const pathInput = document.getElementById('saveCaptureDataPathInput');

  if (!checkbox || !pathSection || !pathInput) return;

  ipcRenderer.invoke('get-save-capture-data').then(({ enabled, path }) => {
    checkbox.checked = !!enabled;
    pathSection.classList.toggle('hidden', !enabled);
    pathInput.value = path || 'Browse';
  }).catch((e) => console.error('Error loading save capture data:', e));

  checkbox.addEventListener('change', () => {
    pathSection.classList.toggle('hidden', !checkbox.checked);
    ipcRenderer.send('updateSaveCaptureData', checkbox.checked);
  });

  pathInput.addEventListener('click', async () => {
    try {
      const selected = await ipcRenderer.invoke('choose-capture-dump-folder');
      if (selected) {
        pathInput.value = selected;
        ipcRenderer.send('updateSaveCaptureDataPath', selected);
      }
    } catch (e) {
      console.error('Error choosing capture dump folder:', e);
    }
  });
}

// Set up test local processing button
function setupTestLocalProcessing() {
  const testBtn = document.getElementById('testLocalProcessing');
  const testResult = document.getElementById('localProcessingTestResult');
  const testIcon = document.getElementById('localProcessingTestIcon');
  const testMessage = document.getElementById('localProcessingTestMessage');
  let testResultHideTimer = null;

  if (!testBtn || !testResult || !testIcon || !testMessage) return;

  testBtn.addEventListener('click', async () => {
    // Prevent multiple simultaneous tests
    if (testBtn.disabled) return;
    
    try {
      // Disable button and update text
      testBtn.disabled = true;
      testBtn.setAttribute('disabled', 'disabled');
      testBtn.textContent = 'Testing...';
      testResult.classList.add('hidden');
      if (testResultHideTimer) { clearTimeout(testResultHideTimer); testResultHideTimer = null; }

      const result = await ipcRenderer.invoke('test-local-processing');
      const success = result && result.success;

      // Update test result display
      testIcon.innerHTML = success
        ? '<svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>'
        : '<svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';

      testResult.classList.remove('border-gray-300', 'border-green-200', 'border-red-200');
      testResult.classList.add(success ? 'border-green-200' : 'border-red-200');

      testMessage.textContent = result?.message || (success ? 'Success' : 'Failed');
      testResult.classList.remove('hidden');
      // Auto-hide after 10 seconds
      testResultHideTimer = setTimeout(() => {
        try { testResult.classList.add('hidden'); } catch (_) {}
        testResultHideTimer = null;
      }, 10000);

    } catch (error) {
      console.error('Error testing local processing:', error);

      testIcon.innerHTML = '<svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
      testResult.classList.remove('border-gray-300', 'border-green-200', 'border-red-200');
      testResult.classList.add('border-red-200');
      testMessage.textContent = `Error: ${error.message || 'Unknown error occurred'}`;
      testResult.classList.remove('hidden');
      // Auto-hide after 10 seconds
      testResultHideTimer = setTimeout(() => {
        try { testResult.classList.add('hidden'); } catch (_) {}
        testResultHideTimer = null;
      }, 10000);
    } finally {
      // Always reset button state after test completes
      testBtn.disabled = false;
      testBtn.removeAttribute('disabled');
      testBtn.textContent = 'Test';
    }
  });
}