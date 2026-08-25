const { getFirestore, doc, onSnapshot } = require("@firebase/firestore");
const { getAuth } = require("firebase/auth");
const { httpsCallable } = require("firebase/functions");
const { firebaseApp, functions } = require("./firebase.js");
const { logAnalyticsEvent } = require('./analytics.js');
const {
  hasWindowsPermission,
  hasScreenCapturePermission,
  isCaptureReadinessReady,
  updateSettingsReady
} = require('./app-state.js');
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
  windows: true,
  audio: false,
  systemAudio: false,
  screen: true,
  location: false
};
let inputDataManagedLocks = {
  windows: false,
  audio: false,
  systemAudio: false,
  screen: false,
  location: false
};
// Server-driven rollout, reported by getUserSettings. Until it says otherwise
// the card stays hidden and main never scans.
let locationFeatureEnabled = false;
let managedAppSettings = null;
let lastManagedSettingsSignature = null;
let lastManualPauseAllowed = true;
const LOCKED_TOOLTIP = 'Managed by your organization';
const MASKED_SECRET = '************************';
const MANAGED_LIST_MODE_FIXED = 'fixed';
const MANAGED_LIST_MODE_MINIMUM = 'minimum';
const MANAGED_INPUT_ENABLED = 'enabled';
const MANAGED_INPUT_OPTIONAL = 'optional';
const MANAGED_INPUT_DISABLED = 'disabled';
const DEFAULT_CAPTURE_INTERVAL_MINUTES = 5;
const ALLOWED_CAPTURE_INTERVAL_MINUTES = [1, 2, 3, 5, 6];
const llmManagedLocks = {
  gemini: false,
  openAICompatible: false
};
let applySaveCaptureManagedConfig = null;
let waylandWindowsPersistInFlight = false;

function isWaylandLinuxSession() {
  return window.electronAPI.platform === 'linux' && !!window.electronAPI.isWayland;
}

function isWaylandWindowsForcedOff() {
  return isWaylandLinuxSession();
}

function isManagedValue(value) {
  return value !== null && value !== undefined;
}

function normalizeBoolOrNull(value) {
  if (!isManagedValue(value)) return null;
  return !!value;
}

function normalizeManagedInputState(value) {
  if (!isManagedValue(value)) return null;
  if (value === MANAGED_INPUT_ENABLED || value === MANAGED_INPUT_OPTIONAL || value === MANAGED_INPUT_DISABLED) {
    return value;
  }
  if (value === true) return MANAGED_INPUT_ENABLED;
  if (value === false) return MANAGED_INPUT_DISABLED;
  return null;
}

function isManagedInputStateForced(value) {
  return value === MANAGED_INPUT_ENABLED || value === MANAGED_INPUT_DISABLED;
}

function resolveInputDataValue(managedState, storedValue, fallbackValue) {
  if (managedState === MANAGED_INPUT_ENABLED) return true;
  if (managedState === MANAGED_INPUT_DISABLED) return false;
  return storedValue != null ? !!storedValue : fallbackValue;
}

function normalizeCaptureIntervalMinutes(value) {
  return ALLOWED_CAPTURE_INTERVAL_MINUTES.includes(value)
    ? value
    : DEFAULT_CAPTURE_INTERVAL_MINUTES;
}

function normalizeManagedListMode(value, fallback = MANAGED_LIST_MODE_FIXED) {
  if (value === MANAGED_LIST_MODE_MINIMUM) return MANAGED_LIST_MODE_MINIMUM;
  if (value === MANAGED_LIST_MODE_FIXED) return MANAGED_LIST_MODE_FIXED;
  return fallback;
}

function normalizeTitlePatterns(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((pattern) => typeof pattern === 'string')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

function normalizeAppExclusions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const appName = typeof item.appName === 'string' ? item.appName.trim() : '';
      if (!appName) return null;
      return {
        appName,
        titlePatterns: normalizeTitlePatterns(item.titlePatterns),
        ignoreActivity: !!item.ignoreActivity
      };
    })
    .filter(Boolean);
}

function normalizeManagedAppExclusionsConfig(value) {
  if (!isManagedValue(value)) return null;
  if (Array.isArray(value)) {
    return {
      mode: MANAGED_LIST_MODE_FIXED,
      entries: normalizeAppExclusions(value)
    };
  }
  if (!value || typeof value !== 'object') return null;
  const hasExplicitConfig =
    isManagedValue(value.mode) ||
    isManagedValue(value.entries) ||
    isManagedValue(value.list) ||
    isManagedValue(value.apps);
  if (!hasExplicitConfig) return null;

  const entries = normalizeAppExclusions(
    value.entries ?? value.list ?? value.apps ?? []
  );
  return {
    mode: normalizeManagedListMode(value.mode, MANAGED_LIST_MODE_FIXED),
    entries
  };
}

function normalizeManagedSaveCaptureDataConfig(value) {
  if (!isManagedValue(value) || !value || typeof value !== 'object') return null;
  const hasExplicitConfig = isManagedValue(value.enabled) || isManagedValue(value.path);
  if (!hasExplicitConfig) return null;

  return {
    enabled: normalizeBoolOrNull(value.enabled),
    path: typeof value.path === 'string' ? value.path.trim() : null
  };
}

function normalizeManagedGeminiConfig(value) {
  if (!isManagedValue(value) || !value || typeof value !== 'object') return null;
  const hasExplicitConfig = isManagedValue(value.enabled) || isManagedValue(value.apiKey);
  if (!hasExplicitConfig) return null;

  return {
    enabled: normalizeBoolOrNull(value.enabled),
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : null
  };
}

function normalizeManagedOpenAICompatibleConfig(value) {
  if (!isManagedValue(value) || !value || typeof value !== 'object') return null;
  const hasExplicitConfig =
    isManagedValue(value.enabled) || isManagedValue(value.endpoint) || isManagedValue(value.model) || isManagedValue(value.apiKey);
  if (!hasExplicitConfig) return null;

  return {
    enabled: normalizeBoolOrNull(value.enabled),
    endpoint: typeof value.endpoint === 'string' ? value.endpoint.trim() : null,
    model: typeof value.model === 'string' ? value.model.trim() : null,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : null
  };
}

function normalizeAppSettings(raw) {
  const recordingRaw = raw?.recording;
  const captureRaw = raw?.capture;
  const localRaw = raw?.localProcessing;

  const appExclusions = normalizeManagedAppExclusionsConfig(captureRaw?.appExclusions);
  const saveCaptureData = normalizeManagedSaveCaptureDataConfig(captureRaw?.saveCaptureData);
  const gemini = normalizeManagedGeminiConfig(localRaw?.gemini);
  const openAICompatible = normalizeManagedOpenAICompatibleConfig(localRaw?.openAICompatible);

  return {
    recording: {
      manualPauseEnabled: normalizeBoolOrNull(recordingRaw?.manualPauseEnabled)
    },
    capture: {
      inputData: {
        windows: normalizeManagedInputState(captureRaw?.inputData?.windows),
        audio: normalizeManagedInputState(captureRaw?.inputData?.audio),
        systemAudio: normalizeManagedInputState(captureRaw?.inputData?.systemAudio),
        screen: normalizeManagedInputState(captureRaw?.inputData?.screen),
        location: normalizeManagedInputState(captureRaw?.inputData?.location)
      },
      appExclusions,
      saveCaptureData
    },
    localProcessing: {
      gemini,
      openAICompatible
    }
  };
}

function setManagedCardLock(elementOrId, locked, tooltip = LOCKED_TOOLTIP) {
  const element = typeof elementOrId === 'string'
    ? document.getElementById(elementOrId)
    : elementOrId;
  if (!element) return;
  element.classList.toggle('managed-locked-card', !!locked);
  if (locked) {
    element.title = tooltip;
  } else {
    element.removeAttribute('title');
  }
}

function setManagedRowLock(checkbox, locked, tooltip = LOCKED_TOOLTIP) {
  if (!checkbox) return;
  const row = checkbox.closest('.flex.items-center.justify-between');
  if (row) {
    row.classList.toggle('managed-locked-row', !!locked);
    if (locked) {
      row.title = tooltip;
    } else {
      row.removeAttribute('title');
    }
  }
}

function applyManualPausePolicy(manualPauseEnabled) {
  const isAllowed = manualPauseEnabled !== false;
  try {
    document.body.dataset.manualPauseAllowed = isAllowed ? 'true' : 'false';
  } catch (_) {}
  if (lastManualPauseAllowed !== isAllowed) {
    lastManualPauseAllowed = isAllowed;
    document.dispatchEvent(new CustomEvent('manual-pause-policy-updated', {
      detail: { isAllowed }
    }));
  }
}

function pushManagedSettingsToMain() {
  if (!managedAppSettings) return;
  let signature = '';
  try {
    signature = JSON.stringify(managedAppSettings);
  } catch (_) {
    return;
  }
  if (signature === lastManagedSettingsSignature) return;
  lastManagedSettingsSignature = signature;
  ipcRenderer.send('apply-managed-app-settings', managedAppSettings);
}

function applyInputDataManagedLockUI() {
  const audioCheckbox = document.getElementById('audioCheckbox');
  const systemAudioCheckbox = document.getElementById('systemAudioCheckbox');
  const screenCheckbox = document.getElementById('screenCheckbox');
  const windowsCheckbox = document.getElementById('windowsCheckbox');

  if (screenCheckbox) {
    screenCheckbox.disabled = !!inputDataManagedLocks.screen;
    setManagedRowLock(screenCheckbox, !!inputDataManagedLocks.screen);
  }
  if (windowsCheckbox) {
    windowsCheckbox.disabled = !!inputDataManagedLocks.windows || isWaylandWindowsForcedOff();
    setManagedRowLock(windowsCheckbox, !!inputDataManagedLocks.windows);
  }
  if (audioCheckbox) {
    audioCheckbox.disabled = !!inputDataManagedLocks.audio;
    setManagedRowLock(audioCheckbox, !!inputDataManagedLocks.audio);
  }
  if (systemAudioCheckbox) {
    const micOn = !!(audioCheckbox && audioCheckbox.checked) || !!inputData.audio;
    const shouldLock = !!inputDataManagedLocks.systemAudio;
    systemAudioCheckbox.disabled = shouldLock || !micOn;
    setManagedRowLock(systemAudioCheckbox, shouldLock);
  }

  const locationCheckbox = document.getElementById('locationCheckbox');
  if (locationCheckbox) {
    locationCheckbox.disabled = !!inputDataManagedLocks.location;
    setManagedRowLock(locationCheckbox, !!inputDataManagedLocks.location);
  }
}

/**
 * The whole location card is hidden unless the server says the feature is on.
 * Gating in the client alone would be a Firebase uid compiled into a shipped
 * binary; this way widening the rollout is one server constant.
 */
function applyLocationFeatureVisibility() {
  const card = document.getElementById('locationCard');
  if (card) card.classList.toggle('hidden', !locationFeatureEnabled);
}

function isLocationFeatureEnabled() {
  return locationFeatureEnabled;
}

function emitCaptureStateUpdated() {
  document.dispatchEvent(new CustomEvent('capture-state-updated'));
}

function isScreenEffectivelyEnabled() {
  return !!inputData.screen && !!hasScreenCapturePermission();
}

function isWindowsEffectivelyEnabled() {
  return !!inputData.windows && !!hasWindowsPermission();
}

/**
 * Say why App masking is inert, in place of the dimmed card's tooltip.
 *
 * The panel can be opened on the masking section alone, where a greyed-out card
 * and a tooltip nobody hovers is the whole screen.
 */
function setMaskingDependencyNote(isBlocked, screenEnabled, windowsEnabled) {
  const note = document.getElementById('appMaskingDependencyNote');
  if (!note) return;

  note.classList.toggle('hidden', !isBlocked);
  if (!isBlocked) return;

  const missing = [];
  if (!screenEnabled) missing.push('Screenshare');
  if (!windowsEnabled) missing.push('Active applications');
  note.textContent = `App masking needs ${missing.join(' and ')} turned on with permission granted. Until then these rules are not applied.`;
}

function refreshCaptureDependentVisibility() {
  const audioCard = document.getElementById('microphonePermissionsCard');
  const appMaskingCard = document.getElementById('appMaskingCard');
  const dimClass = ['opacity-50'];

  const setDimmed = (el, isDimmed, tooltip = '') => {
    if (!el) return;
    dimClass.forEach((className) => {
      el.classList.toggle(className, isDimmed);
    });
    el.classList.toggle('capture-dimmed-card', isDimmed);
    if (isDimmed && tooltip) {
      el.title = tooltip;
    } else {
      el.removeAttribute('title');
    }
  };

  if (!isCaptureReadinessReady()) {
    setDimmed(audioCard, false);
    setDimmed(appMaskingCard, false);
    setMaskingDependencyNote(false);
    return;
  }

  const screenEnabled = isScreenEffectivelyEnabled();
  const windowsEnabled = isWindowsEffectivelyEnabled();

  const bothRequiredMsg = 'Both Screenshare and Active applications must be enabled for this feature to work.';
  const maskingBlocked = !screenEnabled || !windowsEnabled;
  setDimmed(audioCard, !screenEnabled && !windowsEnabled);
  setDimmed(appMaskingCard, maskingBlocked, bothRequiredMsg);
  setMaskingDependencyNote(maskingBlocked, screenEnabled, windowsEnabled);
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
  // Keep capture-dependent UI in sync with permission + toggle state changes.
  setupCaptureStateListener();
  // Note: Screen capture toggle behavior and permission issue handling are in permissions.js

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
  setupSaveCaptureDataListeners();
  setupClientTelemetryListeners();

  // Set up Wayland detection
  setupWaylandDetection();
  setupLinuxAutostartListeners();
  
  refreshCaptureDependentVisibility();
}
// Note: Screen capture checkbox behavior is now handled in permissions.js


function setupCaptureStateListener() {
  document.addEventListener('capture-state-updated', () => {
    recomputeSystemAudioDependency();
    refreshCaptureDependentVisibility();
  });
}

async function handleCaptureToggleIntent(type, enabled) {
  if (!type || typeof enabled !== 'boolean') {
    return { success: false, reverted: false };
  }

  if (inputDataManagedLocks[type]) {
    return { success: false, reverted: true, managed: true };
  }

  const nextPartial = { [type]: enabled };
  const previousInputData = { ...inputData };

  inputData[type] = enabled;
  // Meeting audio depends on microphone. Turning microphone off always forces meeting audio off.
  if (type === 'audio' && !enabled && inputData.systemAudio) {
    inputData.systemAudio = false;
    nextPartial.systemAudio = false;
  }

  try {
    await saveUserSettings('inputData', { ...nextPartial, __partial: true });
    ipcRenderer.send('updateInputDataSettings', nextPartial);
    refreshCaptureDependentVisibility();
    emitCaptureStateUpdated();
    return { success: true, reverted: false };
  } catch (error) {
    console.error(`Error saving ${type} toggle state:`, error);
    inputData = previousInputData;
    refreshCaptureDependentVisibility();
    emitCaptureStateUpdated();
    return { success: false, reverted: true };
  }
}

// Helper function to update screenshots container visibility
function updateScreenshotsContainerVisibility(show) {
  // No-op: screenshots/local processing row removed
}

function formatAppVersionLabel(disabled) {
  const version = `v${packageInfo.version}`;
  return disabled ? `${version} · updates paused` : version;
}

// Hidden: 7 clicks on the version label pauses auto-update for 7 days.
function setupVersionClickHandler() {
  const versionElement = document.querySelector('#appVersion');
  if (!versionElement) return;

  try {
    versionElement.textContent = formatAppVersionLabel(false);
    versionElement.classList.add('select-none');
  } catch (error) {
    versionElement.textContent = 'v?.?.?';
    return;
  }

  ipcRenderer.invoke('auto-update:get-disabled').then((state) => {
    if (state?.disabled) versionElement.textContent = formatAppVersionLabel(true);
  }).catch(() => {});

  let clickCount = 0;
  let clickTimer = null;
  versionElement.addEventListener('click', async () => {
    clickCount += 1;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { clickCount = 0; }, 2000);
    if (clickCount < 7) return;
    clickCount = 0;

    try {
      const state = await ipcRenderer.invoke('auto-update:toggle-disabled');
      versionElement.textContent = formatAppVersionLabel(!!state?.disabled);
      if (state?.message) {
        showBanner(state.message, { title: 'DoneThat', id: 'auto-update-disabled' });
      }
    } catch (error) {
      console.error('Failed to toggle auto-update:', error);
    }
  });
}

// Set up Firestore listener for user settings
function setupSettingsListener(userId) {
  // Stop any existing listener
  stopSettingsListener(false);
  
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
function stopSettingsListener(resetManagedState = true) {
  if (settingsUnsubscribe) {
    settingsUnsubscribe();
    settingsUnsubscribe = null;
  }

  if (!resetManagedState) return;

  managedAppSettings = null;
  lastManagedSettingsSignature = null;
  inputDataManagedLocks = {
    windows: false,
    audio: false,
    systemAudio: false,
    screen: false,
    location: false
  };
  llmManagedLocks.gemini = false;
  llmManagedLocks.openAICompatible = false;
  // Server-driven, so it cannot outlive the session that reported it: main
  // would otherwise keep scanning on the last-seen value after logout.
  locationFeatureEnabled = false;
  applyLocationFeatureVisibility();
  applyManualPausePolicy(null);
  try { ipcRenderer.send('updateLocationFeatureEnabled', false); } catch (_) {}
  try { ipcRenderer.send('apply-managed-app-settings', null); } catch (_) {}
  // Same reasoning as locationFeatureEnabled above: the holiday belongs to the
  // session that reported it. Left set, a previous user's vacation would keep
  // suppressing recording for the next login until settings resync.
  try { ipcRenderer.send('updateHoliday', null); } catch (_) {}
}

/**
 * Load user settings from Firebase
 */
async function loadUserSettings() {
  if (!getAuth().currentUser) return;

  try {
    const result = await getUserSettingsFunction();
    await updateSettingsUI(result.data);
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

    if (type === 'appExclusions') {
      settingsData.capture = { appExclusions: Array.isArray(value) ? value : [] };
      logAnalyticsEvent('settings_updated', {
        type: 'appExclusions',
        count: settingsData.capture.appExclusions.length
      });
    } else if (type === 'screenshots') {
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
            windows: partial.windows != null ? !!partial.windows : (current.windows != null ? !!current.windows : true),
            audio: partial.audio != null ? !!partial.audio : (current.audio != null ? !!current.audio : false),
            systemAudio: partial.systemAudio != null ? !!partial.systemAudio : (current.systemAudio != null ? !!current.systemAudio : false),
            screen: partial.screen != null ? !!partial.screen : (current.screen != null ? !!current.screen : true),
            location: partial.location != null ? !!partial.location : (current.location != null ? !!current.location : false)
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
            windows: fallback.windows != null ? !!fallback.windows : true,
            audio: fallback.audio != null ? !!fallback.audio : false,
            systemAudio: fallback.systemAudio != null ? !!fallback.systemAudio : false,
            screen: fallback.screen != null ? !!fallback.screen : true,
            location: fallback.location != null ? !!fallback.location : false
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
          screen: value.screen != null ? !!value.screen : true,
          location: value.location != null ? !!value.location : false
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

/**
 * Push the account's app masking rules into the desktop's effective list.
 *
 * The rules are a user setting now, edited in the web dashboard; main keeps the
 * merged copy (user rules plus whatever the organization enforces on top) in its
 * own store because capture has to read them synchronously on every screenshot.
 *
 * On the first run of a build that syncs, rules that only ever existed on this
 * machine are uploaded instead of being overwritten by an empty server value —
 * without that, updating the app would silently unmask whatever the user had
 * masked here.
 */
async function syncAppExclusionsFromSettings(settingsExclusions, managedConfig) {
  // A "fixed" policy replaces the member's list outright, and main already wrote
  // the organization's entries to the store when it applied the policy. Pushing
  // the user's own rules here would only be rejected.
  if (isManagedValue(managedConfig) && managedConfig.mode === MANAGED_LIST_MODE_FIXED) return;

  const fromSettings = Array.isArray(settingsExclusions) ? settingsExclusions : [];

  try {
    const migrated = await ipcRenderer.invoke('get-app-exclusions-migrated');
    if (!migrated?.migrated) {
      const local = await ipcRenderer.invoke('get-app-exclusions');
      const localExclusions = (local && local.success && Array.isArray(local.exclusions))
        ? local.exclusions
        : [];

      if (localExclusions.length > 0) {
        // Union, not "server wins": rules may have been added in the web app
        // while this machine still ran a build that kept its own list, and
        // whichever side we dropped would be a mask the user thinks is on.
        const seen = new Set(fromSettings.map((entry) => (entry?.appName || '').trim().toLowerCase()));
        const merged = fromSettings.concat(
          localExclusions.filter((entry) => {
            const name = (entry?.appName || '').trim().toLowerCase();
            if (!name || seen.has(name)) return false;
            seen.add(name);
            return true;
          })
        );

        if (merged.length !== fromSettings.length) {
          await saveUserSettings('appExclusions', merged);
          await ipcRenderer.invoke('set-app-exclusions-migrated');
          return;
        }
      }
      await ipcRenderer.invoke('set-app-exclusions-migrated');
    }
  } catch (error) {
    console.warn('App exclusion migration check failed:', error);
  }

  try {
    await ipcRenderer.invoke('save-app-exclusions', fromSettings);
  } catch (error) {
    console.error('Error applying app exclusions from settings:', error);
  }
}

async function updateSettingsUI(settings) {
  const nextManagedAppSettings = normalizeAppSettings(settings?.appSettings || null);
  managedAppSettings = nextManagedAppSettings;
  applyManualPausePolicy(nextManagedAppSettings.recording.manualPauseEnabled);
  pushManagedSettingsToMain();

  if (typeof applySaveCaptureManagedConfig === 'function') {
    await applySaveCaptureManagedConfig(nextManagedAppSettings.capture.saveCaptureData);
    if (managedAppSettings !== nextManagedAppSettings) return;
  }
  await applyManagedLocalProcessingSettings(nextManagedAppSettings.localProcessing);
  if (managedAppSettings !== nextManagedAppSettings) return;

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
  const managedInputData = nextManagedAppSettings.capture.inputData;
  inputDataManagedLocks = {
    windows: isManagedInputStateForced(managedInputData.windows),
    audio: isManagedInputStateForced(managedInputData.audio),
    systemAudio: isManagedInputStateForced(managedInputData.systemAudio),
    screen: isManagedInputStateForced(managedInputData.screen),
    location: isManagedInputStateForced(managedInputData.location)
  };

  // Use persisted user toggle state; permissions are tracked separately.
  // Defaults: screen=true, windows=true, systemAudio=false
  inputData = {
    windows: resolveInputDataValue(managedInputData.windows, loadedInputData.windows, true),
    audio: resolveInputDataValue(managedInputData.audio, loadedInputData.audio, false),
    systemAudio: resolveInputDataValue(managedInputData.systemAudio, loadedInputData.systemAudio, false),
    screen: resolveInputDataValue(managedInputData.screen, loadedInputData.screen, true),
    location: resolveInputDataValue(managedInputData.location, loadedInputData.location, false)
  };

  // Forward the server's rollout flag to main. Left in the renderer it would
  // stop here, which is exactly what pushManagedSettingsToMain() exists to
  // prevent for the managed settings next to it.
  locationFeatureEnabled = settings?.features?.location === true;
  ipcRenderer.send('updateLocationFeatureEnabled', locationFeatureEnabled);
  applyLocationFeatureVisibility();

  if (isWaylandLinuxSession()) {
    const wasEnabled = !!inputData.windows;
    inputData.windows = false;
    if (wasEnabled || loadedInputData.windows === true) {
      ensureWaylandWindowsSettingPersisted();
    }
  }

  // Compute and send only changed flags to main to avoid clobbering
  const delta = {};
  if (prevInputData.windows !== inputData.windows) delta.windows = inputData.windows;
  if (prevInputData.audio !== inputData.audio) delta.audio = inputData.audio;
  if (prevInputData.systemAudio !== inputData.systemAudio) delta.systemAudio = inputData.systemAudio;
  if (prevInputData.screen !== inputData.screen) delta.screen = inputData.screen;
  if (prevInputData.location !== inputData.location) delta.location = inputData.location;
  
  if (Object.keys(delta).length > 0) {
    console.log('[Settings] sending updateInputDataSettings delta:', delta);
    ipcRenderer.send('updateInputDataSettings', delta);
  }

  const audioCheckbox = document.getElementById('audioCheckbox');
  const systemAudioCheckbox = document.getElementById('systemAudioCheckbox');
  const screenCheckbox = document.getElementById('screenCheckbox');
  const windowsCheckbox = document.getElementById('windowsCheckbox');

  if (windowsCheckbox) windowsCheckbox.checked = inputData.windows;
  if (audioCheckbox) audioCheckbox.checked = inputData.audio; 
  if (screenCheckbox) screenCheckbox.checked = inputData.screen;
  if (systemAudioCheckbox) {
    systemAudioCheckbox.checked = inputData.systemAudio;
  }
  const locationCheckbox = document.getElementById('locationCheckbox');
  if (locationCheckbox) locationCheckbox.checked = inputData.location;

  applyInputDataManagedLockUI();
  try { recomputeSystemAudioDependency(); } catch (_) {}

  const captureIntervalMinutes = normalizeCaptureIntervalMinutes(settings?.capture?.intervalMinutes);
  ipcRenderer.send('updateCaptureInterval', captureIntervalMinutes);

  await syncAppExclusionsFromSettings(
    settings?.capture?.appExclusions,
    nextManagedAppSettings.capture.appExclusions
  );


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
  let applyWorkdays = true;
  if (settings && Array.isArray(settings.workdays)) {
    const raw = settings.workdays;
    const validWorkdays = raw.filter(
      (day) => typeof day === 'number' && day >= 0 && day <= 6
    );
    if (raw.length === 0) {
      loadedWorkdays = [];
    } else if (validWorkdays.length === 0) {
      applyWorkdays = false;
    } else {
      loadedWorkdays = [...new Set(validWorkdays)];
    }
  }

  if (applyWorkdays) {
    workdays = loadedWorkdays;
    ipcRenderer.send('updateWorkdays', workdays);
  }

  // Handle holiday window. Unlike workdays there is no "ambiguous -> skip"
  // guard: a missing or malformed holiday can only ever mean "not on holiday",
  // which keeps recording on, so clearing is always the safe direction.
  ipcRenderer.send('updateHoliday', settings?.holiday ?? null);

  updateSettingsReady(true);
  refreshCaptureDependentVisibility();
  emitCaptureStateUpdated();
}



// Disable "Meeting audio" unless microphone is enabled
function setupSystemAudioDependency() {
  const audioCheckbox = document.getElementById('audioCheckbox');
  const systemAudioCheckbox = document.getElementById('systemAudioCheckbox');
  if (!systemAudioCheckbox) return;

  const applyState = () => {
    const micOn = !!(audioCheckbox && audioCheckbox.checked) || !!inputData.audio;
    systemAudioCheckbox.disabled = !!inputDataManagedLocks.systemAudio || !micOn;
    systemAudioCheckbox.title = micOn
      ? 'Meeting audio is controlled by your setting and permission state'
      : 'Enable microphone in settings to capture meeting audio';
  };

  // Initial application
  applyState();
  
  // React to microphone toggle changes
  if (audioCheckbox) {
    audioCheckbox.addEventListener('change', applyState);
  }
}

function recomputeSystemAudioDependency() {
  const systemAudioCheckbox = document.getElementById('systemAudioCheckbox');
  if (!systemAudioCheckbox) return;

  const audioCheckbox = document.getElementById('audioCheckbox');
  const micOn = !!(audioCheckbox && audioCheckbox.checked) || !!inputData.audio;
  systemAudioCheckbox.disabled = !!inputDataManagedLocks.systemAudio || !micOn;
  systemAudioCheckbox.title = micOn
    ? 'Meeting audio is controlled by your setting and permission state'
    : 'Enable microphone in settings to capture meeting audio';
  applyInputDataManagedLockUI();
}

async function getLocalProcessingStateSummary() {
  try {
    const result = await ipcRenderer.invoke('get-local-processing-state');
    if (result?.success && result.state) {
      return result.state;
    }
  } catch (_) {}

  return {
    gemini: { hasKey: false, keySource: null },
    openAICompatible: { endpoint: null, model: null, hasApiKey: false, keySource: null }
  };
}

async function applyManagedLocalProcessingSettings(localProcessing) {
  const geminiSection = document.getElementById('geminiSettingsSection');
  const openAiSection = document.getElementById('openAiCompatibleSettingsSection');
  const llmSettingsCard = document.getElementById('llmSettingsCard');
  const geminiApiKeyInput = document.getElementById('geminiApiKeyInput');
  const toggleGeminiKeyBtn = document.getElementById('toggleGeminiKeyBtn');
  const clearGeminiKeyBtn = document.getElementById('clearGeminiKeyBtn');
  const openaiEndpointInput = document.getElementById('openaiEndpointInput');
  const openaiModelInput = document.getElementById('openaiModelInput');
  const openaiApiKeyInput = document.getElementById('openaiApiKeyInput');
  const toggleOpenaiKeyBtn = document.getElementById('toggleOpenaiKeyBtn');
  const clearOpenaiConfigBtn = document.getElementById('clearOpenaiConfigBtn');
  const localProcessingState = await getLocalProcessingStateSummary();

  const geminiManaged = isManagedValue(localProcessing?.gemini);
  const openAiManaged = isManagedValue(localProcessing?.openAICompatible);
  const llmManaged = geminiManaged || openAiManaged;
  llmManagedLocks.gemini = llmManaged;
  llmManagedLocks.openAICompatible = llmManaged;

  setManagedCardLock(llmSettingsCard, llmManaged);
  setManagedCardLock(geminiSection, llmManaged);
  setManagedCardLock(openAiSection, llmManaged);

  if (geminiApiKeyInput) geminiApiKeyInput.disabled = llmManaged;
  if (toggleGeminiKeyBtn) toggleGeminiKeyBtn.disabled = llmManaged;
  if (clearGeminiKeyBtn) clearGeminiKeyBtn.disabled = llmManaged;

  if (openaiEndpointInput) openaiEndpointInput.disabled = llmManaged;
  if (openaiModelInput) openaiModelInput.disabled = llmManaged;
  if (openaiApiKeyInput) openaiApiKeyInput.disabled = llmManaged;
  if (toggleOpenaiKeyBtn) toggleOpenaiKeyBtn.disabled = llmManaged;
  if (clearOpenaiConfigBtn) clearOpenaiConfigBtn.disabled = llmManaged;

  if (geminiManaged && geminiApiKeyInput) {
    const config = localProcessing.gemini;
    let hasKey = false;
    if (config.enabled === false) {
      hasKey = false;
    } else if (isManagedValue(config.apiKey)) {
      hasKey = !!config.apiKey;
    } else {
      hasKey = !!localProcessingState?.gemini?.hasKey;
    }
    geminiApiKeyInput.type = 'password';
    geminiApiKeyInput.value = hasKey ? MASKED_SECRET : '';
  } else if (!geminiManaged && geminiApiKeyInput) {
    const hasKey = !!localProcessingState?.gemini?.hasKey;
    geminiApiKeyInput.type = 'password';
    geminiApiKeyInput.value = hasKey ? MASKED_SECRET : '';
  }

  if (openAiManaged) {
    const config = localProcessing.openAICompatible;
    if (config.enabled === false) {
      if (openaiEndpointInput) openaiEndpointInput.value = '';
      if (openaiModelInput) openaiModelInput.value = '';
      if (openaiApiKeyInput) {
        openaiApiKeyInput.type = 'password';
        openaiApiKeyInput.value = '';
      }
    } else {
      const currentConfig = localProcessingState?.openAICompatible || null;

      const endpointValue = isManagedValue(config.endpoint) ? config.endpoint : (currentConfig?.endpoint || '');
      const modelValue = isManagedValue(config.model) ? config.model : (currentConfig?.model || '');
      const hasApiKey = isManagedValue(config.apiKey)
        ? !!config.apiKey
        : !!currentConfig?.hasApiKey;

      if (openaiEndpointInput) openaiEndpointInput.value = endpointValue;
      if (openaiModelInput) openaiModelInput.value = modelValue;
      if (openaiApiKeyInput) {
        openaiApiKeyInput.type = 'password';
        openaiApiKeyInput.value = hasApiKey ? MASKED_SECRET : '';
      }
    }
  } else if (!openAiManaged) {
    const config = localProcessingState?.openAICompatible || null;
    if (openaiEndpointInput) openaiEndpointInput.value = config?.endpoint || '';
    if (openaiModelInput) openaiModelInput.value = config?.model || '';
    if (openaiApiKeyInput) {
      openaiApiKeyInput.type = 'password';
      openaiApiKeyInput.value = config?.hasApiKey ? MASKED_SECRET : '';
    }
  }
}



// Set up Gemini API key listeners
function setupGeminiApiKeyListeners() {
  const geminiApiKeyInput = document.getElementById('geminiApiKeyInput');
  const toggleGeminiKeyBtn = document.getElementById('toggleGeminiKeyBtn');
  const clearGeminiKeyBtn = document.getElementById('clearGeminiKeyBtn');
  let hasStoredKey = false;
  let isShowing = false;
  let storedKeyCached = '';
  
  if (geminiApiKeyInput) {
    // On mount, check if a key exists and show masked
    (async () => {
      try {
        const state = await getLocalProcessingStateSummary();
        hasStoredKey = !!state?.gemini?.hasKey;
        storedKeyCached = '';
        if (llmManagedLocks.gemini) return;
        if (hasStoredKey) {
          geminiApiKeyInput.value = MASKED_SECRET;
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
      if (llmManagedLocks.gemini) return;
      const raw = geminiApiKeyInput.value.trim();
      if (!isShowing && raw === MASKED_SECRET) {
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
            geminiApiKeyInput.value = MASKED_SECRET;
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
      if (llmManagedLocks.gemini) return;
      const input = geminiApiKeyInput;
      if (input.type === 'password') {
        input.type = 'text';
        isShowing = true;
        // Populate with real key if field currently masked
        if (input.value === MASKED_SECRET) {
          // Always refetch to ensure fresh value
          ipcRenderer.invoke('get-gemini-api-key').then((res) => {
            if (res && res.success && res.apiKey) {
              hasStoredKey = true;
              storedKeyCached = res.apiKey;
              input.value = res.apiKey;
            } else {
              hasStoredKey = false;
              storedKeyCached = '';
              input.value = '';
            }
          }).catch(() => { input.value = ''; });
        }
        toggleGeminiKeyBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
          </svg>
        `;
      } else {
        input.type = 'password';
        isShowing = false;
        if (hasStoredKey) {
          input.value = MASKED_SECRET;
        }
        toggleGeminiKeyBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        `;
      }
    });
  }
  
  if (clearGeminiKeyBtn) {
    clearGeminiKeyBtn.addEventListener('click', async () => {
      if (llmManagedLocks.gemini) return;
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
  let hasStoredConfig = false;
  let isShowingKey = false;
  let storedConfig = { endpoint: null, model: null, apiKey: null };

  if (openaiEndpointInput && openaiApiKeyInput) {
    // On mount, load existing config
    (async () => {
      try {
        const state = await getLocalProcessingStateSummary();
        if (state?.openAICompatible) {
          storedConfig = {
            endpoint: state.openAICompatible.endpoint || null,
            model: state.openAICompatible.model || null,
            apiKey: null
          };
          hasStoredConfig = !!(storedConfig.endpoint || storedConfig.model || state.openAICompatible.hasApiKey);
          if (llmManagedLocks.openAICompatible) return;
          if (storedConfig.endpoint) {
            openaiEndpointInput.value = storedConfig.endpoint;
          }
          if (storedConfig.model) {
            openaiModelInput.value = storedConfig.model;
          }
          if (state.openAICompatible.hasApiKey) {
            openaiApiKeyInput.value = MASKED_SECRET;
            openaiApiKeyInput.type = 'password';
          }
        }
      } catch (error) {
        console.error('Error loading OpenAI-compatible config:', error);
      }
    })();

    // Save config on blur for all fields
    const saveConfig = async () => {
      if (llmManagedLocks.openAICompatible) return;
      const endpoint = openaiEndpointInput.value.trim();
      const model = openaiModelInput.value.trim();
      const rawApiKey = openaiApiKeyInput.value.trim();

      let apiKey = null;
      let preserveApiKey = false;
      if (!isShowingKey && rawApiKey === MASKED_SECRET) {
        preserveApiKey = true;
      } else if (rawApiKey) {
        apiKey = rawApiKey;
      }

      try {
        if (endpoint || model || apiKey || preserveApiKey) {
          await ipcRenderer.invoke('save-openai-compatible-config', { endpoint, model, apiKey, preserveApiKey });
          logAnalyticsEvent('openai_config_saved', {
            has_endpoint: !!endpoint,
            has_model: !!model,
            has_key: !!(apiKey || preserveApiKey)
          });
          hasStoredConfig = true;
          storedConfig = {
            endpoint,
            model,
            apiKey: preserveApiKey ? storedConfig.apiKey : apiKey
          };
          if ((apiKey || preserveApiKey) && !isShowingKey) {
            openaiApiKeyInput.value = MASKED_SECRET;
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
      if (llmManagedLocks.openAICompatible) return;
      const input = openaiApiKeyInput;
      if (input.type === 'password') {
        input.type = 'text';
        isShowingKey = true;
        // Populate with real key if field is currently masked
        if (input.value === MASKED_SECRET) {
          ipcRenderer.invoke('get-openai-compatible-config').then((res) => {
            const config = res?.success ? (res.config || {}) : {};
            storedConfig = config;
            hasStoredConfig = !!(config.endpoint || config.model || config.apiKey);
            input.value = config.apiKey || '';
          }).catch(() => {
            input.value = '';
          });
        }
        toggleOpenaiKeyBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
          </svg>
        `;
      } else {
        input.type = 'password';
        isShowingKey = false;
        if (hasStoredConfig && storedConfig.apiKey) {
          input.value = MASKED_SECRET;
        }
        toggleOpenaiKeyBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        `;
      }
    });
  }

  if (clearOpenaiConfigBtn) {
    clearOpenaiConfigBtn.addEventListener('click', async () => {
      if (llmManagedLocks.openAICompatible) return;
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
  saveUserSettings,
  handleCaptureToggleIntent,
  isLocationFeatureEnabled,
  applyLocationFeatureVisibility
};

// --- Hotkey configuration ---
function setupHotkeyConfiguration() {
  const input = document.getElementById('hotkeyLetterInput');
  const cmdCap = document.getElementById('hotkeyCmdCap');
  const shiftCap = document.getElementById('hotkeyShiftCap');
  if (!input || !cmdCap || !shiftCap) return;
  const isWayland = isWaylandLinuxSession();

  try { cmdCap.textContent = (window.electronAPI.platform === 'darwin' ? 'Cmd' : 'Ctrl'); } catch (_) {}

  if (isWayland) {
    input.disabled = true;
    input.classList.add('text-gray-400', 'cursor-not-allowed');
    input.classList.remove('text-gray-900', 'focus:ring-2', 'focus:ring-indigo-400');
    input.title = 'Global hotkeys are unavailable on Wayland sessions.';
    return;
  }

  // Load current from main
  ipcRenderer.invoke('hotkey:get').then((res) => {
    if (res && res.success) {
      try { input.value = (res.suffix || 'D'); } catch (_) {}
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
  const testBtn = document.getElementById('testAppExclusions');
  const testResult = document.getElementById('appExclusionsTestResult');
  const testIcon = document.getElementById('appExclusionsTestIcon');
  const testMessage = document.getElementById('appExclusionsTestMessage');
  const testScreenshots = document.getElementById('appExclusionsTestScreenshots');
  let testResultHideTimer = null;

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

// Set up Wayland detection and show note if on Wayland
function setupWaylandDetection() {
  // Only check on Linux
  if (window.electronAPI.platform !== 'linux') return;
  
  const waylandNote = document.getElementById('waylandNote');
  const waylandMeetingAudioNote = document.getElementById('waylandMeetingAudioNote');
  const waylandHotkeyNote = document.getElementById('waylandHotkeyNote');
  const forcedOffNote = document.getElementById('waylandWindowsForcedOffNote');
  const windowsCheckbox = document.getElementById('windowsCheckbox');
  if (!waylandNote) return;
  
  // Check for Wayland via environment variables (standard detection methods)
  // WAYLAND_DISPLAY is set when running on Wayland
  // XDG_SESSION_TYPE is also commonly set to 'wayland' on Wayland sessions
  const isWayland = window.electronAPI.isWayland;
  
  if (isWayland) {
    waylandNote.classList.remove('hidden');
    if (waylandMeetingAudioNote) waylandMeetingAudioNote.classList.remove('hidden');
    if (waylandHotkeyNote) waylandHotkeyNote.classList.remove('hidden');
    if (forcedOffNote) forcedOffNote.classList.remove('hidden');
    if (windowsCheckbox) {
      windowsCheckbox.checked = false;
      windowsCheckbox.disabled = true;
    }
  } else {
    waylandNote.classList.add('hidden');
    if (waylandMeetingAudioNote) waylandMeetingAudioNote.classList.add('hidden');
    if (waylandHotkeyNote) waylandHotkeyNote.classList.add('hidden');
    if (forcedOffNote) forcedOffNote.classList.add('hidden');
    if (windowsCheckbox) {
      windowsCheckbox.disabled = !!inputDataManagedLocks.windows;
    }
  }
}

function ensureWaylandWindowsSettingPersisted() {
  if (!isWaylandLinuxSession() || waylandWindowsPersistInFlight) return;
  waylandWindowsPersistInFlight = true;
  saveUserSettings('inputData', { windows: false, __partial: true })
    .catch((error) => {
      console.error('Failed to persist Wayland windows disable state:', error);
    })
    .finally(() => {
      waylandWindowsPersistInFlight = false;
    });
}

function setupLinuxAutostartListeners() {
  if (window.electronAPI.platform !== 'linux') return;

  const section = document.getElementById('linuxAutostartSection');
  const checkbox = document.getElementById('linuxAutostartCheckbox');
  const status = document.getElementById('linuxAutostartStatus');
  const errorEl = document.getElementById('linuxAutostartError');
  if (!section || !checkbox) return;

  section.classList.remove('hidden');

  const renderState = (state) => {
    if (!state) return;
    checkbox.checked = !!state.enabled;
    if (status) {
      const filePath = state.filePath || '~/.config/autostart/donethat.desktop';
      const execPath = state.execPath || '';
      status.textContent = `Desktop file: ${filePath}${execPath ? ` | Exec: ${execPath} --no-sandbox` : ''}`;
      status.classList.remove('hidden');
    }
  };

  const setError = (message) => {
    if (!errorEl) return;
    if (message) {
      errorEl.textContent = message;
      errorEl.classList.remove('hidden');
    } else {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
    }
  };

  ipcRenderer.invoke('get-linux-autostart').then((result) => {
    if (result?.success) {
      renderState(result);
      setError(null);
    } else {
      setError(result?.error || 'Failed to load Linux autostart state');
    }
  }).catch((error) => {
    setError(error.message || 'Failed to load Linux autostart state');
  });

  checkbox.addEventListener('change', async () => {
    const enabled = !!checkbox.checked;
    try {
      const result = await ipcRenderer.invoke('set-linux-autostart', enabled);
      if (!result?.success) {
        checkbox.checked = !enabled;
        setError(result?.error || 'Failed to update Linux autostart');
        return;
      }
      renderState(result);
      setError(null);
    } catch (error) {
      checkbox.checked = !enabled;
      setError(error.message || 'Failed to update Linux autostart');
    }
  });
}

// Set up save capture data to folder toggle and path (same pattern as other main-process settings)
function setupSaveCaptureDataListeners() {
  const checkbox = document.getElementById('saveCaptureDataCheckbox');
  const pathSection = document.getElementById('saveCaptureDataPathSection');
  const pathInput = document.getElementById('saveCaptureDataPathInput');
  const saveCaptureSection = document.getElementById('saveCaptureDataSection');

  if (!checkbox || !pathSection || !pathInput) return;

  let saveCaptureManaged = false;

  async function loadSaveCaptureDataFromStore() {
    try {
      const { enabled, path } = await ipcRenderer.invoke('get-save-capture-data');
      if (saveCaptureManaged) return;
      checkbox.checked = !!enabled;
      pathSection.classList.toggle('hidden', !enabled);
      pathInput.value = path || 'Browse';
    } catch (error) {
      console.error('Error loading save capture data:', error);
    }
  }

  async function applyManagedSaveCaptureData(managedSaveCaptureData) {
    saveCaptureManaged = isManagedValue(managedSaveCaptureData);
    setManagedCardLock(saveCaptureSection || 'saveCaptureDataSection', saveCaptureManaged);

    if (saveCaptureManaged) {
      let currentConfig = null;
      try {
        currentConfig = await ipcRenderer.invoke('get-save-capture-data');
      } catch (_) {
        currentConfig = null;
      }
      const effectiveEnabled = isManagedValue(managedSaveCaptureData.enabled)
        ? !!managedSaveCaptureData.enabled
        : !!currentConfig?.enabled;
      const effectivePath = (isManagedValue(managedSaveCaptureData.path) && managedSaveCaptureData.path)
        ? managedSaveCaptureData.path
        : (currentConfig?.path || 'Browse');

      checkbox.checked = effectiveEnabled;
      pathSection.classList.toggle('hidden', !effectiveEnabled);
      pathInput.value = effectivePath;
      return;
    }

    await loadSaveCaptureDataFromStore();
  }

  applySaveCaptureManagedConfig = applyManagedSaveCaptureData;
  if (managedAppSettings) {
    applyManagedSaveCaptureData(managedAppSettings.capture.saveCaptureData);
  } else {
    loadSaveCaptureDataFromStore();
  }

  checkbox.addEventListener('change', () => {
    if (saveCaptureManaged) {
      checkbox.checked = !checkbox.checked;
      return;
    }
    pathSection.classList.toggle('hidden', !checkbox.checked);
    ipcRenderer.send('updateSaveCaptureData', checkbox.checked);
  });

  pathInput.addEventListener('click', async () => {
    if (saveCaptureManaged) return;
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

function setupClientTelemetryListeners() {
  const checkbox = document.getElementById('clientTelemetryCheckbox');

  if (!checkbox) return;

  async function loadClientTelemetryFromStore() {
    try {
      const { enabled } = await ipcRenderer.invoke('get-client-telemetry');
      checkbox.checked = enabled !== false;
    } catch (error) {
      console.error('Error loading client telemetry setting:', error);
      checkbox.checked = true;
    }
  }

  loadClientTelemetryFromStore();

  checkbox.addEventListener('change', () => {
    ipcRenderer.send('updateClientTelemetry', checkbox.checked);
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
