const { initializeApp } = require("firebase/app");
const { getFunctions, httpsCallable } = require("firebase/functions");
const { getAuth } = require("firebase/auth");
const firebaseConfig = require("../firebase-config.js");

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const functions = getFunctions(firebaseApp, "europe-west1");

// Create callable function references
const subscriptionIndividualCreateFunction = httpsCallable(functions, 'subscriptionIndividualPayment');
const subscriptionIndividualCancelFunction = httpsCallable(functions, 'subscriptionIndividualCancel');

// Module variables to store functions from main app
let loadUserSettingsCallback = null;
let showSpinner = null;
let hideSpinner = null;
let navigateToView = null;
let checkoutUrl = null;

/**
 * Initialize the subscription module
 */
function subscriptionInitialize(onSettingsUpdate, showBlockingSpinner, hideBlockingSpinner, viewNavigator) {
  
  loadUserSettingsCallback = onSettingsUpdate;
  showSpinner = showBlockingSpinner;
  hideSpinner = hideBlockingSpinner;
  navigateToView = viewNavigator;
  
  // Set up button click handler
  const subscribeButton = document.getElementById('subscribeButton');
  

  subscribeButton.addEventListener('click', () => {
    subscriptionHandleSubscribe();
  });

  // Set up team link to open in external browser
  document.addEventListener('click', (e) => {
    if (e.target.tagName === 'A' && e.target.getAttribute('href') === 'https://app.donethat.ai') {
      e.preventDefault();
      const { shell } = require('electron');
      shell.openExternal('https://app.donethat.ai');
    }
  });
}

/**
 * Update UI elements based on subscription status
 */
function subscriptionUpdateUI(data) {
  // If we need to show the subscription view or there's no active subscription
  if (data.shouldPromptForSubscription || !data.active) {
    createCheckoutSession().catch(error => {
      console.error('Error initializing subscription:', error);
    });
  } else {
    // Find or create subscription info container in settings
    let subscriptionInfoContainer = document.getElementById('subscriptionInfoContainer');

    if (!subscriptionInfoContainer) {
      // Create the container if it doesn't exist
      const settingsView = document.getElementById('settingsView');
      const dailyReminderContainer = settingsView?.querySelector('.form-group');

      if (dailyReminderContainer) {
        // Create subscription section
        subscriptionInfoContainer = document.createElement('div');
        subscriptionInfoContainer.id = 'subscriptionInfoContainer';
        subscriptionInfoContainer.className = 'mt-4';

        // Create label
        const subscriptionLabel = document.createElement('label');
        subscriptionLabel.className = 'form-label';
        subscriptionLabel.textContent = 'Subscription';
        subscriptionInfoContainer.appendChild(subscriptionLabel);

        // Create info panel
        const infoPanel = document.createElement('div');
        infoPanel.id = 'subscriptionInfoPanel';
        infoPanel.className = 'subscription-info-panel';
        subscriptionInfoContainer.appendChild(infoPanel);

        // Add the container after daily reminder
        dailyReminderContainer.appendChild(subscriptionInfoContainer);
      }
    }

    // Update subscription info content
    const infoPanel = document.getElementById('subscriptionInfoPanel');
    if (infoPanel) {
      let statusContent = '';

      // For company subscription
      if (data.source === 'company') {
        statusContent = `
          <div class="subscription-status-container">
            <p class="subscription-status">Company Subscription Active</p>
            <p class="subscription-detail">You're part of ${data.companyName || 'a company'} subscription</p>
          </div>
        `;
      }
      // For trial
      else if (data.trialActive && data.trialEndsAt) {
        const trialEndDate = new Date(data.trialEndsAt);
        const formattedDate = trialEndDate.toLocaleDateString();

        statusContent = `
          <div class="subscription-status-container">
            <p class="subscription-status">Free Trial Active</p>
            <p class="subscription-detail">Your trial ends on ${formattedDate}</p>
            ${data.trialDaysRemaining ? `<p class="subscription-detail">${data.trialDaysRemaining} days remaining</p>` : ''}
          </div>
        `;
      }
      // For active paid individual subscription
      else if (data.paidActive) {
        const renewalDate = new Date(data.currentPeriodEnd || 0);
        const formattedRenewalDate = renewalDate.toLocaleDateString();

        statusContent = `
          <div class="subscription-status-container">
            <p class="subscription-status">Subscription Active</p>
            <p class="subscription-detail">Next billing date: ${formattedRenewalDate}</p>
            <button id="subscriptionCancelBtn" class="subscription-cancel-btn">
              Cancel Subscription
            </button>
          </div>
        `;
      }

      infoPanel.innerHTML = statusContent;

      // Add event listeners for buttons
      const cancelBtn = document.getElementById('subscriptionCancelBtn');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', subscriptionHandleCancel);
      }
    }
  }
}

async function createCheckoutSession() {
  try {
    // Get current user and ensure they're authenticated
    const auth = getAuth();
    if (!auth.currentUser) {
      console.log('No authenticated user, cannot create subscription intent');
      return { plans: [] };
    }

    const result = await subscriptionIndividualCreateFunction();
    checkoutUrl = result.data.checkoutUrl;
    plan = result.data.plan || {};

    if (plan) {
      // Show the selected plan and update price displays
      displayPlan(plan);
    }

    return result.data;
  } catch (error) {
    console.error('Error fetching plans:', error);
    throw error;
  }
}

/**
 * Display the selected plan in the UI
 */
function displayPlan(plan) {
  
  // Get trial days from plan
  const trialDays = plan.trial?.days || 0;

  // Format price and period
  let formattedPrice = 'Free';
  let periodText = '';
  if (plan.price) {
    if (plan.price.amount) {
      formattedPrice = (plan.price.amount / 100).toLocaleString('en-US', {
        style: 'currency',
        currency: plan.price.currency.toUpperCase()
      });
    }
    periodText = getFormattedPeriod(plan.price);
  }

  // Update header and description
  const sectionHeader = document.querySelector('#subscriptionView h1') ||
    document.querySelector('#subscriptionView .section-header') ||
    document.querySelector('.section-header');
  if (sectionHeader) {
    const headerText = trialDays ? `${trialDays}-Day Free Trial` : 'Subscribe';
    sectionHeader.textContent = headerText;
  }

  const trialDescription = document.querySelector('#subscriptionView .text-sm.text-gray-600.text-center.mb-4');
  if (trialDescription) {
    trialDescription.textContent = trialDays
      ? `Try Done That for ${trialDays} days, no strings attached.`
      : 'Get started with Done That today.';
  }

  // Update all price elements
  document.querySelectorAll('.subscription-price, .subscription-bullet-price').forEach(element => {
    element.textContent = formattedPrice;
  });

  // Update all period elements
  document.querySelectorAll('.subscription-period, .subscription-bullet-period').forEach(element => {
    element.textContent = periodText;
  });

  // Update bullet points with trial text and price
  const bulletPoints = document.querySelectorAll('.bullet-item');
  if (bulletPoints.length > 0) {
    const lastBullet = bulletPoints[bulletPoints.length - 1];
    const contentElement = lastBullet.querySelector('.bullet-content');

    if (contentElement) {
      const priceText = trialDays
        ? `after your ${trialDays}-day free trial ends`
        : 'billed';
      contentElement.innerHTML = `${priceText} <span class="subscription-bullet-price">${formattedPrice}</span><span class="subscription-bullet-period">${periodText}</span>`;
    }
  }

  // Update button text based on trial status
  const subscribeButton = document.getElementById('subscribeButton');
  if (subscribeButton) {
    subscribeButton.disabled = false;
    subscribeButton.classList.remove('disabled-btn');
  }
}

/**
 * Handle subscription form submission
 */
async function subscriptionHandleSubscribe() {

  const errorMessage = document.getElementById('card-errors');
  
  try {    
    const authWindow = window.open(checkoutUrl);

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
    console.error('Subscription error:', error);
    errorMessage.textContent = error.message || 'An error occurred while setting up payment. Please try again later.';
  }
}

/**
 * Handle subscription cancellation
 */
async function subscriptionHandleCancel() {
  if (confirm('Are you sure you want to cancel your subscription? You will still have access until the end of your current billing period.')) {
    try {
      showSpinner();

      const result = await subscriptionIndividualCancelFunction();

      if (result.data.success) {
        alert('Your subscription has been canceled. You will still have access until the end of your current billing period.');
        if (loadUserSettingsCallback) {
          await loadUserSettingsCallback();
        }
      } else {
        alert('There was a problem canceling your subscription. Please try again later.');
      }
    } catch (error) {
      console.error('Error canceling subscription:', error);
      alert('There was a problem canceling your subscription: ' + error.message);
    } finally {
      hideSpinner();
    }
  }
}


function getFormattedPeriod(price) {
  if (!price || !price.interval) return '';

  const interval = price.interval;
  const count = price.intervalCount || 1;

  let periodText = '/month';
  if (interval === 'year') {
    periodText = count > 1 ? `/${count} years` : '/year';
  } else if (interval === 'month') {
    periodText = count > 1 ? `/${count} months` : '/month';
  } else if (interval === 'week') {
    periodText = count > 1 ? `/${count} weeks` : '/week';
  } else if (interval === 'day') {
    periodText = count > 1 ? `/${count} days` : '/day';
  }

  return periodText;
}

module.exports = {
  subscriptionInitialize,
  subscriptionUpdateUI
}; 
