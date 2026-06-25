const ipcRenderer = window.electronAPI;
const {
  updateScreenCapturePermission,
  updateWindowsPermission,
  updateMicrophonePermission,
  updateSystemAudioPermission,
  updatePermissionsReady,
  hasMicrophonePermission
} = require('./app-state.js');
const { logAnalyticsEvent } = require('./analytics.js');
const { handleCaptureToggleIntent } = require('./settings.js');

let navigateToView;
let updateTopbarVisibility;

const permissionStartupLoaded = {
  screen: false,
  windows: false
};

const permissionIssueVisibleState = {
  screen: false,
  windows: false,
  microphone: false,
  systemAudio: false
};
let hasRequestedInitialSystemAudioCheck = false;

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

function initializePermissions(viewNavigator, _currentViewGetter, topbarVisibilityUpdater) {
  navigateToView = viewNavigator;
  updateTopbarVisibility = topbarVisibilityUpdater;

  setupPlatformSpecificListeners();
  setupRuntimePermissionIssueListener();
  setupScreenCaptureCheckboxBehavior();
  setupWindowsCheckboxBehavior();
  setupAudioCheckboxBehavior();
  setupSystemAudioCheckboxBehavior();
  setupPermissionRecheckButtons();
  setupFinishButtonHandler();
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
  updateFinishButtonVisibility();
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
  updateFinishButtonVisibility();

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

function setupScreenCaptureCheckboxBehavior() {
  const checkbox = document.getElementById('screenCheckbox');
  if (!checkbox) return;

  checkbox.addEventListener('change', async () => {
    const enabled = !!checkbox.checked;
    const result = await handleCaptureToggleIntent('screen', enabled);
    if (result?.reverted) {
      checkbox.checked = !enabled;
      updateScreenCaptureCheckbox(checkbox.dataset.permissionGranted === 'true');
      updateFinishButtonVisibility();
      emitCaptureStateUpdated();
      return;
    }
    updateScreenCaptureCheckbox(checkbox.dataset.permissionGranted === 'true');
    updateFinishButtonVisibility();
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
      updateFinishButtonVisibility();
      emitCaptureStateUpdated();
      return;
    }
    updateWindowsCheckbox(checkbox.dataset.permissionGranted === 'true');
    updateFinishButtonVisibility();
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

function requestSystemAudioPermission(shouldOpenSettings = true) {
  logAnalyticsEvent('system_audio_capture_requested', {
    status: 'requested',
    platform: window.electronAPI.platform
  });
  ipcRenderer.send('requestSystemAudioPermission', shouldOpenSettings);
}

function updateFinishButtonVisibility() {
  const finishButtonContainer = document.getElementById('finishButtonContainer');
  if (!finishButtonContainer) return;
  finishButtonContainer.classList.remove('hidden');
}

function setupFinishButtonHandler() {
  const finishButton = document.getElementById('finishButton');
  if (!finishButton) return;

  finishButton.addEventListener('click', () => {
    logAnalyticsEvent('permissions_finished', {
      platform: window.electronAPI.platform
    });

    if (navigateToView) {
      navigateToView('dashboard');
    }
  });
}

module.exports = {
  initializePermissions,
  requestMicrophonePermission,
  requestWindowsPermission,
  updateFinishButtonVisibility
};
