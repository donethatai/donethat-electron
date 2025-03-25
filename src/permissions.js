const { ipcRenderer } = require("electron");
const { isAuthenticated, updateScreenCapturePermission } = require('./app-state.js');

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
  
    // Update UI based on permission status
    if (isAuthenticated()) {
      if (hasPermission) {
        navigateToView('dashboard');
      } else {
        navigateToView('permission');
  
        // If on Linux, update installation instructions based on session type
        if (process.platform === 'linux' && isWaylandSession !== null) {
          updateLinuxInstructions(isWaylandSession);
        }
      }
    }
  });


// Simplify the check notification permission function completely
async function checkNotificationPermission() {
    try {
      return await ipcRenderer.invoke("checkNotificationPermission");
    } catch (error) {
      return false;
    }
  }

  // Update the notification UI function
async function updateNotificationUI() {
    const notificationsSupported = await checkNotificationPermission();
  
    // Get references to containers
    const notificationTimeContainer = document.getElementById("notificationTimeContainer");
    const notificationPermissionContainer = document.getElementById("notificationPermissionContainer");
  
    if (!notificationTimeContainer || !notificationPermissionContainer) {
      return;
    }
  
    if (notificationsSupported) {
      // If notifications are supported, show the time input
      notificationPermissionContainer.classList.add("hidden");
      notificationTimeContainer.classList.remove("hidden");
    } else {
      // If notifications aren't supported, show the permission button
      notificationTimeContainer.classList.add("hidden");
      notificationPermissionContainer.classList.remove("hidden");
    }
  }

  // Simplify the enable notifications button handler
document.addEventListener("DOMContentLoaded", () => {
    const enableNotificationsBtn = document.getElementById("enableNotificationsBtn");
    if (enableNotificationsBtn) {
      enableNotificationsBtn.addEventListener("click", () => {
        alert("Notifications are not supported on this system.");
      });
    }
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
          ipcRenderer.send("requestScreenCapturePermission");
        });
      }

module.exports = { initializePermissions, updateNotificationUI };

