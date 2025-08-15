const {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    onAuthStateChanged,
    signOut,
    sendEmailVerification,
    signInWithCustomToken
  } = require("firebase/auth");

const { ipcRenderer } = require("electron");

// Import auth instance from firebase.js and analytics functions directly
const { auth } = require('./firebase.js');
const { logAnalyticsEvent, setAnalyticsUserProperties } = require('./analytics.js');
const { updateAuthState } = require('./app-state.js');
const { resetSummaryState } = require('./dashboard.js');
// Import modal functions for UI notifications
const { showErrorModal, showSuccessModal, showPersistentErrorModal, hideModal } = require('./modal.js');

const signInForm = document.getElementById("signInForm");
const signUpForm = document.getElementById("signUpForm");
const resetForm = document.getElementById("resetForm");
const googleSignInBtn = document.getElementById("googleSignInBtn");

const showSignUp = document.getElementById("showSignUp");
const backToSignIn = document.getElementById("backToSignIn");

const showResetPassword = document.getElementById("showResetPassword");
const backToSignInFromReset = document.getElementById("backToSignInFromReset");

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
const MAX_RETRIES = 5; // 5 retries: 5s, 10s, 20s, 40s, 80s

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
  const errorType = categorizeAuthError(error);
  
  console.error('Auth error:', error?.code, error?.message, errorType);
  if (retryCount > 0 || errorType === AUTH_ERROR_TYPES.CRITICAL) {
    console.log('=== Auth Error Handler ===');
    console.log('Error details:', error?.code, error?.message);
    console.log('Current retry count:', retryCount);
  }
  
  if (errorType === AUTH_ERROR_TYPES.CRITICAL) {
    console.log('Handling CRITICAL error - initiating logout');
    // Show error notification for critical errors - use persistent modal
    showPersistentErrorModal('Authentication error. Please sign in again.');
    
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
      retryCount++;
      
      // Show notification for retry > 1
      if (retryCount > 1) {
        showPersistentErrorModal('Connection issue. Please check your internet connection.');
        console.log(`Scheduling retry ${retryCount}/${MAX_RETRIES}`);
      }
      
      logAnalyticsEvent('auth_error_retry', {
        error_code: error.code,
        error_message: error.message,
        retry_count: retryCount
      });

      // Schedule next retry
      const delay = getNextRetryDelay();
      setTimeout(() => {
        if (auth.currentUser) {
          refreshAuthToken();
        }
      }, delay);
    } else {
      console.log('Max retries reached - waiting for next capture cycle');
      showPersistentErrorModal('Connection issue. Please check your internet connection.');
      
      logAnalyticsEvent('auth_error_max_retries', {
        error_code: error.code,
        error_message: error.message
      });
      hideSpinner();
    }
  }
}

function initializeAuth(onSettingsUpdate, showBlockingSpinner, hideBlockingSpinner, viewNavigator) {
    loadUserSettingsCallback = onSettingsUpdate;
    showSpinner = showBlockingSpinner;
    hideSpinner = hideBlockingSpinner;
    navigateToView = viewNavigator;
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
ipcRenderer.on('auth-error', (event, error) => {
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
          showSuccessModal("Verification email sent. Please check your inbox.");
        } catch (error) {
          showErrorModal("Error sending verification email: " + error.message);
        }
        await signOut(auth);
        hideSpinner();
        navigateToView('signin');
        return;
      }
      
      // User is signed in
      const token = await user.getIdToken();
      updateAuthState(true, token);
      ipcRenderer.send("login", token);

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
    default:
      return `An error occurred: ${error.message}`;
  }
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
        hideSpinner();
        logAnalyticsEvent('sign_in_error', {
          error_code: error.code,
          error_message: error.message
        });
        showErrorModal(getErrorMessage(error));
      });
  });
  
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
        showErrorModal(getErrorMessage(error));
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
        showSuccessModal("Password reset email sent. Check your inbox.");
        resetView.classList.add("hidden");
        signInView.classList.remove("hidden");
      })
      .catch((error) => {
        hideSpinner();
        logAnalyticsEvent('password_reset_error', {
          error_code: error.code,
          error_message: error.message
        });
        showErrorModal(getErrorMessage(error));
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

  // Handle Google Sign In/Up (single button for both)
  googleSignInBtn.addEventListener("click", (e) => {
    e.preventDefault();
    
    try {
      // Call the Firebase function to start Google Sign In
      const { httpsCallable } = require('firebase/functions');
      const { functions } = require('./firebase.js');
      
      const googleSignInStart = httpsCallable(functions, 'authGoogleSignInStart');
      
      googleSignInStart()
        .then((result) => {
          // The function should return a URL to open
          const url = result.data?.authUrl || result.data?.url || result.data?.data?.url;
          if (url) {
            // Open the URL in the default browser
            const { shell } = require('electron');
            shell.openExternal(url);
          } else {
            console.error('No URL found in result:', JSON.stringify(result.data, null, 2));
            showErrorModal('No URL returned from Google Sign In function.');
          }
        })
        .catch((error) => {
          console.error('Google Sign In error:', error);
          logAnalyticsEvent('google_sign_in_error', {
            error_code: error.code,
            error_message: error.message
          });
          showErrorModal(`Failed to start Google Sign In: ${error.message}`);
        });
    } catch (error) {
      console.error('Google Sign In setup error:', error);
      showErrorModal(`Failed to setup Google Sign In: ${error.message}`);
    }
  });

  // Handle custom token from main process
  ipcRenderer.on('firebase-custom-token', (event, token) => {
    // Request main process to focus the window
    ipcRenderer.send('focus-app-window');
    
    signInWithCustomToken(auth, token)
      .then((userCredential) => {
        logAnalyticsEvent('google_sign_in_success');
      })
      .catch((error) => {
        logAnalyticsEvent('google_sign_in_token_error', {
          error_code: error.code,
          error_message: error.message
        });
        showErrorModal('Failed to complete Google Sign In. Please try again.');
        console.error("Firebase custom token sign-in error:", error);
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
      showErrorModal(`Error signing out: ${error.message}`);
    }
  }

  export { initializeAuth, userIdToken, refreshAuthToken };