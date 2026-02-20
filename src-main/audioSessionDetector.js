const log = require('electron-log');
const { exec, execFile } = require('child_process');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function buildOwnMacBundlePrefixes() {
  const prefixes = new Set([
    'com.github.Electron'
  ]);

  try {
    const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const appId = packageJson && packageJson.build && packageJson.build.appId;
    if (typeof appId === 'string' && appId.trim()) {
      prefixes.add(appId.trim());
    }
  } catch (_) {}

  const envAppId = process.env.DONETHAT_APP_ID || process.env.npm_package_build_appId;
  if (typeof envAppId === 'string' && envAppId.trim()) {
    prefixes.add(envAppId.trim());
  }

  if (process.platform === 'darwin') {
    try {
      const appBundlePath = path.resolve(process.execPath, '../../..');
      const infoPlistPath = path.join(appBundlePath, 'Contents', 'Info');
      const bundleId = execFileSync('/usr/bin/defaults', ['read', infoPlistPath, 'CFBundleIdentifier'], {
        encoding: 'utf8'
      }).trim();
      if (bundleId) {
        prefixes.add(bundleId);
      }
    } catch (_) {}
  }

  return [...prefixes];
}

const OWN_MAC_BUNDLE_PREFIXES = buildOwnMacBundlePrefixes();

// For com.apple.* bundles we use explicit allowlist; non-Apple bundles are allowed by default.
const ALLOWED_APPLE_MIC_BUNDLE_IDS = new Set([
  'com.apple.FaceTime',
  'com.apple.Safari',
  'com.apple.SafariTechnologyPreview',
  'com.apple.quicktimeplayerX',
  'com.apple.PhotoBooth',
  'com.apple.VoiceMemos'
]);

class AudioSessionManager {
  constructor() {
    this.activeMicrophone = null;
    this.sessionCheckInterval = null;
    this.onSessionStartCallback = null;
    this.onSessionEndCallback = null;
    this.onDeviceSwitchCallback = null;
    this.platform = process.platform;
    this.isChecking = false;
    this.currentCheckPromise = null;
    this.windowsHelperMissingLogged = false;
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
    if (this.currentCheckPromise) {
      return this.currentCheckPromise;
    }

    this.currentCheckPromise = (async () => {
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

        const isSameSession = (a, b) => {
          if (a === b) return true;
          if (!a || !b) return false;
          if (typeof a !== typeof b) return false;
          if (typeof a === 'object') {
            return a.pid === b.pid && a.name === b.name;
          }
          return a === b;
        };

        if (this.activeMicrophone && !previouslyActiveMic) {
          if (this.onSessionStartCallback) this.onSessionStartCallback(this.activeMicrophone);
        } else if (this.activeMicrophone && previouslyActiveMic && !isSameSession(this.activeMicrophone, previouslyActiveMic)) {
          if (this.onDeviceSwitchCallback) this.onDeviceSwitchCallback(this.activeMicrophone);
        } else if (!this.activeMicrophone && previouslyActiveMic) {
          if (this.onSessionEndCallback) this.onSessionEndCallback();
        }

        return this.activeMicrophone;
      } catch (error) {
        log.error('Error in checkMicrophoneUsage:', error.message);
        log.error('Error stack:', error.stack);
        return this.activeMicrophone;
      } finally {
        this.isChecking = false;
      }
    })();

    try {
      return await this.currentCheckPromise;
    } finally {
      this.currentCheckPromise = null;
    }
  }
  /**
   * macOS: deterministic CoreAudio process-object helper only.
   */
  async detectMacOSMicrophoneUsage() {
    try {
      const helperPath = this.resolveMacMicHelperPath();
      if (!helperPath) {
        log.warn('[AudioSession] macOS mic helper binary not found');
        return null;
      }
      const { stdout } = await execFileAsync(helperPath);
      const sessions = JSON.parse(stdout);
      if (!Array.isArray(sessions)) {
        throw new Error('Invalid helper output: expected JSON array');
      }

      const externalSessions = sessions.filter((session) => {
        const pid = Number(session && session.pid);
        if (!Number.isInteger(pid) || pid <= 0) return false;
        if (this.isOwnProcessPid(pid)) return false;
        if (this.isOwnBundleId(session && session.bundleId)) return false;
        if (this.isExcludedMacSystemSession(session)) return false;
        return true;
      });

      if (externalSessions.length === 0) {
        return null;
      }

      const active = externalSessions[0];
      return {
        isActive: true,
        pid: Number(active.pid) || null,
        name: active.name || active.bundleId || 'Unknown macOS App',
        path: active.bundleId || null
      };
    } catch (error) {
      log.error('[AudioSession] Error in detectMacOSMicrophoneUsage:', error.message || error);
      return null;
    }
  }

  isOwnProcessPid(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;

    try {
      const { webContents } = require('electron');
      const allWebContents = webContents.getAllWebContents();
      for (const wc of allWebContents) {
        try {
          if (wc.getOSProcessId && wc.getOSProcessId() === pid) {
            return true;
          }
        } catch (_) {}
      }
    } catch (_) {}

    return false;
  }

  isChildOfOwnProcess(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    if (process.platform !== 'linux') return false;

    try {
      let currentPid = pid;
      const visited = new Set();
      while (currentPid > 1 && !visited.has(currentPid)) {
        visited.add(currentPid);
        const status = fs.readFileSync(`/proc/${currentPid}/status`, 'utf8');
        const ppidMatch = status.match(/^PPid:\s+(\d+)$/m);
        if (!ppidMatch) return false;
        const parentPid = parseInt(ppidMatch[1], 10);
        if (!Number.isInteger(parentPid) || parentPid <= 0) return false;
        if (parentPid === process.pid) return true;
        currentPid = parentPid;
      }
    } catch (_) {
      return false;
    }

    return false;
  }

  async getWindowsParentPid(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;

    try {
      const { stdout } = await execAsync(
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId = ${pid}\\").ParentProcessId"`
      );
      const parsed = parseInt(String(stdout || '').trim(), 10);
      if (!Number.isInteger(parsed) || parsed <= 0) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  async isChildOfOwnProcessWindows(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (this.isOwnProcessPid(pid)) return true;
    if (process.platform !== 'win32') return false;

    const visited = new Set();
    let currentPid = pid;
    while (currentPid > 0 && !visited.has(currentPid)) {
      visited.add(currentPid);

      if (this.isOwnProcessPid(currentPid)) {
        return true;
      }

      const parentPid = await this.getWindowsParentPid(currentPid);
      if (!Number.isInteger(parentPid) || parentPid <= 0) {
        return false;
      }
      currentPid = parentPid;
    }

    return false;
  }

  isOwnLinuxSession(stream) {
    if (!stream || typeof stream !== 'object') return false;
    const props = stream.properties || {};
    const rawPid = props['application.process.id'];
    const pid = typeof rawPid === 'number' ? rawPid : parseInt(rawPid, 10);
    if (Number.isInteger(pid) && (this.isOwnProcessPid(pid) || this.isChildOfOwnProcess(pid))) {
      return true;
    }

    const appName = String(props['application.name'] || '').toLowerCase();
    const processBinary = String(props['application.process.binary'] || '').toLowerCase();
    if (appName.includes('donethat') || processBinary.includes('donethat')) {
      return true;
    }

    return false;
  }

  isOwnBundleId(bundleId) {
    if (typeof bundleId !== 'string' || !bundleId) return false;
    const normalized = bundleId.toLowerCase();

    if (normalized.includes('donethat')) {
      return true;
    }

    for (const prefix of OWN_MAC_BUNDLE_PREFIXES) {
      const normalizedPrefix = String(prefix || '').toLowerCase();
      if (normalized === normalizedPrefix || normalized.startsWith(normalizedPrefix + '.')) {
        return true;
      }
    }

    return false;
  }

  isExcludedMacSystemSession(session) {
    const bundleId = (session && typeof session.bundleId === 'string') ? session.bundleId : '';
    if (!bundleId.startsWith('com.apple.')) {
      return false;
    }
    return !ALLOWED_APPLE_MIC_BUNDLE_IDS.has(bundleId);
  }
  resolveMacMicHelperPath() {
    const binaryName = 'mic-monitor';
    const pathsToCheck = [
      process.resourcesPath ? path.resolve(process.resourcesPath, 'app.asar.unpacked', 'bin', binaryName) : null,
      process.resourcesPath ? path.resolve(process.resourcesPath, 'bin', binaryName) : null,
      path.resolve(process.cwd(), 'bin', binaryName),
      path.resolve(__dirname, '..', 'bin', binaryName)
    ];

    for (const candidatePath of pathsToCheck.filter(Boolean)) {
      try {
        if (fs.existsSync(candidatePath)) return candidatePath;
      } catch (_) {}
    }

    return null;
  }

  /**
   * Windows: Uses helper binary (donethatmicmonitor.exe) to check for actual microphone usage.
   * Only returns true when an external app is actively using the microphone.
   */
  async detectWindowsMicrophoneUsage() {
    try {
      const helperPath = this.resolveWindowsHelperPath();
      if (!helperPath) {
        if (!this.windowsHelperMissingLogged) {
          this.windowsHelperMissingLogged = true;
          log.warn('[AudioSession] Windows mic helper not found; microphone session detection disabled');
        }
        return null;
      }

      try {
        const { stdout } = await execAsync(`"${helperPath}"`);
        const sessions = JSON.parse(stdout);
        const externalSessions = [];
        let ownFilteredCount = 0;

        for (const session of sessions) {
          const pid = Number(session && session.pid);
          const name = String((session && session.name) || '').toLowerCase();

          const isOwnSession =
            (Number.isInteger(pid) && (this.isOwnProcessPid(pid) || await this.isChildOfOwnProcessWindows(pid))) ||
            name.includes('donethat');

          if (isOwnSession) {
            ownFilteredCount += 1;
            continue;
          }
          externalSessions.push(session);
        }

        log.debug(`[AudioSession] Windows helper sessions: total=${sessions.length}, ownFiltered=${ownFilteredCount}, external=${externalSessions.length}`);

        if (externalSessions.length > 0) {
          const s = externalSessions[0];
          return {
            isActive: true,
            pid: s.pid,
            name: s.name || 'Unknown Windows App',
            path: null // path not returned by helper yet
          };
        }
        return null;
      } catch (helperError) {
        log.error('[AudioSession] Windows helper execution failed:', helperError.message || helperError);
        return null;
      }
    } catch (error) {
      log.error('Error in detectWindowsMicrophoneUsage:', error.message);
      return null;
    }
  }

  resolveWindowsHelperPath() {
    const binaryName = 'donethatmicmonitor.exe';
    
    const pathsToCheck = [
      process.resourcesPath ? path.resolve(process.resourcesPath, 'app.asar.unpacked', 'bin', binaryName) : null,
      process.resourcesPath ? path.resolve(process.resourcesPath, 'bin', binaryName) : null,
      path.resolve(process.cwd(), 'bin', binaryName),
      path.resolve(__dirname, '..', 'bin', binaryName),
    ].filter(Boolean);

    for (const p of pathsToCheck) {
      try {
        const normalized = p.toLowerCase();
        if (normalized.includes(`${path.sep}app.asar${path.sep}`) && !normalized.includes(`${path.sep}app.asar.unpacked${path.sep}`)) {
          continue;
        }
        if (fs.existsSync(p)) return p;
      } catch (_) {}
    }
    
    return null;
  }

  /**
   * Linux: Checks for active recording streams (source-outputs).
   * "Source" means input (microphone), "Output" means the stream from it.
   * Returns metadata about the process using the microphone.
   */
  async detectLinuxMicrophoneUsage() {
    try {
      // Try JSON format first (PulseAudio 15+)
      try {
        const { stdout } = await execAsync('pactl --format=json list source-outputs');
        // log.debug('[AudioSession] pactl json output:', stdout);
        const streams = JSON.parse(stdout);
        
        // Filter for valid recording streams
        // PulseAudio/PipeWire might list monitor streams or other artifacts
        const recordingStreams = streams.filter((stream) => !this.isOwnLinuxSession(stream));

        if (recordingStreams.length > 0) {
          const s = recordingStreams[0];
          const props = s.properties || {};
          return {
            isActive: true,
            pid: props['application.process.id'],
            name: props['application.name'] || 'Unknown Linux App',
            path: props['application.process.binary']
          };
        }
        return null;

      } catch (jsonError) {
        // Fallback to text parsing if JSON fails (older PulseAudio) or if flag is unsupported
        // Typical output:
        // Source Output #1
        //         Driver: ...
        //         Properties:
        //                 application.name = "Firefox"
        //                 application.process.id = "1234"
        const { stdout } = await execAsync('pactl list source-outputs');
        
        if (!stdout || !stdout.trim()) return null;

        const blocks = stdout.split(/(\n|^)Source Output #/).slice(1);
        
        for (const block of blocks) {
          // Extract PID
          const pidMatch = block.match(/application\.process\.id\s*=\s*"(\d+)"/);
          const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;

          // Extract Name
          const nameMatch = block.match(/application\.name\s*=\s*"(.*?)"/);
          const name = nameMatch ? nameMatch[1] : 'Unknown Linux App';
          const binaryMatch = block.match(/application\.process\.binary\s*=\s*"(.*?)"/);
          const binary = binaryMatch ? binaryMatch[1] : '';
          if (this.isOwnLinuxSession({
            properties: {
              'application.process.id': pid,
              'application.name': name,
              'application.process.binary': binary
            }
          })) {
            continue;
          }

          return {
            isActive: true,
            pid: pid,
            name: name,
            path: binary || null
          };
        }
        
        return null;
      }

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
