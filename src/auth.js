const {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    onAuthStateChanged,
    signOut,
    sendEmailVerification,
    signInWithCustomToken,
    getMultiFactorResolver,
    TotpMultiFactorGenerator
  } = require("firebase/auth");

const ipcRenderer = window.electronAPI;

// Import auth instance from firebase.js and analytics functions directly
const { auth, authPersistenceReady } = require('./firebase.js');
const { logAnalyticsEvent, setAnalyticsUserProperties } = require('./analytics.js');
const { updateAuthState } = require('./app-state.js');
const { resetSummaryState } = require('./dashboard.js');
// Centralized in-app banner
const { showBanner, hideBanner } = require('./notify.js');
const {
  getLocalStorageUnavailableUserMessage,
  isLocalStorageUnavailableError
} = require('./storage-errors.js');
function hideModal() { try { hideBanner(); } catch (_) {} }

const signInForm = document.getElementById("signInForm");
const signUpForm = document.getElementById("signUpForm");
const resetForm = document.getElementById("resetForm");
const googleSignInBtn = document.getElementById("googleSignInBtn");

const showSignUp = document.getElementById("showSignUp");
const backToSignIn = document.getElementById("backToSignIn");

const showResetPassword = document.getElementById("showResetPassword");
const backToSignInFromReset = document.getElementById("backToSignInFromReset");

let mfaResolver = null;
let mfaSelectedHintIndex = 0;

let loadUserSettingsCallback;
let showSpinner;
let hideSpinner;
let navigateToView;

let userIdToken;

// Add these error categories at the top level
const AUTH_ERROR_TYPES = {
  CRITICAL: 'critical',      // User disabled, invalid token
  TEMPORARY: 'temporary',    // Network issues, rate limits
  SESSION: 'session'         // Refresh token expired
};

// Add at the top level with other state
let retryCount = 0;
const INITIAL_RETRY_DELAY = 5000; // 5 seconds
const MAX_RETRIES = 7; // 7 retries: 5s, 10s, 20s, 40s, 80s, 160s, 320s

// When we've hit max retries while offline, wait for online event to retry
let waitingForOnline = false;
let onlineListenerBound = null;
let localStorageUnavailableBannerShown = false;

function showLocalStorageUnavailableBanner() {
  if (localStorageUnavailableBannerShown) return;
  localStorageUnavailableBannerShown = true;
  showBanner(getLocalStorageUnavailableUserMessage(), { title: 'Local Storage Unavailable', sticky: true });
}

// Helper to get next retry delay with exponential backoff
// We use exponential backoff to avoid overwhelming the server during issues
// but still retry quickly enough to handle temporary network blips
function getNextRetryDelay() {
  return INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
}

// Helper to categorize Firebase auth errors
function categorizeAuthError(error) {
  // Only these are permanent issues that require logout
  if (error.code === 'auth/user-disabled' ||
      error.code === 'auth/invalid-refresh-token' ||
      error.code === 'auth/user-not-found' ||
      error.code === 'auth/user-token-expired' ||
      error.code === 'auth/id-token-revoked') {
    return AUTH_ERROR_TYPES.CRITICAL;
  }
  return AUTH_ERROR_TYPES.TEMPORARY;
}

// Enhanced error handling function
async function handleAuthError(error) {
  if (isLocalStorageUnavailableError(error)) {
    console.error('Auth storage error:', error?.message || error);
    logAnalyticsEvent('auth_local_storage_unavailable', {
      error_message: error?.message || String(error)
    });
    showLocalStorageUnavailableBanner();
    if (typeof hideSpinner === 'function') hideSpinner();
    return;
  }

  const errorType = categorizeAuthError(error);
  
  console.error('Auth error:', error?.code, error?.message, errorType);
  if (retryCount > 0 || errorType === AUTH_ERROR_TYPES.CRITICAL) {
    console.log('=== Auth Error Handler ===');
    console.log('Error details:', error?.code, error?.message);
    console.log('Current retry count:', retryCount);
  }
  
  if (errorType === AUTH_ERROR_TYPES.CRITICAL) {
    console.log('Handling CRITICAL error - initiating logout');
    // Show error notification for critical errors - sticky banner
    showBanner('Authentication error. Please sign in again.', { title: 'Auth Error', sticky: true });
    
    // Only logout for permanent issues
    if (auth.currentUser) {
      logAnalyticsEvent('auth_error_critical', {
        error_code: error.code,
        error_message: error.message
      });
      hideSpinner();
      await performFullLogout();
    }
  } else {
    // For temporary errors (network issues, rate limits, etc):
    if (retryCount < MAX_RETRIES) {
      const isOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);

      // Show notification for retry > 0
      if (retryCount > 0) {
        showBanner('Connection issue. Please check your internet connection.', { title: 'Network Issue', sticky: false, noFocus: true });
      }

      logAnalyticsEvent('auth_error_retry', {
        error_code: error.code,
        error_message: error.message,
        retry_count: retryCount + 1,
        offline: isOffline
      });

      if (isOffline) {
        // Pause timer-based backoff; wait for online to continue immediately
        if (!waitingForOnline) {
          waitingForOnline = true;
          onlineListenerBound = () => {
            try { window.removeEventListener('online', onlineListenerBound); } catch (_) {}
            waitingForOnline = false;
            // Proceed with the next retry step immediately upon connectivity
            retryCount++;
            if (auth.currentUser) {
              refreshAuthToken();
            }
          };
          try { window.addEventListener('online', onlineListenerBound, { once: true }); } catch (_) {}
        }
      } else {
        // Online: continue with exponential backoff timer
        retryCount++;
        const delay = getNextRetryDelay();
        setTimeout(() => {
          if (auth.currentUser) {
            refreshAuthToken();
          }
        }, delay);
      }
    } else {
      // Max retries reached. If offline, stop backoff and wait for online to retry immediately
      const isOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);
      showBanner('Connection issue. Waiting to retry when back online…', { title: 'Network Issue', sticky: false, noFocus: true });

      logAnalyticsEvent('auth_error_max_retries', {
        error_code: error.code,
        error_message: error.message,
        offline: isOffline
      });

      if (isOffline && !waitingForOnline) {
        waitingForOnline = true;
        onlineListenerBound = () => {
          try {
            window.removeEventListener('online', onlineListenerBound);
          } catch (_) {}
          waitingForOnline = false;
          // Reset retry counter and attempt immediately
          retryCount = 0;
          if (auth.currentUser) {
            refreshAuthToken();
          }
        };
        try { window.addEventListener('online', onlineListenerBound, { once: true }); } catch (_) {}
      }
      hideSpinner();
    }
  }
}

function initializeAuth(onSettingsUpdate, showBlockingSpinner, hideBlockingSpinner, viewNavigator) {
    loadUserSettingsCallback = onSettingsUpdate;
    showSpinner = showBlockingSpinner;
    hideSpinner = hideBlockingSpinner;
    navigateToView = viewNavigator;

    try {
      window.addEventListener('donethat:local-storage-unavailable', showLocalStorageUnavailableBanner);
      if (window.__donethatLocalStorageUnavailableDetected) {
        showLocalStorageUnavailableBanner();
      }
    } catch (_) {}

    authPersistenceReady.then((result) => {
      if (result?.localStorageUnavailable) {
        showLocalStorageUnavailableBanner();
      }
    }).catch((error) => {
      console.warn('Unexpected auth persistence readiness error:', error?.message || error);
    });
}

// Listen for logout event from tray menu at module level
ipcRenderer.on('logout', async () => {
  await performFullLogout();
});

// Listen for token refresh requests from main process
ipcRenderer.on('refresh-token', async () => {
  // Reset retry count when a new capture cycle starts
  retryCount = 0;
  // Hide any previous error notifications
  hideModal();
  await refreshAuthToken();
});

// Listen for auth errors from main process
ipcRenderer.on('auth-error', (error) => {
  handleAuthError(error || { code: 'unknown', message: 'Unknown auth error' });
});

// Function to refresh Firebase auth token
async function refreshAuthToken() {
  if (retryCount > 0) {
    console.log('=== Token Refresh ===');
    console.log('Current retry count:', retryCount);
    console.log('Has current user:', !!auth.currentUser);
  }
  
  try {
    if (auth.currentUser) {
      if (retryCount > 0) {
        console.log('Getting new token...');
      }
      const newToken = await auth.currentUser.getIdToken(true);
      if (retryCount > 0) {
        console.log('Token refresh successful');
        // Hide error notification on successful refresh
        hideModal();
      }
      updateAuthState(true, newToken);
      ipcRenderer.send('token-refreshed', newToken);
      // Reset retry count on successful refresh
      retryCount = 0;
      return newToken;
    } else {
      console.log('No current user - cannot refresh token');
      return null;
    }
  } catch (error) {
    console.log('Token refresh failed:', error?.code, error?.message);
    await handleAuthError(error);
    return null;
  }
}

// Update the auth state listener
onAuthStateChanged(auth, async (user) => {
  try {
    if (user) {
      // Reset retry count on successful auth
      retryCount = 0;
      // Hide any error notifications
      hideModal();
      
      // Check if email is verified
      if (!user.emailVerified) {
        try {
          await sendEmailVerification(user);
          logAnalyticsEvent('verification_email_sent');
          showBanner("Verification email sent. Please check your inbox.", { title: 'Email Sent' });
        } catch (error) {
          showBanner("Error sending verification email: " + error.message, { title: 'Email Error', sticky: true });
        }
        await signOut(auth);
        hideSpinner();
        navigateToView('signin');
        return;
      }
      
      // User is signed in - add retry mechanism for token retrieval
      let token = null;
      let tokenRetries = 0;
      const maxTokenRetries = 6; // 1s,2s,4s,8s,16s,32s
      
      while (!token && tokenRetries < maxTokenRetries) {
        try {
          token = await user.getIdToken();
          if (token) break;
        } catch (error) {
          tokenRetries++;
          if (tokenRetries < maxTokenRetries) {
            // Wait before retry (1s,2s,4s,8s,16s,32s)
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, tokenRetries - 1)));
          }
        }
      }
      
      if (!token) {
        console.error('Failed to get token after retries');
        // Don't logout immediately - let the user try again
        hideSpinner();
        return;
      }
      
      updateAuthState(true, token);
      ipcRenderer.send("login", token);
      
      // Create overlay window when user signs in
      ipcRenderer.send("create-overlay-if-needed");

      // Set user properties for analytics
      setAnalyticsUserProperties({
        user_id: user.uid,
        email_verified: user.emailVerified
      });

      // Log sign in event
      logAnalyticsEvent('user_signed_in', {
        method: user.providerData[0]?.providerId || 'email',
        email_verified: user.emailVerified
      });

      // Set up a token refresh interval
      const refreshInterval = setInterval(async () => {
        if (auth.currentUser) {
          await refreshAuthToken();
        } else {
          clearInterval(refreshInterval);
        }
      }, 45 * 60 * 1000); // Refresh every 45 minutes

      if (loadUserSettingsCallback) {
        // Keep spinner visible - loadUserSettingsCallback will hide it when done
        loadUserSettingsCallback();
        // Do not hide spinner here, let loadUserSettingsCallback handle it
        return;
      }
      
      // Only hide spinner if loadUserSettingsCallback is not called
      hideSpinner();
    } else {
      // User is signed out
      updateAuthState(false, null);
      
      // Reset retry state
      retryCount = 0;
      
      hideSpinner();
      navigateToView('signin');
      
      // Log sign out event
      logAnalyticsEvent('user_signed_out');
    }
  } catch (error) {
    console.error("Auth state change error:", error);
    hideSpinner();
    navigateToView('signin');
  }
});

// Helper function to get user-friendly error messages
function getErrorMessage(error) {
  if (isLocalStorageUnavailableError(error)) {
    return getLocalStorageUnavailableUserMessage();
  }

  // Deadline exceeded (e.g. from backend) – show generic retry message
  const msg = (error.message || '').toLowerCase();
  if (msg.includes('deadline exceeded') || msg.includes('deadline-exceeded') || (error.code && String(error.code).toLowerCase().includes('deadline'))) {
    return 'Please try again.';
  }
  // Check for network-related errors first
  if (error.code?.includes('network') || error.message?.includes('network')) {
    return 'Network error. Please check your internet connection and try again.';
  }

  switch (error.code) {
    case 'auth/invalid-email':
      return 'Please enter a valid email address';
    case 'auth/user-disabled':
      return 'This account has been disabled';
    case 'auth/user-not-found':
      return 'No account found with this email';
    case 'auth/wrong-password':
      return 'Incorrect password';
    case 'auth/email-already-in-use':
      return 'An account with this email already exists';
    case 'auth/weak-password':
      return 'Password should be at least 6 characters';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later';
    case 'auth/network-request-failed':
      return 'Network error. Please check your connection';
    // Add additional error cases
    case 'auth/missing-email':
      return 'Please enter an email address';
    case 'auth/invalid-credential':
      return 'Invalid login credentials';
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists with the same email but different sign-in credentials';
    case 'auth/operation-not-allowed':
      return 'This operation is not allowed';
    case 'auth/requires-recent-login':
      return 'Please sign in again before retrying this request';
    case 'auth/user-token-expired':
      return 'Your session has expired. Please sign in again';
    case 'auth/expired-action-code':
      return 'This link has expired. Please request a new one';
    case 'auth/invalid-action-code':
      return 'The link you used is invalid or has already been used';
    case 'auth/popup-blocked':
      return 'Sign-in popup was blocked by your browser';
    case 'auth/popup-closed-by-user':
      return 'Sign-in window was closed before completing the process';
    case 'auth/unauthorized-domain':
      return 'This domain is not authorized for this operation';
    case 'auth/quota-exceeded':
      return 'Service quota exceeded. Please try again later';
    case 'auth/timeout':
      return 'The operation has timed out. Please try again';
    case 'auth/web-storage-unsupported':
      return 'Local web storage is required but not supported by your browser';
    case 'auth/multi-factor-auth-required':
      return 'Additional verification required';
    case 'auth/invalid-verification-code':
      return 'Invalid or expired code. Please try again.';
    default:
      return `An error occurred: ${error.message}`;
  }
}

function handleMfaRequired(error) {
  try {
    mfaResolver = getMultiFactorResolver(auth, error);
    const hints = mfaResolver.hints || [];
    const totpIndex = hints.findIndex(h => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
    if (totpIndex === -1) {
      mfaResolver = null;
      hideSpinner();
      showBanner('Verification method not supported in this app. Please sign in on the web.', { title: 'Sign In', sticky: true });
      if (typeof navigateToView === 'function') navigateToView('signin');
      return;
    }
    mfaSelectedHintIndex = totpIndex;
    hideSpinner();
    if (typeof navigateToView === 'function') navigateToView('mfa');
    const codeInput = document.getElementById('mfaCodeInput');
    const mfaError = document.getElementById('mfaError');
    if (codeInput) { codeInput.value = ''; codeInput.focus(); }
    if (mfaError) { mfaError.textContent = ''; mfaError.classList.add('hidden'); }
  } catch (err) {
    console.error('MFA setup error:', err);
    mfaResolver = null;
    hideSpinner();
    showBanner(getErrorMessage(error), { title: 'Sign In Error', sticky: true });
    if (typeof navigateToView === 'function') navigateToView('signin');
  }
}

async function submitMfaCode(code) {
  if (!mfaResolver || !mfaResolver.hints || !mfaResolver.hints[mfaSelectedHintIndex]) return;
  const hint = mfaResolver.hints[mfaSelectedHintIndex];
  if (hint.factorId !== TotpMultiFactorGenerator.FACTOR_ID) return;
  const trimmed = (code || '').trim();
  if (!trimmed) {
    const mfaError = document.getElementById('mfaError');
    if (mfaError) { mfaError.textContent = 'Please enter the code from your authenticator app.'; mfaError.classList.remove('hidden'); }
    return;
  }
  showSpinner();
  const mfaError = document.getElementById('mfaError');
  if (mfaError) { mfaError.textContent = ''; mfaError.classList.add('hidden'); }
  try {
    const assertion = TotpMultiFactorGenerator.assertionForSignIn(hint.uid, trimmed);
    await mfaResolver.resolveSignIn(assertion);
    mfaResolver = null;
    logAnalyticsEvent('mfa_sign_in_success', { factor: 'totp' });
    hideSpinner();
  } catch (err) {
    mfaResolver = null;
    hideSpinner();
    if (typeof navigateToView === 'function') navigateToView('signin');
    logAnalyticsEvent('mfa_sign_in_error', { error_code: err.code, error_message: err.message });
    showBanner(getErrorMessage(err), { title: 'Verification Failed', sticky: false });
  }
}

function cancelMfa() {
  mfaResolver = null;
  if (typeof navigateToView === 'function') navigateToView('signin');
}

// Handle sign-in form submission
signInForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("signInEmail").value;
    const password = document.getElementById("signInPassword").value;
    
    showSpinner();
    signInWithEmailAndPassword(auth, email, password)
      .then((userCredential) => {
        // Delay clearing input fields to give password managers time to save
        setTimeout(() => {
          document.getElementById("signInEmail").value = "";
          document.getElementById("signInPassword").value = "";
        }, 1000);
      })
      .catch((error) => {
        if (error.code === 'auth/multi-factor-auth-required') {
          handleMfaRequired(error);
          return;
        }
        hideSpinner();
        logAnalyticsEvent('sign_in_error', {
          error_code: error.code,
          error_message: error.message
        });
        showBanner(getErrorMessage(error), { title: 'Sign In Error', sticky: true });
      });
  });

  // MFA challenge form
  const mfaVerifyBtn = document.getElementById('mfaVerifyBtn');
  const mfaCancelBtn = document.getElementById('mfaCancelBtn');
  const mfaCodeInput = document.getElementById('mfaCodeInput');
  const mfaForm = document.getElementById('mfaForm');
  if (mfaForm) {
    mfaForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitMfaCode(mfaCodeInput ? mfaCodeInput.value : '');
    });
  }
  if (mfaVerifyBtn) mfaVerifyBtn.addEventListener('click', () => submitMfaCode(mfaCodeInput ? mfaCodeInput.value : ''));
  if (mfaCancelBtn) mfaCancelBtn.addEventListener('click', cancelMfa);
  
  // Handle sign-up form submission
  signUpForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("signUpEmail").value;
    const password = document.getElementById("signUpPassword").value;
    
    showSpinner();
    createUserWithEmailAndPassword(auth, email, password)
      .then((userCredential) => {
        // Delay clearing input fields to give password managers time to save
        setTimeout(() => {
          document.getElementById("signUpEmail").value = "";
          document.getElementById("signUpPassword").value = "";
        }, 1000);
      })
      .catch((error) => {
        hideSpinner();
        logAnalyticsEvent('sign_up_error', {
          error_code: error.code,
          error_message: error.message
        });
        showBanner(getErrorMessage(error), { title: 'Sign Up Error', sticky: true });
      });
  });
  
  // Handle password reset form submission
  resetForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("resetEmail").value;
    
    showSpinner();
    sendPasswordResetEmail(auth, email)
      .then(() => {
        // Clear input field
        document.getElementById("resetEmail").value = "";
        hideSpinner();
        logAnalyticsEvent('password_reset_email_sent');
        showBanner("Password reset email sent. Check your inbox.", { title: 'Email Sent' });
        resetView.classList.add("hidden");
        signInView.classList.remove("hidden");
      })
      .catch((error) => {
        hideSpinner();
        logAnalyticsEvent('password_reset_error', {
          error_code: error.code,
          error_message: error.message
        });
        showBanner(getErrorMessage(error), { title: 'Password Reset Error', sticky: true });
      });
  });
  
  // Toggle to show the sign-up view
  showSignUp.addEventListener("click", (e) => {
    e.preventDefault();
    navigateToView('signup');
  });
  
  // Toggle to go back to the sign-in view from the sign-up view
  backToSignIn.addEventListener("click", (e) => {
    e.preventDefault();
    navigateToView('signin');
  });
  
  // Toggle to show the password reset view
  showResetPassword.addEventListener("click", (e) => {
    e.preventDefault();
    navigateToView('reset');
  });

  // Toggle password visibility helpers
  function wirePasswordToggle(buttonElementId, inputElementId) {
    try {
      const btn = document.getElementById(buttonElementId);
      const input = document.getElementById(inputElementId);
      if (!btn || !input) return;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const isPassword = input.getAttribute('type') === 'password';
        input.setAttribute('type', isPassword ? 'text' : 'password');
      });
    } catch (_) {}
  }

  // Wire up show/hide for auth forms
  wirePasswordToggle('toggleSignInPasswordBtn', 'signInPassword');
  wirePasswordToggle('toggleSignUpPasswordBtn', 'signUpPassword');

  // Handle Google Sign In/Up (single button for both)
  googleSignInBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    
    try {
      showSpinner();
      try { googleSignInBtn.disabled = true; } catch (_) {}
      ipcRenderer.invoke('auth:google-signin', { requestCalendar: false })
        .then((result) => {
          if (!result || result.success === false) {
            console.error('Google Sign In main-process error:', result && result.error);
            showBanner(`Failed to start Google Sign In: ${result && result.error ? result.error : 'Unknown error'}`, { title: 'Google Sign In', sticky: true });
            hideSpinner();
            try { googleSignInBtn.disabled = false; } catch (_) {}
            return;
          }
          const url = result.url;
          if (url) {
            window.electronAPI.invoke('open-external', url).then((res) => {
              if (!res || res.success === false) {
                console.error('open-external failed:', res && res.error);
                showBanner('Failed to open browser for Google Sign In.', { title: 'Google Sign In', sticky: true });
                hideSpinner();
                try { googleSignInBtn.disabled = false; } catch (_) {}
              }
            }).catch((err) => {
              console.error('open-external threw error:', err);
              showBanner('Failed to open browser for Google Sign In.', { title: 'Google Sign In', sticky: true });
              hideSpinner();
              try { googleSignInBtn.disabled = false; } catch (_) {}
            });
          } else {
            console.error('No URL returned from Google Sign In start');
            showBanner('No URL returned from Google Sign In function.', { title: 'Google Sign In', sticky: true });
            hideSpinner();
            try { googleSignInBtn.disabled = false; } catch (_) {}
          }
        })
        .catch((error) => {
          console.error('Google Sign In error:', error);
          logAnalyticsEvent('google_sign_in_error', {
            error_code: error.code,
            error_message: error.message
          });
          showBanner(`Failed to start Google Sign In: ${error.message}`, { title: 'Google Sign In', sticky: true });
          hideSpinner();
          try { googleSignInBtn.disabled = false; } catch (_) {}
        });
    } catch (error) {
      console.error('Google Sign In setup error:', error);
      showBanner(`Failed to setup Google Sign In: ${error.message}`, { title: 'Google Sign In', sticky: true });
      hideSpinner();
      try { googleSignInBtn.disabled = false; } catch (_) {}
      // Stop the auth server on setup error
      try { ipcRenderer.invoke('auth:stop-server'); } catch (_) {}
    }
  });

  // Handle custom token from main process
  ipcRenderer.on('firebase-custom-token', (token) => {
    ipcRenderer.send('focus-app-window');
    signInWithCustomToken(auth, token)
      .then((userCredential) => {
        logAnalyticsEvent('google_sign_in_success');
        hideSpinner();
        try { googleSignInBtn.disabled = false; } catch (_) {}
      })
      .catch((error) => {
        if (error.code === 'auth/multi-factor-auth-required') {
          handleMfaRequired(error);
          return;
        }
        logAnalyticsEvent('google_sign_in_token_error', {
          error_code: error.code,
          error_message: error.message
        });
        showBanner('Failed to complete Google Sign In. Please try again.', { title: 'Google Sign In', sticky: true });
        console.error("Firebase custom token sign-in error:", error);
        hideSpinner();
        try { googleSignInBtn.disabled = false; } catch (_) {}
        // Stop the auth server on error too
        ipcRenderer.invoke('auth:stop-server');
      });
  });
  
  // Toggle to go back to the sign-in view from the password reset view
  backToSignInFromReset.addEventListener("click", (e) => {
    e.preventDefault();
    navigateToView('signin');
  });
  
  // Helper function for complete logout cleanup
  async function performFullLogout() {
    try {
      // Reset retry count on logout
      retryCount = 0;
      
      // Log logout event
      if (auth.currentUser) {
        logAnalyticsEvent('user_logout', {
          user_id: auth.currentUser.uid,
          method: 'explicit_logout'
        });
      }
    
      // Clear Firebase auth state
      await signOut(auth);
  
      // Clear any Firebase specific storage
      const firebaseLocalStorageKeys = Object.keys(window.localStorage)
        .filter(key => key.startsWith('firebase:'));
      firebaseLocalStorageKeys.forEach(key => window.localStorage.removeItem(key));
  
      // Reset application state
      updateAuthState(false, null);
  
      // Reset the UI state
      resetSummaryState();
  
      // Notify main process
      ipcRenderer.send('logout');

      hideSpinner();
      navigateToView('signin');
  
    } catch (error) {
      console.error('Error during logout:', error);
      hideSpinner();
      showBanner(`Error signing out: ${error.message}`, { title: 'Sign Out Error', sticky: true });
    }
  }

  export { initializeAuth, userIdToken, refreshAuthToken, performFullLogout };
