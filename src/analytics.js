/**
 * Analytics Implementation using Firebase Measurement Protocol
 * Direct implementation for Electron
 */
const { ipcRenderer } = require('electron');
const { firebaseApp } = require('./firebase.js');
const { auth } = require('./firebase.js');
const os = require('os');
const { hasValidAccess, getState } = require('./app-state.js');

let appVersion = null;

// Create a random client ID for this session
const generateClientId = () => {
  return 'electron-client-' + Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
};

// Get stored client ID or generate a new one
const getClientId = () => {
  let clientId = localStorage.getItem('firebase-analytics-client-id');
  if (!clientId) {
    clientId = generateClientId();
    localStorage.setItem('firebase-analytics-client-id', clientId);
  }
  return clientId;
};

// Get detailed platform info
const getPlatformInfo = () => {
  return {
    os_name: process.platform,
    os_version: process.getSystemVersion ? process.getSystemVersion() : os.release(),
    os_arch: process.arch,
    memory_gb: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
    cpu_cores: os.cpus().length,
    hostname: os.hostname().replace(/\..+$/, '') // Remove domain part for privacy
  };
};

// Class implementation for analytics
class Analytics {
  // Static property to track if event listeners are initialized
  static listenersInitialized = false;
  
  constructor() {
    this.clientId = getClientId();
    this.appVersion = 'unknown';
    this.measurementId = firebaseApp.options.measurementId;
    this.apiSecret = firebaseApp.options.apiSecret;
    this.initialized = false;
    this.platformInfo = getPlatformInfo();
    this.currentView = null;
    this.sessionStartTime = Date.now();
  }

  /**
   * Initialize analytics
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // Get app version from main process
      try {
        this.appVersion = await ipcRenderer.invoke('get-app-version');
      } catch (error) {
        console.error('Failed to get app version:', error);
        this.appVersion = 'unknown';
      }

      // Check if this is first launch after install
      const isFirstLaunch = !localStorage.getItem('app_previously_launched');
      if (isFirstLaunch) {
        localStorage.setItem('app_previously_launched', 'true');
        localStorage.setItem('first_launch_date', new Date().toISOString());
      }

      // Send startup event
      this.logEvent('app_start', {
        startup_time: new Date().toISOString(),
        timestamp_ms: Date.now(),
        is_first_launch: isFirstLaunch,
        first_launch_date: localStorage.getItem('first_launch_date') || null
      });
      
      // Set up listeners only once by checking for a static flag
      if (!Analytics.listenersInitialized) {
        // Listen for analytics events from main process
        ipcRenderer.on('analytics-event', (event, data) => {
          const { eventName, eventParams } = data;
          this.logEvent(eventName, eventParams);
        });
        
        // Setup hooks for page navigation tracking
        if (typeof window !== 'undefined') {
          // This will be called externally from index.js
          window.trackPageView = (viewName) => {
            this.trackPageView(viewName);
          };
          
          // Set up global error tracking
          window.addEventListener('error', (event) => {
            this.logEvent('javascript_error', {
              error_message: event.message,
              error_source: event.filename,
              error_line: event.lineno,
              error_column: event.colno,
              error_stack: event.error?.stack,
              current_view: this.currentView
            });
          });
          
          // Track unhandled promise rejections
          window.addEventListener('unhandledrejection', (event) => {
            this.logEvent('unhandled_promise_rejection', {
              error_message: event.reason?.message || 'Unknown promise rejection',
              error_stack: event.reason?.stack,
              current_view: this.currentView
            });
          });
          
          // Track app close
          window.addEventListener('beforeunload', () => {
            // Use synchronous approach for beforeunload
            const sessionDurationMs = Date.now() - this.sessionStartTime;
            
            // Create event data directly
            const eventData = {
              client_id: this.clientId,
              user_id: this.getUserId(),
              events: [{
                name: 'app_close',
                params: {
                  ...this.getCommonParams(),
                  session_duration_ms: sessionDurationMs,
                  close_time: new Date().toISOString()
                }
              }]
            };
            
            // Use synchronous XHR for beforeunload events
            const xhr = new XMLHttpRequest();
            const url = `https://www.google-analytics.com/mp/collect?measurement_id=${this.measurementId}&api_secret=${this.apiSecret}`;
            xhr.open('POST', url, false); // Synchronous
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify(eventData));
          });
        }
        
        // Mark listeners as initialized
        Analytics.listenersInitialized = true;
      }
      
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize analytics:', error);
      // Still mark as initialized to avoid repeated attempts
      this.initialized = true;
    }
  }
  
  /**
   * Track page view
   * @param {string} viewName - Name of the view
   * @param {Object} additionalParams - Additional parameters to include
   */
  trackPageView(viewName, additionalParams = {}) {
    if (viewName === this.currentView) return; // Don't track duplicate view changes
    
    const previousView = this.currentView;
    this.currentView = viewName;
    
    this.logEvent('page_view', {
      page_title: viewName,
      page_location: viewName,
      previous_page: previousView || 'none',
      navigation_time: new Date().toISOString(),
      from_view: previousView || 'none',
      to_view: viewName,
      ...additionalParams
    });
  }

  /**
   * Get user ID if available
   */
  getUserId() {
    return auth?.currentUser?.uid || null;
  }
  
  /**
   * Get subscription status type
   */
  getSubscriptionType() {
    // Get current state
    const appState = getState();
    
    // If user doesn't have valid access, return none
    if (!hasValidAccess()) return 'none';
    
    // Check the different types of access
    if (appState.hasActiveTeam) return 'team';
    if (appState.subscriptionStatus === 'trialing') return 'trial';
    if (appState.subscriptionStatus === 'active') return 'paid';
    
    return 'unknown';
  }
  
  /**
   * Get common parameters to include with all events
   */
  getCommonParams() {
    // Get screen and window dimensions if available
    const screenWidth = typeof window !== 'undefined' ? window.screen.width : null;
    const screenHeight = typeof window !== 'undefined' ? window.screen.height : null;
    const windowWidth = typeof window !== 'undefined' ? window.innerWidth : null;
    const windowHeight = typeof window !== 'undefined' ? window.innerHeight : null;
    
    return {
      app_version: this.appVersion || 'unknown',
      user_id: this.getUserId(),
      // Platform info
      platform: this.platformInfo.os_name,
      os_version: this.platformInfo.os_version,
      os_arch: this.platformInfo.os_arch,
      memory_gb: this.platformInfo.memory_gb,
      cpu_cores: this.platformInfo.cpu_cores,
      device_id: this.clientId,
      // Screen dimensions
      screen_width: screenWidth,
      screen_height: screenHeight,
      window_width: windowWidth,
      window_height: windowHeight,
      // Page context
      current_view: this.currentView,
      // Session info
      session_id: this.clientId,
      session_duration_ms: Date.now() - this.sessionStartTime,
      timestamp_ms: Date.now(),
      // User type
      is_new_user: !localStorage.getItem('returning_user'),
      subscription_type: this.getSubscriptionType()
    };
  }

  /**
   * Log an analytics event
   * @param {string} eventName - Name of the event
   * @param {Object} params - Event parameters
   */
  async logEvent(eventName, params = {}) {
    // Make sure we're initialized
    if (!this.initialized) {
      await this.initialize();
    }

    // Basic validation
    if (!eventName) {
      console.error('Event name is required');
      return false;
    }

    // Combine common parameters with event-specific parameters
    const commonParams = this.getCommonParams();
    const eventParams = { ...commonParams, ...params };

    // Construct the event data
    const eventData = {
      client_id: this.clientId,
      user_id: this.getUserId(),
      events: [{
        name: eventName,
        params: eventParams
      }]
    };

    // Construct the URL for measurement protocol
    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${this.measurementId}&api_secret=${this.apiSecret}`;

    try {
      // Use the Fetch API to send the event
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(eventData),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Network response was not ok: ${response.status}`);
      }

      return true;
    } catch (error) {
      console.error(`Failed to send analytics event: ${eventName}`, error);
      return false;
    }
  }

  /**
   * Set user properties - converted to an event
   * @param {Object} properties - User properties to set
   */
  async setUserProperties(properties) {
    if (!properties) return false;
    
    try {
      // Add common properties
      const commonProperties = {
        ...this.getCommonParams(),
        ...properties
      };
      
      // Send user properties as an event
      return await this.logEvent('user_properties_set', commonProperties);
    } catch (error) {
      console.error('Failed to set user properties:', error);
      return false;
    }
  }
}

// Create singleton instance
const analytics = new Analytics();

// Initialize right away
analytics.initialize().catch(err => console.error('Failed to initialize analytics:', err));

// Export methods for external use
module.exports = {
  initializeAnalytics: () => analytics.initialize(),
  logAnalyticsEvent: (eventName, params) => analytics.logEvent(eventName, params),
  setAnalyticsUserProperties: (properties) => analytics.setUserProperties(properties),
  trackPageView: (viewName) => analytics.trackPageView(viewName),
  
  // Track application errors
  trackError: (errorType, errorMessage, errorDetails = {}) => {
    return analytics.logEvent('app_error', {
      error_type: errorType,
      error_message: errorMessage,
      ...errorDetails
    });
  },
  
  // Track user activity/action
  trackUserAction: (actionName, actionDetails = {}) => {
    return analytics.logEvent('user_action', {
      action_name: actionName,
      ...actionDetails
    });
  },
  
  // Track feature usage
  trackFeatureUsage: (featureName, actionDetails = {}) => {
    return analytics.logEvent('feature_used', {
      feature_name: featureName,
      ...actionDetails
    });
  },
  
  // Track performance metrics
  trackPerformance: (operationName, durationMs, details = {}) => {
    return analytics.logEvent('performance', {
      operation: operationName,
      duration_ms: durationMs,
      ...details
    });
  }
}; 