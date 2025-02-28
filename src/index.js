const { initializeApp } = require("firebase/app");
const {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
  browserLocalPersistence,
  setPersistence,
} = require("firebase/auth");
const { getFunctions, httpsCallable } = require("firebase/functions");
const firebaseConfig = require("../firebase-config.js");

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app, "europe-west1"); // Specify region to match your functions

// Optional: Connect to emulator in development
// if (process.env.NODE_ENV === 'development') {
//   connectFunctionsEmulator(functions, "localhost", 5001);
// }

// Create callable function references
const generateRawSummaryFunction = httpsCallable(functions, "generateRawSummary");
const saveFinalSummaryFunction = httpsCallable(functions, "saveFinalSummary");
const discardSummaryFunction = httpsCallable(functions, "discardSummary");
const getUserSettingsFunction = httpsCallable(functions, "getUserSettings");
const updateUserSettingsFunction = httpsCallable(functions, "updateUserSettings");

// Explicitly set auth persistence to local storage
setPersistence(auth, browserLocalPersistence)
  .then(() => {
    console.log("Auth persistence set to local.");
  })
  .catch((error) => {
    console.error("Error setting persistence:", error);
  });

// Get references to views and elements
const signInView = document.getElementById("signInView");
const signUpView = document.getElementById("signUpView");
const resetView = document.getElementById("resetView");
const dashboardView = document.getElementById("dashboardView");
const settingsView = document.getElementById("settingsView");

const signInForm = document.getElementById("signInForm");
const signUpForm = document.getElementById("signUpForm");
const resetForm = document.getElementById("resetForm");

const logoutLink = document.getElementById("logoutLink");

const showSignUp = document.getElementById("showSignUp");
const backToSignIn = document.getElementById("backToSignIn");

const showResetPassword = document.getElementById("showResetPassword");
const backToSignInFromReset = document.getElementById("backToSignInFromReset");

// Add references to dashboard UI elements
const generateSummaryBtn = document.getElementById("generateSummaryBtn");
const submitSummaryBtn = document.getElementById("submitSummaryBtn");
const discardSummaryBtn = document.getElementById("discardSummaryBtn");
const settingsBtn = document.getElementById("settingsBtn");
const backToDashboardBtn = document.getElementById("backToDashboardBtn");
const summaryContainer = document.getElementById("summaryContainer");
const loadingSpinner = document.getElementById("loadingSpinner");
const confirmDiscardModal = document.getElementById("confirmDiscardModal");
const confirmDiscardBtn = document.getElementById("confirmDiscardBtn");
const cancelDiscardBtn = document.getElementById("cancelDiscardBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const recipientEmailsInput = document.getElementById("recipientEmails");

// Reference to new email elements
const emailInput = document.getElementById("emailInput");
const addEmailBtn = document.getElementById("addEmailBtn");
const emailTagsContainer = document.getElementById("emailTagsContainer");

// Global variables to store state
let currentSummaryId = null;
let userIdToken = null;
let selectedBulletPoints = [];

// Global array to store emails
let recipientEmails = [];

// Get the auth state listener to store the ID token when state changes
onAuthStateChanged(auth, (user) => {
  if (user) {
    // User is signed in — show dashboard view and hide other views
    signInView.classList.add("hidden");
    signUpView.classList.add("hidden");
    resetView.classList.add("hidden");
    settingsView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    // Apply consistent styling to dashboard when shown
    dashboardView.className = "min-h-screen flex items-center justify-center";
    console.log("User logged in:", user.email);
    
    // Get and store the ID token
    user.getIdToken().then(idToken => {
      userIdToken = idToken;
      // Load user settings when signed in
      loadUserSettings();
    });
  } else {
    // No user is signed in — show sign in view by default
    dashboardView.classList.add("hidden");
    signUpView.classList.add("hidden");
    resetView.classList.add("hidden");
    settingsView.classList.add("hidden");
    signInView.classList.remove("hidden");
    console.log("No user is signed in.");
    userIdToken = null;
  }
});

// Handle sign-in form submission
signInForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const email = document.getElementById("signInEmail").value;
  const password = document.getElementById("signInPassword").value;

  signInWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      console.log("Signed in successfully:", userCredential.user.email);
      return userCredential.user.getIdToken();
    })
    .then((idToken) => {
      console.log("ID Token:", idToken);
      userIdToken = idToken; // Store the ID token for API calls
      const {ipcRenderer} = require("electron");
      ipcRenderer.send("login", idToken);
      
      // Load user settings when signed in
      loadUserSettings();
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
      console.log("Signed up successfully:", userCredential.user.email);
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
      // Return to the sign in view after sending the reset email.
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
  signInView.classList.add("hidden");
  signUpView.classList.remove("hidden");
});

// Toggle to go back to the sign-in view from the sign-up view
backToSignIn.addEventListener("click", (e) => {
  e.preventDefault();
  signUpView.classList.add("hidden");
  signInView.classList.remove("hidden");
});

// Toggle to show the password reset view
showResetPassword.addEventListener("click", (e) => {
  e.preventDefault();
  signInView.classList.add("hidden");
  resetView.classList.remove("hidden");
});

// Toggle to go back to the sign-in view from the password reset view
backToSignInFromReset.addEventListener("click", (e) => {
  e.preventDefault();
  resetView.classList.add("hidden");
  signInView.classList.remove("hidden");
});

// Handle logout click
logoutLink.addEventListener("click", (e) => {
  e.preventDefault();
  signOut(auth)
    .then(() => {
      console.log("User signed out.");
      const {ipcRenderer} = require("electron");
      ipcRenderer.send("logout");
    })
    .catch((error) => {
      alert("Error signing out: " + error.message);
      console.error("Sign out error:", error);
    });
});

// Update visibility when summary is generated
function showSummaryGeneratedState() {
  // Hide generate button, show save button
  document.getElementById('generateSummaryBtn').classList.add('hidden');
  document.getElementById('submitSummaryBtn').classList.remove('hidden');
  
  // Show discard option
  document.getElementById('discardSummaryOption').classList.remove('hidden');
}

// Reset to initial state
function resetSummaryState() {
  // Show generate button, hide save button
  document.getElementById('generateSummaryBtn').classList.remove('hidden');
  document.getElementById('submitSummaryBtn').classList.add('hidden');
  
  // Hide discard option
  document.getElementById('discardSummaryOption').classList.add('hidden');
  
  // Reset container text
  document.getElementById('summaryContainer').innerHTML = 
    '<p class="text-gray-500 text-center">Generate a summary to see your activities.</p>';
}

// Generate summary button handler
document.getElementById('generateSummaryBtn').addEventListener('click', () => {
  // Show loading spinner
  document.getElementById('loadingSpinner').classList.remove('hidden');
  
  // Simulate API call (replace with your actual API call)
  setTimeout(() => {
    // Hide loading spinner
    document.getElementById('loadingSpinner').classList.add('hidden');
    
    // Update summary container with generated content
    document.getElementById('summaryContainer').innerHTML = 
      '<ul class="list-disc pl-5 space-y-2">' +
      '<li>Completed project presentation for client</li>' +
      '<li>Attended team meeting about new feature release</li>' +
      '<li>Reviewed 3 pull requests from junior developers</li>' +
      '<li>Spent 2 hours on bug fixes for mobile app</li>' +
      '<li>Researched new technologies for upcoming project</li>' +
      '</ul>';
    
    // Show save/discard options
    showSummaryGeneratedState();
  }, 1500);
});

// Submit summary button handler
document.getElementById('submitSummaryBtn').addEventListener('click', () => {
  // Show loading spinner
  document.getElementById('loadingSpinner').classList.remove('hidden');
  
  // Simulate API call (replace with your actual API call)
  setTimeout(() => {
    // Hide loading spinner
    document.getElementById('loadingSpinner').classList.add('hidden');
    
    // Reset to initial state
    resetSummaryState();
    
    // Show success message
    alert('Summary saved successfully!');
  }, 1000);
});

// Discard summary button handler
document.getElementById('discardSummaryBtn').addEventListener('click', (e) => {
  e.preventDefault();
  // Simply reset to initial state
  resetSummaryState();
});

// Settings button click handler
if (settingsBtn) {
  settingsBtn.addEventListener("click", () => {
    dashboardView.classList.add("hidden");
    settingsView.classList.remove("hidden");
    // Apply consistent styling to settings when shown
    settingsView.className = "min-h-screen flex items-center justify-center";
  });
}

// Back to dashboard button click handler
if (backToDashboardBtn) {
  backToDashboardBtn.addEventListener("click", () => {
    settingsView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    // Apply consistent styling to dashboard when returning
    dashboardView.className = "min-h-screen flex items-center justify-center";
  });
}

// Add email to UI as tag
function addEmailTag(email) {
  if (!email || recipientEmails.includes(email)) return;
  
  // Basic email validation
  if (!email.includes("@") || !email.includes(".")) {
    alert(`Invalid email format: ${email}`);
    return;
  }
  
  // Add to array
  recipientEmails.push(email);
  
  // Create tag element as a separate row with proper styling
  const tag = document.createElement("div");
  tag.className = "flex items-center justify-between bg-white border border-gray-300 rounded-lg p-3 w-full";
  tag.innerHTML = `
    <span class="mr-2 text-gray-800 break-all overflow-hidden text-ellipsis">${email}</span>
    <button data-email="${email}" class="remove-email shrink-0 text-gray-500 bg-gray-200 hover:bg-gray-300 focus:outline-none h-6 w-6 rounded-full flex items-center justify-center transition-colors">
      &times;
    </button>
  `;
  
  // Add to container
  emailTagsContainer.appendChild(tag);
  
  // Clear input
  emailInput.value = "";
  emailInput.focus();
}

// Remove email tag
function removeEmailTag(email) {
  recipientEmails = recipientEmails.filter(e => e !== email);
  
  // Remove from UI
  const tags = emailTagsContainer.querySelectorAll("div");
  tags.forEach(tag => {
    const removeBtn = tag.querySelector(".remove-email");
    if (removeBtn && removeBtn.dataset.email === email) {
      tag.remove();
    }
  });
}

// Event listener for adding emails
if (addEmailBtn) {
  addEmailBtn.addEventListener("click", () => {
    const email = emailInput.value.trim();
    addEmailTag(email);
  });
}

// Allow adding emails by pressing Enter
if (emailInput) {
  emailInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const email = emailInput.value.trim();
      addEmailTag(email);
    }
  });
}

// Event delegation for removing emails
if (emailTagsContainer) {
  emailTagsContainer.addEventListener("click", (e) => {
    if (e.target.classList.contains("remove-email")) {
      const email = e.target.dataset.email;
      removeEmailTag(email);
    }
  });
}

// Update the loadUserSettings function to ensure proper display of multiple emails
async function loadUserSettings() {
  if (!auth.currentUser) return;
  
  try {
    // Clear existing emails
    recipientEmails = [];
    emailTagsContainer.innerHTML = "";
    
    // Call the function using Firebase SDK
    const result = await getUserSettingsFunction();
    const settings = result.data;
    
    // Add each email as a separate tag row
    if (settings.emailRecipients && Array.isArray(settings.emailRecipients)) {
      settings.emailRecipients.forEach(email => {
        addEmailTag(email);
      });
    }
  } catch (error) {
    console.error("Error loading settings:", error);
  }
}

// Update the save settings handler
if (saveSettingsBtn) {
  saveSettingsBtn.addEventListener("click", async () => {
    try {
      // Show loading spinner
      loadingSpinner.classList.remove("hidden");
      
      // Call the function using Firebase SDK
      const result = await updateUserSettingsFunction({
        emailRecipients: recipientEmails
      });
      
      const data = result.data;
      
      // Hide loading spinner
      loadingSpinner.classList.add("hidden");
      
      if (data.success) {
        // Switch back to dashboard view
        settingsView.classList.add("hidden");
        dashboardView.classList.remove("hidden");
        dashboardView.className = "min-h-screen flex items-center justify-center";
        
        // Show success message
        alert("Settings updated successfully!");
      } else {
        alert(data.message || "Failed to update settings");
      }
    } catch (error) {
      console.error("Error saving settings:", error);
      loadingSpinner.classList.add("hidden");
      alert(`Error: ${error.message}`);
    }
  });
} 