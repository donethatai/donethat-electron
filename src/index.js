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
const permissionView = document.getElementById("permissionView");

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

// Reference to permission-related elements
const openSettingsBtn = document.getElementById("openSettingsBtn");
const logoutFromPermission = document.getElementById("logoutFromPermission");
const enableNotificationsBtn = document.getElementById("enableNotificationsBtn");
const notificationTimeContainer = document.getElementById("notificationTimeContainer");
const notificationPermissionContainer = document.getElementById("notificationPermissionContainer");

// Global variables to store state
let currentSummaryId = null;
let userIdToken = null;
let selectedBulletPoints = [];
let summaryNotificationTime = "17:00"; // Default time (5:00 PM)
let hasScreenCapturePermission = false;
const {ipcRenderer} = require("electron");

// Global array to store emails
let recipientEmails = [];

// Update variable reference to the new summary spinner
const summaryLoadingSpinner = document.getElementById("summaryLoadingSpinner");

console.log("Element check:");
console.log("generateSummaryBtn exists:", !!generateSummaryBtn);
console.log("settingsBtn exists:", !!settingsBtn);
console.log("backToDashboardBtn exists:", !!backToDashboardBtn);

// Listen for screen capture permission updates
ipcRenderer.on("screenCapturePermission", (event, hasPermission) => {
  console.log("Screen capture permission:", hasPermission);
  hasScreenCapturePermission = hasPermission;
  
  // Update UI based on permission status
  if (userIdToken) {
    if (hasPermission) {
      permissionView.classList.add("hidden");
      dashboardView.classList.remove("hidden");
    } else {
      dashboardView.classList.add("hidden");
      permissionView.classList.remove("hidden");
    }
  }
});

// Function to check notification permission
async function checkNotificationPermission() {
  // First check if notifications are supported by the system
  const areNotificationsSupported = await ipcRenderer.invoke("checkNotificationPermission");
  
  if (!areNotificationsSupported) {
    console.log("Notifications not supported by the system");
    return false;
  }
  
  // Then check browser permission
  console.log("Notification permission status:", Notification.permission);
  if (Notification.permission === "granted") {
    return true;
  } else {
    return false;
  }
}

// Function to update notification UI based on permission
async function updateNotificationUI() {
  const hasPermission = await checkNotificationPermission();
  console.log("Has notification permission:", hasPermission);
  
  // Get references to containers
  const notificationTimeContainer = document.getElementById("notificationTimeContainer");
  const notificationPermissionContainer = document.getElementById("notificationPermissionContainer");
  
  if (!notificationTimeContainer || !notificationPermissionContainer) {
    console.error("Notification containers not found:", 
      { timeContainer: !!notificationTimeContainer, permissionContainer: !!notificationPermissionContainer });
    return;
  }
  
  if (hasPermission) {
    console.log("Showing time input, hiding permission button");
    notificationPermissionContainer.classList.add("hidden");
    notificationTimeContainer.classList.remove("hidden");
  } else {
    console.log("Hiding time input, showing permission button");
    notificationTimeContainer.classList.add("hidden");
    notificationPermissionContainer.classList.remove("hidden");
  }
}

// Get the auth state listener to store the ID token when state changes
onAuthStateChanged(auth, (user) => {
  if (user) {
    signInView.classList.add("hidden");
    signUpView.classList.add("hidden");
    resetView.classList.add("hidden");
    settingsView.classList.add("hidden");
    
    // Show either dashboard or permission view based on screen capture permission
    if (hasScreenCapturePermission) {
      permissionView.classList.add("hidden");
      dashboardView.classList.remove("hidden");
    } else {
      dashboardView.classList.add("hidden");
      permissionView.classList.remove("hidden");
    }
    
    user.getIdToken().then(idToken => {
      userIdToken = idToken;
      loadUserSettings();
    });
  } else {
    dashboardView.classList.add("hidden");
    signUpView.classList.add("hidden");
    resetView.classList.add("hidden");
    settingsView.classList.add("hidden");
    permissionView.classList.add("hidden");
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

// Updated loadUserSettings to also check notification permission
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
    
    // Load notification time if available
    if (result.data && result.data.summaryNotificationTime) {
      summaryNotificationTime = result.data.summaryNotificationTime;
      document.getElementById("notificationTimeInput").value = summaryNotificationTime;
    }
    
    // Send the notification time to the main process
    ipcRenderer.send("updateSummaryNotificationTime", summaryNotificationTime);
    
    // Update notification UI based on permission
    await updateNotificationUI();
    
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

// Updated saveUserSettings to include notification time and use separate spinners
async function saveUserSettings(type, value) {
  if (!auth.currentUser) return;
  
  // Use the appropriate spinner based on the setting type
  if (type === 'emails') {
    loadingSpinner.classList.remove("hidden");
  } else if (type === 'notificationTime') {
    const timeLoadingSpinner = document.getElementById("timeLoadingSpinner");
    if (timeLoadingSpinner) {
      timeLoadingSpinner.classList.remove("hidden");
    }
  }
  
  try {
    let settingsData = {};
    
    if (type === 'emails') {
      settingsData.emailRecipients = value;
    } else if (type === 'notificationTime') {
      settingsData.summaryNotificationTime = value;
      summaryNotificationTime = value;
      
      // Send the updated time to the main process
      ipcRenderer.send("updateSummaryNotificationTime", value);
    }
    
    await updateUserSettingsFunction(settingsData);
    
  } catch (error) {
    console.error("Error saving settings:", error);
    alert(`Error saving settings: ${error.message}`);
    throw error;
  } finally {
    // Hide the appropriate spinner
    if (type === 'emails') {
      loadingSpinner.classList.add("hidden");
    } else if (type === 'notificationTime') {
      const timeLoadingSpinner = document.getElementById("timeLoadingSpinner");
      if (timeLoadingSpinner) {
        timeLoadingSpinner.classList.add("hidden");
      }
    }
  }
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
    await saveUserSettings('emails', recipientEmails);
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
    await saveUserSettings('emails', recipientEmails);
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
        
        // Notify main process that summary was submitted
        ipcRenderer.send("summarySubmitted");
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
  settingsBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    console.log('Settings button clicked');
    dashboardView.classList.add('hidden');
    settingsView.classList.remove('hidden');
    
    // Update the time input to the current value
    const notificationTimeInput = document.getElementById("notificationTimeInput");
    if (notificationTimeInput) {
      notificationTimeInput.value = summaryNotificationTime;
    }
    
    // Ensure we have fresh references to the containers
    const notificationTimeContainer = document.getElementById("notificationTimeContainer");
    const notificationPermissionContainer = document.getElementById("notificationPermissionContainer");
    
    console.log("Container elements:", 
      { timeContainer: !!notificationTimeContainer, permissionContainer: !!notificationPermissionContainer });
    
    // Check notification permissions when settings view is shown
    await updateNotificationUI();
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

// Add event listener for notification time changes
const notificationTimeInput = document.getElementById("notificationTimeInput");
if (notificationTimeInput) {
  // Make the input readonly to prevent typing and force using the picker
  notificationTimeInput.setAttribute("readonly", "readonly");
  
  // When clicked, force the time picker to open
  notificationTimeInput.addEventListener('click', (e) => {
    e.preventDefault();
    
    // Remove readonly temporarily to allow the picker to work
    e.target.removeAttribute("readonly");
    
    // Focus the input
    e.target.focus();
    
    // Try to show the time picker using various methods
    // Modern browsers support showPicker()
    if (typeof e.target.showPicker === 'function') {
      try {
        e.target.showPicker();
      } catch (err) {
        console.log('showPicker failed, falling back', err);
      }
    }
    
    // Add readonly back after a short delay
    setTimeout(() => {
      e.target.setAttribute("readonly", "readonly");
    }, 100);
  });
  
  // Also add a click handler to the parent container to catch clicks
  // on the time picker icon that some browsers show
  const timeInputContainer = notificationTimeInput.parentElement;
  if (timeInputContainer) {
    timeInputContainer.addEventListener('click', (e) => {
      // Don't trigger if we clicked directly on the input (it has its own handler)
      if (e.target !== notificationTimeInput) {
        // Simulate a click on the input
        notificationTimeInput.click();
      }
    });
  }
  
  notificationTimeInput.addEventListener('change', async (e) => {
    const newTime = e.target.value;
    console.log('Notification time changed to:', newTime);
    
    try {
      await saveUserSettings('notificationTime', newTime);
    } catch (error) {
      // If error occurs, revert to previous value
      e.target.value = summaryNotificationTime;
    }
  });
}

// Handle permission buttons
if (openSettingsBtn) {
  openSettingsBtn.addEventListener("click", () => {
    ipcRenderer.send("requestScreenCapturePermission");
  });
}

if (logoutFromPermission) {
  logoutFromPermission.addEventListener("click", (e) => {
    e.preventDefault();
    
    signOut(auth)
      .then(() => {
        console.log("User signed out.");
        ipcRenderer.send("logout");
      })
      .catch((error) => {
        alert("Error signing out: " + error.message);
        console.error("Sign out error:", error);
      });
  });
}

// Make the enable notifications button more robust
document.addEventListener("DOMContentLoaded", () => {
  const enableNotificationsBtn = document.getElementById("enableNotificationsBtn");
  if (enableNotificationsBtn) {
    enableNotificationsBtn.addEventListener("click", async () => {
      console.log("Enable notifications button clicked");
      
      if (!("Notification" in window)) {
        alert("This browser does not support notifications");
        return;
      }
      
      try {
        console.log("Requesting notification permission...");
        const permission = await Notification.requestPermission();
        console.log("Permission result:", permission);
        
        if (permission === "granted") {
          // Update the UI immediately
          await updateNotificationUI();
        } else {
          alert("Notification permission denied. Please enable notifications in your browser settings.");
        }
      } catch (error) {
        console.error("Error requesting notification permission:", error);
        alert("Could not request notification permission: " + error.message);
      }
    });
  } else {
    console.error("Enable notifications button not found on DOMContentLoaded");
  }
});