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

// Global variables to store state
let currentSummaryId = null;
let userIdToken = null;
let selectedBulletPoints = [];

// Get the auth state listener to store the ID token when state changes
onAuthStateChanged(auth, (user) => {
  if (user) {
    // User is signed in — show dashboard view and hide other views
    signInView.classList.add("hidden");
    signUpView.classList.add("hidden");
    resetView.classList.add("hidden");
    settingsView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
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

// Dashboard functionality
// Generate summary button click handler
if (generateSummaryBtn) {
  generateSummaryBtn.addEventListener("click", async () => {
    try {
      // Show loading spinner
      loadingSpinner.classList.remove("hidden");
      summaryContainer.innerHTML = "";
      submitSummaryBtn.disabled = true;
      discardSummaryBtn.disabled = true;
      
      // Call the function using Firebase SDK
      const result = await generateRawSummaryFunction();
      const data = result.data;
      
      // Hide loading spinner
      loadingSpinner.classList.add("hidden");
      
      if (data.success) {
        // Store the summary ID
        currentSummaryId = data.summaryId;
        
        // Check if there are any bullet points to display
        if (!data.bulletPoints || data.bulletPoints.length === 0) {
          summaryContainer.innerHTML = "<p class='text-center text-gray-500'>There is no new data to summarize.</p>";
          return;
        }
        
        // Enable submit and discard buttons
        submitSummaryBtn.disabled = false;
        discardSummaryBtn.disabled = false;
        
        // Display the bullet points with checkboxes
        selectedBulletPoints = [...data.bulletPoints]; // Start with all selected
        displayBulletPoints(data.bulletPoints);
      } else {
        summaryContainer.innerHTML = `<p class="text-red-500">${data.message || "Failed to generate summary"}</p>`;
      }
    } catch (error) {
      console.error("Error generating summary:", error);
      loadingSpinner.classList.add("hidden");
      summaryContainer.innerHTML = `<p class="text-red-500">Error: ${error.message}</p>`;
    }
  });
}

// Function to display bullet points with checkboxes
function displayBulletPoints(bulletPoints) {
  summaryContainer.innerHTML = "";
  
  if (!bulletPoints || bulletPoints.length === 0) {
    summaryContainer.innerHTML = "<p class='text-center text-gray-500'>There is no new data to summarize.</p>";
    return;
  }
  
  const ul = document.createElement("ul");
  ul.className = "space-y-4";
  
  bulletPoints.forEach((point, index) => {
    const li = document.createElement("li");
    li.className = "flex items-start space-x-3";
    
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `bullet-${index}`;
    checkbox.className = "mt-1 h-5 w-5 text-purple-600 rounded border-black focus:ring-purple-500";
    checkbox.checked = true; // Default to checked
    
    const label = document.createElement("label");
    label.htmlFor = `bullet-${index}`;
    label.className = "text-black";
    label.textContent = point;
    
    // Add event listener to update the selectedBulletPoints array
    checkbox.addEventListener("change", function() {
      if (this.checked) {
        if (!selectedBulletPoints.includes(point)) {
          selectedBulletPoints.push(point);
        }
        label.classList.remove("line-through", "text-gray-400");
        label.classList.add("text-black");
      } else {
        selectedBulletPoints = selectedBulletPoints.filter(p => p !== point);
        label.classList.remove("text-black");
        label.classList.add("line-through", "text-gray-400");
      }
    });
    
    li.appendChild(checkbox);
    li.appendChild(label);
    ul.appendChild(li);
  });
  
  summaryContainer.appendChild(ul);
}

// Submit summary button click handler
if (submitSummaryBtn) {
  submitSummaryBtn.addEventListener("click", async () => {
    if (!currentSummaryId || selectedBulletPoints.length === 0) {
      alert("Please generate a summary and select at least one bullet point.");
      return;
    }
    
    try {
      // Show loading spinner
      loadingSpinner.classList.remove("hidden");
      
      // Call the function using Firebase SDK
      const result = await saveFinalSummaryFunction({
        bulletPoints: selectedBulletPoints,
        rawSummaryId: currentSummaryId
      });
      
      const data = result.data;
      
      // Hide loading spinner
      loadingSpinner.classList.add("hidden");
      
      if (data.success) {
        // Clear the current summary
        summaryContainer.innerHTML = `
          <div class="p-4 bg-green-100 text-green-700 rounded-md">
            <p>Summary saved successfully!</p>
            ${data.emailSent ? "<p>Email has been sent to recipients.</p>" : ""}
          </div>
        `;
        
        // Reset state
        currentSummaryId = null;
        selectedBulletPoints = [];
        
        // Disable buttons
        submitSummaryBtn.disabled = true;
        discardSummaryBtn.disabled = true;
      } else {
        summaryContainer.innerHTML = `<p class="text-red-500">${data.message || "Failed to save summary"}</p>`;
      }
    } catch (error) {
      console.error("Error saving summary:", error);
      loadingSpinner.classList.add("hidden");
      summaryContainer.innerHTML = `<p class="text-red-500">Error: ${error.message}</p>`;
    }
  });
}

// Discard summary button click handler
if (discardSummaryBtn) {
  discardSummaryBtn.addEventListener("click", () => {
    if (!currentSummaryId) {
      alert("No summary to discard.");
      return;
    }
    
    // Show confirmation modal
    confirmDiscardModal.classList.remove("hidden");
  });
}

// Confirm discard button click handler
if (confirmDiscardBtn) {
  confirmDiscardBtn.addEventListener("click", async () => {
    try {
      // Hide the modal and show loading spinner
      confirmDiscardModal.classList.add("hidden");
      loadingSpinner.classList.remove("hidden");
      
      // Call the function using Firebase SDK
      const result = await discardSummaryFunction({
        summaryId: currentSummaryId
      });
      
      const data = result.data;
      
      // Hide loading spinner
      loadingSpinner.classList.add("hidden");
      
      if (data.success) {
        // Clear the current summary
        summaryContainer.innerHTML = `
          <div class="p-4 bg-yellow-100 text-yellow-700 rounded-md">
            <p>Summary discarded. The next summary will include all activities since this time.</p>
          </div>
        `;
        
        // Reset state
        currentSummaryId = null;
        selectedBulletPoints = [];
        
        // Disable buttons
        submitSummaryBtn.disabled = true;
        discardSummaryBtn.disabled = true;
      } else {
        summaryContainer.innerHTML = `<p class="text-red-500">${data.message || "Failed to discard summary"}</p>`;
      }
    } catch (error) {
      console.error("Error discarding summary:", error);
      loadingSpinner.classList.add("hidden");
      summaryContainer.innerHTML = `<p class="text-red-500">Error: ${error.message}</p>`;
    }
  });
}

// Cancel discard button click handler
if (cancelDiscardBtn) {
  cancelDiscardBtn.addEventListener("click", () => {
    confirmDiscardModal.classList.add("hidden");
  });
}

// Settings button click handler
if (settingsBtn) {
  settingsBtn.addEventListener("click", () => {
    dashboardView.classList.add("hidden");
    settingsView.classList.remove("hidden");
  });
}

// Back to dashboard button click handler
if (backToDashboardBtn) {
  backToDashboardBtn.addEventListener("click", () => {
    settingsView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
  });
}

// Load user settings from API
async function loadUserSettings() {
  if (!auth.currentUser) return;
  
  try {
    // Call the function using Firebase SDK
    const result = await getUserSettingsFunction();
    const settings = result.data;
    
    // Update the UI with settings
    if (recipientEmailsInput) {
      recipientEmailsInput.value = settings.emailRecipients ? settings.emailRecipients.join(", ") : "";
    }
  } catch (error) {
    console.error("Error loading settings:", error);
  }
}

// Save settings button click handler
if (saveSettingsBtn) {
  saveSettingsBtn.addEventListener("click", async () => {
    try {
      const emailsText = recipientEmailsInput.value;
      const emails = emailsText.split(",").map(email => email.trim()).filter(email => email);
      
      // Basic email validation
      const invalidEmails = emails.filter(email => !email.includes("@") || !email.includes("."));
      if (invalidEmails.length > 0) {
        alert(`Invalid email format: ${invalidEmails.join(", ")}`);
        return;
      }
      
      // Show loading spinner
      loadingSpinner.classList.remove("hidden");
      
      // Call the function using Firebase SDK
      const result = await updateUserSettingsFunction({
        emailRecipients: emails
      });
      
      const data = result.data;
      
      // Hide loading spinner
      loadingSpinner.classList.add("hidden");
      
      if (data.success) {
        // Switch back to dashboard view
        settingsView.classList.add("hidden");
        dashboardView.classList.remove("hidden");
        
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