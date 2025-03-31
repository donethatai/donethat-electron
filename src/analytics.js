const { getAnalytics, logEvent, setUserProperties } = require("firebase/analytics");
const { ipcRenderer } = require('electron');
const { firebaseApp } = require('./firebase.js');

let analytics = null;
let appVersion = null;

// Initialize analytics with the Firebase app instance
async function initializeAnalytics() {
  if (!analytics) {
    analytics = getAnalytics(firebaseApp);
    
    // Get app version from main process
    try {
      appVersion = await ipcRenderer.invoke('get-app-version');
    } catch (error) {
      appVersion = 'unknown';
    }

    // Listen for analytics events from main process
    ipcRenderer.on('analytics-event', (event, data) => {
      const { eventName, eventParams } = data;
      logAnalyticsEvent(eventName, eventParams);
    });
  }
}

/**
 * Log an analytics event
 * @param {string} eventName - Name of the event
 * @param {Object} eventParams - Event parameters
 */
async function logAnalyticsEvent(eventName, eventParams = {}) {
  if (!analytics) {
    await initializeAnalytics();
  }
  
  try {
    // Add common parameters to all events
    const commonParams = {
      app_version: appVersion || 'unknown',
      platform: process.platform,
      arch: process.arch,
      ...eventParams
    };
    
    logEvent(analytics, eventName, commonParams);
  } catch (error) {
    // Silently fail analytics errors
  }
}

/**
 * Set user properties
 * @param {Object} properties - User properties to set
 */
async function setAnalyticsUserProperties(properties) {
  if (!analytics) {
    await initializeAnalytics();
  }
  
  try {
    // Add common properties to all user properties
    const commonProperties = {
      platform: process.platform,
      app_version: appVersion || 'unknown',
      ...properties
    };
    
    setUserProperties(analytics, commonProperties);
  } catch (error) {
    // Silently fail analytics errors
  }
}

module.exports = {
  initializeAnalytics,
  logAnalyticsEvent,
  setAnalyticsUserProperties
}; 