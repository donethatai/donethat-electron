const log = require('electron-log');
const { initializeApp, getApps } = require('firebase/app');
const { getFunctions, httpsCallable } = require('firebase/functions');
const firebaseConfig = require('../firebase-config.js');

let firebaseApp = null;
let functionsClient = null;

function getFirebaseFunctionsClient() {
  if (!firebaseApp) {
    try {
      // Reuse existing default app if already initialized elsewhere in this process
      const existing = getApps && typeof getApps === 'function' ? getApps() : [];
      if (existing && existing.length > 0) {
        firebaseApp = existing[0];
      } else {
        firebaseApp = initializeApp(firebaseConfig);
      }
    } catch (e) {
      log.error('Failed to initialize Firebase app in main process:', e);
      throw e;
    }
  }

  if (!functionsClient) {
    try {
      functionsClient = getFunctions(firebaseApp, 'europe-west1');
    } catch (e) {
      log.error('Failed to initialize Functions client in main process:', e);
      throw e;
    }
  }

  return functionsClient;
}

async function getGoogleSignInUrl(port) {
  try {
    const functions = getFirebaseFunctionsClient();
    const googleSignInStart = httpsCallable(functions, 'authGoogleSignInStart');
    const result = await googleSignInStart({ port });
    return result && result.data ? result.data : null;
  } catch (error) {
    log.error('Error calling authGoogleSignInStart from main process:', error);
    throw error;
  }
}

module.exports = {
  getGoogleSignInUrl
};

