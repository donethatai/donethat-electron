const { initializeApp } = require("firebase/app");
const { getFunctions, httpsCallable } = require("firebase/functions");
const { getAuth } = require("firebase/auth");
const firebaseConfig = require("../firebase-config.js");

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const functions = getFunctions(firebaseApp, "europe-west1");

// Create callable function references
const getPlansFunction = httpsCallable(functions, 'subscriptionPlans');
const collectPaymentFunction = httpsCallable(functions, 'subscriptionCollectPayment');
const billingPortalFunction = httpsCallable(functions, 'subscriptionBillingPortal');

// Module variables to store functions from main app
let loadUserSettingsCallback = null;
let showSpinner = null;
let hideSpinner = null;
let navigateToView = null;
let checkoutUrl = null;
let selectedPlan = null;

/**
 * Get the Stripe billing portal URL
 */
async function getBillingPortalUrl() {
  try {
    const result = await billingPortalFunction({
      returnUrl: 'https://donethat.ai'
    });
    
    if (!result.data.url) {
      throw new Error('No portal URL received from server');
    }
    
    return result.data.url;
  } catch (error) {
    console.error('Error getting billing portal URL:', error);
    throw error;
  }
}

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
  const subscriptionActionBtn = document.getElementById('subscriptionActionBtn');

  subscribeButton.addEventListener('click', () => {
    subscriptionHandleSubscribe();
  });

  // Add click handler for subscription action button
  if (subscriptionActionBtn) {
    subscriptionActionBtn.addEventListener('click', async () => {
      try {
        showSpinner();
        const portalUrl = await getBillingPortalUrl();
        
        // Open portal window
        const portalWindow = window.open(portalUrl);

        // Function to cleanup listeners
        const cleanup = () => {
          window.removeEventListener('focus', checkWindowClosed);
          hideSpinner();
        };

        // Function to check if portal window was closed
        const checkWindowClosed = () => {
          if (loadUserSettingsCallback) loadUserSettingsCallback();

          if (portalWindow.closed) {
            cleanup();
          }
        };

        // Add focus listener
        window.addEventListener('focus', checkWindowClosed);
        
        // Safety cleanup after 5 minutes
        setTimeout(() => {
          cleanup();
          if (!portalWindow.closed) {
            portalWindow.close();
            if (loadUserSettingsCallback) loadUserSettingsCallback();
          }
        }, 5 * 60 * 1000);

      } catch (error) {
        console.error('Error in subscription action button handler:', error);
        hideSpinner();
        alert(`Failed to open billing portal: ${error.message}`);
      }
    });
  }

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
 * Load and display plan details
 */
async function loadAndDisplayPlan() {
  showSpinner();
  try {
    // Get available plans
    const plansResult = await getPlansFunction({ type: "Individual" });
    const plans = plansResult.data;
    
    if (!plans || plans.length === 0) {
      console.error('No plans available');
      return;
    }

    // Select the first plan (assuming we only have one plan for now)
    selectedPlan = plans[0];

    // Display the plan details
    displayPlan(selectedPlan);
  } catch (error) {
    console.error('Error loading plan details:', error);
  } finally {
    hideSpinner();
  }
}

/**
 * Update UI elements based on subscription status
 */
async function subscriptionUpdateUI(data) {
  // If we need to show the subscription view or there's no active subscription
  if (data.shouldPromptForSubscription || !data.active) {
    await loadAndDisplayPlan();
  } else {
    // Update subscription text
    const subscriptionInput = document.getElementById('subscriptionInput');
    if (subscriptionInput) {
      let statusText = '';
      const subscriptionActionBtn = document.getElementById('subscriptionActionBtn');
      
      // First check if individual subscription is active or trialing
      if ((data.trialActive || data.paidActive) && data.source !== 'team') {
        if (data.trialActive && data.trialEndsAt) {
          const trialEndDate = new Date(data.trialEndsAt);
          const formattedDate = trialEndDate.toLocaleDateString();
          statusText = `Trial ends on ${formattedDate}`;
        } else if (data.paidActive && data.currentPeriodEnd) {
          const renewalDate = new Date(data.currentPeriodEnd);
          const formattedDate = renewalDate.toLocaleDateString();
          statusText = `Renews on ${formattedDate}`;
        }

        // Ensure subscription action button is enabled for individual subscriptions
        if (subscriptionActionBtn) {
          subscriptionActionBtn.disabled = false;
          subscriptionActionBtn.classList.remove('disabled-btn');
        }
      }
      // Only if individual subscription is not active, check for team subscription
      else if (data.source === 'team') {
        // Check if the team is active
        if (data.status === 'ACTIVE') {
          statusText = `Part of ${data.teamName || 'a team'}`;
          
          // Disable only the subscription action button if team subscription exists
          if (subscriptionActionBtn) {
            subscriptionActionBtn.disabled = true;
            subscriptionActionBtn.classList.add('disabled-btn');
          }
        } else {
          // If team is not active, show subscription view
          await loadAndDisplayPlan();
          return;
        }
      }

      subscriptionInput.value = statusText;
    }
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
      ? `Try DoneThat for ${trialDays} days, no strings attached.`
      : 'Get started with DoneThat today.';
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
  const subscribeButton = document.getElementById('subscribeButton');
  
  try {
    // Disable button and show loading state
    subscribeButton.disabled = true;
    subscribeButton.classList.add('disabled-btn');
    subscribeButton.textContent = 'Loading...';
    
    // Show loading spinner
    showSpinner();

    // Get current user and ensure they're authenticated
    const auth = getAuth();
    if (!auth.currentUser) {
      throw new Error('No authenticated user, cannot create subscription intent');
    }

    if (!selectedPlan) {
      throw new Error('No plan selected');
    }

    // Create checkout session with the selected plan
    const checkoutResult = await collectPaymentFunction({
      type: "Individual",
      priceId: selectedPlan.id
    });

    checkoutUrl = checkoutResult.data.checkoutUrl;

    // Open checkout window
    const authWindow = window.open(checkoutUrl);

    // Function to cleanup listeners
    const cleanup = () => {
      window.removeEventListener('focus', checkWindowClosed);
      // Reset button state
      subscribeButton.disabled = false;
      subscribeButton.classList.remove('disabled-btn');
      subscribeButton.textContent = 'Start Free Trial';
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
    
    // Reset button state on error
    subscribeButton.disabled = false;
    subscribeButton.classList.remove('disabled-btn');
    subscribeButton.textContent = 'Start Free Trial';
  } finally {
    // Hide loading spinner
    hideSpinner();
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
