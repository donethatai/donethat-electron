const { ipcRenderer } = require("electron");

// Listen for update events from main process
ipcRenderer.on('update-downloaded', () => {
  // Use navigateToView to show the update view
  navigateToView('update');
});

// Add restart button handler
const restartForUpdateBtn = document.getElementById("restartForUpdateBtn");
if (restartForUpdateBtn) {
  restartForUpdateBtn.addEventListener("click", () => {
    ipcRenderer.send("install-update");
  });
}

// Export the initialization function
function initializeAutoUpdate(viewNavigator) {
  navigateToView = viewNavigator;
}

module.exports = { initializeAutoUpdate };