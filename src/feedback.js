const ipcRenderer = window.electronAPI;
const { httpsCallable } = require('firebase/functions');
const { functions } = require('./firebase.js');
const { showBanner } = require('./notify.js');

let feedbackOverlay = null;
let feedbackTextarea = null;
let feedbackCheckbox = null;
let feedbackCloseBtn = null;
let feedbackCancelBtn = null;
let feedbackSubmitBtn = null;

function closeFeedbackOverlay() {
  if (feedbackOverlay) {
    feedbackOverlay.classList.add('hidden');
  }
}

function openFeedbackOverlay(options = {}) {
  if (feedbackOverlay) {
    const prefillText = typeof options === 'string'
      ? options
      : typeof options?.text === 'string'
        ? options.text
        : '';
    feedbackOverlay.classList.remove('hidden');
    if (feedbackTextarea) {
      feedbackTextarea.value = prefillText;
      feedbackTextarea.focus();
      feedbackTextarea.setSelectionRange(feedbackTextarea.value.length, feedbackTextarea.value.length);
    }
    if (feedbackCheckbox) feedbackCheckbox.checked = false;
  }
}

async function submitFeedback() {
  const feedbackText = feedbackTextarea?.value || '';
  const includeScreenshot = feedbackCheckbox?.checked || false;
  
  if (!feedbackText.trim()) {
    // Don't submit empty feedback
    return;
  }

  try {
    // Disable submit button while processing
    if (feedbackSubmitBtn) {
      feedbackSubmitBtn.disabled = true;
      feedbackSubmitBtn.textContent = 'Submitting...';
    }

    // Close the overlay BEFORE taking screenshot (so dialog isn't in the screenshot)
    closeFeedbackOverlay();

    // Wait for the overlay to finish closing animation
    await new Promise(resolve => setTimeout(resolve, 300));

    let screenshot = null;
    if (includeScreenshot) {
      // Request screenshot from main process
      screenshot = await ipcRenderer.invoke('capture-feedback-screenshot');
    }

    // Call Firebase cloud function
    const submitFeedbackFn = httpsCallable(functions, 'feedbackSubmit');
    const result = await submitFeedbackFn({
      text: feedbackText,
      screenshot: screenshot || undefined // Only include if we have a screenshot
    });

    // Show success notification
    showBanner('Thank you for your feedback!', {
      title: 'Feedback submitted',
      sticky: false
    });
  } catch (error) {
    console.error('Error submitting feedback:', error);
    
    // Parse error message for better user feedback
    let errorMessage = 'Failed to submit feedback. Please try again.';
    
    if (error.code === 'unauthenticated') {
      errorMessage = 'You must be signed in to submit feedback.';
    } else if (error.code === 'resource-exhausted') {
      errorMessage = 'Rate limit exceeded. Please try again later.';
    } else if (error.message) {
      // Use the error message if available
      errorMessage = error.message;
    }
    
    // Show error notification
    showBanner(errorMessage, {
      title: 'Error',
      sticky: false
    });
  } finally {
    // Re-enable submit button
    if (feedbackSubmitBtn) {
      feedbackSubmitBtn.disabled = false;
      feedbackSubmitBtn.textContent = 'Submit';
    }
  }
}

function initializeFeedback() {
  // Get DOM elements
  feedbackOverlay = document.getElementById('feedbackOverlay');
  feedbackTextarea = document.getElementById('feedbackTextarea');
  feedbackCheckbox = document.getElementById('feedbackIncludeScreenshot');
  feedbackCloseBtn = document.getElementById('feedbackCloseBtn');
  feedbackCancelBtn = document.getElementById('feedbackCancelBtn');
  feedbackSubmitBtn = document.getElementById('feedbackSubmitBtn');
  const openFeedbackBtn = document.getElementById('openFeedbackBtn');

  // Set up event listeners
  if (openFeedbackBtn) {
    openFeedbackBtn.addEventListener('click', openFeedbackOverlay);
  }

  if (feedbackCloseBtn) {
    feedbackCloseBtn.addEventListener('click', closeFeedbackOverlay);
  }

  if (feedbackCancelBtn) {
    feedbackCancelBtn.addEventListener('click', closeFeedbackOverlay);
  }

  if (feedbackSubmitBtn) {
    feedbackSubmitBtn.addEventListener('click', submitFeedback);
  }

  ipcRenderer.on('feedback:open', (_event, payload) => {
    openFeedbackOverlay(payload || {});
  });
}

module.exports = {
  initializeFeedback,
  openFeedbackOverlay,
  closeFeedbackOverlay
};
