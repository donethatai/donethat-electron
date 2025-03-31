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

// Update the auth state listener
onAuthStateChanged(auth, async (user) => {
  if (user) {
    // Check if email is verified
    if (!user.emailVerified) {
      // Ask if user wants to receive another verification email
      if (confirm("Your email is not verified. Would you like us to send another verification email?")) {
        try {
          await sendEmailVerification(user);
          logAnalyticsEvent('verification_email_sent');
          alert("Verification email sent. Please check your inbox.");
        } catch (error) {
          alert("Error sending verification email: " + error.message);
        }
      }
      await signOut(auth);
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

    // Set up a token refresh listener
    const refreshInterval = setInterval(async () => {
      if (auth.currentUser) {
        try {
          const freshToken = await auth.currentUser.getIdToken(true);
          updateAuthState(true, freshToken);
          ipcRenderer.send("login", freshToken);
        } catch (error) {
          console.error("Token refresh failed:", error);
        }
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

// Handle sign-in form submission
signInForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("signInEmail").value;
    const password = document.getElementById("signInPassword").value;
  
    signInWithEmailAndPassword(auth, email, password)
      .then((userCredential) => {
        // No need to manually handle the token here
        // The onAuthStateChanged listener will handle it
      })
      .catch((error) => {
        logAnalyticsEvent('sign_in_error', {
          error_code: error.code,
          error_message: error.message
        });
        alert("Sign in error: " + error.message);
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
        // Send email verification
        sendEmailVerification(userCredential.user)
          .then(() => {
            logAnalyticsEvent('verification_email_sent');
            alert("Verification email sent. Please check your inbox to verify your account before signing in.");
            signOut(auth); // Sign out until email is verified
            navigateToView('signin');
          })
          .catch((error) => {
            logAnalyticsEvent('verification_email_error', {
              error_code: error.code,
              error_message: error.message
            });
            console.error("Error sending verification email:", error);
            alert("Error sending verification email: " + error.message);
          });
      })
      .catch((error) => {
        logAnalyticsEvent('sign_up_error', {
          error_code: error.code,
          error_message: error.message
        });
        alert("Sign up error: " + error.message);
        console.error("Sign up error:", error);
      });
  });
  
  // Handle password reset form submission
  resetForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("resetEmail").value;
  
    sendPasswordResetEmail(auth, email)
      .then(() => {
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
        alert("Password reset error: " + error.message);
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

  export { initializeAuth, userIdToken };