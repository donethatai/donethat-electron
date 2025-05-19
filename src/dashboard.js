const { getFunctions, httpsCallable } = require("firebase/functions");
const { firebaseApp } = require('./firebase.js');
const { ipcRenderer } = require('electron');
const { logAnalyticsEvent } = require('./analytics.js');
const {  getIsPaused, getIsPublic } = require('./app-state.js');

const functions = getFunctions(firebaseApp, "europe-west1");

// Create callable function references
const generateRawSummaryFunction = httpsCallable(functions, "generateRawSummary");
const saveFinalSummaryFunction = httpsCallable(functions, "saveFinalSummary");

// Reference to permission-related elements 
const generateSummaryBtn = document.getElementById("generateSummaryBtn");
const submitSummaryBtn = document.getElementById("submitSummaryBtn");
const summaryContainer = document.getElementById("summaryContainer");
let currentSummaryId = null;
const summaryLoadingSpinner = document.getElementById("summaryLoadingSpinner");

let loadUserSettingsCallback;
let navigateToView;
let showSpinner;
let hideSpinner;
let currentPeriodEndTime = null;
// Add an array to store custom bullets
let customBullets = [];

// Helper function to format date for headline
function formatHeadlineDate(timestamp) {
  if (!timestamp) return "DoneThat";

  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  let dateString = "";
  const timeString = date.toLocaleTimeString('en-US', {
    hour: 'numeric', 
    minute: '2-digit',
    hour12: false
  });

  // Create a copy for date comparison without time
  const dateOnly = new Date(date);
  dateOnly.setHours(0, 0, 0, 0);

  // Reset time parts for today/yesterday comparison
  today.setHours(0, 0, 0, 0);
  yesterday.setHours(0, 0, 0, 0);

  if (dateOnly.getTime() === today.getTime()) {
    dateString = "Today";
  } else if (dateOnly.getTime() === yesterday.getTime()) {
    dateString = "Yesterday";
  } else {
    const day = date.getDate();
    const month = date.toLocaleString('en-US', { month: 'short' });
    let suffix = 'th';
    if (day % 10 === 1 && day !== 11) suffix = 'st';
    if (day % 10 === 2 && day !== 12) suffix = 'nd';
    if (day % 10 === 3 && day !== 13) suffix = 'rd';
    dateString = `${month} ${day}${suffix}`;
  }

  return `${dateString} ${timeString}`; // Combine date and time
}

// Update visibility when summary is generated
function showSummaryGeneratedState() {
    document.getElementById('generateSummaryBtn').classList.add('hidden');
    document.getElementById('submitSummaryBtn').classList.remove('hidden');

    // Show visibility note
    const visibilityNoteContainer = document.getElementById('visibilityNoteContainer');
    if (visibilityNoteContainer) {
      const isPublic = getIsPublic();
      let visibilityText = isPublic ? 'Posting to your public feed' : 'Posting to your feed';
      visibilityText += `. <a href="#" class="settings-link">Change here</a>.`;

      visibilityNoteContainer.innerHTML = `<p class="text-xs text-gray-500 text-center">${visibilityText}</p>`;
      visibilityNoteContainer.classList.remove('hidden');

      // Re-add event listener for the link
      visibilityNoteContainer.querySelector('.settings-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        navigateToView('settings');
      });
    }
  }
  
  // Function to handle all dashboard note operations
  function dashboardNote(extraNotes = []) {
    const notes = [];
    
    // Check if app is paused
    if (getIsPaused()) {
      notes.push({
        text: 'DoneThat is paused. <a href="#" class="resume-link">Resume recording</a>.',
        isWarning: true
      });
    }

    // Add any extra notes
    notes.push(...extraNotes);

    // Only add default note if no other notes exist
    if (notes.length === 0) {
      notes.push({
        text: "Summaries always show work you did since the last summary.",
        isWarning: false
      });
      notes.push({
        text: "Generate one once you're done for the day.",
        isWarning: false
      });
    }

    // Render the notes
    const notesHTML = notes.map(note => `
      <p class="dashboard-note ${note.isWarning ? 'text-gray-900' : 'text-gray-500'} text-center text-sm">
        ${note.text}
      </p>
    `).join('');

    const summaryContainer = document.getElementById('summaryContainer');
    if (summaryContainer) {
      summaryContainer.innerHTML = notesHTML;

      // Add event listeners for links
      document.querySelectorAll('.resume-link').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          resumeRecording();
        });
      });

      document.querySelectorAll('.settings-link').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          navigateToView('settings');
        });
      });
    }
  }

  // Reset to initial state
  function resetSummaryState() {
    document.getElementById('generateSummaryBtn').classList.remove('hidden');
    
    // Full reset of the submit button state
    const submitBtn = document.getElementById('submitSummaryBtn');
    submitBtn.classList.add('hidden');
    submitBtn.textContent = "Done That"; // Reset text
    submitBtn.disabled = false; // Reset disabled state
    submitBtn.classList.remove('disabled-btn'); // Remove disabled styling
    
    document.getElementById('visibilityNoteContainer')?.classList.add('hidden'); // Hide note on reset
    document.getElementById('summaryLoadingSpinner').classList.add('hidden'); // Ensure spinner is hidden
    currentSummaryId = null;
    customBullets = []; // Reset custom bullets
    currentPeriodEndTime = null; // Reset the stored period end time
  
    // Reset headline
    const headlineElement = document.getElementById('dashboardHeadline');
    if (headlineElement) {
      headlineElement.textContent = "DoneThat";
    }
    
    dashboardNote();
  }

  // Initialize dashboard
  function initializeDashboard(onSettingsUpdate, showBlockingSpinner, hideBlockingSpinner, viewNavigator) {
    loadUserSettingsCallback = onSettingsUpdate;
    showSpinner = showBlockingSpinner;
    hideSpinner = hideBlockingSpinner;
    navigateToView = viewNavigator;
  }

  // Only add event listeners if elements exist
if (submitSummaryBtn) {
    submitSummaryBtn.addEventListener('click', () => {
      summaryLoadingSpinner.classList.remove('hidden');
  
      const selectedBullets = [];
      document.querySelectorAll('.bullet-item').forEach(item => {
        const checkbox = item.querySelector('.bullet-checkbox');
        const textElement = item.querySelector('.bullet-text');
  
        if (checkbox.checked) {
          let bulletText = textElement.textContent.trim();
          selectedBullets.push(bulletText);
        }
      });
  
      // Get custom bullets
      const filteredCustomBullets = [];
      document.querySelectorAll('.custom-bullet').forEach(item => {
        const textElement = item.querySelector('.bullet-text');
        
        if (textElement) {
          let bulletText = textElement.textContent.trim();
          filteredCustomBullets.push(bulletText);
        }
      });

      const commentText = document.getElementById('commentInput').value.trim();
  
      saveFinalSummaryFunction({
        summaryId: currentSummaryId,
        selectedBullets: selectedBullets,
        customBullets: filteredCustomBullets,
        comment: commentText
      }).then(() => {
        summaryLoadingSpinner.classList.add('hidden');

        const now = new Date();
        const isRecentSummary = currentPeriodEndTime && (now.getTime() - currentPeriodEndTime < (60 * 60 * 1000));

        const shouldPauseAndDelayReset = isRecentSummary;

        // Clear summary content immediately
        document.getElementById('summaryContainer').innerHTML = '<p class="empty-state-text"></p>';

        // Send both the current timestamp and the period end time
        ipcRenderer.send("summarySubmitted", {
          timestamp: Date.now(),
          lastSummaryPeriodEnd: currentPeriodEndTime
        });

        logAnalyticsEvent('summary_submitted', {
            status: 'success',
            bullet_points_count: selectedBullets.length,
            has_comment: !!commentText
        });

        if (shouldPauseAndDelayReset) {
            ipcRenderer.send("pauseUntilTomorrow");

            submitSummaryBtn.textContent = "Well done!";
            submitSummaryBtn.disabled = true;
            submitSummaryBtn.classList.add('disabled-btn');
            submitSummaryBtn.classList.remove('hidden'); // Ensure it stays visible

            setTimeout(() => {
                resetSummaryState(); // Resets UI including button state
            }, 2000);
        } else {
            // New behavior: No pause, reset immediately
            resetSummaryState(); // Resets UI including button state
        }

      }).catch((error) => {
        summaryLoadingSpinner.classList.add('hidden');
        console.error("Error submitting summary:", error);
        alert(`Error submitting summary: ${error.message}`);
        
        // Log error in summary submission
        logAnalyticsEvent('summary_submitted', {
          status: 'error',
          error_code: error.code,
          error_message: error.message
        });
      });
    });
  }
  
  // Update the event listener for the generate summary button
  if (generateSummaryBtn) {
    generateSummaryBtn.addEventListener('click', async () => {
      summaryLoadingSpinner.classList.remove('hidden');
  
      // Call the actual Cloud Function instead of using dummy data
      generateRawSummaryFunction()
        .then((result) => {
          summaryLoadingSpinner.classList.add('hidden');
  
          // Process the result from the cloud function
          const bulletPoints = result.data.bulletPoints || [];
          currentSummaryId = result.data.summaryId;
          const period = result.data.period;
          // Store the period end time (as a number/timestamp)
          currentPeriodEndTime = period?.end;
          
          // Reset custom bullets when generating a new summary
          customBullets = [];

          // Update headline
          const headlineElement = document.getElementById('dashboardHeadline');
          if (headlineElement) {
            headlineElement.textContent = formatHeadlineDate(period?.end);
          }

          if (bulletPoints.length === 0) {
            dashboardNote([{
              text: 'No activities found for today. Check if DoneThat is paused and try again in an hour.',
              isWarning: true
            }]);
            logAnalyticsEvent('summary_generated', {
              status: 'empty',
              bullet_points_count: 0
            });
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
            </div>
          `).join('');
  
          // Add custom bullets container
          const customBulletsHTML = `
            <div id="customBulletsContainer" class="custom-bullets-container"></div>
          `;
  
          const commentHTML = `
            <textarea id="commentInput" class="comment-input" placeholder="Add a comment here"></textarea>
          `;
  
          summaryContainer.innerHTML = periodHTML + bulletHTML + customBulletsHTML + commentHTML;
  
          // Initialize custom bullets container
          renderCustomBullets();
  
          // Add event listeners for checkboxes
          document.querySelectorAll('.bullet-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', function () {
              const textElement = this.nextElementSibling;
  
              if (this.checked) {
                textElement.classList.remove('bullet-text-crossed');
              } else {
                textElement.classList.add('bullet-text-crossed');
              }
            });
          });
  
          showSummaryGeneratedState();
          
          // Log successful summary generation
          logAnalyticsEvent('summary_generated', {
            status: 'success',
            bullet_points_count: bulletPoints.length,
            has_period: !!period
          });
        })
        .catch((error) => {
          summaryLoadingSpinner.classList.add('hidden');
          console.error("Error generating summary:", error);
          summaryContainer.innerHTML = `<p class="empty-state-text">Error: ${error.message}</p>`;
          
          // Log error in summary generation
          logAnalyticsEvent('summary_generated', {
            status: 'error',
            error_code: error.code,
            error_message: error.message
          });
        });
    });
  } else {
    console.error("Generate summary button not found");
  }

// Add resume function
function resumeRecording() {
  ipcRenderer.send('resumeRecording');
}

// Add pause state change listener
ipcRenderer.on('pauseStateChanged', () => {
  // Add a small delay back to ensure app state is updated first
  setTimeout(() => {
    dashboardNote();
  }, 100);
});

// Add a function to explicitly refresh notes
function refreshDashboardNotes() {
  dashboardNote();
}

// Function to render existing custom bullets
function renderCustomBullets() {
  const customBulletsContainer = document.getElementById('customBulletsContainer');
  if (!customBulletsContainer) return;
  
  // Clear existing bullets
  customBulletsContainer.innerHTML = '';
  
  // Add each custom bullet as a non-editable item
  customBullets.forEach((bullet, index) => {
    const bulletItem = document.createElement('div');
    bulletItem.className = 'custom-bullet';
    
    // Create delete icon
    const deleteIcon = document.createElement('span');
    deleteIcon.className = 'delete-icon';
    deleteIcon.innerHTML = '×';
    deleteIcon.addEventListener('click', () => {
      customBullets.splice(index, 1);
      renderCustomBullets();
    });
    
    // Create text span for the bullet content
    const textSpan = document.createElement('span');
    textSpan.className = 'bullet-content bullet-text custom-bullet-italic';
    textSpan.textContent = bullet;
    
    // Add elements to bullet item
    bulletItem.appendChild(deleteIcon);
    bulletItem.appendChild(textSpan);
    
    customBulletsContainer.appendChild(bulletItem);
  });
  
  // Add input field for new bullets with proper alignment
  const inputRow = document.createElement('div');
  inputRow.className = 'bullet-input-row';
  inputRow.style.display = 'flex';
  inputRow.style.alignItems = 'center';
  
  // Create plus icon
  const plusIcon = document.createElement('span');
  plusIcon.className = 'add-bullet-icon';
  plusIcon.innerHTML = '+';
  
  // Create input field that spans full width
  const inputField = document.createElement('input');
  inputField.type = 'text';
  inputField.className = 'custom-bullet-input';
  inputField.placeholder = 'Add bullet points';
  
  // Function to add new bullet
  const addNewBullet = () => {
    const text = inputField.value.trim();
    if (text) {
      customBullets.push(text);
      inputField.value = '';
      renderCustomBullets();
      // Focus the input field after adding a bullet
      setTimeout(() => {
        const newInputField = document.querySelector('.custom-bullet-input');
        if (newInputField) newInputField.focus();
      }, 0);
    }
  };
  
  // Add event listeners
  plusIcon.addEventListener('click', addNewBullet);
  
  inputField.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addNewBullet();
    }
  });
  
  // Append elements to the input row
  inputRow.appendChild(plusIcon);
  inputRow.appendChild(inputField);
  
  // Add the input row to the container
  customBulletsContainer.appendChild(inputRow);
}

module.exports = { initializeDashboard, resetSummaryState, refreshDashboardNotes };