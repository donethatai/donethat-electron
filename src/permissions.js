const ipcRenderer = window.electronAPI;
const { updateScreenCapturePermission, updateWindowsPermission, hasScreenCapturePermission, hasWindowsPermission } = require('./app-state.js');
const { logAnalyticsEvent } = require('./analytics.js');

const openSettingsBtn = document.getElementById("openSettingsBtn");

let navigateToView;
let getCurrentView;
let updateTopbarVisibility;
let lastWindowsPermFocusTs = 0; // throttle focusing app on permission loss

// Initialize permissions module
function initializePermissions(viewNavigator, currentViewGetter, topbarVisibilityUpdater) {
  navigateToView = viewNavigator;
  getCurrentView = currentViewGetter;
  updateTopbarVisibility = topbarVisibilityUpdater;

  // Set up event listeners for platform-specific permission issues
  setupPlatformSpecificListeners();

  // Set up screen capture checkbox behavior
  setupScreenCaptureCheckboxBehavior();

  // Set up windows checkbox behavior
  setupWindowsCheckboxBehavior();

  // Set up audio checkbox behavior
  setupAudioCheckboxBehavior();

  // Check permissions on startup
  checkPermissionsOnStartup();
  
  // Set up finish button handler
  setupFinishButtonHandler();
}

// Check all permissions on startup to update state
function checkPermissionsOnStartup() {
  // NEW, TODO CHECK
  ipcRenderer.send('requestScreenCapturePermission');

  // Check Windows permission (don't open settings, just check current status)
  ipcRenderer.send('requestWindowsPermission', false);

  // Check other permissions as needed
  // (Audio might need different handling)
}

// Set up event listeners for platform-specific permission troubleshooting
function setupPlatformSpecificListeners() {
  // Listen for Linux-specific permission notices
  ipcRenderer.on('linux-windows-permission-notice', () => {
    showLinuxPermissionHelp('windows');
    // Uncheck the windows checkbox since permission is required
    const windowsCheckbox = document.getElementById('windowsCheckbox');
    if (windowsCheckbox) {
      windowsCheckbox.checked = false;
      // Don't disable - allow user to try again after granting permission
    }
    // Functionally disable windows tracking
    ipcRenderer.send('updateInputDataSettings', { windows: false });
  });

  ipcRenderer.on('linux-audio-permission-notice', () => {
    showLinuxPermissionHelp('audio');
  });

  ipcRenderer.on('linux-pactl-missing-notice', () => {
    showLinuxPermissionHelp('pactl');
    // Uncheck the audio checkbox since audio session detection won't work
    const audioCheckbox = document.getElementById('audioCheckbox');
    if (audioCheckbox) {
      audioCheckbox.checked = false;
      // Don't disable - allow user to try again after installing pactl
    }
    // Functionally disable audio tracking
    ipcRenderer.send('updateInputDataSettings', { audio: false });
  });
}

// Function to show Linux permission help
function showLinuxPermissionHelp(permissionType) {
  const platform = window.electronAPI.platform;
  if (platform !== 'linux') return;

  // Show inline notifications instead of modals
  switch (permissionType) {
    case 'audio':
      showInlineLinuxNotification('linuxWindowsSection');
      break;
    case 'windows':
      showInlineLinuxNotification('linuxWindowsSection');
      break;
    case 'pactl':
      showInlineLinuxNotification('linuxPactlSection');
      break;
    default:
      return;
  }
}

// Function to show inline Linux notifications
function showInlineLinuxNotification(sectionId) {
  const section = document.getElementById(sectionId);
  if (section) {
    section.classList.remove('hidden');
  }
}

// Function to show custom screenshot section on Linux
function showLinuxScreenshotSection() {
  const platform = window.electronAPI.platform;
  if (platform !== 'linux') return;

  const linuxScreenshotSection = document.getElementById('linuxScreenshotSection');
  if (linuxScreenshotSection) {
    linuxScreenshotSection.classList.remove('hidden');
  }
}

// Screen capture permission listener
ipcRenderer.on('screenCapturePermission', (event, data) => {
  // Extract permission status
  const hasPermission = typeof data === 'object' ? data.hasPermission : data;

  updateScreenCapturePermission(hasPermission);

  // Log screen capture permission status
  logAnalyticsEvent('screen_capture_permission', {
    status: hasPermission ? 'granted' : 'denied',
    platform: window.electronAPI.platform
  });

  // Show custom screenshot section on Linux (regardless of permission status)
  if (window.electronAPI.platform === 'linux') {
    showLinuxScreenshotSection();
  }

  // Update screen capture checkbox in settings if we're on settings view
  updateScreenCaptureCheckbox(hasPermission);

  // Update finish button visibility
  updateFinishButtonVisibility();

  // Update topbar visibility
  if (updateTopbarVisibility) updateTopbarVisibility();

  // If screen recording permission is missing, ensure app window is shown
  try {
    if (!hasPermission) {
      ipcRenderer.send('focus-app-window');
    }
  } catch (_) {}

  // Navigate to signup-next only when screen recording is missing
  if (!hasPermission) {
    const currentView = getCurrentView ? getCurrentView() : null;
    if (currentView !== 'settings') {
      navigateToView('signup-next');
    }
  }
});

// Add listeners for other permission types
ipcRenderer.on('audioPermission', (event, hasPermission) => {
  logAnalyticsEvent('audio_permission', {
    status: hasPermission ? 'granted' : 'denied',
    platform: window.electronAPI.platform
  });
  // Notify settings component about permission status
  document.dispatchEvent(new CustomEvent('permissionResult', {
    detail: { type: 'audio', hasPermission }
  }));
});

ipcRenderer.on('windowsPermission', (event, hasPermission) => {
  updateWindowsPermission(hasPermission);

  // Log windows permission status
  logAnalyticsEvent('windows_permission', {
    status: hasPermission ? 'granted' : 'denied',
    platform: window.electronAPI.platform
  });

  // Update windows checkbox in settings if we're on settings view
  updateWindowsCheckbox(hasPermission);

  // Update finish button visibility
  updateFinishButtonVisibility();

  // Notify settings component about permission status
  document.dispatchEvent(new CustomEvent('permissionResult', {
    detail: { type: 'windows', hasPermission }
  }));

  // Update topbar visibility
  if (updateTopbarVisibility) updateTopbarVisibility();
  // Bring app to front on permission loss, but throttle to avoid churn during revocation
  if (!hasPermission) {
    const now = Date.now();
    if (now - lastWindowsPermFocusTs > 2000) {
      lastWindowsPermFocusTs = now;
      // Fail silently
      // try { ipcRenderer.send('focus-app-window'); } catch (_) {}
      // Navigate to settings if not already there (slight delay to avoid event ordering issues)
      try {
        const currentView = getCurrentView ? getCurrentView() : null;
        if (currentView !== 'settings') {
          setTimeout(() => { try { navigateToView('settings'); } catch (_) {} }, 150);
        }
      } catch (_) {}
    }
    // Tell main to keep the capture interval paused for a short duration
    try { ipcRenderer.send('pause-capture-due-to-permission', { source: 'windows', ms: 3000 }); } catch (_) {}
  }
});


// Function to update screen capture checkbox in settings
function updateScreenCaptureCheckbox(hasPermission) {
  const checkbox = document.getElementById('screenCheckbox');
  if (!checkbox) return;

  const toggleLabel = checkbox.closest('.toggle');

  try {
    // Show checked when we have permission; unchecked when not.
    checkbox.checked = !!hasPermission;

    if (!hasPermission) {
      // Permission missing: enable toggle and make it look clickable
      checkbox.disabled = false;
      if (toggleLabel) {
        // Rely on CSS for visuals; reset any inline styles from prior state
        toggleLabel.style.opacity = '';
        toggleLabel.style.cursor = 'pointer';
        toggleLabel.title = 'Grant screen recording permission';
      }
    } else {
      // Permission granted: disable toggle and use CSS-driven disabled visuals
      checkbox.disabled = true;
      if (toggleLabel) {
        // Reset inline opacity to ensure consistent color with other toggles
        toggleLabel.style.opacity = '';
        toggleLabel.style.cursor = 'not-allowed';
        toggleLabel.title = 'Screen recording enabled (managed by system)';
      }
    }
  } catch (error) {
    console.error('Error updating screen capture checkbox:', error);
  }
}

// Function to update windows checkbox in settings
function updateWindowsCheckbox(hasPermission) {
  const checkbox = document.getElementById('windowsCheckbox');
  if (!checkbox) return;

  const toggleLabel = checkbox.closest('.toggle');

  try {
    // Show checked when we have permission; unchecked when not.
    checkbox.checked = !!hasPermission;

    if (!hasPermission) {
      // Permission missing: enable toggle and make it look clickable
      checkbox.disabled = false;
      if (toggleLabel) {
        // Rely on CSS for visuals; reset any inline styles from prior state
        toggleLabel.style.opacity = '';
        toggleLabel.style.cursor = 'pointer';
        toggleLabel.title = 'Grant active applications permission';
      }
    } else {
      // Permission granted: disable toggle and use CSS-driven disabled visuals
      checkbox.disabled = true;
      if (toggleLabel) {
        // Reset inline opacity to ensure consistent color with other toggles
        toggleLabel.style.opacity = '';
        toggleLabel.style.cursor = 'not-allowed';
        toggleLabel.title = 'Active applications enabled (managed by system)';
      }
    }
  } catch (error) {
    console.error('Error updating windows checkbox:', error);
  }
}

// Set up screen capture checkbox behavior
function setupScreenCaptureCheckboxBehavior() {
  const checkbox = document.getElementById('screenCheckbox');
  if (!checkbox) return;

  const toggleLabel = checkbox.closest('.toggle');

  // When user clicks the toggle area, open system settings
  if (toggleLabel) {
    toggleLabel.addEventListener('click', (e) => {
      if (!hasScreenCapturePermission()) {
        e.preventDefault();
        e.stopPropagation();
        // Log and request permission via system settings
        logAnalyticsEvent('screen_capture_requested', {
          status: 'requested',
          platform: window.electronAPI.platform
        });
        ipcRenderer.send('requestScreenCapturePermission');
      }
      // When permission exists, the toggle is disabled so clicks are ignored
    });
  }

  // Handle permission buttons
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener("click", () => {
      // Log that user requested screen capture permission
      logAnalyticsEvent('screen_capture_requested', {
        status: 'requested',
        platform: window.electronAPI.platform
      });
      ipcRenderer.send("requestScreenCapturePermission");
    });
  }
}

// Set up windows checkbox behavior
function setupWindowsCheckboxBehavior() {
  const checkbox = document.getElementById('windowsCheckbox');
  if (!checkbox) return;

  const toggleLabel = checkbox.closest('.toggle');

  // When user clicks the toggle area, open system settings
  if (toggleLabel) {
    toggleLabel.addEventListener('click', (e) => {
      if (!hasWindowsPermission()) {
        e.preventDefault();
        e.stopPropagation();
        // Log and request permission via system settings
        logAnalyticsEvent('windows_capture_requested', {
          status: 'requested',
          platform: window.electronAPI.platform
        });
        ipcRenderer.send('requestWindowsPermission');
      }
      // When permission exists, the toggle is disabled so clicks are ignored
    });
  }
}

// Set up audio checkbox behavior
function setupAudioCheckboxBehavior() {
  const checkbox = document.getElementById('audioCheckbox');
  if (!checkbox) return;

  const handleCheckboxChange = async (isChecked) => {
    const originalValue = checkbox.checked;

    if (isChecked) {
      // Revert checkbox state immediately - will be re-enabled by permission listener if granted
      checkbox.checked = false;
      // Request permission and wait for the result
      requestAudioPermission();
    } else {
      // If turning OFF, update setting immediately - no permission needed
      try {
        // Dispatch custom event to notify settings.js to save the state
        document.dispatchEvent(new CustomEvent('permissionResult', {
          detail: { type: 'audio', hasPermission: false }
        }));
      } catch (error) {
        // Revert UI on error
        checkbox.checked = originalValue;
      }
    }
  };

  checkbox.addEventListener('change', () => {
    handleCheckboxChange(checkbox.checked);
  });
}

// Functions to request permissions for each capture type
function requestAudioPermission() {
  logAnalyticsEvent('audio_capture_requested', {
    status: 'requested',
    platform: window.electronAPI.platform
  });
  ipcRenderer.send("requestAudioPermission");
}

function requestWindowsPermission() {
  logAnalyticsEvent('windows_capture_requested', {
    status: 'requested',
    platform: window.electronAPI.platform
  });
  ipcRenderer.send("requestWindowsPermission");
}

function requestSystemAudioPermission() {
  logAnalyticsEvent('system_audio_capture_requested', {
    status: 'requested',
    platform: window.electronAPI.platform
  });
  ipcRenderer.send("requestSystemAudioPermission");
}

// Helper function to check if running on Wayland
function isWayland() {
  return window.electronAPI.isWayland;
}

// Function to update finish button visibility based on required permissions
function updateFinishButtonVisibility() {
  const finishButtonContainer = document.getElementById('finishButtonContainer');
  if (!finishButtonContainer) return;

  // Check the actual checkbox states
  const screenToggle = document.getElementById('screenCheckbox');
  const windowsToggle = document.getElementById('windowsCheckbox');
  
  if (!screenToggle || !windowsToggle) return;

  const screenChecked = screenToggle.checked;
  const windowsChecked = windowsToggle.checked;

  // On Wayland, only require screen permission (windows detection doesn't work properly)
  // On other platforms, require both permissions
  const shouldShow = isWayland() ? screenChecked : (screenChecked && windowsChecked);

  if (shouldShow) {
    finishButtonContainer.classList.remove('hidden');
  } else {
    finishButtonContainer.classList.add('hidden');
  }
}

// Set up finish button click handler
function setupFinishButtonHandler() {
  const finishButton = document.getElementById('finishButton');
  if (!finishButton) return;

  finishButton.addEventListener('click', () => {
    // Log analytics event
    logAnalyticsEvent('permissions_finished', {
      platform: window.electronAPI.platform
    });
    
    // Navigate to dashboard
    if (navigateToView) {
      navigateToView('dashboard');
    }
  });
}

module.exports = {
  initializePermissions,
  requestAudioPermission,
  requestWindowsPermission,
  requestSystemAudioPermission,
  updateFinishButtonVisibility
};

