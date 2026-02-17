const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted channels for sending messages to main process
// Keep this in sync with all ipcRenderer.send(...) usages in src/*
const validSendChannels = [
  // Auth / lifecycle
  'login',
  'logout',
  'token-refreshed',
  'renderer:ready-for-auth',
  'initialAuthCheck',

  // Navigation / UI
  'navigate',
  'router:open-link',

  // Recording / permissions
  'pauseForMs',
  'pauseForToday',
  'resumeRecording',
  'requestWindowsPermission',
  'requestScreenCapturePermission',
  'requestMicrophonePermission',
  'requestSystemAudioPermission',
  'checkScreenCapturePermission',
  'updateInputDataSettings',

  'updateSaveCaptureData',
  'updateSaveCaptureDataPath',
  'update-context-capture-enabled',
  'updateWorkhours',
  'updateWorkdays',
  'pause-capture-due-to-permission',
  'audio-device-changed',

  // Chat
  'chat:set-messages',
  'chat:recent-chats-updated',
  'chat:message-result',
  'chat:load-chat-result',

  // Overlay / windows
  'overlay:show-if-hidden',
  'overlay:resize',
  'overlay:hide',
  'overlay:open-main',
  'overlay:toggle',
  'create-overlay-if-needed',
  'focus-app-window',
  'updateUserStatus',

  // Notifications
  'notification:close',
  'notification:action',
  'notification:content-height',
  'notification:ready',
  'background:notify',
  'background:hide',

  // Updates
  'update:install',

  // Dashboard / summary
  'summarySubmitted',
  'pauseUntilTomorrow'
];

// Whitelisted channels for invoking main process handlers (async/promise)
// Keep this in sync with all ipcRenderer.invoke(...) usages in src/*
const validInvokeChannels = [
  // App / platform
  'get-app-version',
  'get-platform-info',
  'check-main-window-focus',
  'checkWindowsPermission',
  'checkMicrophonePermission',

  // Settings / Tailwind-related helpers
  'settings:load',
  'get-linux-screenshot-command',
  'save-linux-screenshot-command',
  'test-linux-screenshot-command',
  'get-gemini-api-key',
  'save-gemini-api-key',
  'clear-gemini-api-key',
  'get-openai-compatible-config',
  'save-openai-compatible-config',
  'clear-openai-compatible-config',
  'get-app-exclusions',
  'save-app-exclusions',
  'test-app-exclusions',
  'get-context-capture-enabled',
  'get-context-apps',
  'save-context-apps',
  'test-local-processing',
  'get-save-capture-data',
  'choose-capture-dump-folder',

  // Chat / capture
  'chat:reset',
  'chat:capture-screenshot',
  'chat:send-message',
  'chat:get-recent-chats',
  'chat:load-chat',
  'capture-feedback-screenshot',

  // UI helpers
  'open-external',
  'get-debug-flag',
  'hotkey:get',
  'hotkey:set',
  'getInitialPauseState',
  'update:check-status',

  // Auth server
  'auth:google-signin',
  'auth:google-reauth'
];

// Whitelisted channels for receiving messages from main process
// Keep this in sync with all ipcRenderer.on(...) usages in src/*
const validReceiveChannels = [
  // Auth
  'logout',
  'refresh-token',
  'auth-error',
  'firebase-custom-token',
  'auth:custom-token-for-portal',
  'auth:reauth-result-for-portal',
  'auth:calendar-linked',

  // Chat
  'chat:receive-messages',
  'chat:message-update',
  'chat:recent-chats-updated',
  'chat:load-chat-result',
  'chat:process-message',
  'chat:reset-state',
  'chat:get-recent-chats',
  'chat:load-chat',
  'liquid-glass-active',

  // Webview / hotkey / updates
  'webview:reload',
  'hotkey:updated',
  'update:available',
  'update:not-available',

  // Permissions / recording
  'linux-windows-permission-notice',
  'linux-audio-permission-notice',
  'linux-pactl-missing-notice',
  'screenCapturePermission',
  'microphonePermission',
  'systemAudioPermission',
  'systemAudioPermission-recheck',
  'windowsPermission',
  'pauseStateChanged',
  'disable-capture-features',

  // Analytics / notifications
  'analytics-event',
  'request-notification',
  'inapp:hide',
  'background:notify',
  'background:hide',

  // Navigation / routing
  'navigate',
  'router:open-link'
];

contextBridge.exposeInMainWorld('electronAPI', {
  send: (channel, data) => {
    if (validSendChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    } else {
      console.warn(`Blocked unauthorized IPC send on channel: ${channel}`);
    }
  },
  invoke: (channel, data) => {
    if (validInvokeChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    } else {
      console.warn(`Blocked unauthorized IPC invoke on channel: ${channel}`);
      return Promise.reject(new Error(`Blocked unauthorized IPC invoke on channel: ${channel}`));
    }
  },
  on: (channel, func) => {
    if (validReceiveChannels.includes(channel)) {
      // Deliberately strip event as it includes `sender` 
      const subscription = (event, ...args) => func(event, ...args);
      ipcRenderer.on(channel, subscription);
      
      // Return a cleanup function
      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    } else {
      console.warn(`Blocked unauthorized IPC listener on channel: ${channel}`);
      return () => {};
    }
  },
  // Expose specific removeListener if needed, but the 'on' returns a cleanup function which is safer pattern for React/frontend
  // However, existing code uses ipcRenderer.removeListener pattern?
  // We'll expose a wrapper.
  removeListener: (channel, func) => {
    if (validReceiveChannels.includes(channel)) {
        ipcRenderer.removeListener(channel, func);
    }
  },
  // Platform info that was previously accessed via process
  platform: process.platform,
  isWayland: process.platform === 'linux' && !!(process.env.WAYLAND_DISPLAY || (process.env.XDG_SESSION_TYPE && process.env.XDG_SESSION_TYPE.toLowerCase() === 'wayland')),
  
  // Specific expose for debug/logging if needed
  log: (msg) => console.log(msg)
});
