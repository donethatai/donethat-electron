const ipcRenderer = window.electronAPI;
const {
  updateScreenCapturePermission,
  updateWindowsPermission,
  updateMicrophonePermission,
  updatePermissionsReady,
  hasScreenCapturePermission,
  hasWindowsPermission,
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

function emitCaptureStateUpdated() {
  document.dispatchEvent(new CustomEvent('capture-state-updated'));
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
  setupScreenCaptureCheckboxBehavior();
  setupWindowsCheckboxBehavior();
  setupAudioCheckboxBehavior();
  setupFinishButtonHandler();

  checkPermissionsOnStartup();
}

function checkPermissionsOnStartup() {
  ipcRenderer.send('checkScreenCapturePermission');

  retryWindowsPermissionStartupCheck().then((hasPermission) => {
    applyWindowsPermissionUpdate(!!hasPermission, true, 'startup-passive-check');
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

function setupPlatformSpecificListeners() {
  ipcRenderer.on('linux-windows-permission-notice', () => {
    showLinuxPermissionHelp('windows');
  });

  ipcRenderer.on('linux-audio-permission-notice', () => {
    showLinuxPermissionHelp('audio');
  });

  ipcRenderer.on('linux-pactl-missing-notice', () => {
    showLinuxPermissionHelp('pactl');
    const audioCheckbox = document.getElementById('audioCheckbox');
    if (audioCheckbox) {
      audioCheckbox.checked = false;
    }
    handleCaptureToggleIntent('audio', false).catch(() => {});
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

  document.dispatchEvent(new CustomEvent('permissionResult', {
    detail: { type: 'windows', hasPermission }
  }));

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

  document.dispatchEvent(new CustomEvent('permissionResult', {
    detail: { type: 'audio', hasPermission: !!hasPermission }
  }));

  emitCaptureStateUpdated();
}

ipcRenderer.on('screenCapturePermission', (_event, data) => {
  handleIncomingPermissionEvent('screen', data, applyScreenPermissionUpdate, {
    defaultSource: 'screen-channel',
    fromStartup: true
  });
});

ipcRenderer.on('microphonePermission', (_event, data) => {
  handleIncomingPermissionEvent('microphone', data, applyMicrophonePermissionUpdate, {
    defaultSource: 'microphone-channel',
    fromStartup: false
  });
});

ipcRenderer.on('windowsPermission', (_event, data) => {
  handleIncomingPermissionEvent('windows', data, applyWindowsPermissionUpdate, {
    defaultSource: 'windows-channel',
    fromStartup: false
  });
});

function updateScreenCaptureCheckbox(hasPermission) {
  const checkbox = document.getElementById('screenCheckbox');
  if (!checkbox) return;

  checkbox.dataset.permissionGranted = hasPermission ? 'true' : 'false';

  const toggleLabel = checkbox.closest('.toggle');
  if (toggleLabel) {
    toggleLabel.title = hasPermission
      ? 'Screen permission granted'
      : 'Screen permission required for effective capture';
  }
}

function updateWindowsCheckbox(hasPermission) {
  const checkbox = document.getElementById('windowsCheckbox');
  if (!checkbox) return;

  checkbox.dataset.permissionGranted = hasPermission ? 'true' : 'false';

  const toggleLabel = checkbox.closest('.toggle');
  if (toggleLabel) {
    toggleLabel.title = hasPermission
      ? 'Active applications permission granted'
      : 'Active applications permission required for effective capture';
  }
}

function setupScreenCaptureCheckboxBehavior() {
  const checkbox = document.getElementById('screenCheckbox');
  if (!checkbox) return;

  checkbox.addEventListener('change', async () => {
    const enabled = !!checkbox.checked;
    const result = await handleCaptureToggleIntent('screen', enabled);
    if (result?.reverted) {
      checkbox.checked = !enabled;
      updateFinishButtonVisibility();
      emitCaptureStateUpdated();
      return;
    }

    if (enabled && !hasScreenCapturePermission()) {
      requestScreenCapturePermission();
    }

    updateFinishButtonVisibility();
    emitCaptureStateUpdated();
  });

}

function setupWindowsCheckboxBehavior() {
  const checkbox = document.getElementById('windowsCheckbox');
  if (!checkbox) return;

  checkbox.addEventListener('change', async () => {
    const enabled = !!checkbox.checked;
    const result = await handleCaptureToggleIntent('windows', enabled);
    if (result?.reverted) {
      checkbox.checked = !enabled;
      updateFinishButtonVisibility();
      emitCaptureStateUpdated();
      return;
    }

    if (enabled && !hasWindowsPermission()) {
      requestWindowsPermission(true);
    }

    updateFinishButtonVisibility();
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

    if (enabled && !hasMicrophonePermission()) {
      requestMicrophonePermission();
    }

    emitCaptureStateUpdated();
  });
}

function requestMicrophonePermission() {
  logAnalyticsEvent('microphone_capture_requested', {
    status: 'requested',
    platform: window.electronAPI.platform
  });
  ipcRenderer.send('requestMicrophonePermission', true);
}

function requestWindowsPermission(shouldOpenSettings = true) {
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

function isWayland() {
  return window.electronAPI.isWayland;
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
  requestSystemAudioPermission,
  updateFinishButtonVisibility
};
