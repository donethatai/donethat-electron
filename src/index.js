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
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const functions = getFunctions(firebaseApp, "europe-west1");

// Create callable function references
const generateRawSummaryFunction = httpsCallable(functions, "generateRawSummary");
const saveFinalSummaryFunction = httpsCallable(functions, "saveFinalSummary");
const getUserSettingsFunction = httpsCallable(functions, "getUserSettings");
const updateUserSettingsFunction = httpsCallable(functions, "updateUserSettings");
const slackConnectFunction = httpsCallable(functions, 'slackConnect');
const slackDisconnectFunction = httpsCallable(functions, 'slackDisconnect');
const slackUpdateChannelFunction = httpsCallable(functions, 'slackUpdateChannel');

// Set persistence to browser local storage
setPersistence(auth, browserLocalPersistence)
  .then(() => {
  })
  .catch((error) => {
    console.error("Error setting persistence:", error);
  });

// Add a small delay to check initial auth state
setTimeout(() => {
  const { ipcRenderer } = require('electron');
  ipcRenderer.send('initialAuthCheck', !!auth.currentUser);
}, 1000);

// Get references to views and elements
const signInView = document.getElementById("signInView");
const signUpView = document.getElementById("signUpView");
const resetView = document.getElementById("resetView");
const dashboardView = document.getElementById("dashboardView");
const settingsView = document.getElementById("settingsView");
const permissionView = document.getElementById("permissionView");
const updateView = document.getElementById("updateView");

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

// Add near the top with other state variables
let slackConnected = false;
let slackChannel = '';
let slackConfig = null;

// Modify the existing screenCapturePermission listener to include session type
ipcRenderer.on('screenCapturePermission', (event, data) => {
  // Extract permission status and session type (if provided)
  const hasPermission = typeof data === 'object' ? data.hasPermission : data;
  const isWaylandSession = typeof data === 'object' ? data.isWaylandSession : null;
  
  console.log(`Permission update received: hasPermission=${hasPermission}, isWaylandSession=${isWaylandSession}`);
  
  hasScreenCapturePermission = hasPermission;
  
  // Update UI based on permission status
  if (userIdToken) {
    if (hasPermission) {
      permissionView.classList.add('hidden');
      dashboardView.classList.remove('hidden');
    } else {
      dashboardView.classList.add('hidden');
      permissionView.classList.remove('hidden');
      
      // If on Linux, update installation instructions based on session type
      if (process.platform === 'linux' && isWaylandSession !== null) {
        updateLinuxInstructions(isWaylandSession);
      }
    }
  }
});

// Simplified function to update Linux installation instructions
function updateLinuxInstructions(isWaylandSession) {
  console.log(`Updating Linux instructions, Wayland: ${isWaylandSession}`);
  
  const standardPermissionSection = document.getElementById('standardPermissionSection');
  const linuxInstallSection = document.getElementById('linuxInstallSection');
  
  // Show Linux install instructions
  standardPermissionSection.classList.add('hidden');
  linuxInstallSection.classList.remove('hidden');
  
  // Hide all instruction sets first
  const waylandInstructions = document.getElementById('waylandInstructions');
  const x11Instructions = document.getElementById('x11Instructions');
  
  waylandInstructions.classList.add('hidden');
  x11Instructions.classList.add('hidden');
  
  // Show appropriate instructions based on session type
  if (isWaylandSession) {
    waylandInstructions.classList.remove('hidden');
  } else {
    x11Instructions.classList.remove('hidden');
  }
}

// Simplify the check notification permission function completely
async function checkNotificationPermission() {
  try {
    return await ipcRenderer.invoke("checkNotificationPermission");
  } catch (error) {
    return false;
  }
}

// Update the notification UI function
async function updateNotificationUI() {
  const notificationsSupported = await checkNotificationPermission();
  
  // Get references to containers
  const notificationTimeContainer = document.getElementById("notificationTimeContainer");
  const notificationPermissionContainer = document.getElementById("notificationPermissionContainer");
  
  if (!notificationTimeContainer || !notificationPermissionContainer) {
    return;
  }
  
  if (notificationsSupported) {
    // If notifications are supported, show the time input
    notificationPermissionContainer.classList.add("hidden");
    notificationTimeContainer.classList.remove("hidden");
  } else {
    // If notifications aren't supported, show the permission button
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
    
    // Show logout buttons when logged in
    if (logoutLink) logoutLink.classList.remove("hidden");
    if (logoutFromPermission) logoutFromPermission.classList.remove("hidden");
    
    // First, get the initial token
    user.getIdToken().then(idToken => {
      userIdToken = idToken;
      ipcRenderer.send("login", idToken);
      loadUserSettings();
      
      // Set up a token refresh listener
      const refreshInterval = setInterval(async () => {
        if (auth.currentUser) {
          try {
            const freshToken = await auth.currentUser.getIdToken(true);
            userIdToken = freshToken;
            ipcRenderer.send("login", freshToken);
          } catch (error) {
            console.error("Token refresh failed:", error);
          }
        } else {
          clearInterval(refreshInterval);
        }
      }, 45 * 60 * 1000); // Refresh every 45 minutes
    });
  } else {
    dashboardView.classList.add("hidden");
    signUpView.classList.add("hidden");
    resetView.classList.add("hidden");
    settingsView.classList.add("hidden");
    permissionView.classList.add("hidden");
    signInView.classList.remove("hidden");
    userIdToken = null;
    
    // Hide logout buttons when not logged in
    if (logoutLink) logoutLink.classList.add("hidden");
    if (logoutFromPermission) logoutFromPermission.classList.add("hidden");
    
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

// Helper function for complete logout cleanup
async function performFullLogout() {
  try {
    // Clear Firebase auth state
    await auth.signOut();
    
    // Clear any Firebase specific storage
    const firebaseLocalStorageKeys = Object.keys(window.localStorage)
      .filter(key => key.startsWith('firebase:'));
    firebaseLocalStorageKeys.forEach(key => window.localStorage.removeItem(key));
    
    // Reset application state
    recipientEmails = [];
    currentSummaryId = null;
    userIdToken = null;
    
    // Reset the UI state
    resetSummaryState();
    
    // Notify main process
    ipcRenderer.send('logout');
    
  } catch (error) {
    console.error('Error during logout:', error);
    alert(`Error signing out: ${error.message}`);
  }
}

// Update both logout handlers to use the new function
if (logoutLink) {
  logoutLink.addEventListener('click', (e) => {
    e.preventDefault();
    performFullLogout();
  });
}

if (logoutFromPermission) {
  logoutFromPermission.addEventListener('click', (e) => {
    e.preventDefault();
    performFullLogout();
  });
}

// Update visibility when summary is generated
function showSummaryGeneratedState() {
  document.getElementById('generateSummaryBtn').classList.add('hidden');
  document.getElementById('submitSummaryBtn').classList.remove('hidden');
}

// Reset to initial state
function resetSummaryState() {
  document.getElementById('generateSummaryBtn').classList.remove('hidden');
  document.getElementById('submitSummaryBtn').classList.add('hidden');
  currentSummaryId = null;
  selectedBulletPoints = [];
  
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
    
    // Handle Slack settings
    if (result.data.slack?.accessToken) {
      slackConnected = true;
      slackChannel = result.data.slack.defaultChannel || '';
      
      // Update the input value with the current channel
      const slackInput = document.getElementById('slackInput');
      if (slackInput) {
        slackInput.value = slackChannel;
      }
      
      updateSlackInputState(true, result.data.slack.teamName, slackChannel);
    } else {
      slackConnected = false;
      slackChannel = '';
      updateSlackInputState(false);
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
          bulletText = '🧡 ' + bulletText;
        }
        
        selectedBullets.push(bulletText);
      }
    });
    
    const commentText = document.getElementById('commentInput').value.trim();
    
    
    saveFinalSummaryFunction({
      summaryId: currentSummaryId,
      selectedBullets: selectedBullets,
      comment: commentText
    }).then(() => {
      summaryLoadingSpinner.classList.add('hidden');
      // Clear summary content immediately before resetSummary later after delay
      document.getElementById('summaryContainer').innerHTML = 
        '<p class="empty-state-text"></p>';
      
      // Reset internal state
      currentSummaryId = null;
      selectedBulletPoints = [];
      
      // Update button text and disable it
      submitSummaryBtn.textContent = "Well done! Paused recording.";
      submitSummaryBtn.disabled = true;
      submitSummaryBtn.classList.add('disabled-btn');
      submitSummaryBtn.classList.remove('hidden');

      // Notify main process that summary was submitted
      ipcRenderer.send("summarySubmitted");
      
      // Pause recording until tomorrow
      ipcRenderer.send("pauseUntilTomorrow");
      
      // Reset summary state AFTER button update and ensure button stays visible
      setTimeout(() => {
        resetSummaryState();
        submitSummaryBtn.textContent = "Submit";
        submitSummaryBtn.classList.remove('disabled-btn');
        submitSummaryBtn.disabled = false;
      }, 10000);
      }).catch((error) => {
        summaryLoadingSpinner.classList.add('hidden');
        console.error("Error submitting summary:", error);
        alert(`Error submitting summary: ${error.message}`);
      })
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
        const period = result.data.period;
        
        if (bulletPoints.length === 0) {
          summaryContainer.innerHTML = '<p class="empty-state-text">No activities found for today.</p>';
          return;
        }
        
        // Format the period timestamps
        const formatDateTime = (timestamp) => {
          if (!timestamp) return '';
          const date = new Date(timestamp);
          return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });
        };
        
        const periodHTML = period ? `
          <div class="summary-period">
            Activities from ${formatDateTime(period.start)} to ${formatDateTime(period.end)}
          </div>
        ` : '';
        
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
        
        summaryContainer.innerHTML = periodHTML + bulletHTML + commentHTML;
        
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
    dashboardView.classList.add('hidden');
    settingsView.classList.remove('hidden');
    
    // Reset summary state when leaving dashboard
    resetSummaryState();
    
    // Update the time input to the current value
    const notificationTimeInput = document.getElementById("notificationTimeInput");
    if (notificationTimeInput) {
      notificationTimeInput.value = summaryNotificationTime;
    }
    
    // Ensure we have fresh references to the containers
    const notificationTimeContainer = document.getElementById("notificationTimeContainer");
    const notificationPermissionContainer = document.getElementById("notificationPermissionContainer");
    
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
    settingsView.classList.add('hidden');
    dashboardView.classList.remove('hidden');
  });
} else {
  console.error("Back to dashboard button not found");
}

// Email management
if (addEmailBtn) {
  addEmailBtn.addEventListener('click', () => {
    const email = emailInput.value.trim();
    if (email) {
      addEmailTag(email);
    }
  });
} else {
  console.error("Add email button not found");
}

// Email input handling
if (emailInput) {
  emailInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const email = emailInput.value.trim();
      if (email) {
        addEmailTag(email);
      }
    }
  });
}

// Event delegation for removing emails
if (emailTagsContainer) {
  emailTagsContainer.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-email')) {
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

// Simplify the enable notifications button handler
document.addEventListener("DOMContentLoaded", () => {
  const enableNotificationsBtn = document.getElementById("enableNotificationsBtn");
  if (enableNotificationsBtn) {
    enableNotificationsBtn.addEventListener("click", () => {
      alert("Notifications are not supported on this system.");
    });
  }
});

// Listen for update events from main process
ipcRenderer.on('update-downloaded', () => {
  // Hide all other views
  signInView.classList.add("hidden");
  signUpView.classList.add("hidden");
  resetView.classList.add("hidden");
  dashboardView.classList.add("hidden");
  settingsView.classList.add("hidden");
  permissionView.classList.add("hidden");
  
  // Show update view
  updateView.classList.remove("hidden");
});

// Add restart button handler
const restartForUpdateBtn = document.getElementById("restartForUpdateBtn");
if (restartForUpdateBtn) {
  restartForUpdateBtn.addEventListener("click", () => {
    ipcRenderer.send("install-update");
  });
}


function updateSlackUI(connected, team = '') {
  const connectedDiv = document.getElementById('slackConnected');
  const disconnectedDiv = document.getElementById('slackDisconnected');
  const channelContainer = document.getElementById('slackChannelContainer');
  const teamNameSpan = document.getElementById('slackTeamName');
  
  if (connected) {
    connectedDiv.classList.remove('hidden');
    disconnectedDiv.classList.add('hidden');
    channelContainer.classList.remove('hidden');
    teamNameSpan.textContent = team;
    slackConnected = true;
  } else {
    connectedDiv.classList.add('hidden');
    disconnectedDiv.classList.remove('hidden');
    channelContainer.classList.add('hidden');
    slackConnected = false;
  }
}

// Update the connect button click handler
const connectSlackBtn = document.getElementById('connectSlackBtn');
if (connectSlackBtn) {
  connectSlackBtn.addEventListener('click', async () => {
    try {
      const result = await slackConnectFunction();
      const authWindow = window.open(result.data.authUrl);
      
      // When the window closes, reload settings to check if connection was successful
      authWindow.addEventListener('beforeunload', () => {
        loadUserSettings();
      });
      
    } catch (error) {
      console.error('Error starting Slack connection:', error);
      alert('Error connecting to Slack: ' + error.message);
    }
  });
}

// Update the disconnect button handler
const disconnectSlackBtn = document.getElementById('disconnectSlackBtn');
if (disconnectSlackBtn) {
  disconnectSlackBtn.addEventListener('click', async () => {
    try {
      await slackDisconnectFunction();
      updateSlackUI(false);
    } catch (error) {
      console.error('Error disconnecting Slack:', error);
      alert('Error disconnecting from Slack: ' + error.message);
    }
  });
}

// Add event listener for Slack channel input changes
const slackChannelInput = document.getElementById('slackChannelInput');
if (slackChannelInput) {
  // Add a debounce function to avoid too many requests
  let updateTimeout;
  slackChannelInput.addEventListener('change', async () => {
    const channel = slackChannelInput.value.trim();
    
    try {
      // Show loading state
      slackChannelInput.classList.add('loading');
      slackChannelInput.disabled = true;
      
      // Update the channel
      await slackUpdateChannelFunction({ channel });
      
      // Show success state briefly
      slackChannelInput.classList.remove('loading');
      slackChannelInput.classList.add('success');
      
      // Reset state after a moment
      setTimeout(() => {
        slackChannelInput.classList.remove('success');
        slackChannelInput.disabled = false;
      }, 1000);
      
    } catch (error) {
      console.error('Error updating Slack channel:', error);
      alert('Error updating Slack channel: ' + error.message);
      
      // Reset state
      slackChannelInput.classList.remove('loading');
      slackChannelInput.disabled = false;
    }
  });
}

// Update the updateSlackInputState function to be simpler
function updateSlackInputState(connected, teamName = '', channel = '') {
  const slackInput = document.getElementById('slackInput');
  const slackButton = document.getElementById('slackActionBtn');
  
  if (!slackInput || !slackButton) return;
  
  if (connected) {
    slackInput.value = channel;
    slackInput.placeholder = `Set channel for ${teamName}`;
    slackInput.disabled = false;
    
    // Update button icon based on state
    if (channel) {
      slackButton.className = 'add-email-btn'; // Use the same class as email button
      slackButton.innerHTML = `
        <div class="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </div>
      `;
    } else {
      slackButton.className = 'add-email-btn'; // Use the same class as email button
      slackButton.innerHTML = `
        <div class="w-4 h-4 rounded-full flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </div>
      `;
    }
  } else {
    slackInput.value = '';
    slackInput.placeholder = 'Connect to Slack';
    slackInput.disabled = true;
    slackButton.className = 'add-email-btn';
    slackButton.innerHTML = `
      <div class="w-4 h-4 rounded-full flex items-center justify-center">
        <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </div>
    `;
  }
}

// Update the Slack action button handler
const slackActionBtn = document.getElementById('slackActionBtn');
if (slackActionBtn) {
  slackActionBtn.addEventListener('click', async () => {
    if (!slackConnected) {
      // Connect to Slack
      try {
        const result = await slackConnectFunction();
        const authWindow = window.open(result.data.authUrl);
        
        // Poll for connection status
        const checkConnection = setInterval(async () => {
          if (authWindow.closed) {
            clearInterval(checkConnection);
            await loadUserSettings();
          }
        }, 1000);
        
        // Clear interval after 2 minutes as safety
        setTimeout(() => clearInterval(checkConnection), 120000);
      } catch (error) {
        console.error('Error connecting to Slack:', error);
        alert('Error connecting to Slack: ' + error.message);
      }
    } else {
      const slackInput = document.getElementById('slackInput');
      const currentChannel = slackInput.value.trim();
      
      if (currentChannel === slackChannel) {
        // Disconnect from Slack if channel hasn't changed
        if (confirm('Are you sure you want to disconnect from Slack?')) {
          try {
            await slackDisconnectFunction();
            slackConnected = false;
            slackChannel = '';
            slackInput.value = ''; // Explicitly clear the input field
            slackInput.disabled = true; // Disable the input field
            updateSlackInputState(false);
          } catch (error) {
            console.error('Error disconnecting from Slack:', error);
            alert('Error disconnecting from Slack: ' + error.message);
          }
        }
      } else {
        // Update channel
        try {
          await slackUpdateChannelFunction({ channel: currentChannel });
          slackChannel = currentChannel;
          updateSlackInputState(true, undefined, currentChannel);
        } catch (error) {
          console.error('Error updating Slack channel:', error);
          alert('Error updating Slack channel: ' + error.message);
          slackInput.value = slackChannel; // Reset to previous value
        }
      }
    }
  });
}

// Add input event listener for Slack channel input
const slackInput = document.getElementById('slackInput');
if (slackInput) {
  slackInput.addEventListener('input', () => {
    const currentValue = slackInput.value.trim();
    const slackButton = document.getElementById('slackActionBtn');
    
    if (currentValue !== slackChannel) {
      // Show orange plus when the value is different from saved channel
      slackButton.innerHTML = `
        <div class="w-4 h-4 rounded-full flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </div>
      `;
    } else {
      // Show red X when the value matches the saved channel
      slackButton.innerHTML = `
        <div class="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </div>
      `;
    }
  });
}

// Slack input handling
if (slackInput) {
  slackInput.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const currentValue = slackInput.value.trim();
      
      // Only handle channel updates since input is disabled when not connected
      if (currentValue !== slackChannel) {
        try {
          await slackUpdateChannelFunction({ channel: currentValue });
          slackChannel = currentValue;
          updateSlackInputState(true, undefined, currentValue);
        } catch (error) {
          console.error('Error updating Slack channel:', error);
          alert('Error updating Slack channel: ' + error.message);
          slackInput.value = slackChannel; // Reset to previous value
        }
      }
    }
  });
}