const { getFunctions, httpsCallable } = require("firebase/functions");
const { firebaseApp } = require('./firebase.js');
const { ipcRenderer, shell } = require('electron');
const { logAnalyticsEvent } = require('./analytics.js');
const { getIsPaused } = require('./app-state.js');
const { showErrorModal } = require('./modal.js');

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

// Summary overlay elements
const summaryOverlay = document.getElementById("summaryOverlay");
const summaryHeadline = document.getElementById("summaryHeadline");
const summaryPeriod = document.getElementById("summaryPeriod");
const summaryBulletsContainer = document.getElementById("summaryBulletsContainer");
const summaryCustomBulletsContainer = document.getElementById("summaryCustomBulletsContainer");
const summaryCommentInput = document.getElementById("summaryCommentInput");
const summaryCloseBtn = document.getElementById("summaryCloseBtn");
const summaryCancelBtn = document.getElementById("summaryCancelBtn");
const summarySubmitBtn = document.getElementById("summarySubmitBtn");
const summaryCustomInput = document.getElementById("summaryCustomInput");
const summaryAddCustomBtn = document.getElementById("summaryAddCustomBtn");

let loadUserSettingsCallback;
let navigateToView;
let showSpinner;
let hideSpinner;
let currentPeriodEndTime = null;

// Bullet point state management (matching FE pattern)
let bulletPoints = []; // Array of BulletPoint objects: { text: string; duration?: number }
let bulletPointsChecked = [];
let customBullets = [];

// Helper function to format date for headline
function formatHeadlineDate(timestamp) {
  if (!timestamp) return "Today";

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


// Helper function to format duration in minutes to readable format
function formatDuration(minutes) {
  if (!minutes || minutes === 0) return '';
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  if (hours > 0) {
    return `${hours}h ${remainingMinutes}m`;
  } else {
    return `${minutes}m`;
  }
}

// Show summary overlay
function showSummaryOverlay() {
  if (summaryOverlay) {
    summaryOverlay.classList.remove('hidden');
  }
}

// Hide summary overlay
function hideSummaryOverlay() {
  if (summaryOverlay) {
    summaryOverlay.classList.add('hidden');
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
          shell.openExternal('https://app.donethat.ai/feed');
        });
      });
    }
  }

  // Reset to initial state
  function resetSummaryState() {
    document.getElementById('summaryLoadingSpinner').classList.add('hidden'); // Ensure spinner is hidden
    currentSummaryId = null;
    customBullets = []; // Reset custom bullets
    currentPeriodEndTime = null; // Reset the stored period end time
  
    // Reset headline
    const headlineElement = document.getElementById('dashboardHeadline');
    if (headlineElement) {
      headlineElement.textContent = "Today";
    }
    
    // Hide summary overlay
    hideSummaryOverlay();
    
    dashboardNote();
  }

  // Initialize dashboard
  function initializeDashboard(onSettingsUpdate, showBlockingSpinner, hideBlockingSpinner, viewNavigator) {
    loadUserSettingsCallback = onSettingsUpdate;
    showSpinner = showBlockingSpinner;
    hideSpinner = hideBlockingSpinner;
    navigateToView = viewNavigator;
  }



// Add event listeners for summary overlay buttons
if (summaryCloseBtn) {
  summaryCloseBtn.addEventListener('click', () => {
    hideSummaryOverlay();
  });
}

if (summaryCancelBtn) {
  summaryCancelBtn.addEventListener('click', () => {
    hideSummaryOverlay();
  });
}

// Add event listener for custom bullet input
if (summaryCustomInput && summaryAddCustomBtn) {
  const addCustomBullet = () => {
    const text = summaryCustomInput.value.trim();
    const timeInput = document.getElementById('summaryCustomTimeInput');
    const timeMinutes = timeInput && timeInput.value ? parseInt(timeInput.value) : null;
    
    if (text) {
      customBullets.push({
        text: text,
        duration: timeMinutes // Store as minutes or null
      });
      summaryCustomInput.value = '';
      if (timeInput) timeInput.value = '';
      renderCustomBullets();
      summaryCustomInput.focus();
    }
  };

  summaryAddCustomBtn.addEventListener('click', addCustomBullet);
  
  summaryCustomInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCustomBullet();
    }
  });
  
  // Add Enter key handling for time input
  const timeInput = document.getElementById('summaryCustomTimeInput');
  if (timeInput) {
    timeInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addCustomBullet();
      }
    });
  }
}

if (summarySubmitBtn) {
  summarySubmitBtn.addEventListener('click', () => {
    summaryLoadingSpinner.classList.remove('hidden');

    // Filter to only include checked bullet points
    const selectedBullets = bulletPoints.filter((_, index) => bulletPointsChecked[index]);

    const commentText = summaryCommentInput.value.trim();

    saveFinalSummaryFunction({
      summaryId: currentSummaryId,
      selectedBullets: selectedBullets,
      customBullets: customBullets.map(bullet => bullet.text || bullet),
      comment: commentText
    }).then(() => {
      summaryLoadingSpinner.classList.add('hidden');

      const now = new Date();
      const isRecentSummary = currentPeriodEndTime && (now.getTime() - currentPeriodEndTime < (60 * 60 * 1000));

      const shouldPauseAndDelayReset = isRecentSummary;

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
      }
      
      // Reload the webview after successful submission
      const webview = document.getElementById('portalView');
      if (webview) {
        webview.reload();
      }
      
      // Always reset immediately
      resetSummaryState();

    }).catch((error) => {
      summaryLoadingSpinner.classList.add('hidden');
      console.error("Error submitting summary:", error);
      showErrorModal(`Error submitting summary: ${error.message}`);
      
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
          const bulletPointsData = result.data.bulletPoints || [];
          const bulletTimesData = result.data.bulletTimes || [];
          currentSummaryId = result.data.summaryId;
          const period = result.data.period;
          currentPeriodEndTime = period?.end;
          
          // Convert to BulletPoint objects with time data
          bulletPoints = bulletPointsData.map((text, index) => ({
            text: text,
            duration: Array.isArray(bulletTimesData) ? bulletTimesData[index] : undefined
          }));
          bulletPointsChecked = bulletPoints.map(() => true);
          customBullets = [];

          // Update headline
          const headlineElement = document.getElementById('dashboardHeadline');
          if (headlineElement) {
            headlineElement.textContent = formatHeadlineDate(period?.end);
          }

          // Update overlay headline
          if (summaryHeadline) {
            summaryHeadline.textContent = formatHeadlineDate(period?.end);
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
  
          // Update overlay period
          if (summaryPeriod) {
            if (period) {
              summaryPeriod.textContent = `Activities from ${formatDateTime(period.start)} to ${formatDateTime(period.end)}`;
              summaryPeriod.classList.remove('hidden');
            } else {
              summaryPeriod.classList.add('hidden');
            }
          }
  
          // Render bullet points with time information
          const bulletHTML = bulletPoints.map((point, index) => {
            const isChecked = bulletPointsChecked[index];
            const timeInfo = point.duration && formatDuration(point.duration) ? `<span class="bullet-time-chip ${!isChecked ? 'bullet-time-chip-crossed' : ''}">${formatDuration(point.duration)}</span>` : '';
            return `
              <div class="bullet-item">
                <input type="checkbox" class="bullet-checkbox" id="bullet-${index}" ${isChecked ? 'checked' : ''}>
                <label for="bullet-${index}" class="bullet-text ${!isChecked ? 'bullet-text-crossed' : ''}">${point.text}</label>
                ${timeInfo}
              </div>
            `;
          }).join('');

          // Populate overlay bullets
          if (summaryBulletsContainer) {
            summaryBulletsContainer.innerHTML = bulletHTML;
          }
  
          // Render custom bullets
          renderCustomBullets();
  
          // Add event listeners for overlay checkboxes
          summaryBulletsContainer.querySelectorAll('.bullet-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', function () {
              const index = parseInt(this.id.replace('bullet-', ''));
              bulletPointsChecked[index] = this.checked;
              
              const bulletItem = this.closest('.bullet-item');
              const textLabel = bulletItem.querySelector('.bullet-text');
              const timeChip = bulletItem.querySelector('.bullet-time-chip');
              
              if (this.checked) {
                textLabel.classList.remove('bullet-text-crossed');
                if (timeChip) timeChip.classList.remove('bullet-time-chip-crossed');
              } else {
                textLabel.classList.add('bullet-text-crossed');
                if (timeChip) timeChip.classList.add('bullet-time-chip-crossed');
              }
            });
          });
  
          showSummaryOverlay();
          
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
  if (!summaryCustomBulletsContainer) return;
  
  // Clear existing bullets
  summaryCustomBulletsContainer.innerHTML = '';
  
  // Add each custom bullet
  customBullets.forEach((bullet, index) => {
    const bulletItem = document.createElement('div');
    bulletItem.className = 'custom-bullet';
    
    // Create delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'custom-bullet-delete';
    deleteBtn.innerHTML = '×';
    deleteBtn.addEventListener('click', () => {
      customBullets.splice(index, 1);
      renderCustomBullets();
    });
    
    // Create text span for the bullet content
    const textSpan = document.createElement('span');
    textSpan.className = 'custom-bullet-text';
    textSpan.textContent = bullet.text || bullet;
    
    // Add elements to bullet item
    bulletItem.appendChild(deleteBtn);
    bulletItem.appendChild(textSpan);
    
    // Add time chip only if duration exists
    if (bullet.duration) {
      const timeChip = document.createElement('span');
      timeChip.className = 'bullet-time-chip';
      timeChip.textContent = formatDuration(bullet.duration);
      bulletItem.appendChild(timeChip);
    }
    
    summaryCustomBulletsContainer.appendChild(bulletItem);
  });
}

module.exports = { initializeDashboard, resetSummaryState, refreshDashboardNotes };