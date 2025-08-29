const log = require('electron-log');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);

class AudioSessionManager {
  constructor() {
    this.activeMicrophone = null;
    this.sessionCheckInterval = null;
    this.onSessionStartCallback = null;
    this.onSessionEndCallback = null;
    this.onDeviceSwitchCallback = null;
    this.platform = process.platform;
    this.isChecking = false;
  }

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
  onPactlMissing(callback) { this.onPactlMissingCallback = callback; }



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
        default:
          log.warn('Unsupported platform for microphone detection:', this.platform);
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
      log.error('Error stack:', error.stack);
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
   * Windows: Uses PowerShell to check for actual microphone usage.
   * Only returns true when an app is actually using the microphone.
   */
  async detectWindowsMicrophoneUsage() {
    try {
      // Method 1: Check registry for active microphone usage (most reliable)
      const registryCommand = `powershell -ExecutionPolicy Bypass -Command "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\*\\*' | Where-Object { $_.LastUsedTimeStop -eq 0 } | Select-Object -First 1"`;
      
      try {
        const { stdout } = await execAsync(registryCommand);
        if (stdout.trim().length > 0) {
          return "Active Windows Device (Registry)";
        }
      } catch (registryError) {
        // Registry method failed, continue to fallback
      }

      // Method 2: Check for active audio sessions using a different registry path (fallback)
      const audioSessionRegistryCommand = `powershell -ExecutionPolicy Bypass -Command "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\*' | Where-Object { $_.LastUsedTimeStop -eq 0 } | Select-Object -First 1"`;
      
      try {
        const { stdout } = await execAsync(audioSessionRegistryCommand);
        if (stdout.trim().length > 0) {
          return "Active Windows Device (NonPackaged)";
        }
      } catch (nonPackagedError) {
        // Non-packaged registry method failed
      }
      return null;
      
    } catch (error) {
      log.error('Error in detectWindowsMicrophoneUsage:', error.message);
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
      // Check if the error is due to pactl not being installed
      if (error.code === 127) {
        // pactl not found - notify the main process to show user help
        if (this.onPactlMissingCallback) {
          this.onPactlMissingCallback();
        }
      }
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



  /**
   * Get current status of the session detector
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      initialized: !!this.sessionCheckInterval,
      activeMicrophone: this.activeMicrophone,
      platform: this.platform,
      isChecking: this.isChecking
    };
  }

  shutdown() {
    
    if (this.sessionCheckInterval) {
      clearInterval(this.sessionCheckInterval);
      this.sessionCheckInterval = null;
    }
  }
}

const sessionManager = new AudioSessionManager();
module.exports = {
  initialize: sessionManager.initialize.bind(sessionManager),
  onSessionStart: sessionManager.onSessionStart.bind(sessionManager),
  onSessionEnd: sessionManager.onSessionEnd.bind(sessionManager),
  onDeviceSwitch: sessionManager.onDeviceSwitch.bind(sessionManager),
  onPactlMissing: sessionManager.onPactlMissing.bind(sessionManager),
  getStatus: sessionManager.getStatus.bind(sessionManager),
  checkMicrophoneUsage: sessionManager.checkMicrophoneUsage.bind(sessionManager),
  detectWindowsMicrophoneUsage: sessionManager.detectWindowsMicrophoneUsage.bind(sessionManager),
  detectMacOSMicrophoneUsage: sessionManager.detectMacOSMicrophoneUsage.bind(sessionManager),
  detectLinuxMicrophoneUsage: sessionManager.detectLinuxMicrophoneUsage.bind(sessionManager),
  detectMicrophoneUsage: sessionManager.detectMicrophoneUsage.bind(sessionManager),
  shutdown: sessionManager.shutdown.bind(sessionManager)
};