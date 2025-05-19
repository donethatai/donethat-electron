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

const logoutLink = document.getElementById("logoutLink");

let loadUserSettingsCallback;
let showSpinner;
let hideSpinner;
let navigateToView;

let userIdToken;

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
  await refreshAuthToken();
});

// Listen for auth errors from main process
ipcRenderer.on('auth-error', () => {
  handleAuthError();
});

// Function to refresh Firebase auth token
async function refreshAuthToken() {
  try {
    if (auth.currentUser) {
      // Force refresh the token
      const newToken = await auth.currentUser.getIdToken(true);
      
      // Update app state with new token
      updateAuthState(true, newToken);
      
      ipcRenderer.send('token-refreshed', newToken);
      return newToken;
    } else {
      ipcRenderer.send('token-refreshed', null);
      return null;
    }
  } catch (error) {
    console.error('Renderer: Error during refreshAuthToken:', error);
    console.error("Renderer: Error Code:", error.code);
    console.error("Renderer: Error Message:", error.message);

    if (error.code === 'auth/user-token-expired' ||
        error.code === 'auth/invalid-refresh-token' ||
        error.code === 'auth/user-disabled' ||
        error.code === 'auth/invalid-user-token') {
        console.error("Renderer: Refresh token might be invalid or user session expired server-side.");
    }

    ipcRenderer.send('token-refreshed', null);
    return null;
  }
}

// Function to handle auth errors
function handleAuthError() {
  // For severe auth errors, do a proper logout
  if (auth.currentUser) {
    // Perform full logout rather than just updating state
    performFullLogout();
  } else {
    // If no current user, just navigate to sign in
    navigateToView('signin');
  }
}

// Update the auth state listener
onAuthStateChanged(auth, async (user) => {
  if (user) {
    // Check if email is verified
    if (!user.emailVerified) {
      try{
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

    // Set up a token refresh interval using the same refreshAuthToken function
    const refreshInterval = setInterval(async () => {
      if (auth.currentUser) {
        // Use the same refreshAuthToken function for consistency
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
      // Log logout event before actually logging out to include user ID
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