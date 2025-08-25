// Application state management
const { ipcRenderer } = require('electron');
const { onAuthStateChanged } = require('firebase/auth');
const { firebaseApp, functions, auth } = require('./firebase.js');
const { getFirestore } = require('firebase/firestore');
const { collection, query, orderBy, onSnapshot } = require('@firebase/firestore');
const { httpsCallable } = require('firebase/functions');
const state = {
  // Authentication state
  isAuthenticated: false,
  userIdToken: null,

  // Permission state
  hasScreenCapturePermission: false,

  // Subscription state
  hasValidAccess: false,
  subscriptionStatus: null,
  hasActiveTeam: false,

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

function hasValidAccess() {
  return state.hasValidAccess;
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

function updateSubscriptionState(subscriptionStatus, activeTeam) {
  state.subscriptionStatus = subscriptionStatus;
  state.hasActiveTeam = activeTeam;
  state.hasValidAccess = activeTeam || 
                        subscriptionStatus === 'trialing' || 
                        subscriptionStatus === 'active';
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
      return {
        id: d.id,
        role: m.role === 'assistant' ? 'system' : 'user',
        text: m.content || '',
        status: m.status || 'sent'
      };
    });
    try { ipcRenderer.send('chat:new-messages', messages); } catch (_) {}
  }, (error) => {
    console.error('[CHAT] Message listener error:', error);
  });
}

function startChatListeners() {
  if (!auth?.currentUser) return;
  const db = getFirestore(firebaseApp, 'europe-west1');
  const q = query(
    collection(db, `chats/${auth.currentUser.uid}/chats`),
    orderBy('updatedAt', 'desc')
  );

  state.stopChatListener = onSnapshot(q, (snap) => {
    const docs = snap.docs;
    if (!docs || docs.length === 0) {
      state.currentChatId = null;
      try { ipcRenderer.send('chat:new-messages', []); } catch (_) {}
      return;
    }
    const mostRecent = docs[0];
    const newChatId = mostRecent.id;
    if (newChatId !== state.currentChatId) {
      state.currentChatId = newChatId;
      // Trigger overlay to show when a new chat is detected
      try { ipcRenderer.send('overlay:show-if-hidden'); } catch (_) {}
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
        chatId: state.currentChatId
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
    try { ipcRenderer.send('chat:new-messages', []); } catch (_) {}
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
  hasValidAccess,
  isPublic,
  isStoreScreenshots,
  getCurrentView,
  getLastSummary,
  getIsPaused,
  getDateCreated,
  updateAuthState,
  updateScreenCapturePermission,
  updateSubscriptionState,
  updateIsPublic,
  updateStoreScreenshots,
  updateCurrentView,
  updateLastSummary,
  updatePauseState,
  updateDateCreated,
  resetState,
  initializeChat
};