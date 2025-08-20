const log = require('electron-log');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);

// --- macOS FFI removed; Swift micstatus helper is used instead ---

class AudioSessionManager {
  constructor() {
    this.activeMicrophone = null;
    this.sessionCheckInterval = null;
    this.onSessionStartCallback = null;
    this.onSessionEndCallback = null;
    this.onDeviceSwitchCallback = null;
    this.platform = process.platform;
    this.isChecking = false;

    // No FFI init; macOS uses Swift helper
  }

  // FFI setup removed

  initialize(options = 1000) {
    const intervalMs = typeof options === 'number' ? options : (options && options.checkIntervalMs ? options.checkIntervalMs : 1000);
    
    if (this.sessionCheckInterval) {
      clearInterval(this.sessionCheckInterval);
    }
    this.sessionCheckInterval = setInterval(() => this.checkMicrophoneUsage(), intervalMs);
    return true;
  }

  onSessionStart(callback) { this.onSessionStartCallback = callback; }
  onSessionEnd(callback) { this.onSessionEndCallback = callback; }
  onDeviceSwitch(callback) { this.onDeviceSwitchCallback = callback; }

  async checkMicrophoneUsage() {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      const previouslyActiveMic = this.activeMicrophone;
      let currentlyActiveMic = null;

      switch (this.platform) {
        case 'win32':
          currentlyActiveMic = await this.detectWindowsMicrophoneUsage();
          break;
        case 'darwin':
          currentlyActiveMic = await this.detectMacOSMicrophoneUsage();
          
          break;
        case 'linux':
          currentlyActiveMic = await this.detectLinuxMicrophoneUsage();
          break;
      }

      this.activeMicrophone = currentlyActiveMic;

      if (this.activeMicrophone && !previouslyActiveMic) {
        
        if (this.onSessionStartCallback) this.onSessionStartCallback(this.activeMicrophone);
      } else if (this.activeMicrophone && previouslyActiveMic && this.activeMicrophone !== previouslyActiveMic) {
        
        if (this.onDeviceSwitchCallback) this.onDeviceSwitchCallback(this.activeMicrophone);
      } else if (!this.activeMicrophone && previouslyActiveMic) {
        
        if (this.onSessionEndCallback) this.onSessionEndCallback();
      }
    } catch (error) {
      log.error('Error in checkMicrophoneUsage:', error.message);
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * macOS: Use CoreAudio FFI only. No fallbacks (they cause false positives).
   */
  async detectMacOSMicrophoneUsage() {
    // Swift helper (bin/micstatus) checks input devices running state
    try {
      const micstatusPath = this.resolveMicstatusPath();
      if (!micstatusPath) {
        return null;
      }
      const { stdout } = await execAsync(`"${micstatusPath}"`);
      const val = stdout.trim();
      if (val === '1') {
        return 'Active macOS Device (Swift)';
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  resolveMicstatusPath() {
    const candidates = [
      path.resolve(process.cwd(), 'bin', 'micstatus'),
      path.resolve(__dirname, '..', 'bin', 'micstatus'),
      process.resourcesPath ? path.resolve(process.resourcesPath, 'bin', 'micstatus') : null,
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch (_) {}
    }
    
    return null;
  }

  /**
   * Windows: Uses PowerShell to check the microphone privacy registry.
   * This is reliable and microphone-specific.
   */
  async detectWindowsMicrophoneUsage() {
    // This command gets all apps that have accessed the mic, converts the last access time to a number,
    // and checks if any have a LastUsedTimeStop value of 0, which indicates active use.
    const command = `powershell -Command "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\*\\*' | Where-Object { $_.LastUsedTimeStop -eq 0 } | Select-Object -First 1"`;
    try {
      const { stdout } = await execAsync(command);
      return stdout.trim().length > 0 ? "Active Windows Device" : null;
    } catch (error) {
      // Command fails if nothing is found
      return null;
    }
  }

  /**
   * Linux: Checks for active recording streams (source-outputs).
   * "Source" means input (microphone), "Output" means the stream from it.
   */
  async detectLinuxMicrophoneUsage() {
    try {
      const { stdout } = await execAsync('pactl list short source-outputs');
      return stdout.trim().length > 0 ? "Active Linux Device" : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Detect microphone usage (for periodic checks)
   * @returns {Promise<Object>} { isActive: boolean, deviceId: string }
   */
  async detectMicrophoneUsage() {
    try {
      const result = await this.checkMicrophoneUsage();
      return {
        isActive: !!this.activeMicrophone,
        deviceId: this.activeMicrophone
      };
    } catch (error) {
      log.error('Error in detectMicrophoneUsage:', error);
      return { isActive: false, deviceId: null };
    }
  }

  

  shutdown() {
    
    if (this.sessionCheckInterval) {
      clearInterval(this.sessionCheckInterval);
      this.sessionCheckInterval = null;
    }
  }
}

const sessionManager = new AudioSessionManager();
module.exports = sessionManager;