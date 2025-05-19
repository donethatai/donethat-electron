const {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    onAuthStateChanged,
    signOut,
    sendEmailVerification
  } = require("firebase/auth");

const { ipcRenderer } = require("electron");

// Import auth instance from firebase.js and analytics functions directly
const { auth } = require('./firebase.js');
const { logAnalyticsEvent, setAnalyticsUserProperties } = require('./analytics.js');
const { updateAuthState } = require('./app-state.js');
const { resetSummaryState } = require('./dashboard.js');

const signInForm = document.getElementById("signInForm");
const signUpForm = document.getElementById("signUpForm");
const resetForm = document.getElementById("resetForm");

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
  
  // Everything else is temporary and should be retried
  return AUTH_ERROR_TYPES.TEMPORARY;
}

// Enhanced error handling function
async function handleAuthError(error) {
  console.error('Auth error:', error?.code, error?.message);
  
  const errorType = categorizeAuthError(error);
  
  if (errorType === AUTH_ERROR_TYPES.CRITICAL) {
    // Only logout for permanent issues
    if (auth.currentUser) {
      logAnalyticsEvent('auth_error_critical', {
        error_code: error.code,
        error_message: error.message
      });
      await performFullLogout();
    }
  } else {
    // For temporary errors (network issues, rate limits, etc):
    // - Try up to 5 times with exponential backoff
    // - After 5 retries, let the next capture cycle handle it
    // - This prevents overlap with the 5-minute capture cycle
    // - Total retry window is ~2.5 minutes (5+10+20+40+80 seconds)
    if (retryCount < MAX_RETRIES) {
      retryCount++;
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
      // After max retries, just log and let next capture cycle handle it
      // This ensures we don't have retries overlapping with the 5-minute capture cycle
      logAnalyticsEvent('auth_error_max_retries', {
        error_code: error.code,
        error_message: error.message
      });
      // No need to force logout - next capture cycle will handle retry
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
  await refreshAuthToken();
});

// Listen for auth errors from main process
ipcRenderer.on('auth-error', (event, error) => {
  handleAuthError(error || { code: 'unknown', message: 'Unknown auth error' });
});

// Function to refresh Firebase auth token
async function refreshAuthToken() {
  try {
    if (auth.currentUser) {
      const newToken = await auth.currentUser.getIdToken(true);
      updateAuthState(true, newToken);
      ipcRenderer.send('token-refreshed', newToken);
      // Reset retry count on successful refresh
      retryCount = 0;
      return newToken;
    } else {
      return null;
    }
  } catch (error) {
    console.error('Renderer: Error during refreshAuthToken:', error);
    await handleAuthError(error);
    return null;
  }
}

// Update the auth state listener
onAuthStateChanged(auth, async (user) => {
  if (user) {
    // Reset retry count on successful auth
    retryCount = 0;
    
    // Check if email is verified
    if (!user.emailVerified) {
      try {
        await sendEmailVerification(user);
        logAnalyticsEvent('verification_email_sent');
        alert("Verification email sent. Please check your inbox.");
      } catch (error) {
        alert("Error sending verification email: " + error.message);
      }
      await signOut(auth);
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
      loadUserSettingsCallback();
    }
  } else {
    // User is signed out
    updateAuthState(false, null);
    
    // Reset retry state
    retryCount = 0;
    
    navigateToView('signin');
    
    // Log sign out event
    logAnalyticsEvent('user_signed_out');
  }
});

// Helper function to get user-friendly error messages
function getErrorMessage(error) {
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
    default:
      return `An error occurred: ${error.message}`;
  }
}

// Handle sign-in form submission
signInForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("signInEmail").value;
    const password = document.getElementById("signInPassword").value;
  
    signInWithEmailAndPassword(auth, email, password)
      .then((userCredential) => {
        // Clear input fields
        document.getElementById("signInEmail").value = "";
        document.getElementById("signInPassword").value = "";
      })
      .catch((error) => {
        logAnalyticsEvent('sign_in_error', {
          error_code: error.code,
          error_message: error.message
        });
        alert(getErrorMessage(error));
        console.error("Sign in error:", error);
      });
  });
  
  // Handle sign-up form submission
  signUpForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("signUpEmail").value;
    const password = document.getElementById("signUpPassword").value;
  
    createUserWithEmailAndPassword(auth, email, password)
      .then((userCredential) => {
        // Clear input fields
        document.getElementById("signUpEmail").value = "";
        document.getElementById("signUpPassword").value = "";
      })
      .catch((error) => {
        logAnalyticsEvent('sign_up_error', {
          error_code: error.code,
          error_message: error.message
        });
        alert(getErrorMessage(error));
        console.error("Sign up error:", error);
      });
  });
  
  // Handle password reset form submission
  resetForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("resetEmail").value;
  
    sendPasswordResetEmail(auth, email)
      .then(() => {
        // Clear input field
        document.getElementById("resetEmail").value = "";
        logAnalyticsEvent('password_reset_email_sent');
        alert("Password reset email sent. Check your inbox.");
        resetView.classList.add("hidden");
        signInView.classList.remove("hidden");
      })
      .catch((error) => {
        logAnalyticsEvent('password_reset_error', {
          error_code: error.code,
          error_message: error.message
        });
        alert(getErrorMessage(error));
        console.error("Password reset error:", error);
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

      navigateToView('signin');
  
    } catch (error) {
      console.error('Error during logout:', error);
      alert(`Error signing out: ${error.message}`);
    }
  }

  export { initializeAuth, userIdToken, refreshAuthToken };