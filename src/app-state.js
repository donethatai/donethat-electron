// Application state management
const { ipcRenderer } = require('electron');
const { onAuthStateChanged } = require('firebase/auth');
const { firebaseApp, functions, auth } = require('./firebase.js');
const { getFirestore } = require('firebase/firestore');
const { collection, query, orderBy, where, onSnapshot } = require('@firebase/firestore');
const { httpsCallable } = require('firebase/functions');
const state = {
  // Authentication state
  isAuthenticated: false,
  userIdToken: null,

  // Permission state
  hasScreenCapturePermission: false,
  hasWindowsPermission: false,

  // User status
  userStatus: 'active',

  // Settings state
  isPublic: false,
  storeScreenshots: false,
  lastSummary: null,

  // Navigation state
  currentView: null,

  // Paused and user creation date
  isPaused: false,
  userDateCreated: null,

  // Chat state
  currentChatId: null,
  stopChatListener: null,
  stopMessageListener: null,
  chatIpcInitialized: false
};

// Helper to parse Firestore Timestamp createdAt to millis; ignore other types
function parseCreatedAtForTs(createdAt, docId) {
  try {
    if (!createdAt || typeof createdAt.toDate !== 'function') {
      // Only Firestore Timestamp supported
      return undefined;
    }
    const d = createdAt.toDate();
    const t = d && typeof d.getTime === 'function' ? d.getTime() : undefined;
    if (!Number.isFinite(t)) {
      console.warn('[CHAT] createdAt.toDate() invalid for message', docId);
      return undefined;
    }
    return t;
  } catch (e) {
    console.warn('[CHAT] Error parsing createdAt for message', docId, e);
    return undefined;
  }
}

// Getters
function getState() {
  return { ...state }; // Return a copy to prevent direct mutation
}

function isAuthenticated() {
  return state.isAuthenticated;
}

function hasScreenCapturePermission() {
  return state.hasScreenCapturePermission;
}

function hasWindowsPermission() {
  return state.hasWindowsPermission;
}

function hasValidAccess() {
  return state.userStatus === 'active';
}

function isPublic() {
  return state.isPublic;
}

function isStoreScreenshots() {
  return state.storeScreenshots;
}

function getCurrentView() {
  return state.currentView;
}

function getLastSummary() {
  return state.lastSummary;
}

function getIsPaused() {
  return state.isPaused;
}

function getDateCreated() {
  return state.userDateCreated;
}

// Setters
function updateAuthState(isAuthenticated, userIdToken) {
  state.isAuthenticated = isAuthenticated;
  state.userIdToken = userIdToken;
}

function updateScreenCapturePermission(hasPermission) {
  state.hasScreenCapturePermission = hasPermission;
}

function updateWindowsPermission(hasPermission) {
  state.hasWindowsPermission = hasPermission;
}

function updateUserStatus(status) {
  state.userStatus = status;
}

function updateIsPublic(isPublic) {
  state.isPublic = isPublic;
}

function updateStoreScreenshots(storeScreenshots) {
  state.storeScreenshots = storeScreenshots;
}

function updateCurrentView(view) {
  state.currentView = view;
}

function updateLastSummary(timestamp) {
  state.lastSummary = timestamp;
}

function updatePauseState(paused) {
  state.isPaused = paused;
}

function updateDateCreated(timestamp) {
  state.userDateCreated = timestamp;
}

// Reset state
function resetState() {
  Object.keys(state).forEach(key => {
    if (Array.isArray(state[key])) {
      state[key] = [];
    } else if (typeof state[key] === 'boolean') {
      state[key] = false;
    } else if (typeof state[key] === 'string') {
      state[key] = '';
    } else {
      state[key] = null;
    }
  });
}

// ---------------- Chat listeners moved from index.js ----------------
// Keep chat-related listeners centralized with state

function subscribeToMessages(chatId) {
  if (state.stopMessageListener) {
    try { state.stopMessageListener(); } catch (_) {}
    state.stopMessageListener = null;
  }

  const db = getFirestore(firebaseApp, 'europe-west1');
  const q = query(collection(db, `chats/${auth.currentUser.uid}/chats/${chatId}/messages`), orderBy('createdAt', 'asc'));

  state.stopMessageListener = onSnapshot(q, (snap) => {
    const messages = snap.docs.map((d) => {
      const m = d.data() || {};
      const ts = parseCreatedAtForTs(m.createdAt, d.id);
      return {
        id: d.id,
        // Preserve assistant role so renderer logic can react (e.g., requestScreen)
        role: m.role === 'assistant' ? 'assistant' : 'user',
        text: m.content || '',
        status: m.status || 'sent',
        // Pass through a numeric timestamp for inactivity checks (with logging)
        ts,
        // Pass through assistant request for next-user screenshot if present
        requestScreen: typeof m.requestScreen === 'boolean' ? m.requestScreen : undefined
      };
    });
    try { ipcRenderer.send('chat:set-messages', messages); } catch (_) {}
  }, (error) => {
    console.error('[CHAT] Message listener error:', error);
  });
}

function startChatListeners() {
  if (!auth?.currentUser) return;
  const db = getFirestore(firebaseApp, 'europe-west1');
  const q = query(
    collection(db, `chats/${auth.currentUser.uid}/chats`),
    where('channel', '==', 'desktop'),
    orderBy('updatedAt', 'desc')
  );

  state.stopChatListener = onSnapshot(q, async (snap) => {
    const docs = snap.docs;
    if (!docs || docs.length === 0) {
      state.currentChatId = null;
      try { ipcRenderer.send('chat:set-messages', []); } catch (_) {}
      return;
    }
    const mostRecent = docs[0];
    const newChatId = mostRecent.id;
    
    // Check if this is a truly new chat (younger than 1 minute)
    const chatData = mostRecent.data();
    const chatCreatedAt = chatData?.createdAt?.toDate?.() || new Date(chatData?.createdAt);
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    
    if (newChatId !== state.currentChatId && chatCreatedAt > oneMinuteAgo) {
      state.currentChatId = newChatId;
      // Clear chat window first, then show overlay (only if user has valid access and not in DND)
      try { ipcRenderer.send('chat:set-messages', []); } catch (_) {}
      if (hasValidAccess()) {
        // Check do not disturb mode before showing overlay
        try {
          const isDND = await ipcRenderer.invoke('check-do-not-disturb');
          if (!isDND) {
            try { ipcRenderer.send('overlay:show-if-hidden'); } catch (_) {}
          }
        } catch (error) {
          // If check fails, default to showing overlay
          console.error('[CHAT] Error checking do not disturb:', error);
          try { ipcRenderer.send('overlay:show-if-hidden'); } catch (_) {}
        }
      }
      subscribeToMessages(state.currentChatId);
    }
  }, (error) => {
    console.error('[CHAT] Chat listener error:', error);
  });
}

function stopChatListeners() {
  try { if (state.stopChatListener) state.stopChatListener(); } catch (_) {}
  try { if (state.stopMessageListener) state.stopMessageListener(); } catch (_) {}
  state.stopChatListener = null;
  state.stopMessageListener = null;
  state.currentChatId = null;
}

function setupChatIpcBridge() {
  if (state.chatIpcInitialized) return;
  state.chatIpcInitialized = true;

  // Handle chat message processing from overlay
  ipcRenderer.on('chat:process-message', async (_event, messageData) => {
    if (!auth?.currentUser) {
      try { ipcRenderer.send('chat:message-result', { success: false, error: 'Not authenticated' }); } catch (_) {}
      return;
    }
    try {
      const sendMessageFn = httpsCallable(functions, 'chatSendMessage');
      const result = await sendMessageFn({
        text: messageData.text,
        images: messageData.images || [],
        chatId: state.currentChatId,
        channel: 'desktop'
      });
      if (result.data?.chatId && result.data?.createdNewChat) {
        state.currentChatId = result.data.chatId;
        try { subscribeToMessages(state.currentChatId); } catch (e) { console.error('[CHAT] Failed to subscribe after new chat create:', e); }
      }
      ipcRenderer.send('chat:message-result', { success: true, data: result.data, messageId: result.data?.messageId });
    } catch (error) {
      console.error('[CHAT] Error sending message:', error);
      try { ipcRenderer.send('chat:message-result', { success: false, error: error.message }); } catch (_) {}
    }
  });

  // Handle chat reset from overlay
  ipcRenderer.on('chat:reset-state', () => {
    state.currentChatId = null;
    try { ipcRenderer.send('chat:set-messages', []); } catch (_) {}
  });
}

function initializeChat() {
  setupChatIpcBridge();
  onAuthStateChanged(auth, (user) => {
    if (user) {
      startChatListeners();
    } else {
      stopChatListeners();
    }
  });
  // Also initialize immediately if user is already signed in
  if (auth?.currentUser) {
    startChatListeners();
  }
}

module.exports = {
  getState,
  isAuthenticated,
  hasScreenCapturePermission,
  hasWindowsPermission,
  hasValidAccess,
  isPublic,
  isStoreScreenshots,
  getCurrentView,
  getLastSummary,
  getIsPaused,
  getDateCreated,
  updateAuthState,
  updateScreenCapturePermission,
  updateWindowsPermission,
  updateUserStatus,
  updateIsPublic,
  updateStoreScreenshots,
  updateCurrentView,
  updateLastSummary,
  updatePauseState,
  updateDateCreated,
  resetState,
  initializeChat
};