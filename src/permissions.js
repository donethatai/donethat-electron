const ipcRenderer = window.electronAPI;
const {
  updateScreenCapturePermission,
  updateWindowsPermission,
  updateMicrophonePermission,
  updateSystemAudioPermission,
  updateLocationPermission,
  updatePermissionsReady,
  hasMicrophonePermission
} = require('./app-state.js');
const { logAnalyticsEvent } = require('./analytics.js');
const { handleCaptureToggleIntent } = require('./settings.js');

let updateTopbarVisibility;

const permissionStartupLoaded = {
  screen: false,
  windows: false
};

const permissionIssueVisibleState = {
  screen: false,
  windows: false,
  microphone: false,
  systemAudio: false,
  location: false
};
let hasRequestedInitialSystemAudioCheck = false;

// The feature-flag event rides on the settings snapshot, and settings arrive
// from a Firestore listener that re-fires on every write. Without this latch
// the check ran per snapshot, and each run both spawned the wifi-scan helper
// and cleared the scan-blocked latch that exists to stop exactly that.
let locationStartupCheckDone = false;

function isWaylandLinuxSession() {
  return window.electronAPI.platform === 'linux' && !!window.electronAPI.isWayland;
}

function emitCaptureStateUpdated() {
  document.dispatchEvent(new CustomEvent('capture-state-updated'));
}

function readPermissionDataset(checkbox) {
  if (!checkbox) return null;
  const raw = checkbox.dataset.permissionGranted;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function parsePermissionPayload(data, fallbackSource = 'unknown') {
  if (data && typeof data === 'object') {
    return {
      hasPermission: !!data.hasPermission,
      source: typeof data.source === 'string' && data.source ? data.source : fallbackSource
    };
  }

  return {
    hasPermission: !!data,
    source: fallbackSource
  };
}

function handleIncomingPermissionEvent(type, data, applyUpdate, options = {}) {
  const { defaultSource = 'unknown', fromStartup = false } = options;
  const parsed = parsePermissionPayload(data, defaultSource);

  logAnalyticsEvent('permission_event_received', {
    type,
    source: parsed.source,
    status: parsed.hasPermission ? 'granted' : 'denied',
    platform: window.electronAPI.platform
  });

  applyUpdate(parsed.hasPermission, fromStartup, parsed.source);
}

function markPermissionLoaded(type) {
  permissionStartupLoaded[type] = true;
  const ready = permissionStartupLoaded.screen && permissionStartupLoaded.windows;
  updatePermissionsReady(ready);
  emitCaptureStateUpdated();
}

function initializePermissions(topbarVisibilityUpdater) {
  updateTopbarVisibility = topbarVisibilityUpdater;

  setupPlatformSpecificListeners();
  setupRuntimePermissionIssueListener();
  setupScreenCaptureCheckboxBehavior();
  setupWindowsCheckboxBehavior();
  setupAudioCheckboxBehavior();
  setupSystemAudioCheckboxBehavior();
  setupLocationCheckboxBehavior();
  setupLocationStartupCheck();
  setupPermissionRecheckButtons();
  setupPermissionIndicatorRefresh();

  checkPermissionsOnStartup();
}

function setupRuntimePermissionIssueListener() {
  ipcRenderer.on('flag-permission-issues', (payload) => {
    const runtimeIssues = payload && typeof payload === 'object' ? payload.runtimeIssues : null;
    if (!runtimeIssues || typeof runtimeIssues !== 'object') return;

    if (runtimeIssues.screen) {
      applyScreenPermissionUpdate(false, false, 'runtime-issue');
    }

    if (runtimeIssues.windows) {
      applyWindowsPermissionUpdate(false, false, 'runtime-issue');
    }

    if (runtimeIssues.microphone) {
      applyMicrophonePermissionUpdate(false, false, 'runtime-issue');
    }

    if (runtimeIssues.systemAudio) {
      applySystemAudioPermissionUpdate(false, false, 'runtime-issue');
    }

    if (runtimeIssues.location) {
      // Only a real refusal reaches here — the capture cycle never flags an
      // empty room — but which refusal matters: `restricted` is an MDM policy
      // no button can undo, so it must not be relabelled as `denied`.
      const authorization = runtimeIssues.location.authorization === 'restricted'
        ? 'restricted'
        : 'denied';
      applyLocationPermissionUpdate({
        hasPermission: false,
        authorization,
        dataAvailable: false,
        reason: authorization
      }, 'runtime-issue');
    }
  });
}

function setupPermissionIndicatorRefresh() {
  document.addEventListener('capture-state-updated', () => {
    const screenCheckbox = document.getElementById('screenCheckbox');
    if (screenCheckbox) {
      updateScreenCaptureCheckbox(screenCheckbox.dataset.permissionGranted === 'true');
    }
    const windowsCheckbox = document.getElementById('windowsCheckbox');
    if (windowsCheckbox) {
      updateWindowsCheckbox(windowsCheckbox.dataset.permissionGranted === 'true');
    }
    const audioCheckbox = document.getElementById('audioCheckbox');
    if (audioCheckbox) {
      updateMicrophoneCheckbox(audioCheckbox.dataset.permissionGranted === 'true');
    }
    const systemAudioCheckbox = document.getElementById('systemAudioCheckbox');
    if (systemAudioCheckbox) {
      updateSystemAudioCheckbox(readPermissionDataset(systemAudioCheckbox));
    }
    const locationCheckbox = document.getElementById('locationCheckbox');
    if (locationCheckbox) {
      updateLocationCheckbox(readPermissionDataset(locationCheckbox), lastLocationReason);
    }
  });
}

function checkPermissionsOnStartup() {
  ipcRenderer.send('checkScreenCapturePermission');

  if (isWaylandLinuxSession()) {
    applyWindowsPermissionUpdate(false, true, 'wayland-forced-disabled');
  } else {
    retryWindowsPermissionStartupCheck().then((hasPermission) => {
      applyWindowsPermissionUpdate(!!hasPermission, true, 'startup-passive-check');
    });
  }
  retryMicrophonePermissionStartupCheck().then((hasPermission) => {
    applyMicrophonePermissionUpdate(!!hasPermission, true, 'startup-passive-check');
  });
}

async function retryWindowsPermissionStartupCheck() {
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const hasPermission = await ipcRenderer.invoke('checkWindowsPermission');
      if (hasPermission) return true;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
  } catch (_) {}
  return false;
}

async function retryMicrophonePermissionStartupCheck() {
  try {
    const hasPermission = await ipcRenderer.invoke('checkMicrophonePermission', true);
    return !!hasPermission;
  } catch (_) {}
  return false;
}

function setupPlatformSpecificListeners() {
  ipcRenderer.on('linux-windows-permission-notice', () => {
    showLinuxPermissionHelp('windows');
  });

  ipcRenderer.on('linux-audio-permission-notice', () => {
    showLinuxPermissionHelp('audio');
  });

  ipcRenderer.on('linux-pactl-missing-notice', () => {
    showLinuxPermissionHelp('pactl');
    emitCaptureStateUpdated();
  });
}

function showLinuxPermissionHelp(permissionType) {
  const platform = window.electronAPI.platform;
  if (platform !== 'linux') return;

  switch (permissionType) {
    case 'audio':
    case 'windows':
      showInlineLinuxNotification('linuxWindowsSection');
      break;
    case 'pactl':
      showInlineLinuxNotification('linuxPactlSection');
      break;
    default:
      break;
  }
}

function showInlineLinuxNotification(sectionId) {
  const section = document.getElementById(sectionId);
  if (section) {
    section.classList.remove('hidden');
  }
}

function showLinuxScreenshotSection() {
  if (window.electronAPI.platform !== 'linux') return;
  const linuxInstallGuideNote = document.getElementById('linuxInstallGuideNote');
  if (linuxInstallGuideNote) {
    linuxInstallGuideNote.classList.remove('hidden');
  }
  const linuxScreenshotSection = document.getElementById('linuxScreenshotSection');
  if (linuxScreenshotSection) {
    linuxScreenshotSection.classList.remove('hidden');
  }
}

function applyScreenPermissionUpdate(hasPermission, fromStartup = false, source = 'unknown') {
  updateScreenCapturePermission(hasPermission);

  logAnalyticsEvent('screen_capture_permission', {
    status: hasPermission ? 'granted' : 'denied',
    platform: window.electronAPI.platform,
    source
  });

  if (window.electronAPI.platform === 'linux') {
    showLinuxScreenshotSection();
  }

  updateScreenCaptureCheckbox(hasPermission);
  if (updateTopbarVisibility) updateTopbarVisibility();

  if (fromStartup) {
    markPermissionLoaded('screen');
  }

  emitCaptureStateUpdated();
}

function applyWindowsPermissionUpdate(hasPermission, fromStartup = false, source = 'unknown') {
  updateWindowsPermission(hasPermission);

  logAnalyticsEvent('windows_permission', {
    status: hasPermission ? 'granted' : 'denied',
    platform: window.electronAPI.platform,
    source
  });

  updateWindowsCheckbox(hasPermission);

  if (updateTopbarVisibility) updateTopbarVisibility();

  if (fromStartup) {
    markPermissionLoaded('windows');
  }

  emitCaptureStateUpdated();
}

function applyMicrophonePermissionUpdate(hasPermission, _fromStartup = false, source = 'unknown') {
  updateMicrophonePermission(hasPermission);

  logAnalyticsEvent('microphone_permission', {
    status: hasPermission ? 'granted' : 'denied',
    platform: window.electronAPI.platform,
    source
  });

  updateMicrophoneCheckbox(hasPermission);
  const systemAudioCheckbox = document.getElementById('systemAudioCheckbox');
  if (systemAudioCheckbox) {
    updateSystemAudioCheckbox(readPermissionDataset(systemAudioCheckbox));
  }
  emitCaptureStateUpdated();
}

// The last reason the main process reported, kept so a re-render triggered by
// something else (a toggle flip, a capture-state event) can redraw the note
// without inventing a status it never received.
let lastLocationReason = null;

/**
 * Location's payload is a record, not a boolean, so it does not go through
 * `handleIncomingPermissionEvent` — but everything downstream of it (state,
 * analytics, checkbox, indicator) matches the other four exactly.
 */
function applyLocationPermissionUpdate(payload, source = 'unknown') {
  const hasPermission = payload?.hasPermission === true;
  const authorization = payload?.authorization || 'unknown';
  const reason = payload?.reason || null;

  lastLocationReason = reason;
  updateLocationPermission(hasPermission, authorization, reason);

  logAnalyticsEvent('location_permission', {
    status: hasPermission ? 'granted' : 'denied',
    authorization,
    reason: reason || 'none',
    dataAvailable: payload?.dataAvailable === true ? 'true' : 'false',
    platform: window.electronAPI.platform,
    source
  });

  updateLocationCheckbox(hasPermission, reason);
  emitCaptureStateUpdated();
}

function applySystemAudioPermissionUpdate(hasPermission, _fromStartup = false, source = 'unknown') {
  updateSystemAudioPermission(hasPermission);

  logAnalyticsEvent('system_audio_permission', {
    status: hasPermission ? 'granted' : 'denied',
    platform: window.electronAPI.platform,
    source
  });

  updateSystemAudioCheckbox(hasPermission);
  emitCaptureStateUpdated();
}

ipcRenderer.on('screenCapturePermission', (data) => {
  handleIncomingPermissionEvent('screen', data, applyScreenPermissionUpdate, {
    defaultSource: 'screen-channel',
    fromStartup: true
  });
  if (!hasRequestedInitialSystemAudioCheck) {
    hasRequestedInitialSystemAudioCheck = true;
    requestSystemAudioPermission(false);
  }
});

ipcRenderer.on('microphonePermission', (data) => {
  handleIncomingPermissionEvent('microphone', data, applyMicrophonePermissionUpdate, {
    defaultSource: 'microphone-channel',
    fromStartup: false
  });
});

ipcRenderer.on('windowsPermission', (data) => {
  handleIncomingPermissionEvent('windows', data, applyWindowsPermissionUpdate, {
    defaultSource: 'windows-channel',
    fromStartup: false
  });
});

ipcRenderer.on('systemAudioPermission', (data) => {
  handleIncomingPermissionEvent('systemAudio', data, applySystemAudioPermissionUpdate, {
    defaultSource: 'system-audio-channel',
    fromStartup: false
  });
});

ipcRenderer.on('systemAudioPermission-recheck', () => {
  requestSystemAudioPermission(false);
});

// A denial has to be visible. A toggle that reads "on" while nothing is ever
// recorded is worse than one that fails loudly.
//
// Keyed on `reason`, not `hasPermission`: a granted machine with the radio off
// still has nothing to report, and saying so is not the same as saying access
// was refused. Only LOCATION_ACTIONABLE_REASONS are the user's to fix in
// System Settings; the rest are hardware states that lead nowhere.
const LOCATION_NOTE_MESSAGES = {
  denied: 'Location access is off. Enable DoneThat in System Settings.',
  restricted: 'Location access is restricted on this machine.',
  disabled: 'Nearby networks are not enabled for this account.',
  unknown: 'Couldn\'t read nearby networks.',
  unavailable: 'Couldn\'t read nearby networks.',
  noWifi: 'No Wi-Fi adapter found.',
  noNetworks: 'No nearby networks found.'
};

// Two different questions, so two different sets.
//
// BLOCKING: the grant is what stops the fingerprint — worth a tooltip and a
// `permission_issue_visible` event, whether or not the user can do anything.
// ACTIONABLE: the user can actually change it, so a Settings button leads
// somewhere. `restricted` is an MDM policy and the main process refuses to open
// Settings for it, so offering the button would be offering a no-op.
const LOCATION_BLOCKING_REASONS = new Set(['denied', 'restricted']);
const LOCATION_ACTIONABLE_REASONS = new Set(['denied']);

ipcRenderer.on('locationPermission', (data) => {
  applyLocationPermissionUpdate(data, data?.source || 'location-channel');
});

function updateScreenCaptureCheckbox(hasPermission) {
  const checkbox = document.getElementById('screenCheckbox');
  if (!checkbox) return;

  checkbox.dataset.permissionGranted = hasPermission ? 'true' : 'false';
  const enabledByToggle = !!checkbox.checked;
  const blockedByPermission = enabledByToggle && !hasPermission;
  if (blockedByPermission !== permissionIssueVisibleState.screen) {
    permissionIssueVisibleState.screen = blockedByPermission;
    if (blockedByPermission) {
      logAnalyticsEvent('permission_issue_visible', {
        type: 'screen',
        platform: window.electronAPI.platform
      });
    }
  }

  const toggleLabel = checkbox.closest('.toggle');
  if (toggleLabel) {
    toggleLabel.title = blockedByPermission
      ? 'Enabled in settings, but currently blocked by missing screen permission'
      : (hasPermission ? 'Screen permission granted' : 'Screen permission required for effective capture');
  }

  const recheckBtn = document.getElementById('recheckScreenPermissionBtn');
  if (recheckBtn) recheckBtn.classList.toggle('hidden', !blockedByPermission);
}

function updateWindowsCheckbox(hasPermission) {
  const checkbox = document.getElementById('windowsCheckbox');
  if (!checkbox) return;

  checkbox.dataset.permissionGranted = hasPermission ? 'true' : 'false';
  const enabledByToggle = !!checkbox.checked;
  const blockedByPermission = enabledByToggle && !hasPermission;
  if (blockedByPermission !== permissionIssueVisibleState.windows) {
    permissionIssueVisibleState.windows = blockedByPermission;
    if (blockedByPermission) {
      logAnalyticsEvent('permission_issue_visible', {
        type: 'windows',
        platform: window.electronAPI.platform
      });
    }
  }

  const toggleLabel = checkbox.closest('.toggle');
  if (toggleLabel) {
    toggleLabel.title = blockedByPermission
      ? 'Enabled in settings, but currently blocked by missing active applications permission'
      : (hasPermission ? 'Active applications permission granted' : 'Active applications permission required for effective capture');
  }

  const recheckBtn = document.getElementById('recheckWindowsPermissionBtn');
  if (recheckBtn) recheckBtn.classList.toggle('hidden', !blockedByPermission);
}

function updateMicrophoneCheckbox(hasPermission) {
  const checkbox = document.getElementById('audioCheckbox');
  if (!checkbox) return;

  checkbox.dataset.permissionGranted = hasPermission ? 'true' : 'false';
  const enabledByToggle = !!checkbox.checked;
  const blockedByPermission = enabledByToggle && !hasPermission;
  if (blockedByPermission !== permissionIssueVisibleState.microphone) {
    permissionIssueVisibleState.microphone = blockedByPermission;
    if (blockedByPermission) {
      logAnalyticsEvent('permission_issue_visible', {
        type: 'microphone',
        platform: window.electronAPI.platform
      });
    }
  }

  const toggleLabel = checkbox.closest('.toggle');
  if (toggleLabel) {
    toggleLabel.title = blockedByPermission
      ? 'Enabled in settings, but currently blocked by missing microphone permission'
      : (hasPermission ? 'Microphone permission granted' : 'Microphone permission required for effective capture');
  }

  const recheckBtn = document.getElementById('recheckMicrophonePermissionBtn');
  if (recheckBtn) recheckBtn.classList.toggle('hidden', !blockedByPermission);
}

function updateSystemAudioCheckbox(hasPermission) {
  const checkbox = document.getElementById('systemAudioCheckbox');
  if (!checkbox) return;

  const isKnown = typeof hasPermission === 'boolean';
  if (isKnown) {
    checkbox.dataset.permissionGranted = hasPermission ? 'true' : 'false';
  }
  const enabledByToggle = !!checkbox.checked;
  const audioEnabled = !!document.getElementById('audioCheckbox')?.checked;
  const blockedByPermission = isKnown && enabledByToggle && audioEnabled && !hasPermission;
  if (blockedByPermission !== permissionIssueVisibleState.systemAudio) {
    permissionIssueVisibleState.systemAudio = blockedByPermission;
    if (blockedByPermission) {
      logAnalyticsEvent('permission_issue_visible', {
        type: 'systemAudio',
        platform: window.electronAPI.platform
      });
    }
  }

  const toggleLabel = checkbox.closest('.toggle');
  if (toggleLabel) {
    toggleLabel.title = blockedByPermission
      ? 'Enabled in settings, but currently blocked by missing meeting audio permission'
      : (!isKnown
        ? 'Meeting audio permission status is still being checked'
        : (hasPermission
        ? 'Meeting audio permission granted'
        : 'Meeting audio permission required for effective capture'));
  }

  const recheckBtn = document.getElementById('recheckSystemAudioPermissionBtn');
  if (recheckBtn) recheckBtn.classList.toggle('hidden', !blockedByPermission);
}

/**
 * Mirrors the other four checkbox updaters, with one extra axis: a missing
 * fingerprint is only worth a Settings button when the cause is a refusal.
 *
 * @param {boolean|null} hasPermission - null while the status is still unknown.
 * @param {string|null} reason
 */
function updateLocationCheckbox(hasPermission, reason = null) {
  const checkbox = document.getElementById('locationCheckbox');
  if (!checkbox) return;

  const isKnown = typeof hasPermission === 'boolean';
  if (isKnown) {
    checkbox.dataset.permissionGranted = hasPermission ? 'true' : 'false';
  }

  const enabledByToggle = !!checkbox.checked;
  const blockedByPermission =
    isKnown && enabledByToggle && !hasPermission && LOCATION_BLOCKING_REASONS.has(reason);
  const actionable = blockedByPermission && LOCATION_ACTIONABLE_REASONS.has(reason);

  if (blockedByPermission !== permissionIssueVisibleState.location) {
    permissionIssueVisibleState.location = blockedByPermission;
    if (blockedByPermission) {
      logAnalyticsEvent('permission_issue_visible', {
        type: 'location',
        platform: window.electronAPI.platform
      });
    }
  }

  const toggleLabel = checkbox.closest('.toggle');
  if (toggleLabel) {
    toggleLabel.title = blockedByPermission
      ? 'Enabled in settings, but currently blocked by missing location permission'
      : (!isKnown
        ? 'Location permission status is still being checked'
        : (hasPermission
          ? 'Location permission granted'
          : 'Location permission required to read nearby networks'));
  }

  // The note speaks for both axes; the button only for the actionable one.
  const note = document.getElementById('locationPermissionNote');
  if (note) {
    const message = enabledByToggle && reason && reason !== 'notDetermined'
      ? (LOCATION_NOTE_MESSAGES[reason] || LOCATION_NOTE_MESSAGES.unavailable)
      : null;
    note.textContent = message || '';
    note.classList.toggle('hidden', !message);
  }

  const recheckBtn = document.getElementById('recheckLocationPermissionBtn');
  if (recheckBtn) recheckBtn.classList.toggle('hidden', !actionable);
}

function setupScreenCaptureCheckboxBehavior() {
  const checkbox = document.getElementById('screenCheckbox');
  if (!checkbox) return;

  checkbox.addEventListener('change', async () => {
    const enabled = !!checkbox.checked;
    const result = await handleCaptureToggleIntent('screen', enabled);
    if (result?.reverted) {
      checkbox.checked = !enabled;
      updateScreenCaptureCheckbox(checkbox.dataset.permissionGranted === 'true');
      emitCaptureStateUpdated();
      return;
    }
    updateScreenCaptureCheckbox(checkbox.dataset.permissionGranted === 'true');
    if (enabled) {
      requestScreenCapturePermission();
    }
    emitCaptureStateUpdated();
  });

}

function setupWindowsCheckboxBehavior() {
  const checkbox = document.getElementById('windowsCheckbox');
  if (!checkbox) return;

  checkbox.addEventListener('change', async () => {
    if (isWaylandLinuxSession()) {
      checkbox.checked = false;
      updateWindowsCheckbox(false);
      emitCaptureStateUpdated();
      return;
    }
    const enabled = !!checkbox.checked;
    const result = await handleCaptureToggleIntent('windows', enabled);
    if (result?.reverted) {
      checkbox.checked = !enabled;
      updateWindowsCheckbox(checkbox.dataset.permissionGranted === 'true');
      emitCaptureStateUpdated();
      return;
    }
    updateWindowsCheckbox(checkbox.dataset.permissionGranted === 'true');
    if (enabled) {
      requestWindowsPermission(true);
    }
    emitCaptureStateUpdated();
  });
}

function setupAudioCheckboxBehavior() {
  const checkbox = document.getElementById('audioCheckbox');
  if (!checkbox) return;

  checkbox.addEventListener('change', async () => {
    const enabled = !!checkbox.checked;
    const result = await handleCaptureToggleIntent('audio', enabled);
    if (result?.reverted) {
      checkbox.checked = !enabled;
      emitCaptureStateUpdated();
      return;
    }
    updateMicrophoneCheckbox(checkbox.dataset.permissionGranted === 'true');
    const systemAudioCheckbox = document.getElementById('systemAudioCheckbox');
    if (systemAudioCheckbox) {
      updateSystemAudioCheckbox(readPermissionDataset(systemAudioCheckbox));
    }
    if (enabled) {
      requestMicrophonePermission();
    }
    emitCaptureStateUpdated();
  });
}

function setupSystemAudioCheckboxBehavior() {
  const checkbox = document.getElementById('systemAudioCheckbox');
  if (!checkbox) return;

  checkbox.addEventListener('change', async () => {
    const enabled = !!checkbox.checked;
    const result = await handleCaptureToggleIntent('systemAudio', enabled);
    if (result?.reverted) {
      checkbox.checked = !enabled;
      updateSystemAudioCheckbox(readPermissionDataset(checkbox));
      emitCaptureStateUpdated();
      return;
    }
    updateSystemAudioCheckbox(readPermissionDataset(checkbox));
    if (enabled) {
      requestSystemAudioPermission(true);
    }
    emitCaptureStateUpdated();
  });
}

function setupLocationCheckboxBehavior() {
  const checkbox = document.getElementById('locationCheckbox');
  if (!checkbox) return;

  // Only macOS gates SSID reads behind Location; elsewhere the sentence would
  // describe a prompt that never appears.
  if (window.electronAPI.platform === 'darwin') {
    const macNote = document.getElementById('locationMacNote');
    if (macNote) macNote.classList.remove('hidden');
  }

  checkbox.addEventListener('change', async () => {
    const enabled = !!checkbox.checked;
    const result = await handleCaptureToggleIntent('location', enabled);
    if (result?.reverted) {
      checkbox.checked = !enabled;
      updateLocationCheckbox(readPermissionDataset(checkbox), lastLocationReason);
      emitCaptureStateUpdated();
      return;
    }

    updateLocationCheckbox(readPermissionDataset(checkbox), lastLocationReason);
    if (enabled) {
      requestLocationPermission();
    }
    emitCaptureStateUpdated();
  });
}

/**
 * Runs once the server-side feature flag is known — not on the startup sweep.
 * Before the flag arrives the main process answers `disabled` without spawning
 * the helper, so an unconditional startup check would only ever learn nothing.
 */
function setupLocationStartupCheck() {
  document.addEventListener('location-feature-changed', (event) => {
    // A logout clears the flag; re-arm so the next session checks again.
    if (event?.detail?.enabled !== true) {
      locationStartupCheckDone = false;
      return;
    }
    // Nobody who left the toggle off should pay for a helper spawn, or see a
    // prompt they never asked for.
    if (event.detail.capturing !== true) return;
    if (locationStartupCheckDone) return;

    locationStartupCheckDone = true;
    checkLocationPermissionPassively();
  });
}

async function checkLocationPermissionPassively() {
  let result;
  try {
    result = await ipcRenderer.invoke('checkLocationPermission');
  } catch (_) {
    return;
  }

  // A helper that timed out reports `unavailable`, which is strictly less
  // informative than a refusal already on record. Letting it through would
  // replace "Location access is off" with "Couldn't read nearby networks" —
  // turning a fixable, actionable state into a shrug.
  if (result?.reason === 'unavailable' && LOCATION_BLOCKING_REASONS.has(lastLocationReason)) {
    return;
  }

  applyLocationPermissionUpdate(result, 'startup-passive-check');
}

function setupPermissionRecheckButtons() {
  const recheckScreenBtn = document.getElementById('recheckScreenPermissionBtn');
  if (recheckScreenBtn) {
    recheckScreenBtn.addEventListener('click', () => {
      logAnalyticsEvent('permission_recheck_clicked', {
        type: 'screen',
        platform: window.electronAPI.platform
      });
      requestScreenCapturePermission();
    });
  }

  const recheckWindowsBtn = document.getElementById('recheckWindowsPermissionBtn');
  if (recheckWindowsBtn) {
    if (isWaylandLinuxSession()) {
      recheckWindowsBtn.classList.add('hidden');
    } else {
      recheckWindowsBtn.addEventListener('click', () => {
        logAnalyticsEvent('permission_recheck_clicked', {
          type: 'windows',
          platform: window.electronAPI.platform
        });
        requestWindowsPermission(true);
      });
    }
  }

  const recheckMicrophoneBtn = document.getElementById('recheckMicrophonePermissionBtn');
  if (recheckMicrophoneBtn) {
    recheckMicrophoneBtn.addEventListener('click', () => {
      logAnalyticsEvent('permission_recheck_clicked', {
        type: 'microphone',
        platform: window.electronAPI.platform
      });
      requestMicrophonePermission();
    });
  }

  const recheckSystemAudioBtn = document.getElementById('recheckSystemAudioPermissionBtn');
  if (recheckSystemAudioBtn) {
    recheckSystemAudioBtn.addEventListener('click', () => {
      logAnalyticsEvent('permission_recheck_clicked', {
        type: 'systemAudio',
        platform: window.electronAPI.platform
      });
      requestSystemAudioPermission(true);
    });
  }

  const recheckLocationBtn = document.getElementById('recheckLocationPermissionBtn');
  if (recheckLocationBtn) {
    recheckLocationBtn.addEventListener('click', () => {
      logAnalyticsEvent('permission_recheck_clicked', {
        type: 'location',
        platform: window.electronAPI.platform
      });
      requestLocationPermission();
    });
  }
}

function requestMicrophonePermission() {
  logAnalyticsEvent('microphone_capture_requested', {
    status: 'requested',
    platform: window.electronAPI.platform
  });
  ipcRenderer.send('requestMicrophonePermission', true);
}

function requestWindowsPermission(shouldOpenSettings = true) {
  if (isWaylandLinuxSession()) {
    applyWindowsPermissionUpdate(false, false, 'wayland-forced-disabled');
    return;
  }
  logAnalyticsEvent('windows_capture_requested', {
    status: 'requested',
    platform: window.electronAPI.platform
  });
  ipcRenderer.send('requestWindowsPermission', shouldOpenSettings);
}

function requestScreenCapturePermission() {
  logAnalyticsEvent('screen_capture_requested', {
    status: 'requested',
    platform: window.electronAPI.platform
  });
  ipcRenderer.send('requestScreenCapturePermission', true);
}

function requestLocationPermission() {
  logAnalyticsEvent('location_capture_requested', {
    status: 'requested',
    platform: window.electronAPI.platform
  });
  ipcRenderer.send('requestLocationPermission');
}

function requestSystemAudioPermission(shouldOpenSettings = true) {
  logAnalyticsEvent('system_audio_capture_requested', {
    status: 'requested',
    platform: window.electronAPI.platform
  });
  ipcRenderer.send('requestSystemAudioPermission', shouldOpenSettings);
}

module.exports = {
  initializePermissions,
  requestMicrophonePermission,
  requestWindowsPermission
};
