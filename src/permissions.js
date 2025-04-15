const { ipcRenderer } = require("electron");
const { isAuthenticated, updateScreenCapturePermission } = require('./app-state.js');
const { logAnalyticsEvent } = require('./analytics.js');

const openSettingsBtn = document.getElementById("openSettingsBtn");

let navigateToView;

// Initialize permissions module
function initializePermissions(viewNavigator) {
  navigateToView = viewNavigator;
  
  // Set up event listeners for platform-specific permission issues
  setupPlatformSpecificListeners();
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
  modalContent.innerHTML = `
    <h3 class="text-lg font-medium mb-4">${title}</h3>
    <p class="mb-3">${message}</p>
    
    <div class="p-4 bg-gray-100 rounded-lg mb-4">
      <p>On Linux, you may need to:</p>
      <ul class="list-disc pl-5 mt-2 space-y-1">
        <li>Install required packages: <code>wmctrl</code>, <code>xdotool</code>, or <code>evtest</code></li>
        <li>Ensure DoneThat has appropriate permissions</li>
        <li>For Wayland sessions, some features may have limited functionality</li>
      </ul>
    </div>
    
    <div class="flex justify-end">
      <button id="permHelpCloseBtn" class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded">
        Got it
      </button>
    </div>
  `;
  
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
    navigateToView('signup-next');
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

    const standardPermissionSection = document.getElementById('standardPermissionSection');
    const linuxInstallSection = document.getElementById('linuxInstallSection');
  
    // Show Linux install instructions
    standardPermissionSection.classList.add('hidden');
    linuxInstallSection.classList.remove('hidden');
  
    // Hide all instruction sets first
    const waylandInstructions = document.getElementById('waylandInstructions');
    const x11Instructions = document.getElementById('x11Instructions');
  
    waylandInstructions.classList.add('hidden');
    x11Instructions.classList.add('hidden');
  
    // Show appropriate instructions based on session type
    if (isWaylandSession) {
      waylandInstructions.classList.remove('hidden');
    } else {
      x11Instructions.classList.remove('hidden');
    }
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

