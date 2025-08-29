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
    this.config = {
      enableRegistryMethod: true,
      enableProcessMethod: true,
      enableDeviceMethod: true,
      enablePrivacyMethod: true,
      enableNonPackagedMethod: true,
      enableWindowActivityMethod: true
    };

    // No FFI init; macOS uses Swift helper
  }

  // FFI setup removed

  initialize(options = 1000) {
    const intervalMs = typeof options === 'number' ? options : (options && options.checkIntervalMs ? options.checkIntervalMs : 1000);
    
    log.info(`Initializing audio session detector for platform: ${this.platform}, interval: ${intervalMs}ms`);
    
    if (this.sessionCheckInterval) {
      clearInterval(this.sessionCheckInterval);
    }
    this.sessionCheckInterval = setInterval(() => this.checkMicrophoneUsage(), intervalMs);
    
    // Log platform-specific initialization
    if (this.platform === 'win32') {
      log.info('Windows audio detection initialized with multiple fallback methods');
    }
    
    return true;
  }

  onSessionStart(callback) { this.onSessionStartCallback = callback; }
  onSessionEnd(callback) { this.onSessionEndCallback = callback; }
  onDeviceSwitch(callback) { this.onDeviceSwitchCallback = callback; }

  /**
   * Configure Windows detection methods
   * @param {Object} options Configuration options
   */
  configureWindowsDetection(options) {
    if (this.platform !== 'win32') {
      log.warn('Windows detection configuration ignored on non-Windows platform');
      return;
    }
    
    if (options.enableRegistryMethod !== undefined) {
      this.config.enableRegistryMethod = options.enableRegistryMethod;
    }
    if (options.enableProcessMethod !== undefined) {
      this.config.enableProcessMethod = options.enableProcessMethod;
    }
    if (options.enableDeviceMethod !== undefined) {
      this.config.enableDeviceMethod = options.enableDeviceMethod;
    }
    if (options.enablePrivacyMethod !== undefined) {
      this.config.enablePrivacyMethod = options.enablePrivacyMethod;
    }
    if (options.enableNonPackagedMethod !== undefined) {
      this.config.enableNonPackagedMethod = options.enableNonPackagedMethod;
    }
    if (options.enableWindowActivityMethod !== undefined) {
      this.config.enableWindowActivityMethod = options.enableWindowActivityMethod;
    }
    
    log.info('Windows detection configuration updated:', this.config);
  }

  async checkMicrophoneUsage() {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      const previouslyActiveMic = this.activeMicrophone;
      let currentlyActiveMic = null;

      switch (this.platform) {
        case 'win32':
          log.debug('Checking Windows microphone usage...');
          currentlyActiveMic = await this.detectWindowsMicrophoneUsage();
          log.debug('Windows microphone check result:', currentlyActiveMic);
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
        log.info('Microphone session started:', this.activeMicrophone);
        if (this.onSessionStartCallback) this.onSessionStartCallback(this.activeMicrophone);
      } else if (this.activeMicrophone && previouslyActiveMic && this.activeMicrophone !== previouslyActiveMic) {
        log.info('Microphone device switched:', this.activeMicrophone);
        if (this.onDeviceSwitchCallback) this.onDeviceSwitchCallback(this.activeMicrophone);
      } else if (!this.activeMicrophone && previouslyActiveMic) {
        log.info('Microphone session ended');
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
   * Windows: Uses PowerShell to check the microphone privacy registry.
   * This is reliable and microphone-specific.
   */
  async detectWindowsMicrophoneUsage() {
    try {
      // Method 1: Check registry for active microphone usage
      if (this.config.enableRegistryMethod) {
        const registryCommand = `powershell -ExecutionPolicy Bypass -Command "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\*\\*' | Where-Object { $_.LastUsedTimeStop -eq 0 } | Select-Object -First 1"`;
        
        try {
          const { stdout } = await execAsync(registryCommand);
          if (stdout.trim().length > 0) {
            log.debug('Windows microphone detected via registry method');
            return "Active Windows Device (Registry)";
          }
        } catch (registryError) {
          log.debug('Registry method failed, trying alternative methods:', registryError.message);
        }
      }

      // Method 2: Check for active audio sessions using PowerShell
      if (this.config.enableProcessMethod) {
        const audioSessionCommand = `powershell -ExecutionPolicy Bypass -Command "Get-Process | Where-Object {$_.ProcessName -in @('Teams', 'Zoom', 'Discord', 'Skype', 'chrome', 'firefox', 'edge', 'msedge', 'opera', 'brave')} | Select-Object -First 1"`;
        
        try {
          const { stdout } = await execAsync(audioSessionCommand);
          if (stdout.trim().length > 0) {
            log.debug('Windows microphone detected via process method');
            return "Active Windows Device (Process)";
          }
        } catch (processError) {
          log.debug('Process method failed:', processError.message);
        }
      }

      // Method 3: Check Windows audio device status
      if (this.config.enableDeviceMethod) {
        const audioDeviceCommand = `powershell -ExecutionPolicy Bypass -Command "Get-WmiObject -Class Win32_SoundDevice | Where-Object {$_.Status -eq 'OK'} | Select-Object -First 1"`;
        
        try {
          const { stdout } = await execAsync(audioDeviceCommand);
          if (stdout.trim().length > 0) {
            log.debug('Windows microphone detected via device method');
            return "Active Windows Device (Device)";
          }
        } catch (deviceError) {
          log.debug('Device method failed:', deviceError.message);
        }
      }

      // Method 4: Check for microphone privacy settings
      if (this.config.enablePrivacyMethod) {
        const privacyCommand = `powershell -ExecutionPolicy Bypass -Command "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone' -Name Value | Select-Object -ExpandProperty Value"`;
        
        try {
          const { stdout } = await execAsync(privacyCommand);
          if (stdout.trim() === '1') {
            log.debug('Windows microphone detected via privacy settings');
            return "Active Windows Device (Privacy)";
          }
        } catch (privacyError) {
          log.debug('Privacy method failed:', privacyError.message);
        }
      }

      // Method 5: Check for active audio sessions using a different registry path
      if (this.config.enableNonPackagedMethod) {
        const audioSessionRegistryCommand = `powershell -ExecutionPolicy Bypass -Command "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\*' | Where-Object { $_.LastUsedTimeStop -eq 0 } | Select-Object -First 1"`;
        
        try {
          const { stdout } = await execAsync(audioSessionRegistryCommand);
          if (stdout.trim().length > 0) {
            log.debug('Windows microphone detected via non-packaged registry method');
            return "Active Windows Device (NonPackaged)";
          }
        } catch (nonPackagedError) {
          log.debug('Non-packaged registry method failed:', nonPackagedError.message);
        }
      }

      // Method 6: Check for microphone activity using Windows audio session API (simplified)
      if (this.config.enableWindowActivityMethod) {
        const audioActivityCommand = `powershell -ExecutionPolicy Bypass -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne '' -and $_.ProcessName -in @('Teams', 'Zoom', 'Discord', 'Skype', 'chrome', 'firefox', 'edge', 'msedge', 'opera', 'brave', 'outlook', 'teams', 'slack')} | Select-Object -First 1"`;
        
        try {
          const { stdout } = await execAsync(audioActivityCommand);
          if (stdout.trim().length > 0) {
            log.debug('Windows microphone detected via window activity method');
            return "Active Windows Device (WindowActivity)";
          }
        } catch (windowActivityError) {
          log.debug('Window activity method failed:', windowActivityError.message);
        }
      }

      log.debug('No Windows microphone activity detected');
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
   * Get current Windows detection configuration
   * @returns {Object} Current configuration
   */
  getWindowsDetectionConfig() {
    return { ...this.config };
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
  ...sessionManager,
  configureWindowsDetection: sessionManager.configureWindowsDetection.bind(sessionManager),
  getWindowsDetectionConfig: sessionManager.getWindowsDetectionConfig.bind(sessionManager)
};