const { ipcRenderer } = require("electron");
const { isAuthenticated, updateScreenCapturePermission } = require('./app-state.js');
const { logAnalyticsEvent } = require('./analytics.js');

const openSettingsBtn = document.getElementById("openSettingsBtn");

let navigateToView;

// Initialize permissions module
function initializePermissions(viewNavigator) {
  navigateToView = viewNavigator;
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

module.exports = { initializePermissions };

