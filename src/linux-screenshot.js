const ipcRenderer = window.electronAPI;

// Linux screenshot command management
class LinuxScreenshotManager {
  constructor() {
    this.commandInput = null;
    this.testButton = null;
    this.restoreButton = null;
    this.testResult = null;
    this.testIcon = null;
    this.testMessage = null;
    this.isLinux = window.electronAPI && window.electronAPI.platform === 'linux';
    this.hideTimer = null;
    
    this.init();
  }

  init() {
    if (!this.isLinux) return;

    // Get DOM elements
    this.commandInput = document.getElementById('linuxScreenshotCommand');
    this.testButton = document.getElementById('testScreenshotCommand');
    this.restoreButton = document.getElementById('restoreDefaultScreenshot');
    this.testResult = document.getElementById('screenshotTestResult');
    this.testIcon = document.getElementById('screenshotTestIcon');
    this.testMessage = document.getElementById('screenshotTestMessage');

    if (!this.commandInput || !this.testButton || !this.restoreButton) {
      console.warn('Linux screenshot elements not found');
      return;
    }

    this.setupEventListeners();
    this.loadSavedCommand();
  }

  setupEventListeners() {
    // Test button
    this.testButton.addEventListener('click', () => {
      this.testCommand();
    });

    // Restore defaults button
    this.restoreButton.addEventListener('click', () => {
      this.restoreDefaults();
    });

    // Save command on input change (with debounce)
    let saveTimeout;
    this.commandInput.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        this.saveCommand();
      }, 500);
    });
  }

  async loadSavedCommand() {
    try {
      const result = await ipcRenderer.invoke('get-linux-screenshot-command');
      if (result.success && result.command) {
        this.commandInput.value = result.command;
      }
    } catch (error) {
      console.error('Error loading Linux screenshot command:', error);
    }
  }

  async saveCommand() {
    try {
      const command = this.commandInput.value.trim();
      await ipcRenderer.invoke('save-linux-screenshot-command', command);
    } catch (error) {
      console.error('Error saving Linux screenshot command:', error);
    }
  }

  async testCommand() {
    const command = this.commandInput.value.trim();
    if (!command) {
      this.showTestResult(false, 'Please enter a command to test');
      return;
    }

    // Show loading state
    this.testButton.disabled = true;
    this.testButton.textContent = 'Testing...';
    this.hideTestResult();
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }

    try {
      const result = await ipcRenderer.invoke('test-linux-screenshot-command', command);
      this.showTestResult(result.success, result.message);
    } catch (error) {
      this.showTestResult(false, `Test failed: ${error.message}`);
    } finally {
      this.testButton.disabled = false;
      this.testButton.textContent = 'Test';
    }
  }

  showTestResult(success, message) {
    if (!this.testResult || !this.testIcon || !this.testMessage) return;

    this.testResult.classList.remove('hidden');
    
    // Set icon and message
    if (success) {
      this.testIcon.innerHTML = `
        <svg class="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path>
        </svg>
      `;
      this.testResult.className = 'p-3 rounded-lg border border-green-200 bg-green-50';
    } else {
      this.testIcon.innerHTML = `
        <svg class="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"></path>
        </svg>
      `;
      this.testResult.className = 'p-3 rounded-lg border border-red-200 bg-red-50';
    }

    this.testMessage.textContent = message;

    // Auto-hide after 10 seconds
    if (this.hideTimer) { clearTimeout(this.hideTimer); }
    this.hideTimer = setTimeout(() => {
      try { this.hideTestResult(); } catch (_) {}
      this.hideTimer = null;
    }, 10000);
  }

  hideTestResult() {
    if (this.testResult) {
      this.testResult.classList.add('hidden');
    }
  }

  async restoreDefaults() {
    // Set the default command (same as the one used in captureScreenshots.js)
    const defaultCommand = `bash -c 'getOriginalAnimationSetting=$(gsettings get org.gnome.desktop.interface enable-animations); getOriginalSoundSetting=$(gsettings get org.gnome.desktop.sound event-sounds); gsettings set org.gnome.desktop.interface enable-animations false; gsettings set org.gnome.desktop.sound event-sounds false; gnome-screenshot -f "%s"; gsettings set org.gnome.desktop.interface enable-animations $getOriginalAnimationSetting; gsettings set org.gnome.desktop.sound event-sounds $getOriginalSoundSetting'`;
    
    // Set the command input to the default
    this.commandInput.value = defaultCommand;
    
    // Save the default command
    await this.saveCommand();
    
    // Hide test result
    this.hideTestResult();
    
    // Show brief confirmation without changing button text
    this.restoreButton.disabled = true;
    
    setTimeout(() => {
      this.restoreButton.disabled = false;
    }, 1500);
  }

}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new LinuxScreenshotManager();
});

module.exports = { LinuxScreenshotManager };
