const { initializeApp } = require("firebase/app");
const { getAuth, setPersistence, browserLocalPersistence } = require("firebase/auth");
const { getFunctions } = require("firebase/functions");
const firebaseConfig = require("../firebase-config.js");
const { isLocalStorageUnavailableError } = require("./storage-errors.js");

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// Configure persistence to ensure auth state persists across app restarts.
// Chromium can reject this when IndexedDB/local profile storage cannot write
// (for example FILE_ERROR_NO_SPACE). Keep the rejection handled so startup does
// not become a global unhandledrejection.
const authPersistenceReady = setPersistence(auth, browserLocalPersistence)
  .then(() => ({ ok: true }))
  .catch((error) => {
    if (isLocalStorageUnavailableError(error)) {
      console.warn('Firebase auth persistence unavailable because local storage cannot be accessed:', error?.message || error);
      return { ok: false, localStorageUnavailable: true, error };
    }

    console.warn('Firebase auth persistence unavailable:', error?.message || error);
    return { ok: false, localStorageUnavailable: false, error };
  });

const functions = getFunctions(firebaseApp, "europe-west1");

module.exports = { auth, authPersistenceReady, firebaseApp, functions };
