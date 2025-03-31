const { ipcRenderer } = require("electron");
const { logAnalyticsEvent } = require('./analytics.js');

let navigateToView;

// Listen for update events from main process
ipcRenderer.on('update-downloaded', () => {
  // Log that an update was downloaded
  logAnalyticsEvent('update_downloaded', {
    status: 'success'
  });
  // Use navigateToView to show the update view
  navigateToView('update');
});

// Add restart button handler
const restartForUpdateBtn = document.getElementById("restartForUpdateBtn");
if (restartForUpdateBtn) {
  restartForUpdateBtn.addEventListener("click", () => {
    // Log that user initiated update installation
    logAnalyticsEvent('update_install_started', {
      status: 'success'
    });
    ipcRenderer.send("install-update");
  });
}

// Export the initialization function
function initializeAutoUpdate(viewNavigator) {
  navigateToView = viewNavigator;
}

module.exports = { initializeAutoUpdate };