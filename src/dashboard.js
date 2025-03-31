const { getFunctions, httpsCallable } = require("firebase/functions");
const { firebaseApp } = require('./firebase.js');
const { ipcRenderer } = require('electron');
const { logAnalyticsEvent } = require('./analytics.js');

const functions = getFunctions(firebaseApp, "europe-west1");

// Create callable function references
const generateRawSummaryFunction = httpsCallable(functions, "generateRawSummary");
const saveFinalSummaryFunction = httpsCallable(functions, "saveFinalSummary");
const discardSummaryFunction = httpsCallable(functions, "summaryDiscard");

// Reference to permission-related elements 
const generateSummaryBtn = document.getElementById("generateSummaryBtn");
const submitSummaryBtn = document.getElementById("submitSummaryBtn");
const discardSummaryBtn = document.getElementById("discardSummaryBtn");
const summaryContainer = document.getElementById("summaryContainer");
let currentSummaryId = null;
const summaryLoadingSpinner = document.getElementById("summaryLoadingSpinner");

let loadUserSettingsCallback;
let navigateToView;
let showSpinner;
let hideSpinner;

// Update visibility when summary is generated
function showSummaryGeneratedState() {
    document.getElementById('generateSummaryBtn').classList.add('hidden');
    document.getElementById('submitSummaryBtn').classList.remove('hidden');
    document.getElementById('discardSummaryBtn').classList.remove('hidden');
  }
  
  // Reset to initial state
  function resetSummaryState() {
    document.getElementById('generateSummaryBtn').classList.remove('hidden');
    document.getElementById('submitSummaryBtn').classList.add('hidden');
    document.getElementById('discardSummaryBtn').classList.add('hidden');
    currentSummaryId = null;
    selectedBulletPoints = [];
  
    document.getElementById('summaryContainer').innerHTML =
      '<p class="empty-state-text">Generate a summary to see your activities.</p>';
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
        submitSummaryBtn.textContent = "Well done!";
        submitSummaryBtn.disabled = true;
        submitSummaryBtn.classList.add('disabled-btn');
        submitSummaryBtn.classList.remove('hidden');
  
        // Notify main process that summary was submitted
        ipcRenderer.send("summarySubmitted");
  
        // Pause recording until tomorrow
        ipcRenderer.send("pauseUntilTomorrow");
  
        // Log successful summary submission
        logAnalyticsEvent('summary_submitted', {
          status: 'success',
          bullet_points_count: selectedBullets.length,
          has_comment: !!commentText
        });
  
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
        
        // Log error in summary submission
        logAnalyticsEvent('summary_submitted', {
          status: 'error',
          error_code: error.code,
          error_message: error.message
        });
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
              <span class="heart-icon">♥</span>
            </div>
          `).join('');
  
          const commentHTML = `
            <textarea id="commentInput" class="comment-input" placeholder="Add a comment here"></textarea>
          `;
  
          summaryContainer.innerHTML = periodHTML + bulletHTML + commentHTML;
  
          // Add event listeners for checkboxes and heart icons
          document.querySelectorAll('.bullet-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', function () {
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
            heart.addEventListener('click', function () {
              this.classList.toggle('active');
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

// Add event listener for discard button
if (discardSummaryBtn) {
  discardSummaryBtn.addEventListener('click', () => {
    if (!currentSummaryId) {
      console.error("No summary ID to discard");
      return;
    }

    summaryLoadingSpinner.classList.remove('hidden');


    discardSummaryFunction({
      summaryId: currentSummaryId
    }).then(() => {
      summaryLoadingSpinner.classList.add('hidden');
      // Notify main process that summary was submitted
      ipcRenderer.send("summarySubmitted");

      // Pause recording until tomorrow
      ipcRenderer.send("pauseUntilTomorrow");
      resetSummaryState();
      
      // Log successful summary discard
      logAnalyticsEvent('summary_discarded', {
        status: 'success'
      });
    }).catch((error) => {
      summaryLoadingSpinner.classList.add('hidden');
      console.error("Error discarding summary:", error);
      alert(`Error discarding summary: ${error.message}`);
      
      // Log error in summary discard
      logAnalyticsEvent('summary_discarded', {
        status: 'error',
        error_code: error.code,
        error_message: error.message
      });
    });
  });
}

module.exports = { initializeDashboard, resetSummaryState };