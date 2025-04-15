const { execSync } = require('child_process')
const log = require('electron-log')
const os = require('os')
const fs = require('fs')
const path = require('path')

// Variables to track application windows
let appPollInterval = null
let appTimeline = []
let lastActiveApps = []

/**
 * Check if the application has permission to track active windows
 * @returns {Promise<boolean>} True if permission is granted
 */
async function checkPermission() {
  try {
    if (process.platform === 'darwin') {
      // macOS: Check for accessibility permissions (required for window title access)
      try {
        const testScript = `
          tell application "System Events"
            set frontApp to name of first application process whose frontmost is true
            return frontApp
          end tell
        `;
        
        execSync(`osascript -e '${testScript}'`, { timeout: 3000 });
        return true;
      } catch (error) {
        log.error('Window tracking permission check failed on macOS:', error)
        return false
      }
    } else if (process.platform === 'win32') {
      // Windows: No direct permission check, attempt to get active window
      try {
        const activeApps = await getActiveApplications()
        return Array.isArray(activeApps) && activeApps.length > 0
      } catch (error) {
        log.error('Window tracking permission check failed on Windows:', error)
        return false
      }
    } else if (process.platform === 'linux') {
      // Linux: Check if required tools are available
      try {
        // Check if we're running Wayland or X11
        const isWayland = process.env.XDG_SESSION_TYPE === 'wayland'
        
        if (isWayland) {
          // Check for wmctrl
          execSync('which wmctrl', { stdio: 'ignore' })
        } else {
          // Check for xdotool
          execSync('which xdotool', { stdio: 'ignore' })
        }
        
        return true
      } catch (error) {
        log.error('Window tracking permission check failed on Linux:', error)
        return false
      }
    }
    
    return false
  } catch (error) {
    log.error('Error checking window tracking permission:', error)
    return false
  }
}

/**
 * Get information about currently active applications and windows
 * @returns {Promise<Array>} Array of active application objects
 */
async function getActiveApplications() {
  try {
    const activeApps = []
    
    if (process.platform === 'darwin') {
      // macOS: Use AppleScript to get active application and window title
      const script = `
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
          set frontAppPath to path of first application process whose frontmost is true
          set windowTitle to ""
          
          tell process frontApp
            if exists (1st window whose value of attribute "AXMain" is true) then
              set windowTitle to name of 1st window whose value of attribute "AXMain" is true
            end if
          end tell
          
          return frontApp & ";" & windowTitle & ";" & frontAppPath
        end tell
      `
      
      const result = execSync(`osascript -e '${script}'`).toString().trim()
      const [name, title, path] = result.split(';')
      
      if (name) {
        activeApps.push({
          name,
          title: title || name,
          path: path || '',
          isActive: true
        })
        
        // Try to get other visible applications as well
        try {
          const visibleAppsScript = `
            tell application "System Events"
              set visibleApps to name of every application process whose visible is true
              return visibleApps
            end tell
          `
          
          const visibleApps = execSync(`osascript -e '${visibleAppsScript}'`).toString().trim()
          
          if (visibleApps) {
            visibleApps.split(', ').forEach(appName => {
              if (appName !== name) {
                activeApps.push({
                  name: appName,
                  title: appName,
                  path: '',
                  isActive: false
                })
              }
            })
          }
        } catch (err) {
          log.warn('Error getting visible apps on macOS:', err)
        }
      }
    } else if (process.platform === 'win32') {
      // Windows: Use PowerShell to get active window
      const script = `
        Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        public class WindowInfo {
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();
            
            [DllImport("user32.dll")]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
            
            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
            
            [DllImport("kernel32.dll")]
            public static extern IntPtr OpenProcess(int dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
            
            [DllImport("kernel32.dll")]
            public static extern bool QueryFullProcessImageName(IntPtr hProcess, int dwFlags, StringBuilder lpExeName, ref int lpdwSize);
            
            [DllImport("kernel32.dll", SetLastError=true)]
            public static extern bool CloseHandle(IntPtr hObject);
        }
'@
        
        $hwnd = [WindowInfo]::GetForegroundWindow()
        $title = New-Object System.Text.StringBuilder 256
        [WindowInfo]::GetWindowText($hwnd, $title, 256) | Out-Null
        
        $processId = 0
        [WindowInfo]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null
        
        $process = Get-Process -Id $processId
        $processName = $process.ProcessName
        
        $PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        $hProcess = [WindowInfo]::OpenProcess($PROCESS_QUERY_LIMITED_INFORMATION, $false, $processId)
        
        $pathBuilder = New-Object System.Text.StringBuilder 256
        $capacity = 256
        if ([WindowInfo]::QueryFullProcessImageName($hProcess, 0, $pathBuilder, [ref]$capacity)) {
            $processPath = $pathBuilder.ToString()
        } else {
            $processPath = ""
        }
        
        [WindowInfo]::CloseHandle($hProcess) | Out-Null
        
        $output = "$processName;$($title.ToString());$processPath"
        Write-Output $output
      `
      
      const result = execSync(`powershell -command "${script.replace(/\$/g, '`$')}"`, { shell: true }).toString().trim()
      const [name, title, path] = result.split(';')
      
      if (name) {
        activeApps.push({
          name,
          title: title || name,
          path: path || '',
          isActive: true
        })
        
        // Try to get other visible windows
        try {
          const otherWindowsScript = `
            Add-Type @'
            using System;
            using System.Runtime.InteropServices;
            using System.Text;
            using System.Collections.Generic;
            
            public class VisibleWindows {
                [DllImport("user32.dll")]
                [return: MarshalAs(UnmanagedType.Bool)]
                public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
                
                [DllImport("user32.dll")]
                [return: MarshalAs(UnmanagedType.Bool)]
                public static extern bool IsWindowVisible(IntPtr hWnd);
                
                [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
                public static extern int GetWindowTextLength(IntPtr hWnd);
                
                [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
                public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
                
                [DllImport("user32.dll")]
                public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
                
                public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
                
                public static List<string> GetVisibleWindows() {
                    List<string> results = new List<string>();
                    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
                        if (IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0) {
                            uint processId = 0;
                            GetWindowThreadProcessId(hWnd, out processId);
                            
                            int length = GetWindowTextLength(hWnd);
                            if (length > 0) {
                                StringBuilder sb = new StringBuilder(length + 1);
                                GetWindowText(hWnd, sb, sb.Capacity);
                                results.Add(processId.ToString() + ";" + sb.ToString());
                            }
                        }
                        return true;
                    }, IntPtr.Zero);
                    return results;
                }
            }
'@
            
            $windows = [VisibleWindows]::GetVisibleWindows()
            foreach ($window in $windows) {
                Write-Output $window
            }
          `
          
          const otherWindows = execSync(`powershell -command "${otherWindowsScript.replace(/\$/g, '`$')}"`, { shell: true }).toString().trim().split('\n')
          
          for (const windowInfo of otherWindows) {
            const [pid, windowTitle] = windowInfo.split(';')
            
            if (pid && windowTitle) {
              try {
                const processInfo = execSync(`powershell -command "Get-Process -Id ${pid} | Select-Object ProcessName, Path | ConvertTo-Csv -NoTypeInformation"`, { shell: true }).toString().trim().split('\n')
                
                if (processInfo.length >= 2) {
                  const [processName, processPath] = processInfo[1].split(',').map(value => value.replace(/^"(.*)"$/, '$1'))
                  
                  // Skip if this is the same as the active window
                  if (processName !== name || windowTitle !== title) {
                    activeApps.push({
                      name: processName,
                      title: windowTitle,
                      path: processPath || '',
                      isActive: false
                    })
                  }
                }
              } catch (err) {
                // Skip this window
              }
            }
          }
        } catch (err) {
          log.warn('Error getting other visible windows on Windows:', err)
        }
      }
    } else if (process.platform === 'linux') {
      // Linux: Detect desktop environment and use appropriate command
      const isWayland = process.env.XDG_SESSION_TYPE === 'wayland'
      
      if (isWayland) {
        // Wayland: Use wmctrl
        try {
          const result = execSync('wmctrl -l').toString().trim()
          const lines = result.split('\n')
          
          for (const line of lines) {
            const parts = line.trim().split(/\s+/)
            
            if (parts.length >= 4) {
              const windowId = parts[0]
              const desktopId = parts[1]
              const hostname = parts[2]
              const title = parts.slice(3).join(' ')
              
              // Check if this is the active window
              const isActive = desktopId !== '-1' // Typically, active window isn't on desktop -1
              
              activeApps.push({
                name: title.split(' - ').pop() || title, // Best-effort app name extraction
                title,
                path: '',
                isActive
              })
            }
          }
        } catch (error) {
          log.error('Error getting window info on Wayland:', error)
        }
      } else {
        // X11: Use xdotool
        try {
          // Get active window
          const activeWindowId = execSync('xdotool getactivewindow').toString().trim()
          const activeWindowTitle = execSync(`xdotool getwindowname ${activeWindowId}`).toString().trim()
          const activeWindowPid = execSync(`xdotool getwindowpid ${activeWindowId}`).toString().trim()
          
          let activeWindowName = activeWindowTitle
          try {
            // Try to get the process name
            const processPath = execSync(`readlink -f /proc/${activeWindowPid}/exe`).toString().trim()
            activeWindowName = processPath.split('/').pop() || activeWindowTitle
          } catch (err) {
            // Use the window title as fallback
          }
          
          activeApps.push({
            name: activeWindowName,
            title: activeWindowTitle,
            path: '',
            isActive: true
          })
          
          // Get other visible windows
          try {
            const allWindowIds = execSync('xdotool search --onlyvisible --name ""').toString().trim().split('\n')
            
            for (const windowId of allWindowIds) {
              if (windowId === activeWindowId) continue
              
              try {
                const windowTitle = execSync(`xdotool getwindowname ${windowId}`).toString().trim()
                
                let windowName = windowTitle
                try {
                  const windowPid = execSync(`xdotool getwindowpid ${windowId}`).toString().trim()
                  const processPath = execSync(`readlink -f /proc/${windowPid}/exe`).toString().trim()
                  windowName = processPath.split('/').pop() || windowTitle
                } catch (err) {
                  // Use the window title as fallback
                }
                
                activeApps.push({
                  name: windowName,
                  title: windowTitle,
                  path: '',
                  isActive: false
                })
              } catch (err) {
                // Skip this window
              }
            }
          } catch (err) {
            log.warn('Error getting other visible windows on X11:', err)
          }
        } catch (error) {
          log.error('Error getting window info on X11:', error)
        }
      }
    }
    
    return activeApps
  } catch (error) {
    log.error('Error getting active applications:', error)
    throw error
  }
}

/**
 * Start tracking active windows with a polling interval
 * @param {Object} options Configuration options
 * @param {number} options.pollInterval Polling interval in ms (default: 100ms)
 * @param {number} options.maxHistory Maximum history to keep in ms (default: 5 minutes)
 * @returns {boolean} True if tracking started successfully
 */
function startTracking(options = {}) {
  if (appPollInterval) {
    log.warn('Window tracking already active')
    return false
  }
  
  const pollInterval = options.pollInterval || 100
  const maxHistory = options.maxHistory || 5 * 60 * 1000 // 5 minutes
  
  // Clear previous timeline
  appTimeline = []
  lastActiveApps = []
  
  // Start polling for active applications
  appPollInterval = setInterval(async () => {
    try {
      // Get current active applications
      const activeApps = await getActiveApplications()
      
      // Check if there's a change compared to last check
      const isDifferent = isAppsDifferent(activeApps, lastActiveApps)
      
      if (isDifferent) {
        // Record the change
        appTimeline.push({
          timestamp: Date.now(),
          apps: activeApps
        })
        
        // Update last active apps
        lastActiveApps = activeApps
        
        // Trim old entries to maintain maxHistory
        const oldestAllowed = Date.now() - maxHistory
        appTimeline = appTimeline.filter(entry => entry.timestamp >= oldestAllowed)
      }
    } catch (error) {
      log.error('Error in window tracking interval:', error)
    }
  }, pollInterval)
  
  log.info('Started window tracking')
  return true
}

/**
 * Stop tracking active windows
 * @returns {boolean} True if tracking was active and is now stopped
 */
function stopTracking() {
  if (appPollInterval) {
    clearInterval(appPollInterval)
    appPollInterval = null
    appTimeline = []
    lastActiveApps = []
    log.info('Stopped window tracking')
    return true
  }
  
  return false
}

/**
 * Check if two sets of apps are different
 * @param {Array} appsA First set of apps
 * @param {Array} appsB Second set of apps
 * @returns {boolean} True if the sets are different
 */
function isAppsDifferent(appsA, appsB) {
  if (!appsA || !appsB) return true
  if (appsA.length !== appsB.length) return true
  
  // Check active app differences (only the active one matters most)
  const activeAppA = appsA.find(app => app.isActive)
  const activeAppB = appsB.find(app => app.isActive)
  
  if (!activeAppA || !activeAppB) return true
  if (activeAppA.name !== activeAppB.name) return true
  if (activeAppA.title !== activeAppB.title) return true
  
  return false
}

/**
 * Process the timeline data into a more useful format
 * @param {Array} timeline Raw timeline entries
 * @param {Object} options Processing options
 * @param {boolean} options.onlyActive Only include active windows (default: true) 
 * @param {boolean} options.includeInactive Include inactive windows in result (default: false)
 * @returns {Array} Processed timeline data
 */
function processTimelineData(timeline, options = {}) {
  const onlyActive = options.onlyActive !== false
  const includeInactive = options.includeInactive === true
  
  if (!timeline || timeline.length === 0) {
    return []
  }
  
  // Group by application activity periods
  const periods = []
  let currentPeriod = null
  
  for (const entry of timeline) {
    const activeApp = entry.apps.find(app => app.isActive)
    
    // Skip if no active app and we only care about active ones
    if (!activeApp && onlyActive) continue
    
    if (!currentPeriod || 
        currentPeriod.name !== activeApp.name || 
        currentPeriod.title !== activeApp.title) {
      // New application or title change
      if (currentPeriod) {
        currentPeriod.endTime = entry.timestamp
        currentPeriod.duration = currentPeriod.endTime - currentPeriod.startTime
        periods.push(currentPeriod)
      }
      
      currentPeriod = {
        name: activeApp.name,
        title: activeApp.title,
        path: activeApp.path || '',
        startTime: entry.timestamp,
        endTime: null,
        duration: 0
      }
      
      // Add other visible apps if requested
      if (includeInactive) {
        currentPeriod.otherApps = entry.apps
          .filter(app => !app.isActive)
          .map(app => ({
            name: app.name,
            title: app.title
          }))
      }
    }
  }
  
  // Add the last period
  if (currentPeriod) {
    currentPeriod.endTime = Date.now()
    currentPeriod.duration = currentPeriod.endTime - currentPeriod.startTime
    periods.push(currentPeriod)
  }
  
  return periods
}

/**
 * Get the current window tracking status
 * @returns {Object} Current tracking status
 */
function getStatus() {
  return {
    isTracking: !!appPollInterval,
    timelineEntries: appTimeline.length,
    lastActiveApp: lastActiveApps.find(app => app.isActive) || null
  }
}

/**
 * Get the current timeline data
 * @returns {Array} Current timeline data
 */
function getTimeline() {
  return [...appTimeline]
}

module.exports = {
  checkPermission,
  getActiveApplications,
  startTracking,
  stopTracking,
  processTimelineData,
  getStatus,
  getTimeline
} 