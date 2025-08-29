const { ipcRenderer } = require("electron");
const { updateScreenCapturePermission, hasScreenCapturePermission } = require('./app-state.js');
const { logAnalyticsEvent } = require('./analytics.js');

const openSettingsBtn = document.getElementById("openSettingsBtn");

let navigateToView;
let getCurrentView;

// Initialize permissions module
function initializePermissions(viewNavigator, currentViewGetter) {
  navigateToView = viewNavigator;
  getCurrentView = currentViewGetter;
  
  // Set up event listeners for platform-specific permission issues
  setupPlatformSpecificListeners();
  
  // Set up screen capture checkbox behavior
  setupScreenCaptureCheckboxBehavior();
}

// Set up event listeners for platform-specific permission troubleshooting
function setupPlatformSpecificListeners() {
  // Listen for Linux-specific permission notices
  ipcRenderer.on('linux-windows-permission-notice', () => {
    showLinuxPermissionHelp('windows');
  });
  
  ipcRenderer.on('linux-audio-permission-notice', () => {
    showLinuxPermissionHelp('audio');
  });
  
  ipcRenderer.on('linux-keystrokes-permission-notice', () => {
    showLinuxPermissionHelp('keystrokes');
  });
}

// Function to show Linux permission help
function showLinuxPermissionHelp(permissionType) {
  const platform = process.platform;
  if (platform !== 'linux') return;
  
  let title, message;
  
  switch (permissionType) {
    case 'audio':
      title = 'Audio Permission Required';
      message = 'DoneThat needs permission to access your microphone.';
      break;
    case 'keystrokes':
      title = 'Keystroke Logging Permission Required';
      message = 'DoneThat needs permission to monitor keystrokes.';
      break;
    case 'windows':
      title = 'Window Tracking Permission Required';
      message = 'DoneThat needs permission to track active windows.';
      break;
    default:
      return;
  }
  
  // Create modal dialog for detailed help
  const modalBackground = document.createElement('div');
  modalBackground.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
  
  const modalContent = document.createElement('div');
  modalContent.className = 'bg-white rounded-lg p-6 max-w-lg mx-4';
  
  // For keystrokes permission, include clear instructions for running with sudo
  if (permissionType === 'keystrokes') {
    modalContent.innerHTML = `
      <h3 class="text-lg font-medium mb-4">${title}</h3>
      <p class="mb-3">Keystroke tracking is currently not supported on Linux.</p>
      
      <div class="p-4 bg-gray-100 rounded-lg mb-4">
        <p class="font-medium mb-2">Limitations on Linux:</p>
        <ul class="list-disc pl-5 mt-2 space-y-1">
          <li>Keystroke tracking is not available when running as an AppImage on Linux</li>
          <li>Other features of DoneThat will continue to work normally</li>
          <li>You can still use window tracking and audio recording features</li>
        </ul>
      </div>
      
      <div class="flex justify-end">
        <button id="permHelpCloseBtn" class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded">
          Got it
        </button>
      </div>
    `;
  } else if (permissionType === 'audio') {
    modalContent.innerHTML = `
      <h3 class="text-lg font-medium mb-4">${title}</h3>
      <p class="mb-3">${message}</p>
      
      <div class="p-4 bg-gray-100 rounded-lg mb-4">
        <p class="font-medium mb-2">On Linux:</p>
        <ul class="list-disc pl-5 mt-2 space-y-1">
          <li>Grant microphone access in your system settings</li>
          <li>For Wayland sessions, ensure your browser/Electron has audio permissions</li>
          <li>Check that your microphone is not being used by other applications</li>
        </ul>
      </div>
      
      <div class="flex justify-end">
        <button id="permHelpCloseBtn" class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded">
          Got it
        </button>
      </div>
    `;
  } else if (permissionType === 'windows') {
    modalContent.innerHTML = `
      <h3 class="text-lg font-medium mb-4">${title}</h3>
      <p class="mb-3">${message}</p>
      
      <div class="p-4 bg-gray-100 rounded-lg mb-4">
        <p class="font-medium mb-2">On Linux:</p>
        <ul class="list-disc pl-5 mt-2 space-y-1">
          <li>Grant accessibility permissions in your system settings</li>
          <li>For Wayland sessions, some window tracking features may be limited</li>
          <li>Ensure DoneThat has permission to access window information</li>
        </ul>
      </div>
      
      <div class="flex justify-end">
        <button id="permHelpCloseBtn" class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded">
          Got it
        </button>
      </div>
    `;
  }
  
  modalBackground.appendChild(modalContent);
  document.body.appendChild(modalBackground);
  
  // Add event listener to close button
  document.getElementById('permHelpCloseBtn').addEventListener('click', () => {
    document.body.removeChild(modalBackground);
    
    // Also update the relevant setting
    document.dispatchEvent(new CustomEvent('permissionResult', {
      detail: { type: permissionType, hasPermission: false }
    }));
  });
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
    
    // Only navigate if we're not already on settings view
    const currentView = getCurrentView ? getCurrentView() : null;
    if (currentView !== 'settings') {
      navigateToView('signup-next');
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
  logAnalyticsEvent('windows_permission', {
    status: hasPermission ? 'granted' : 'denied',
    platform: process.platform
  });
  // Notify settings component about permission status
  document.dispatchEvent(new CustomEvent('permissionResult', {
    detail: { type: 'windows', hasPermission }
  }));
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

