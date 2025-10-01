const { ipcRenderer } = require("electron");
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

  // Set up keystrokes checkbox behavior
  setupKeystrokesCheckboxBehavior();

  // Check permissions on startup
  checkPermissionsOnStartup();
}

// Check all permissions on startup to update state
function checkPermissionsOnStartup() {

  // Check Windows permission (don't open settings, just check current status)
  ipcRenderer.send('requestWindowsPermission', false);

  // Check other permissions as needed
  // (Audio and keystrokes might need different handling)
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

  ipcRenderer.on('linux-keystrokes-permission-notice', () => {
    showLinuxPermissionHelp('keystrokes');
    // Uncheck the keystrokes checkbox since it's not supported on Linux
    const keystrokesCheckbox = document.getElementById('keystrokesCheckbox');
    if (keystrokesCheckbox) {
      keystrokesCheckbox.checked = false;
      // Don't disable - allow user to try again if support is added
    }
    // Functionally disable keystrokes tracking
    ipcRenderer.send('updateInputDataSettings', { keystrokes: false });
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
  const platform = process.platform;
  if (platform !== 'linux') return;

  // Show inline notifications instead of modals
  switch (permissionType) {
    case 'audio':
      showInlineLinuxNotification('linuxWindowsSection');
      break;
    case 'keystrokes':
      showInlineLinuxNotification('linuxKeystrokesSection');
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

// Modify the existing screenCapturePermission listener to include session type
ipcRenderer.on('screenCapturePermission', (event, data) => {
  // Extract permission status and session type (if provided)
  const hasPermission = typeof data === 'object' ? data.hasPermission : data;
  const isWaylandSession = typeof data === 'object' ? data.isWaylandSession : null;

  updateScreenCapturePermission(hasPermission);

  // Log screen capture permission status
  logAnalyticsEvent('screen_capture_permission', {
    status: hasPermission ? 'granted' : 'denied',
    platform: process.platform,
    is_wayland: isWaylandSession
  });

  // Update UI based on permission status
  if (!hasPermission && process.platform === 'linux' && isWaylandSession !== null) {
    updateLinuxInstructions(isWaylandSession);
  }

  // Update screen capture checkbox in settings if we're on settings view
  updateScreenCaptureCheckbox(hasPermission);

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
    platform: process.platform
  });
  // Notify settings component about permission status
  document.dispatchEvent(new CustomEvent('permissionResult', {
    detail: { type: 'audio', hasPermission }
  }));
});

ipcRenderer.on('keystrokesPermission', (event, hasPermission) => {
  logAnalyticsEvent('keystrokes_permission', {
    status: hasPermission ? 'granted' : 'denied',
    platform: process.platform
  });
  // Notify settings component about permission status
  document.dispatchEvent(new CustomEvent('permissionResult', {
    detail: { type: 'keystrokes', hasPermission }
  }));
});

ipcRenderer.on('windowsPermission', (event, hasPermission) => {
  updateWindowsPermission(hasPermission);

  // Log windows permission status
  logAnalyticsEvent('windows_permission', {
    status: hasPermission ? 'granted' : 'denied',
    platform: process.platform
  });

  // Update windows checkbox in settings if we're on settings view
  updateWindowsCheckbox(hasPermission);

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

// Simplified function to update Linux installation instructions
function updateLinuxInstructions(isWaylandSession) {
  const linuxInstallSection = document.getElementById('linuxInstallSection');

  // Show Linux install instructions
  if (linuxInstallSection) {
    linuxInstallSection.classList.remove('hidden');
  }

  // Hide all instruction sets first
  const waylandInstructions = document.getElementById('waylandInstructions');
  const x11Instructions = document.getElementById('x11Instructions');

  if (waylandInstructions) waylandInstructions.classList.add('hidden');
  if (x11Instructions) x11Instructions.classList.add('hidden');

  // Show appropriate instructions based on session type
  if (isWaylandSession) {
    if (waylandInstructions) waylandInstructions.classList.remove('hidden');
  } else {
    if (x11Instructions) x11Instructions.classList.remove('hidden');
  }
}

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
          platform: process.platform
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
        platform: process.platform
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
          platform: process.platform
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

// Set up keystrokes checkbox behavior
function setupKeystrokesCheckboxBehavior() {
  const checkbox = document.getElementById('keystrokesCheckbox');
  if (!checkbox) return;

  const handleCheckboxChange = async (isChecked) => {
    const originalValue = checkbox.checked;

    if (isChecked) {
      // Revert checkbox state immediately - will be re-enabled by permission listener if granted
      checkbox.checked = false;
      // Request permission and wait for the result
      requestKeystrokesPermission();
    } else {
      // If turning OFF, update setting immediately - no permission needed
      try {
        // Dispatch custom event to notify settings.js to save the state
        document.dispatchEvent(new CustomEvent('permissionResult', {
          detail: { type: 'keystrokes', hasPermission: false }
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
    platform: process.platform
  });
  ipcRenderer.send("requestAudioPermission");
}

function requestKeystrokesPermission() {
  logAnalyticsEvent('keystrokes_capture_requested', {
    status: 'requested',
    platform: process.platform
  });
  ipcRenderer.send("requestKeystrokesPermission");
}

function requestWindowsPermission() {
  logAnalyticsEvent('windows_capture_requested', {
    status: 'requested',
    platform: process.platform
  });
  ipcRenderer.send("requestWindowsPermission");
}

module.exports = {
  initializePermissions,
  requestAudioPermission,
  requestKeystrokesPermission,
  requestWindowsPermission
};

