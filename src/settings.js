const { initializeApp } = require("firebase/app");
const { getFirestore, doc, onSnapshot } = require("@firebase/firestore");
const { getAuth } = require("firebase/auth");
const { getFunctions, httpsCallable } = require("firebase/functions");
const firebaseConfig = require("../firebase-config.js");
const { logAnalyticsEvent } = require('./analytics.js');
const { ipcRenderer } = require("electron");
const { updateIsPublic } = require('./app-state.js');
const { requestAudioPermission, requestKeystrokesPermission, requestWindowsPermission } = require('./permissions.js');
const { refreshAuthToken } = require('./auth.js');
const os = require('os');
const packageInfo = require('../package.json');
const { showErrorModal } = require('./modal.js');

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
  // Setup workday click handler
  setupWorkdayClickHandler();
  // Set up event listeners for new checkboxes
  setupInputDataCheckboxListeners();
  // Set up permission result listener
  setupPermissionResultListener();
  // Set up listener for disable-capture-features message
  setupDisableCaptureListener();
  // Set up work hours change listeners
  setupWorkhoursChangeListeners();
}

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
    } else if (type === 'workdays') {
      settingsData.workdays = value;
      workdays = value; // Update local state immediately
      logAnalyticsEvent('settings_updated', {
        type: 'workdays',
        days: value.join(',') // Log the selected days
      });
    } else if (type === 'workhours') {
      settingsData.workhours = value;
      workhours = value; // Update local state
      logAnalyticsEvent('settings_updated', {
        type: 'workhours',
        start: value.start,
        end: value.end
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

    // If save was successful, *now* send the update to main process for workdays
    if (type === 'workdays') {
      ipcRenderer.send('updateWorkdays', value);
    }

    // Send workhours to main process if needed
    if (type === 'workhours') {
      ipcRenderer.send('updateWorkhours', value);
    }

  } catch (error) {
    logAnalyticsEvent('settings_update_error', {
      type: type,
      error_code: error.code,
      error_message: error.message
    });
    console.error("Error saving settings:", error);
    showErrorModal(`Error saving settings: ${error.message}`);
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

  const windowsCheckbox = document.getElementById('windowsCheckbox'); // Updated ID
  const keystrokesCheckbox = document.getElementById('keystrokesCheckbox');
  const audioCheckbox = document.getElementById('audioCheckbox');

  if (windowsCheckbox) windowsCheckbox.checked = inputData.windows; // Use windows key
  if (keystrokesCheckbox) keystrokesCheckbox.checked = inputData.keystrokes;
  if (audioCheckbox) audioCheckbox.checked = inputData.audio; // Keep disabled state from HTML

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
  
  // Update workhours inputs
  const workhoursStartInput = document.getElementById('workhoursStart');
  const workhoursEndInput = document.getElementById('workhoursEnd');
  if (workhoursStartInput) workhoursStartInput.value = workhours.start;
  if (workhoursEndInput) workhoursEndInput.value = workhours.end;
  
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

  // Render the selectors
  renderWorkdaySelectors();

  // Send initial workdays to main process
  ipcRenderer.send('updateWorkdays', workdays);

  // Handle isPublic setting
  if (typeof settings?.isPublic === 'boolean') {
    updateIsPublic(settings.isPublic);
  }
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
      // Revert checkbox state immediately - will be re-enabled by permission listener if granted
      checkbox.checked = false;
      // If turning ON, only request permission and wait for the result
      // The permissionResult event listener will handle enabling if granted
      permissionFunction();
      

    } else {
      // If turning OFF, update setting immediately - no permission needed
      inputData[fieldName] = false;
      
      try {
        await saveUserSettings('inputData', inputData);
        
        // Send updated input data to main process
        ipcRenderer.send('updateInputDataSettings', inputData);
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

// Set up listeners for workhours inputs
function setupWorkhoursChangeListeners() {
  const workhoursStartInput = document.getElementById('workhoursStart');
  const workhoursEndInput = document.getElementById('workhoursEnd');
  
  if (workhoursStartInput) {
    workhoursStartInput.addEventListener('blur', async (e) => {
      const newStart = e.target.value;
      const originalStart = workhours.start;
      
      // Only proceed if value has changed
      if (newStart === originalStart) return;
      
      try {
        // Update local state
        workhours = { ...workhours, start: newStart };
        
        // Save to server
        await saveUserSettings('workhours', workhours);
      } catch (error) {
        // Revert on error
        workhours.start = originalStart;
        e.target.value = originalStart;
      }
    });
  }
  
  if (workhoursEndInput) {
    workhoursEndInput.addEventListener('blur', async (e) => {
      const newEnd = e.target.value;
      const originalEnd = workhours.end;
      
      // Only proceed if value has changed
      if (newEnd === originalEnd) return;
      
      try {
        // Update local state
        workhours = { ...workhours, end: newEnd };
        
        // Save to server
        await saveUserSettings('workhours', workhours);
      } catch (error) {
        // Revert on error
        workhours.end = originalEnd;
        e.target.value = originalEnd;
      }
    });
  }
}

module.exports = {
  initializeSettings,
  loadUserSettings,
  saveUserSettings
};