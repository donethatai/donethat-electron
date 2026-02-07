const { httpsCallable } = require("firebase/functions");
const { functions } = require('./firebase.js');
const ipcRenderer = window.electronAPI;
const { logAnalyticsEvent } = require('./analytics.js');
const { getIsPaused } = require('./app-state.js');
const { showBanner } = require('./notify.js');

// Create callable function references
const generateRawSummaryFunction = httpsCallable(functions, "generateRawSummary");
const saveFinalSummaryFunction = httpsCallable(functions, "saveFinalSummary");

// Reference to permission-related elements 
const generateSummaryBtn = document.getElementById("generateSummaryBtn");
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
  
  

  // Reset to initial state
  function resetSummaryState() {
    document.getElementById('summaryLoadingSpinner').classList.add('hidden'); // Ensure spinner is hidden
    const finishDayMessage = document.getElementById('finishDayMessage');
    if (finishDayMessage) finishDayMessage.classList.add('hidden');
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
    // Input is provided in hours; convert to minutes for storage
    const timeHours = timeInput && timeInput.value ? parseFloat(timeInput.value) : null;
    const timeMinutes = (typeof timeHours === 'number' && !isNaN(timeHours)) ? Math.max(0, Math.round(timeHours * 60)) : null;
    
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
    // Show loading state
    summarySubmitBtn.disabled = true;
    summarySubmitBtn.innerHTML = '<div class="spinner-small"></div> Submitting...';

    // Filter to only include checked bullet points
    const selectedBullets = bulletPoints.filter((_, index) => bulletPointsChecked[index]);

    const commentText = summaryCommentInput.value.trim();

    saveFinalSummaryFunction({
      summaryId: currentSummaryId,
      selectedBullets: selectedBullets,
      customBullets: customBullets.map(bullet => bullet.text || bullet),
      comment: commentText
    }).then(() => {
      // Reset button state
      summarySubmitBtn.disabled = false;
      summarySubmitBtn.textContent = 'Submit';

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

      // Pause handled on click; no additional pause here
      
      // Reload the webview after successful submission
      const webview = document.getElementById('portalView');
      if (webview) {
        webview.reload();
      }
      
      // Always reset immediately
      resetSummaryState();

    }).catch((error) => {
      // Reset button state on error
      summarySubmitBtn.disabled = false;
      summarySubmitBtn.textContent = 'Submit';
      console.error("Error submitting summary:", error);
      showBanner(`Error submitting summary: ${error.message}`, { title: 'Summary', sticky: true });
      
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
      const finishDayMessage = document.getElementById('finishDayMessage');
      if (finishDayMessage) finishDayMessage.classList.remove('hidden');
      let pausedByFinishDay = false;
      // Immediately pause until tomorrow when finishing the day, if not already paused
      try {
        if (!getIsPaused()) {
          ipcRenderer.send("pauseUntilTomorrow");
          pausedByFinishDay = true;
        }
      } catch (e) {
        // No-op if IPC is unavailable
      }

      // Call the actual Cloud Function instead of using dummy data
      generateRawSummaryFunction()
        .then((result) => {
          summaryLoadingSpinner.classList.add('hidden');
          const finishDayMessage = document.getElementById('finishDayMessage');
          if (finishDayMessage) finishDayMessage.classList.add('hidden');

          // Process the result from the cloud function
          const bulletPointsData = result.data.bulletPoints || [];
          const bulletTimesData = result.data.bulletTimes || [];
          currentSummaryId = result.data.summaryId;
          const period = result.data.period;
          currentPeriodEndTime = period?.end;

          // If the summary is not recent and we actively paused, resume now
          try {
            const now = new Date();
            const isRecentSummary = currentPeriodEndTime && (now.getTime() - currentPeriodEndTime < (60 * 60 * 1000));
            if (!isRecentSummary && pausedByFinishDay) {
              ipcRenderer.send('resumeRecording');
            }
          } catch (_) {}
          
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
             // Show notification for empty summary
             showBanner('No activities found for today. Check if DoneThat is paused and try again in an hour.', {
               title: 'Empty Summary',
               sticky: false
             });
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
          const finishDayMessage = document.getElementById('finishDayMessage');
          if (finishDayMessage) finishDayMessage.classList.add('hidden');
          console.error("Error generating summary:", error);
          
          // Show error notification instead of just logging
          showBanner(error.message || 'Failed to generate summary', {
            title: 'Finish Day Error',
            sticky: false
          });
          
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
ipcRenderer.on('pauseStateChanged', (_event, isPaused, meta) => {
  // Pause state changed - no notification needed
  // The workday ended notification will handle informing the user when appropriate
});

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

 module.exports = { initializeDashboard, resetSummaryState };