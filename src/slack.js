const { initializeApp } = require("firebase/app");
const { getFunctions, httpsCallable } = require("firebase/functions");
const firebaseConfig = require("../firebase-config.js");
const { logAnalyticsEvent } = require('./analytics.js');

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const functions = getFunctions(firebaseApp, "europe-west1");

// Create callable function references
const slackConnectFunction = httpsCallable(functions, 'slackConnect');
const slackDisconnectFunction = httpsCallable(functions, 'slackDisconnect');
const slackUpdateChannelFunction = httpsCallable(functions, 'slackUpdateChannel');

// Slack-related state
let slackConnected = false;
let slackChannel = '';

// Update module variables to store the spinner functions
let loadUserSettingsCallback = null;
let showSpinner = null;
let hideSpinner = null;
let viewNavigator = null;

// Helper function to update Slack UI elements
function updateSlackUI(connected, team = '') {
  const connectedDiv = document.getElementById('slackConnected');
  const disconnectedDiv = document.getElementById('slackDisconnected');
  const channelContainer = document.getElementById('slackChannelContainer');
  const teamNameSpan = document.getElementById('slackTeamName');
  
  // Guard clause - if any required elements are missing, return early
  if (!connectedDiv || !disconnectedDiv || !channelContainer || !teamNameSpan) {
    return;
  }
  
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

// Helper function for Slack connection - no spinner involved
async function handleSlackConnect() {
  try {
    const result = await slackConnectFunction();
    const authWindow = window.open(result.data.authUrl);
    
    // Log that Slack connection was initiated
    logAnalyticsEvent('slack_connect_started', {
      status: 'success'
    });
    
    // Function to cleanup listeners
    const cleanup = () => {
      window.removeEventListener('focus', checkWindowClosed);
    };

    // Function to check if auth window was closed
    const checkWindowClosed = () => {
      if (loadUserSettingsCallback) loadUserSettingsCallback();

      if (authWindow.closed) {
        cleanup();
      }
    };

    // Add focus listener
    window.addEventListener('focus', checkWindowClosed);
    
    // Safety cleanup after 5 minutes
    setTimeout(() => {
      cleanup();
      if (!authWindow.closed) {
        authWindow.close();
        if (loadUserSettingsCallback) loadUserSettingsCallback();
      }
    }, 5 * 60 * 1000);
    
  } catch (error) {
    console.error('Error starting Slack connection:', error);
    alert('Error connecting to Slack: ' + error.message);
    
    // Log error in Slack connection
    logAnalyticsEvent('slack_connect_started', {
      status: 'error',
      error_code: error.code,
      error_message: error.message
    });
  }
}

function updateSlackInputState(connected, teamName = '', channel = '') {
  const slackInput = document.getElementById('slackInput');
  const slackButton = document.getElementById('slackActionBtn');
  
  if (!slackInput || !slackButton) return;
  
  slackConnected = connected;
  
  if (connected) {
    slackInput.value = channel;
    slackInput.placeholder = `Set channel for ${teamName}`;
    slackInput.disabled = false;
    slackChannel = channel;
    
    // Update button icon based on state
    if (channel === slackInput.value.trim()) {
      slackButton.className = 'add-email-btn';
      slackButton.innerHTML = `
        <div class="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </div>
      `;
    } else {
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
  } else {
    slackInput.value = '';
    slackInput.placeholder = 'Connect to Slack';
    slackInput.disabled = true;
    slackChannel = '';
    slackConnected = false;
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

// Add this helper function to update button state
function updateButtonState(isDisconnectButton = false) {
  const slackButton = document.getElementById('slackActionBtn');
  if (!slackButton) return;

  slackButton.innerHTML = isDisconnectButton ? `
    <div class="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center">
      <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </div>
  ` : `
    <div class="w-4 h-4 rounded-full flex items-center justify-center">
      <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
    </div>
  `;
}

// Update the initialization function to accept spinner functions
function initializeSlack(onSettingsUpdate, showBlockingSpinner, hideBlockingSpinner, viewNavigator) {
  loadUserSettingsCallback = onSettingsUpdate;
  showSpinner = showBlockingSpinner;
  hideSpinner = hideBlockingSpinner;
  viewNavigator = viewNavigator;
  
  const connectSlackBtn = document.getElementById('connectSlackBtn');
  const slackActionBtn = document.getElementById('slackActionBtn');
  const slackInput = document.getElementById('slackInput');

  if (connectSlackBtn) {
    connectSlackBtn.addEventListener('click', handleSlackConnect);
  }

  if (slackActionBtn) {
    slackActionBtn.addEventListener('click', async () => {
      const currentChannel = slackInput.value.trim();
      
      if (slackConnected) {
        if (currentChannel === slackChannel) {
          if (confirm('Are you sure you want to disconnect from Slack?')) {
            try {
              // Show blocking spinner
              showSpinner();
              
              await slackDisconnectFunction();
              updateSlackUI(false);
              updateSlackInputState(false);
              
              // Log successful Slack disconnection
              logAnalyticsEvent('slack_disconnected', {
                status: 'success'
              });
              
              if (loadUserSettingsCallback) loadUserSettingsCallback();
            } catch (error) {
              console.error('Error disconnecting from Slack:', error);
              alert('Error disconnecting from Slack: ' + error.message);
              
              // Log error in Slack disconnection
              logAnalyticsEvent('slack_disconnected', {
                status: 'error',
                error_code: error.code,
                error_message: error.message
              });
            } finally {
              // Hide blocking spinner
              hideSpinner();
            }
          }
        } else {
          try {
            // Show blocking spinner
            showSpinner();
            
            const response = await slackUpdateChannelFunction({ channel: currentChannel });
            const tmp = slackInput.value;
            // Check if the response indicates failure
            if (response.data && response.data.success === false) {
              console.warn('Channel update failed:', response.data.error);
              alert(response.data.error || "Could not find channel. If you are using a private channel, make sure you have invited the bot to the channel.");
              slackInput.value = tmp;
              updateSlackInputState(true);
              
              // Log info event for channel update failure
              logAnalyticsEvent('slack_channel_updated', {
                status: 'info',
                message: response.data.error,
                channel: currentChannel
              });
            } else {
              updateSlackInputState(true, undefined, currentChannel);
              
              // Log successful channel update
              logAnalyticsEvent('slack_channel_updated', {
                status: 'success',
                channel: currentChannel
              });
              
              if (loadUserSettingsCallback) loadUserSettingsCallback();
            }
          } catch (error) {
            console.error('Error updating Slack channel:', error);
            alert('Error updating Slack channel: ' + error.message);
            slackInput.value = slackChannel;
            updateButtonState(true);
            
            // Log error in channel update
            logAnalyticsEvent('slack_channel_updated', {
              status: 'error',
              error_code: error.code,
              error_message: error.message,
              channel: currentChannel
            });
          } finally {
            // Hide blocking spinner
            hideSpinner();
          }
        }
      } else {
        // No spinner for connection - just call handleSlackConnect
        await handleSlackConnect();
      }
    });
  }

  if (slackInput) {
    slackInput.addEventListener('input', () => {
      const currentValue = slackInput.value.trim();
      updateButtonState(currentValue === slackChannel);
    });

    slackInput.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const currentValue = slackInput.value.trim();
        
        if (slackConnected && currentValue !== slackChannel) {
          try {
            // Use the Tailwind blocking spinner
            showSpinner();
            
            const response = await slackUpdateChannelFunction({ channel: currentValue });
            
            // Check if the response indicates failure
            if (response.data && response.data.success === false) {
              console.warn('Channel update failed:', response.data.error);
              alert(response.data.error || "Could not find channel. If you are using a private channel, make sure you have invited the bot to the channel.");
              slackInput.value = slackChannel;
              updateButtonState(true);
              
              // Log info event for channel update failure
              logAnalyticsEvent('slack_channel_updated', {
                status: 'info',
                message: response.data.error,
                channel: currentValue
              });
            } else {
              updateSlackInputState(true, undefined, currentValue);
              if (loadUserSettingsCallback) loadUserSettingsCallback();
            }
          } catch (error) {
            console.error('Error updating Slack channel:', error);
            alert('Error updating Slack channel: ' + error.message);
            slackInput.value = slackChannel;
            updateButtonState(true);
          } finally {
            // Use the Tailwind hide function
            hideSpinner();
          }
        }
      }
    });
  }
}

module.exports = {
  initializeSlack,
  updateSlackInputState,
  updateSlackUI,
  slackConnected,
  slackChannel
}; 