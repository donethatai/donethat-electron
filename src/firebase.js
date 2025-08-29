const { initializeApp } = require("firebase/app");
const { getAuth, setPersistence, browserLocalPersistence } = require("firebase/auth");
const { getFunctions, httpsCallable } = require("firebase/functions");
const firebaseConfig = require("../firebase-config.js");

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// Configure persistence to ensure auth state persists across app restarts
setPersistence(auth, browserLocalPersistence);

const functions = getFunctions(firebaseApp, "europe-west1");

// External AppCheck token management
let externalAppCheckToken = null;
let tokenExpiry = null;

async function getAppCheckToken(options = { forceRefresh: false }) {
  try {
    if (!options.forceRefresh && externalAppCheckToken && tokenExpiry && Date.now() < tokenExpiry) return externalAppCheckToken;
    const { ipcRenderer } = require('electron');
    const recaptchaToken = await ipcRenderer.invoke('generate-appcheck-token');
    if (!recaptchaToken) {
      console.error('AppCheck: missing reCAPTCHA token');
      return null;
    }
    const callable = httpsCallable(functions, 'authGetAppCheckToken');
    const { data } = await callable({ clientToken: recaptchaToken, action: 'ELECTRON_LOGIN', appId: 'donethat' });
    if (!data || !data.token || !data.ttlMillis) {
      console.error('AppCheck: invalid function response');
      return null;
    }
    setExternalAppCheckToken(data.token, data.ttlMillis);
    return data.token;
  } catch (e) {
    console.error('AppCheck: token fetch failed', e?.code || '', e?.message || e);
    return null;
  }
}

// Function to set external AppCheck token from cloud function
function setExternalAppCheckToken(token, ttlMillis) {
  externalAppCheckToken = token;
  // subtract a small buffer (5 seconds) to avoid edge expiry
  const bufferMs = 5000;
  tokenExpiry = Date.now() + Math.max(0, ttlMillis - bufferMs);
}

module.exports = { auth, firebaseApp, functions, getAppCheckToken, setExternalAppCheckToken };

// Expose App Check getter globally for main process to call via executeJavaScript
try { 
  if (typeof window !== 'undefined') { 
    window.getAppCheckToken = () => getAppCheckToken(); 
    
    // Add a function to check AppCheck status
    window.getAppCheckStatus = () => ({
      hasExternalToken: !!externalAppCheckToken,
      tokenExpiry: tokenExpiry,
      tokenValid: tokenExpiry && Date.now() < tokenExpiry
    });
    
    // Add function to set external AppCheck token
    window.setExternalAppCheckToken = (token, ttlSeconds) => {
      setExternalAppCheckToken(token, ttlSeconds);
    };

    // Auth status helper for main process gating
    window.getAuthStatus = () => ({ signedIn: !!auth.currentUser });
  } 
} catch (error) { 
  
}