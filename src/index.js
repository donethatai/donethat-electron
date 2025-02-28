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
const functions = getFunctions(app, "europe-west1");

// Create callable function references
const generateRawSummaryFunction = httpsCallable(functions, "generateRawSummary");
const saveFinalSummaryFunction = httpsCallable(functions, "saveFinalSummary");
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
const settingsBtn = document.getElementById("settingsBtn");
const backToDashboardBtn = document.getElementById("backToDashboardBtn");
const summaryContainer = document.getElementById("summaryContainer");
const loadingSpinner = document.getElementById("loadingSpinner");
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

// Update variable reference to the new summary spinner
const summaryLoadingSpinner = document.getElementById("summaryLoadingSpinner");

console.log("Element check:");
console.log("generateSummaryBtn exists:", !!generateSummaryBtn);
console.log("settingsBtn exists:", !!settingsBtn);
console.log("backToDashboardBtn exists:", !!backToDashboardBtn);

// Get the auth state listener to store the ID token when state changes
onAuthStateChanged(auth, (user) => {
  if (user) {
    signInView.classList.add("hidden");
    signUpView.classList.add("hidden");
    resetView.classList.add("hidden");
    settingsView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    
    user.getIdToken().then(idToken => {
      userIdToken = idToken;
      loadUserSettings();
    });
  } else {
    dashboardView.classList.add("hidden");
    signUpView.classList.add("hidden");
    resetView.classList.add("hidden");
    settingsView.classList.add("hidden");
    signInView.classList.remove("hidden");
    userIdToken = null;
    
    // Clear email state when logged out
    recipientEmails = [];
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
      userIdToken = idToken;
      const {ipcRenderer} = require("electron");
      ipcRenderer.send("login", idToken);
      
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
  document.getElementById('generateSummaryBtn').classList.add('hidden');
  document.getElementById('submitSummaryBtn').classList.remove('hidden');
}

// Reset to initial state
function resetSummaryState() {
  document.getElementById('generateSummaryBtn').classList.remove('hidden');
  document.getElementById('submitSummaryBtn').classList.add('hidden');
  
  document.getElementById('summaryContainer').innerHTML = 
    '<p class="empty-state-text">Generate a summary to see your activities.</p>';
}

// Completely redesigned loadUserSettings function
async function loadUserSettings() {
  if (!auth.currentUser) return;
  
  try {
    loadingSpinner.classList.remove("hidden");
    
    // Reset state
    recipientEmails = [];
    emailTagsContainer.innerHTML = "";
    
    const result = await getUserSettingsFunction();
    
    if (result.data && 
        result.data.emailRecipients && 
        Array.isArray(result.data.emailRecipients) && 
        result.data.emailRecipients.length > 0) {
      
      // Get unique emails from server response
      const uniqueEmails = [...new Set(result.data.emailRecipients)];
      
      // Set our internal state
      recipientEmails = uniqueEmails;
      
      // Render the email tags
      renderEmailTags();
    } else {
      // No emails, show empty state
      emailTagsContainer.innerHTML = '<p class="empty-state-text">No recipients added. Add emails to receive your summaries.</p>';
    }
  } catch (error) {
    console.error("Error loading settings:", error);
    emailTagsContainer.innerHTML = '<p class="empty-state-text">Error loading recipients. Please try again.</p>';
  } finally {
    loadingSpinner.classList.add("hidden");
  }
}

// New function to render email tags
function renderEmailTags() {
  // Clear container first
  emailTagsContainer.innerHTML = "";
  
  if (recipientEmails.length === 0) {
    emailTagsContainer.innerHTML = '<p class="empty-state-text">No recipients added. Add emails to receive your summaries.</p>';
    return;
  }
  
  // Create a tag for each email
  recipientEmails.forEach(email => {
    const tag = document.createElement("div");
    tag.className = "email-tag";
    tag.innerHTML = `
      <span class="email-text">${email}</span>
      <button data-email="${email}" class="remove-email remove-email-btn">
        &times;
      </button>
    `;
    
    emailTagsContainer.appendChild(tag);
  });
}

// Simplified addEmailTag function
async function addEmailTag(email) {
  if (!email) return;
  
  email = email.trim();
  
  if (recipientEmails.includes(email)) {
    alert(`Email ${email} is already in the list.`);
    return;
  }
  
  if (!email.includes("@") || !email.includes(".")) {
    alert(`Invalid email format: ${email}`);
    return;
  }
  
  loadingSpinner.classList.remove("hidden");
  
  try {
    // Add to our local array
    recipientEmails.push(email);
    
    // Clear input field
    emailInput.value = "";
    
    // Render the updated list
    renderEmailTags();
    
    // Save to server
    await updateUserSettingsFunction({
      emailRecipients: recipientEmails
    });
  } catch (error) {
    // If error, remove the email we just added
    recipientEmails = recipientEmails.filter(e => e !== email);
    renderEmailTags();
    
    console.error("Error saving settings:", error);
    alert(`Error saving: ${error.message}`);
  } finally {
    loadingSpinner.classList.add("hidden");
  }
}

// Simplified removeEmailTag function
async function removeEmailTag(email) {
  if (!email || !recipientEmails.includes(email)) return;
  
  loadingSpinner.classList.remove("hidden");
  
  try {
    // Create a backup of the current list
    const originalList = [...recipientEmails];
    
    // Update our local array
    recipientEmails = recipientEmails.filter(e => e !== email);
    
    // Render the updated list
    renderEmailTags();
    
    // Save to server
    await updateUserSettingsFunction({
      emailRecipients: recipientEmails
    });
  } catch (error) {
    // If error, restore original list
    recipientEmails = originalList;
    renderEmailTags();
    
    console.error("Error saving settings:", error);
    alert(`Error saving: ${error.message}`);
  } finally {
    loadingSpinner.classList.add("hidden");
  }
}

// Only add event listeners if elements exist
if (submitSummaryBtn) {
  submitSummaryBtn.addEventListener('click', () => {
    summaryLoadingSpinner.classList.remove('hidden');
    
    const selectedBullets = [];
    document.querySelectorAll('.bullet-item').forEach(item => {
      const checkbox = item.querySelector('.bullet-checkbox');
      const heartIcon = item.querySelector('.heart-icon');
      const textElement = item.querySelector('.bullet-text');
      
      if (checkbox.checked) {
        let bulletText = textElement.textContent.trim();
        
        if (heartIcon.classList.contains('active')) {
          bulletText = '💜 ' + bulletText;
        }
        
        selectedBullets.push(bulletText);
      }
    });
    
    const commentText = document.getElementById('commentInput').value.trim();
    
    // Call the cloud function to save the final summary
    saveFinalSummaryFunction({
      summaryId: currentSummaryId,
      selectedBullets: selectedBullets,
      comment: commentText
    })
      .then((result) => {
        summaryLoadingSpinner.classList.add('hidden');
        resetSummaryState();
      })
      .catch((error) => {
        summaryLoadingSpinner.classList.add('hidden');
        console.error("Error submitting summary:", error);
        alert(`Error submitting summary: ${error.message}`);
        // Keep the current state for retry
      });
  });
}

// Update the event listener for the generate summary button
if (generateSummaryBtn) {
  generateSummaryBtn.addEventListener('click', () => {
    summaryLoadingSpinner.classList.remove('hidden');
    
    // Call the actual Cloud Function instead of using dummy data
    generateRawSummaryFunction()
      .then((result) => {
        summaryLoadingSpinner.classList.add('hidden');
        
        // Process the result from the cloud function
        const bulletPoints = result.data.bulletPoints || [];
        currentSummaryId = result.data.summaryId;
        
        if (bulletPoints.length === 0) {
          summaryContainer.innerHTML = '<p class="empty-state-text">No activities found for today.</p>';
          return;
        }
        
        const bulletHTML = bulletPoints.map(point => `
          <div class="bullet-item">
            <input type="checkbox" class="bullet-checkbox" checked>
            <span class="bullet-content bullet-text">${point}</span>
            <span class="heart-icon">♥</span>
          </div>
        `).join('');
        
        const commentHTML = `
          <textarea id="commentInput" class="comment-input" placeholder="Add a comment here"></textarea>
        `;
        
        summaryContainer.innerHTML = bulletHTML + commentHTML;
        
        // Add event listeners for checkboxes and heart icons
        document.querySelectorAll('.bullet-checkbox').forEach(checkbox => {
          checkbox.addEventListener('change', function() {
            const textElement = this.nextElementSibling;
            const heartIcon = textElement.nextElementSibling;
            
            if (this.checked) {
              textElement.classList.remove('bullet-text-crossed');
              heartIcon.classList.remove('opacity-50', 'pointer-events-none');
            } else {
              textElement.classList.add('bullet-text-crossed');
              heartIcon.classList.add('opacity-50', 'pointer-events-none');
              heartIcon.classList.remove('active');
            }
          });
        });
        
        document.querySelectorAll('.heart-icon').forEach(heart => {
          heart.addEventListener('click', function() {
            this.classList.toggle('active');
          });
        });
        
        showSummaryGeneratedState();
      })
      .catch((error) => {
        summaryLoadingSpinner.classList.add('hidden');
        console.error("Error generating summary:", error);
        summaryContainer.innerHTML = `<p class="empty-state-text">Error: ${error.message}</p>`;
      });
  });
} else {
  console.error("Generate summary button not found");
}

// Settings button
if (settingsBtn) {
  settingsBtn.addEventListener('click', (e) => {
    e.preventDefault();
    console.log('Settings button clicked');
    dashboardView.classList.add('hidden');
    settingsView.classList.remove('hidden');
  });
} else {
  console.error("Settings button not found");
}

// Back to dashboard button
if (backToDashboardBtn) {
  backToDashboardBtn.addEventListener('click', (e) => {
    e.preventDefault();
    console.log('Back to dashboard button clicked');
    settingsView.classList.add('hidden');
    dashboardView.classList.remove('hidden');
  });
} else {
  console.error("Back to dashboard button not found");
}

// Email management
if (addEmailBtn) {
  addEmailBtn.addEventListener('click', () => {
    console.log('Add email button clicked');
    const email = emailInput.value.trim();
    if (email) {
      addEmailTag(email);
    }
  });
} else {
  console.error("Add email button not found");
}

// Allow adding emails by pressing Enter
if (emailInput) {
  emailInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      console.log('Enter pressed in email input');
      const email = emailInput.value.trim();
      if (email) {
        addEmailTag(email);
      }
    }
  });
} else {
  console.error("Email input not found");
}

// Event delegation for removing emails
if (emailTagsContainer) {
  emailTagsContainer.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-email')) {
      console.log('Remove email button clicked');
      const email = e.target.dataset.email;
      removeEmailTag(email);
    }
  });
} else {
  console.error("Email tags container not found");
} 