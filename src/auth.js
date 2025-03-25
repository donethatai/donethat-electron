const {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    onAuthStateChanged,
    signOut
  } = require("firebase/auth");

const { ipcRenderer } = require("electron");


// Import auth instance from firebase.js
const { auth } = require('./firebase.js');
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
    // User is signed in
    const token = await user.getIdToken();
    updateAuthState(true, token);
    ipcRenderer.send("login", token);

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
      })
      .catch((error) => {
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
        alert("Password reset email sent. Check your inbox.");
        resetView.classList.add("hidden");
        signInView.classList.remove("hidden");
      })
      .catch((error) => {
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