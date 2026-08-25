const {
  onAuthStateChanged,
  onIdTokenChanged,
} = require("firebase/auth");
const ipcRenderer = window.electronAPI;

const { auth } = require('./firebase.js');

const { initializeSettings, loadUserSettings } = require('./settings.js');
const { initializeAuth } = require('./auth.js');
const { initializeDashboard, resetSummaryState } = require('./dashboard.js');
const { initializePermissions } = require('./permissions.js');
const { initializeAnalytics, trackPageView } = require('./analytics.js');
const { initializeFeedback } = require('./feedback.js');
const { routeLink } = require('./link-router.js');
const { showBanner } = require('./notify.js');
const {
  drainPendingPortalBridge,
  shouldSendGenericPortalToken
} = require('./portal-pending-bridge.js');
const { 
  hasScreenCapturePermission,
  hasWindowsPermission,
  isCaptureReadinessReady,
  updateStoreScreenshots,
  updateCurrentView,
  getCurrentView,
  isAuthenticated,
  hasValidAccess,
  updatePauseState,
  updateDateCreated,
  initializeChat,
  updateUserStatus
} = require('./app-state.js');

require('./audio-recorder');
require('./linux-screenshot');



// Reference to embedded portal webview
let portalView = null;
let portalMount = null;
let portalDomReady = false;
let lastPortalTokenSent = null;
let lastPortalTokenTs = 0;
// Webview load watchdog/retry state
let portalLoadTimer = null;
let portalLoadRetries = 0;
const PORTAL_LOAD_TIMEOUT_MS = 12000; // 12s timeout for slow networks
const PORTAL_MAX_RETRIES = 3;
/** Re-send id token to embedded portal if SPA/bootstrap missed the first postMessage (Windows timing). */
const PORTAL_AUTH_HANDSHAKE_RETRY_DELAYS_MS = [350, 900, 2200, 5000];
let portalHandshakeRetryTimers = [];
let portalSpinnerTimer = null; // delay before showing dashboard spinner
const PORTAL_RELOAD_COOLDOWN_MS = 10000; // avoid reloads shortly after token delivery
const PORTAL_DEFAULT_URL = 'https://app.donethat.ai';
/**
 * View names that mean "open this route in the embedded web app" rather than a
 * host screen. Keyed by the names main sends over `navigate` (app shortcuts,
 * the chat overlay links), valued with the web app's own routes.
 */
const PORTAL_VIEW_PATHS = {
  'don-settings': '/settings/don',
  'portal-settings': '/settings',
  home: '/summaries',
  calendar: '/calendar',
  tasks: '/tasks',
  feed: '/social',
  stats: '/stats',
  'app-settings': '/settings/app-config'
};
// Path the portal should open on next create; consumed by createPortalView so a
// deep link works even when the webview is currently suspended.
let pendingPortalPath = null;
let lastWebviewActivityTs = 0;
let lastWebviewActivityKey = '';
const WEBVIEW_ACTIVITY_DEDUPE_MS = 1500;
const TRUSTED_PORTAL_ORIGIN = new URL(PORTAL_DEFAULT_URL).origin;
// Default to visible: the renderer is loaded by the main process when the
// window is shown, and `app:window-shown` may have already fired before this
// script registers its IPC handler. The DOMContentLoaded probe below corrects
// this if the window actually started hidden.
let isAppWindowVisible = true;
const pendingPortalBridge = {
  customToken: null,
  reauthResult: null,
  logout: false,
  reloadAfterLoad: false,
  logTime: false
};

// Inform main that renderer is ready to receive auth tokens as early as possible
try { ipcRenderer.send('renderer:ready-for-auth'); } catch (_) {}

function emitTelemetrySignal(name, fields = {}) {
  try {
    ipcRenderer.send('telemetry:signal', { name, fields });
  } catch (_) {}
}

function emitWebviewActivity(event, reason) {
  const now = Date.now();
  const key = `${event}|${reason}`;
  if (lastWebviewActivityKey === key && (now - lastWebviewActivityTs) < WEBVIEW_ACTIVITY_DEDUPE_MS) {
    return;
  }
  emitTelemetrySignal('webview_activity', {
    event,
    reason,
    sincePrevMs: lastWebviewActivityTs ? (now - lastWebviewActivityTs) : -1
  });
  lastWebviewActivityTs = now;
  lastWebviewActivityKey = key;
}

function isTrustedPortalUrl(url) {
  try {
    return new URL(url).origin === TRUSTED_PORTAL_ORIGIN;
  } catch (_) {
    return false;
  }
}

function getPortalViewUrl(view) {
  try {
    if (view && typeof view.getURL === 'function') {
      return view.getURL();
    }
  } catch (_) {}
  try {
    return view?.getAttribute?.('src') || '';
  } catch (_) {
    return '';
  }
}

function isTrustedPortalView(view) {
  const url = getPortalViewUrl(view);
  return !!url && isTrustedPortalUrl(url);
}

function blockUntrustedPortalNavigation(event, url, reason) {
  if (!url || isTrustedPortalUrl(url)) return false;
  try { event?.preventDefault?.(); } catch (_) {}
  emitWebviewActivity('blocked-navigation', reason || 'untrusted');
  try { routeLink(url, { source: 'webview-navigation' }); } catch (_) {}
  return true;
}

function clearPortalHandshakeRetries() {
  try {
    portalHandshakeRetryTimers.forEach((id) => clearTimeout(id));
    portalHandshakeRetryTimers = [];
  } catch (_) {}
}

function schedulePortalAuthHandshakeRetries(view) {
  clearPortalHandshakeRetries();
  if (!view || view !== portalView || !portalDomReady) return;
  PORTAL_AUTH_HANDSHAKE_RETRY_DELAYS_MS.forEach((delay) => {
    const id = setTimeout(() => {
      try {
        if (!portalView || portalView !== view || !portalDomReady) return;
        if (!shouldSendGenericPortalToken(pendingPortalBridge)) return;
        sendPortalLoginIfPossible({ bypassDebounce: true });
      } catch (_) {}
    }, delay);
    portalHandshakeRetryTimers.push(id);
  });
}

/** Token + bounded retries when portal is ready (Firebase user is source of truth; avoids lag vs app-state `isAuthenticated`). */
function kickPortalAuthHandshake() {
  try {
    if (!portalView || !portalDomReady) return;
    if (!shouldSendGenericPortalToken(pendingPortalBridge)) return;
    if (!auth?.currentUser?.getIdToken) return;
    sendPortalLoginIfPossible({ bypassDebounce: true });
    schedulePortalAuthHandshakeRetries(portalView);
  } catch (_) {}
}

/** SPA navigations fire often — bypass debounce without resetting the full retry timer suite. */
function nudgePortalAuthToken() {
  try {
    sendPortalLoginIfPossible({ bypassDebounce: true });
  } catch (_) {}
}

/** After login, auth listener often ran before `<webview>` existed; dom-ready may race settings/nav — kick several times. */
function schedulePortalKickAfterDashboardNavigation() {
  const kickDelaysMs = [0, 120, 350, 900, 2200];
  kickDelaysMs.forEach((delay) => {
    setTimeout(() => {
      try {
        if (getCurrentView() !== 'dashboard') return;
        kickPortalAuthHandshake();
      } catch (_) {}
    }, delay);
  });
}

function hidePortalSpinner() {
  try {
    if (portalSpinnerTimer) { clearTimeout(portalSpinnerTimer); portalSpinnerTimer = null; }
    const s = document.getElementById('summaryLoadingSpinner');
    if (s) s.classList.add('hidden');
  } catch (_) {}
}

function showPortalSpinnerDelayed() {
  try {
    if (portalSpinnerTimer) { clearTimeout(portalSpinnerTimer); portalSpinnerTimer = null; }
    portalSpinnerTimer = setTimeout(() => {
      try {
        const s = document.getElementById('summaryLoadingSpinner');
        if (s) s.classList.remove('hidden');
      } catch (_) {}
    }, 1000); // 1s delay to avoid flicker on fast loads
  } catch (_) {}
}

function clearPortalLoadWatchdog() {
  if (portalLoadTimer) {
    clearTimeout(portalLoadTimer);
    portalLoadTimer = null;
  }
}

function startPortalLoadWatchdog(reason) {
  try { clearPortalLoadWatchdog(); } catch (_) {}
  try {
    const activePortalView = portalView;
    // Reuse summary spinner as a generic dashboard overlay while webview loads (only when online)
    if (navigator.onLine) {
      showPortalSpinnerDelayed();
    }
    portalLoadTimer = setTimeout(() => {
      if (!activePortalView || activePortalView !== portalView) {
        clearPortalLoadWatchdog();
        return;
      }
      // If we timed out waiting for load, show error and optionally retry
      try { console.warn('[Webview] load timeout (' + (reason || 'unknown') + '), retries:', portalLoadRetries); } catch (_) {}
      showWebviewError();
      // Retry only if we appear to be online and under retry limit
      if (navigator.onLine && portalView && portalLoadRetries < PORTAL_MAX_RETRIES) {
        portalLoadRetries += 1;
        try {
          if (navigator.onLine) hideWebviewError();
          recoverPortalView('timeout-retry-' + portalLoadRetries);
        } catch (e) {
          console.error('[Webview] Error reloading after timeout:', e);
          clearPortalLoadWatchdog();
        }
      } else {
        clearPortalLoadWatchdog();
      }
    }, PORTAL_LOAD_TIMEOUT_MS);
  } catch (_) {}
}

/**
 * Which Setup cards belong to each section the portal can ask for.
 *
 * Setup used to be one long page reached from the top bar. It is now opened from
 * the portal's own settings nav, one section at a time, so the cards are grouped
 * to match those entries. 'all' keeps the full page available for the entry
 * points that are not section-specific (the app menu).
 */
const SETUP_SECTIONS = {
  all: null,
  permissions: ['requiredPermissionsCard', 'microphonePermissionsCard', 'locationCard'],
  llm: ['llmSettingsCard'],
  appconfig: ['appConfigCard'],
  masking: ['appMaskingCard']
};

const SETUP_SECTION_TITLES = {
  all: 'Setup',
  permissions: 'Permissions',
  llm: 'LLM',
  appconfig: 'App',
  masking: 'Test app masking'
};

function isSetupOverlayOpen() {
  const overlay = document.getElementById('settingsView');
  return !!overlay && !overlay.classList.contains('hidden');
}

/**
 * Show the Setup panel over whatever is on screen.
 *
 * Deliberately not a view: the portal webview underneath must stay loaded,
 * because on the common path it is the portal's own settings nav that asked for
 * this panel and destroying it would unload the page the user came from.
 */
function openSetupOverlay(section) {
  const overlay = document.getElementById('settingsView');
  if (!overlay) return;
  // The portal has its own session, so it can ask for this while the host is
  // still mid-handshake. Nothing here is usable without auth, so drop it — but
  // leave a trace, because from the portal's side the click just did nothing.
  if (!isAuthenticated()) {
    console.warn('[setup] ignoring open request while unauthenticated:', section || 'all');
    return;
  }

  let key = 'all';
  if (Object.prototype.hasOwnProperty.call(SETUP_SECTIONS, section)) {
    key = section;
  } else if (section) {
    // The portal asked for something this build does not have — show the whole
    // panel rather than nothing, but say so: it means the two sides disagree
    // about what this version can do.
    console.warn('[setup] unknown section, falling back to the full panel:', section);
  }
  const visibleCards = SETUP_SECTIONS[key];

  const outOfSection = (cardId) => !!visibleCards && !visibleCards.includes(cardId);

  document.querySelectorAll('#settingsView [data-settings-card]').forEach((card) => {
    // A card hidden for its own reasons (the location rollout flag, for one)
    // stays hidden; sections only ever narrow what is already on offer.
    card.classList.toggle('setup-card-out-of-section', outOfSection(card.id));
  });

  // Notes live outside their card (see the dim in refreshCaptureDependentVisibility)
  // so they have to follow it out of the section by hand.
  document.querySelectorAll('#settingsView [data-settings-card-note]').forEach((note) => {
    note.classList.toggle('setup-card-out-of-section', outOfSection(note.dataset.settingsCardNote));
  });

  // A section showing a single card would otherwise say its name twice: once in
  // the panel header, once on the card. The card's own title is the better of
  // the two (it is written for a reader, not for a nav entry), so it becomes the
  // header and the card drops it.
  const soleCard = visibleCards && visibleCards.length === 1
    ? document.getElementById(visibleCards[0])
    : null;
  const soleCardTitle = soleCard ? soleCard.querySelector('.dt-card-title') : null;

  document.querySelectorAll('#settingsView [data-settings-card] .dt-card-title').forEach((cardTitle) => {
    cardTitle.classList.toggle('hidden', cardTitle === soleCardTitle);
  });

  const title = document.getElementById('setupOverlayTitle');
  if (title) {
    title.textContent = (soleCardTitle && soleCardTitle.textContent.trim())
      || SETUP_SECTION_TITLES[key]
      || SETUP_SECTION_TITLES.all;
  }

  applyLinuxSetupSections();
  resetSummaryState();
  overlay.classList.remove('hidden');

  const body = overlay.querySelector('.setup-dialog-body');
  if (body) body.scrollTop = 0;

  // Move focus into the panel: it is what makes the Tab trap below hold, since a
  // keypress inside the webview never reaches this document.
  const dialog = overlay.querySelector('.setup-dialog');
  if (dialog) dialog.focus();
  else if (document.activeElement) document.activeElement.blur();

  trackPageView('settings');
}

/**
 * Keyboard shortcuts overview.
 *
 * The list is built in main, which owns the accelerators (including the
 * user-configurable chat hotkey), so this only renders what it is handed.
 */
function renderShortcutsOverlay(sections) {
  const body = document.getElementById('shortcutsOverlayBody');
  if (!body) return;
  body.textContent = '';
  (Array.isArray(sections) ? sections : []).forEach((section) => {
    const wrap = document.createElement('div');
    wrap.className = 'shortcuts-section';

    const title = document.createElement('div');
    title.className = 'shortcuts-section-title';
    title.textContent = section?.title || '';
    wrap.appendChild(title);

    (Array.isArray(section?.items) ? section.items : []).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'shortcuts-row';

      const label = document.createElement('span');
      label.className = 'shortcuts-label';
      label.appendChild(document.createTextNode(item?.label || ''));

      // Rows main marked as configurable say so, and link to where.
      if (item?.note || item?.link) {
        const note = document.createElement('span');
        note.className = 'shortcuts-note';
        if (item.note) note.appendChild(document.createTextNode(item.note));
        if (item.link) {
          if (item.note) note.appendChild(document.createTextNode(' in '));
          const link = document.createElement('button');
          link.type = 'button';
          link.className = 'shortcuts-note-link';
          link.textContent = item.link.label || 'Settings';
          link.addEventListener('click', () => {
            closeShortcutsOverlay();
            navigateToView(item.link.view);
          });
          note.appendChild(link);
        }
        label.appendChild(note);
      }

      row.appendChild(label);

      const keys = document.createElement('span');
      keys.className = 'shortcuts-keys';
      keys.textContent = item?.keys || '';
      row.appendChild(keys);

      wrap.appendChild(row);
    });

    body.appendChild(wrap);
  });
}

function isShortcutsOverlayOpen() {
  const overlay = document.getElementById('shortcutsOverlay');
  return !!overlay && !overlay.classList.contains('hidden');
}

function closeShortcutsOverlay() {
  const overlay = document.getElementById('shortcutsOverlay');
  if (!overlay) return;
  if (overlay.contains(document.activeElement)) document.activeElement.blur();
  overlay.classList.add('hidden');
}

function toggleShortcutsOverlay(sections) {
  const overlay = document.getElementById('shortcutsOverlay');
  if (!overlay) return;
  if (isShortcutsOverlayOpen()) {
    closeShortcutsOverlay();
    return;
  }
  renderShortcutsOverlay(sections);
  overlay.classList.remove('hidden');
  // Focus the dialog so Escape lands here and not in the webview underneath.
  const dialog = overlay.querySelector('.setup-dialog');
  if (dialog) dialog.focus();
}

function closeSetupOverlay() {
  const overlay = document.getElementById('settingsView');
  if (!overlay) return;
  // Focus left on a node that is about to be hidden is focus nobody owns.
  if (overlay.contains(document.activeElement)) document.activeElement.blur();
  overlay.classList.add('hidden');
}

const SETUP_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

/** Tabbable nodes inside the panel, minus the cards the current section hides. */
function getSetupFocusableElements(overlay) {
  return Array.from(overlay.querySelectorAll(SETUP_FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null);
}

/**
 * Keep Tab inside the panel while it is open.
 *
 * Without this the dashboard webview behind the scrim stays tabbable, so a
 * keyboard user walks straight out of a dialog that claims to be modal.
 */
function handleSetupOverlayTab(event) {
  const overlay = document.getElementById('settingsView');
  if (!overlay) return;

  const focusables = getSetupFocusableElements(overlay);
  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (!overlay.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Linux-only Setup content, revealed whenever the panel opens. */
function applyLinuxSetupSections() {
  if (!(window.electronAPI && window.electronAPI.platform === 'linux')) return;
  const linuxInstallGuideNote = document.getElementById('linuxInstallGuideNote');
  if (linuxInstallGuideNote) linuxInstallGuideNote.classList.remove('hidden');
  const linuxScreenshotSection = document.getElementById('linuxScreenshotSection');
  if (linuxScreenshotSection) linuxScreenshotSection.classList.remove('hidden');
}

function updateTopbarReloadVisibility(viewName) {
  try {
    const reloadBtn = document.getElementById('reloadIframeBtn');
    if (!reloadBtn) return;
    if (viewName === 'dashboard') {
      reloadBtn.classList.remove('hidden');
      reloadBtn.style.display = '';
      reloadBtn.setAttribute('aria-hidden', 'false');
    } else {
      reloadBtn.classList.add('hidden');
      reloadBtn.style.display = 'none';
      reloadBtn.setAttribute('aria-hidden', 'true');
    }
  } catch (_) {}
}

// Proactively send token to the embedded portal when available
async function sendPortalLoginIfPossible(options = {}) {
  const bypassDebounce = options.bypassDebounce === true;
  try {
    if (!portalView) return;
    if (!portalDomReady) return;
    if (!isTrustedPortalView(portalView)) return;
    if (!shouldSendGenericPortalToken(pendingPortalBridge)) return;
    if (!auth?.currentUser?.getIdToken) return;
    const token = await auth.currentUser.getIdToken();
    const now = Date.now();
    if (!bypassDebounce) {
      const sameToken = lastPortalTokenSent && lastPortalTokenSent === token;
      const withinCooldown = now - lastPortalTokenTs < 10000; // 10s
      if (sameToken && withinCooldown) {
        return;
      }
    }
    try { portalView.send('auth:setToken', token); } catch (e) { console.error('[PortalSync] Error sending token', e); }
    lastPortalTokenSent = token;
    lastPortalTokenTs = now;
  } catch (e) {}
}

function canReloadPortalNow() {
  try {
    // Avoid reloads shortly after we just sent an auth token to the portal
    if (lastPortalTokenTs && (Date.now() - lastPortalTokenTs) < PORTAL_RELOAD_COOLDOWN_MS) {
      return false;
    }
  } catch (_) {}
  return true;
}

function safePortalReload(reason) {
  try {
    if (!portalView) return;
    // Only reload once the webview has emitted dom-ready; calling reload too early
    // can throw “WebView must be attached to the DOM and dom-ready emitted”.
    if (!portalDomReady) return;
    if (!navigator.onLine) { showWebviewError(); return; }
    if (!canReloadPortalNow()) { return; }
    hideWebviewError();
    portalView.reload();
    emitWebviewActivity('reload', reason || 'safe-reload');
    startPortalLoadWatchdog(reason || 'safe-reload');
  } catch (e) {
    console.error('[Webview] Error in safePortalReload:', e);
  }
}

function setPortalPlaceholderVisible(visible) {
  const placeholder = document.getElementById('portalSuspendedPlaceholder');
  if (!placeholder) return;
  if (visible) {
    placeholder.classList.remove('hidden');
  } else {
    placeholder.classList.add('hidden');
  }
}

function resetPortalAuthSyncState() {
  lastPortalTokenSent = null;
  lastPortalTokenTs = 0;
}

function updatePortalPlaceholderVisibility() {
  const shouldPortalBeActive = getCurrentView() === 'dashboard' && isAppWindowVisible === true;
  setPortalPlaceholderVisible(shouldPortalBeActive && !portalView);
}

function flushPendingPortalBridgeActions(view) {
  if (!view || view !== portalView || !portalDomReady) {
    return { suppressGenericTokenSync: false };
  }
  if (!isTrustedPortalView(view)) {
    return { suppressGenericTokenSync: true };
  }

  const { actions, suppressGenericTokenSync } = drainPendingPortalBridge(pendingPortalBridge);
  actions.forEach((action) => {
    try {
      if (action.type === 'logout') {
        view.send('auth:logout');
      } else if (action.type === 'customToken') {
        view.send('auth:setCustomToken', action.payload);
      } else if (action.type === 'reauthResult') {
        view.send('auth:reauth-result', action.payload);
      } else if (action.type === 'logTime') {
        view.send('desktop:log-time');
      }
    } catch (e) {
      console.error('[PortalSync] Error sending pending bridge action', action.type, e);
    }
  });

  return { suppressGenericTokenSync };
}

function attachPortalViewListeners(view) {
  const isActivePortalView = () => view === portalView;

  try {
    view.addEventListener('will-navigate', (event) => {
      if (!isActivePortalView()) return;
      blockUntrustedPortalNavigation(event, event.url, 'will-navigate');
    });
  } catch (_) {}

  try {
    view.addEventListener('new-window', (event) => {
      if (!isActivePortalView()) return;
      blockUntrustedPortalNavigation(event, event.url, 'new-window');
    });
  } catch (_) {}

  view.addEventListener('did-fail-load', (event) => {
    if (!isActivePortalView()) return;
    console.error('[Webview] Failed to load:', event);
    showWebviewError();
    clearPortalLoadWatchdog();
    hidePortalSpinner();
  });

  try {
    view.addEventListener('did-fail-provisional-load', (event) => {
      if (!isActivePortalView()) return;
      if (event?.errorCode === -3) return;
      console.error('[Webview] Provisional load failed:', event);
      showWebviewError();
      clearPortalLoadWatchdog();
      hidePortalSpinner();
    });
  } catch (_) {}

  try {
    view.addEventListener('did-start-loading', () => {
      if (!isActivePortalView()) return;
      emitWebviewActivity('did-start-loading', 'guest');
      if (navigator.onLine) {
        hideWebviewError();
        startPortalLoadWatchdog('did-start-loading');
      } else {
        showWebviewError();
      }
    });
  } catch (_) {}

  try {
    view.addEventListener('did-stop-loading', () => {
      if (!isActivePortalView()) return;
      emitWebviewActivity('did-stop-loading', 'guest');
      clearPortalLoadWatchdog();
      hidePortalSpinner();
    });
  } catch (_) {}

  view.addEventListener('dom-ready', () => {
    if (!isActivePortalView()) return;
    portalDomReady = true;
    // A deep link that arrived while the webview was still loading can only be
    // applied now; createPortalView clears it when it handled the path itself.
    if (pendingPortalPath) {
      const path = pendingPortalPath;
      pendingPortalPath = null;
      navigatePortalTo(path, 'deferred-portal-path');
    }
    if (navigator.onLine) {
      hideWebviewError();
    }
    portalLoadRetries = 0;
    clearPortalLoadWatchdog();
    hidePortalSpinner();
    const { suppressGenericTokenSync } = flushPendingPortalBridgeActions(view);
    if (!suppressGenericTokenSync) {
      kickPortalAuthHandshake();
    }

    (async () => {
      try {
        const isDebug = await ipcRenderer.invoke('get-debug-flag');
        if (isDebug && isActivePortalView()) {
          try { view.openDevTools(); } catch (e) {}
        }
      } catch (e) {}
    })();
  });

  try {
    view.addEventListener('did-finish-load', () => {
      if (!isActivePortalView()) return;
      portalLoadRetries = 0;
      clearPortalLoadWatchdog();
      hidePortalSpinner();
      if (shouldSendGenericPortalToken(pendingPortalBridge)) {
        kickPortalAuthHandshake();
      }
      if (pendingPortalBridge.reloadAfterLoad) {
        pendingPortalBridge.reloadAfterLoad = false;
        safePortalReload('calendar-linked-deferred');
      }
    });
  } catch (_) {}

  try {
    view.addEventListener('did-navigate', (event) => {
      if (!isActivePortalView()) return;
      if (event?.url && !isTrustedPortalUrl(event.url)) {
        emitWebviewActivity('blocked-navigation', 'did-navigate');
        destroyPortalView('untrusted-navigation');
        return;
      }
      emitWebviewActivity('did-navigate', 'guest');
      nudgePortalAuthToken();
    });
  } catch (e) {}
  try { view.addEventListener('did-frame-finish-load', () => { if (isActivePortalView()) nudgePortalAuthToken(); }); } catch (e) {}

  (async () => {
    try {
      const isDebug = await ipcRenderer.invoke('get-debug-flag');
      if (isDebug && isActivePortalView()) {
        try {
          view.addEventListener('console-message', (e) => {
            if (!isActivePortalView()) return;
            console.log('[Webview]', e.level, e.message);
          });
        } catch (e) {}
      }
    } catch (e) {}
  })();

  view.addEventListener('ipc-message', async (event) => {
    if (!isActivePortalView()) return;
    if (event.channel === 'portal:logout' || event.channel === 'auth:logout') {
      try {
        const { performFullLogout } = require('./auth.js');
        await performFullLogout();
      } catch (e) {
        console.error('Error during portal-initiated logout:', e);
      }
    } else if (event.channel === 'portal:open-link') {
      const url = event.args[0];
      if (url) routeLink(url, { source: 'webview' });
    } else if (event.channel === 'auth:google-signin') {
      const payload = event.args && event.args[0] || {};
      const requestCalendar = payload.requestCalendar === true;
      const openUrl = (url) => {
        if (url) window.electronAPI.invoke('open-external', url).catch(() => {});
      };
      window.electronAPI.invoke('auth:google-signin', { requestCalendar, fromPortal: true })
        .then((res) => {
          if (res && res.success && res.url) openUrl(res.url);
        })
        .catch((err) => { console.error('[ipc-message] auth:google-signin error:', err); });
    } else if (event.channel === 'desktop:open-setup') {
      const payload = event.args && event.args[0] || {};
      openSetupOverlay(payload.section);
    } else if (event.channel === 'updateCaptureInterval') {
      const minutes = event.args && event.args[0];
      if (Number.isFinite(minutes)) {
        try { ipcRenderer.send('updateCaptureInterval', minutes); } catch (e) {}
      }
    } else if (event.channel === 'auth:google-reauth') {
      const payload = event.args && event.args[0] || {};
      window.electronAPI.invoke('auth:google-reauth', {
        idToken: payload.idToken,
        requestCalendar: payload.requestCalendar === true,
      })
        .then((res) => {
          if (res && res.success && res.url) {
            window.electronAPI.invoke('open-external', res.url).catch(() => {});
          }
        })
        .catch(() => {});
    }
  });
}

function createPortalView(reason) {
  if (portalView || !portalMount) return portalView;

  console.info('[PortalLifecycle] create', reason || 'unknown');
  const view = document.createElement('webview');
  view.id = 'portalView';
  view.className = 'portal-frame';
  view.setAttribute('src', portalUrlFor(pendingPortalPath));
  pendingPortalPath = null;
  view.setAttribute('partition', 'persist:donethat');
  view.setAttribute('preload', './portal-preload.js');
  view.setAttribute('webpreferences', 'contextIsolation=true, nodeIntegration=false');

  portalView = view;
  portalDomReady = false;
  portalLoadRetries = 0;
  resetPortalAuthSyncState();
  attachPortalViewListeners(view);
  portalMount.appendChild(view);
  updatePortalPlaceholderVisibility();

  if (navigator.onLine) {
    hideWebviewError();
    startPortalLoadWatchdog(reason || 'create-portal');
  } else {
    showWebviewError();
  }

  return view;
}

function destroyPortalView(reason) {
  if (!portalView) {
    updatePortalPlaceholderVisibility();
    return;
  }

  console.info('[PortalLifecycle] destroy', reason || 'unknown');
  const view = portalView;
  portalView = null;
  portalDomReady = false;
  portalLoadRetries = 0;
  resetPortalAuthSyncState();
  clearPortalLoadWatchdog();
  clearPortalHandshakeRetries();
  hidePortalSpinner();
  hideWebviewError();

  try { view.remove(); } catch (_) {}
  updatePortalPlaceholderVisibility();
}

function ensurePortalActive(reason) {
  if (!(getCurrentView() === 'dashboard' && isAppWindowVisible === true)) {
    destroyPortalView(reason || 'portal-inactive');
    return null;
  }

  return portalView || createPortalView(reason || 'ensure-portal-active');
}

/**
 * Ask the embedded web app to open its Log time dialog.
 *
 * Deliberately not a navigation: the dialog belongs on whatever page the user is
 * already looking at. If the portal is not up yet the request rides along on the
 * pending bridge and is delivered on dom-ready.
 */
function requestPortalLogTime() {
  if (!isAuthenticated()) return;

  if (getCurrentView() !== 'dashboard') {
    navigateToView('dashboard');
  }

  const view = ensurePortalActive('log-time');
  if (view && portalDomReady && isTrustedPortalView(view)) {
    try {
      view.send('desktop:log-time');
      return;
    } catch (e) {
      console.error('[PortalSync] Error sending log-time', e);
    }
  }

  pendingPortalBridge.logTime = true;
}

function portalUrlFor(path) {
  if (!path) return PORTAL_DEFAULT_URL;
  try {
    return new URL(path, PORTAL_DEFAULT_URL).toString();
  } catch (_) {
    return PORTAL_DEFAULT_URL;
  }
}

/**
 * Point the embedded portal at a specific route (e.g. Don's settings).
 *
 * The webview is destroyed whenever the dashboard is not on screen, so the path
 * is stashed and picked up by createPortalView when there is nothing to steer.
 */
function navigatePortalTo(path, reason) {
  pendingPortalPath = path || null;
  const view = ensurePortalActive(reason || 'navigate-portal');
  if (!view || !path) return;
  // A freshly created webview already got the URL from pendingPortalPath.
  if (!portalDomReady) return;
  pendingPortalPath = null;
  const url = portalUrlFor(path);
  try {
    if (typeof view.loadURL === 'function') view.loadURL(url);
    else view.setAttribute('src', url);
  } catch (e) {
    console.error('[PortalLifecycle] navigate failed', reason, e);
  }
}

function recoverPortalView(reason, options = {}) {
  const { ignoreCache = false } = options;

  if (!navigator.onLine) {
    showWebviewError();
    return null;
  }

  let view = ensurePortalActive(reason || 'recover-portal');
  if (!view) return null;

  hideWebviewError();

  // If the guest failed before dom-ready, a plain reload can be a no-op.
  // Recreate the webview so user-triggered recovery always has an effect.
  if (!portalDomReady) {
    destroyPortalView((reason || 'recover-portal') + '-recreate');
    view = ensurePortalActive((reason || 'recover-portal') + '-recreate');
    return view;
  }

  if (ignoreCache && typeof view.reloadIgnoringCache === 'function') {
    view.reloadIgnoringCache();
  } else {
    view.reload();
  }
  startPortalLoadWatchdog(reason || 'recover-portal');
  kickPortalAuthHandshake();
  schedulePortalKickAfterDashboardNavigation();
  return view;
}



// Add a small delay to check initial auth state
setTimeout(() => {
  // Use the secure preload bridge instead of requiring electron in the renderer
  try {
    ipcRenderer.send('initialAuthCheck', !!auth.currentUser);
  } catch (_) {}
  // Windows needed 3s, 1s was enough for mac
}, 3000);

// Get references to views and elements
const signInView = document.getElementById("signInView");
const mfaChallengeView = document.getElementById("mfaChallengeView");
const signUpView = document.getElementById("signUpView");
const resetView = document.getElementById("resetView");
const dashboardView = document.getElementById("dashboardView");

/** Chromium focuses the first tabbable node when the BrowserWindow gains focus; blur after that frame so the top bar does not stay focused (e.g. Setup). */
function blurTopbarChromeFocus() {
  try {
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest('#appTopbar')) {
      ae.blur();
    }
  } catch (_) {}
}

function scheduleBlurTopbarChromeFocus() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      blurTopbarChromeFocus();
    });
  });
}

// Update the navigateToView function
function navigateToView(viewName) {
  const currentView = getCurrentView();

  // Deep link into the web app's own routes rather than a host screen.
  // Any navigation supersedes a deep link that never got applied.
  pendingPortalPath = null;
  let portalPath = null;
  if (Object.prototype.hasOwnProperty.call(PORTAL_VIEW_PATHS, viewName)) {
    if (!isAuthenticated()) {
      viewName = 'signin';
    } else {
      portalPath = PORTAL_VIEW_PATHS[viewName];
      viewName = 'dashboard';
    }
  }

  // Setup is an overlay, not a view. Callers still ask for it by the old view
  // names (the app menu, deep links, the capture warning), so translate here
  // rather than making every caller know the difference.
  if (viewName === 'settings' || viewName === 'permission' || viewName === 'permissions') {
    if (!isAuthenticated()) {
      viewName = 'signin';
    } else {
      openSetupOverlay('all');
      return;
    }
  }

  // Anything that navigates somewhere else dismisses Setup, which is what makes
  // the Finish button and the tray/menu entries close it without extra wiring.
  closeSetupOverlay();
  closeShortcutsOverlay();

  // Handle 'signup-next' parameter
  if (viewName === 'signup-next') {
    // If not authenticated, always go to signin
    if (!isAuthenticated()) {
      viewName = 'signin';
    } else {
      viewName = 'dashboard';
    }
  }

  // Protected views require authentication
  const protectedViews = ['dashboard'];
  if (protectedViews.includes(viewName) && !isAuthenticated()) {
    viewName = 'signin';
  }

  // Show the requested view
  let viewToShow;
  switch (viewName) {
    case 'dashboard':
      viewToShow = dashboardView;
      break;
    case 'signin':
      viewToShow = signInView;
      break;
    case 'mfa':
      viewToShow = mfaChallengeView;
      break;
    case 'signup':
      viewToShow = signUpView;
      break;
    case 'reset':
      viewToShow = resetView;
      break;
    default:
      viewName = isAuthenticated() ? 'dashboard' : 'signin';
      viewToShow = viewName === 'dashboard' ? dashboardView : signInView;
  }

  if (!viewToShow) {
    console.error('View not found:', viewName);
    return;
  }

  if (currentView === 'dashboard' && viewName === 'dashboard') {
    if (portalPath) navigatePortalTo(portalPath, 'repeat-navigate-to-portal-path');
    else ensurePortalActive('repeat-navigate-to-dashboard');
    schedulePortalKickAfterDashboardNavigation();
    return;
  }

  const allViews = document.querySelectorAll('.view-container');
  allViews.forEach(view => view.classList.add('hidden'));
  viewToShow.classList.remove('hidden');

  const appTopbar = document.getElementById('appTopbar');
  const isAuthScreen = (viewName === 'signin' || viewName === 'signup' || viewName === 'reset' || viewName === 'mfa');
  if (appTopbar) {
    const shouldHideTopbar = isAuthScreen;
    if (shouldHideTopbar) appTopbar.classList.add('hidden');
    else appTopbar.classList.remove('hidden');
  }
  if (document.activeElement) document.activeElement.blur();

  updateCurrentView(viewName);

  if (viewName === 'dashboard') {
    if (portalPath) navigatePortalTo(portalPath, 'navigate-to-portal-path');
    else ensurePortalActive('navigate-to-dashboard');
    schedulePortalKickAfterDashboardNavigation();
  } else {
    destroyPortalView('navigate-away-from-dashboard');
  }

  const topbarActionsElement = document.querySelector('.topbar-actions');
  if (topbarActionsElement) {
    topbarActionsElement.classList.remove('hidden');
  }
  updateTopbarReloadVisibility(viewName);
  trackPageView(viewName);
  updateDashboardCaptureWarning();
}

async function loadUserSettingsCallback() {
  // Keep spinner visible during the entire process - no need to call showBlockingSpinner() again
  try {
    const result = await loadUserSettings();
    if (!result) {
      hideBlockingSpinner();
      return; // Exit if no result (user not logged in)
    }
    
    // Use the status directly from settings - backend should send the correct status
    const userStatus = result.data?.status || 'inactive';

    // Update all relevant state
    updateUserStatus(userStatus);
    updateStoreScreenshots(result.data?.storeScreenshots || false);
    updateDateCreated(result.data?.analytics?.createdAt);

    // Send user status to main process (via secure preload bridge)
    try {
      ipcRenderer.send('updateUserStatus', userStatus);
    } catch (_) {}
    
    // Fetch initial pause state from main process
    let initialIsPaused = false;
    try {
      initialIsPaused = await ipcRenderer.invoke('getInitialPauseState');
    } catch (_) {}
    
    // Update app-state with the initial value
    updatePauseState(initialIsPaused);

    // Settings arrive from a Firestore listener, so this runs again every time a
    // Setup control writes one. Navigating would dismiss the panel the user is
    // still working in, so leave the view alone while it is open.
    if (!isSetupOverlayOpen()) {
      // Now hide spinner only after we've prepared everything for navigation
      navigateToView('signup-next');
    }
    
    // Hide spinner after everything is complete, including view transition
    hideBlockingSpinner();
  } catch (error) {
    console.error("Error loading user settings:", error);
    hideBlockingSpinner();
  }
}

// Function to show webview error message
function showWebviewError() {
  const dashboardEmbed = document.querySelector('.dashboard-embed');
  // Hide the webview while showing the error overlay
  try {
    if (portalView) portalView.classList.add('hidden');
  } catch (_) {}
  if (dashboardEmbed) {
    // Create error message if it doesn't exist
    let errorDiv = dashboardEmbed.querySelector('.runtime-webview-error');
    if (!errorDiv) {
      errorDiv = document.createElement('div');
      errorDiv.className = 'webview-error runtime-webview-error';
      errorDiv.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full p-8 text-center">
          <div class="text-gray-500 mb-4">
            <svg class="w-12 h-12 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <!-- Balanced, non-tilted no-wifi icon: wifi arcs + small X -->
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.004 11.803A15.5 15.5 0 0122 11.803"></path>
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.05 14.753a10.5 10.5 0 0113.9 0"></path>
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.111 17.804a5.5 5.5 0 017.778 0"></path>
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.75 19.25l2.5 2.5M13.25 19.25l-2.5 2.5"></path>
            </svg>
            <p class="text-lg font-medium mb-2">You seem to be offline</p>
            <p class="text-sm text-gray-400 mb-4">Check your connection and try again</p>
            <button id="webviewRetryBtn" class="dt-button dt-button--primary">
              Try again
            </button>
          </div>
        </div>
      `;
      dashboardEmbed.appendChild(errorDiv);
      
      // Add event listener for retry button
      const retryBtn = errorDiv.querySelector('#webviewRetryBtn');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          // Only attempt reload if back online
          if (!navigator.onLine) return;
          try {
            recoverPortalView('webview-error-retry');
          } catch (e) {
            console.error('[Webview] Error reloading:', e);
          }
        });
      }
    }
    errorDiv.classList.remove('hidden');
  }
}

// Function to hide webview error message
function hideWebviewError() {
  const errorDiv = document.querySelector('.runtime-webview-error');
  if (errorDiv) {
    errorDiv.classList.add('hidden');
  }
  // Show the webview again
  try {
    if (portalView) portalView.classList.remove('hidden');
  } catch (_) {}
}

function updateDashboardCaptureWarning() {
  const warningEl = document.getElementById('dashboardCaptureWarning');
  const warningText = document.getElementById('dashboardCaptureWarningText');
  if (!warningEl || !warningText) return;

  if (!isCaptureReadinessReady()) {
    warningEl.classList.add('hidden');
    return;
  }

  const screenToggle = document.getElementById('screenCheckbox');
  const windowsToggle = document.getElementById('windowsCheckbox');
  const isWaylandLinux = window.electronAPI?.platform === 'linux' && !!window.electronAPI?.isWayland;

  const screenEnabledByToggle = !!screenToggle?.checked;
  const windowsEnabledByToggle = isWaylandLinux ? true : !!windowsToggle?.checked;
  const screenPermissionGranted = !!hasScreenCapturePermission();
  const windowsPermissionGranted = isWaylandLinux ? true : !!hasWindowsPermission();

  const screenEffective = screenEnabledByToggle && screenPermissionGranted;
  const windowsEffective = windowsEnabledByToggle && windowsPermissionGranted;

  if (screenEffective && windowsEffective) {
    warningEl.classList.add('hidden');
    return;
  }

  const issues = [];
  if (!screenEffective) {
    if (!screenEnabledByToggle) {
      issues.push('Screenshare is turned off in Setup');
    } else if (!screenPermissionGranted) {
      issues.push('Screenshare permission is missing');
    }
  }
  if (!windowsEffective && !isWaylandLinux) {
    if (!windowsEnabledByToggle) {
      issues.push('Active applications are turned off in Setup');
    } else if (!windowsPermissionGranted) {
      issues.push('Active applications permission is missing');
    }
  }

  const issueSummary = issues.join(' and ');
  warningText.textContent = `Capture is limited because ${issueSummary}.`;

  warningEl.classList.remove('hidden');
}

// Update the document ready handler
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize all modules
  initializeAuth(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeDashboard(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializeSettings(loadUserSettingsCallback, showBlockingSpinner, hideBlockingSpinner, navigateToView);
  initializePermissions(updateTopbarVisibility);
  initializeFeedback();
  initializeAnalytics();
  document.addEventListener('capture-state-updated', updateDashboardCaptureWarning);

  // Grab the portal mount if present
  portalMount = document.getElementById('portalMount');
  const reloadSuspendedPortalBtn = document.getElementById('reloadSuspendedPortalBtn');

  // Respond to main process request to reload webview (throttled in main)
  try {
    ipcRenderer.on('webview:reload', () => {
      try {
        if (getCurrentView && getCurrentView() === 'dashboard' && portalView) {
          safePortalReload('ipc-reload');
          schedulePortalKickAfterDashboardNavigation();
        }
      } catch (e) { console.error('[Webview] Error reloading on IPC webview:reload:', e); }
    });
  } catch (e) {}

  // Initial offline/online UI state
  if (!navigator.onLine) {
    showWebviewError();
  } else {
    hideWebviewError();
  }

  try {
    isAppWindowVisible = await ipcRenderer.invoke('get-main-window-visibility');
  } catch (_) {
    // Keep optimistic default on probe failure rather than forcing the dashboard
    // into the suspended placeholder.
    isAppWindowVisible = true;
  }
  // Reconcile portal lifecycle now that we know the real visibility — handles
  // both directions: create if we optimistically defaulted true but were
  // actually visible-on-dashboard already, and destroy if we started hidden.
  ensurePortalActive('initial-visibility-probe');
  if (isAppWindowVisible) {
    scheduleBlurTopbarChromeFocus();
  }

  if (reloadSuspendedPortalBtn) {
    reloadSuspendedPortalBtn.addEventListener('click', () => {
      if (getCurrentView && getCurrentView() !== 'dashboard') {
        return;
      }
      if (!navigator.onLine) {
        showWebviewError();
        return;
      }
      try {
        recoverPortalView('manual-placeholder-reload', { ignoreCache: true });
      } catch (e) {
        console.error('[Webview] Error reloading dashboard placeholder:', e);
      }
    });
  }
  
  // Listen to connectivity changes
  window.addEventListener('offline', () => {
    showWebviewError();
    try {
      const s = document.getElementById('summaryLoadingSpinner');
      if (s) s.classList.add('hidden');
      const fd = document.getElementById('finishDayLoadingSpinner');
      if (fd) fd.classList.add('hidden');
      const fdMsg = document.getElementById('finishDayMessage');
      if (fdMsg) fdMsg.classList.add('hidden');
    } catch (_) {}
  });
  window.addEventListener('online', () => {
    hideWebviewError();
    try {
      const view = ensurePortalActive('online');
      if (view) {
        safePortalReload('online');
      }
    } catch (e) { console.error('[Webview] reload on online failed', e); }
  });

  // Reloads on focus are coordinated via main process (webview:reload)
  const openChatBtn = document.getElementById('openChatBtn');

  if (openChatBtn) {
    const isWaylandLinux = window.electronAPI?.platform === 'linux' && !!window.electronAPI?.isWayland;
    // The button always reads just "Chat"; the hotkey lives in the tooltip and
    // in the shortcuts overview (Cmd/Ctrl+/) instead of widening the top bar.
    const applyChatLabel = (label) => {
      openChatBtn.textContent = 'Chat';
      openChatBtn.title = label ? `Chat (${label})` : 'Chat';
    };
    applyChatLabel(null);
    
    openChatBtn.addEventListener('click', () => {
      // Only allow chat if authenticated and has valid access
      if (!isAuthenticated()) {
        return;
      }
      if (!hasValidAccess()) {
        return;
      }
      try { ipcRenderer.send('overlay:toggle'); } catch (e) {}
    });

    if (!isWaylandLinux) {
      // React to hotkey updates from main to refresh label
      try {
        ipcRenderer.on('hotkey:updated', (payload) => {
          applyChatLabel(payload && payload.label ? payload.label : null);
        });
        // Also request current label once
        ipcRenderer.invoke('hotkey:get').then((res) => {
          applyChatLabel(res && res.success && res.label ? res.label : null);
        }).catch(() => {});
      } catch (_) {}
    }
  }
  const shortcutsOverlayCloseBtn = document.getElementById('shortcutsOverlayCloseBtn');
  if (shortcutsOverlayCloseBtn) {
    shortcutsOverlayCloseBtn.addEventListener('click', () => closeShortcutsOverlay());
  }

  const shortcutsOverlay = document.getElementById('shortcutsOverlay');
  if (shortcutsOverlay) {
    shortcutsOverlay.addEventListener('mousedown', (event) => {
      if (event.target === shortcutsOverlay) closeShortcutsOverlay();
    });
  }

  try {
    ipcRenderer.on('shortcuts:toggle', (payload) => {
      toggleShortcutsOverlay(payload && payload.sections);
    });
  } catch (_) {}

  try {
    ipcRenderer.on('portal:log-time', () => {
      requestPortalLogTime();
    });
  } catch (_) {}

  const setupOverlayCloseBtn = document.getElementById('setupOverlayCloseBtn');
  if (setupOverlayCloseBtn) {
    setupOverlayCloseBtn.addEventListener('click', () => closeSetupOverlay());
  }

  const dashboardCaptureWarningSetupBtn = document.getElementById('dashboardCaptureWarningSetupBtn');
  if (dashboardCaptureWarningSetupBtn) {
    dashboardCaptureWarningSetupBtn.addEventListener('click', () => {
      openSetupOverlay('permissions');
    });
  }

  document.addEventListener('keydown', (event) => {
    if (isShortcutsOverlayOpen() && event.key === 'Escape') {
      closeShortcutsOverlay();
      return;
    }
    if (!isSetupOverlayOpen()) return;
    if (event.key === 'Escape') closeSetupOverlay();
    else if (event.key === 'Tab') handleSetupOverlayTab(event);
  });

  // Reload iframe button (manually reload when dashboard goes blank)
  const reloadIframeBtn = document.getElementById('reloadIframeBtn');
  if (reloadIframeBtn) {
    reloadIframeBtn.addEventListener('click', () => {
      if (getCurrentView && getCurrentView() === 'dashboard') {
        try {
          if (!navigator.onLine) {
            showWebviewError();
            return;
          }
          recoverPortalView('manual-hard-reload', { ignoreCache: true });
        } catch (e) {
          console.error('[Webview] Error in manual hard reload:', e);
        }
      }
    });
  }

  // Update button (only visible on Windows/Linux when update is available)
  const updateBtn = document.getElementById('updateBtn');
  if (updateBtn) {
    updateBtn.addEventListener('click', () => {
      try { ipcRenderer.send('update:install', { forceRunAfter: true }); } catch (e) {}
    });
  }

  // Handle update availability notifications
  ipcRenderer.on('update:available', () => {
    if (updateBtn) {
      updateBtn.classList.remove('hidden');
    }
  });

  ipcRenderer.on('update:not-available', () => {
    if (updateBtn) {
      updateBtn.classList.add('hidden');
    }
  });

  // Check update status on startup (only for Windows/Linux)
  (async () => {
    const platform = window.electronAPI?.platform || 'unknown';
    if (platform === 'win32' || platform === 'linux') {
      try {
        const status = await ipcRenderer.invoke('update:check-status');
        if (status && status.available) {
          if (updateBtn) {
            updateBtn.classList.remove('hidden');
          }
        } else {
          if (updateBtn) {
            updateBtn.classList.add('hidden');
          }
        }
      } catch (e) {
        // Hide button on error
        if (updateBtn) {
          updateBtn.classList.add('hidden');
        }
      }
    } else {
      // Hide button on macOS (uses silent updates)
      if (updateBtn) {
        updateBtn.classList.add('hidden');
      }
    }
  })();
  // Recording dropdown
  const recordingBtn = document.getElementById('recordingStateBtn');
  const recordingText = document.getElementById('recordingStateText');
  const recordingMenu = document.getElementById('recordingMenu');
  const pauseTodayBtn = document.getElementById('pauseTodayBtn');
  const resumeNowBtn = document.getElementById('resumeNowBtn');
  let lastKnownPauseState = false;

  function isManualPauseAllowed() {
    return document.body?.dataset?.manualPauseAllowed !== 'false';
  }

  function toggleRecordingMenu(open) {
    if (!recordingMenu) return;
    if (open === true) recordingMenu.classList.remove('hidden');
    else if (open === false) recordingMenu.classList.add('hidden');
    else recordingMenu.classList.toggle('hidden');
  }

  // Enable/disable menu entries based on pause state and valid access
  function updateRecordingMenuState(isPaused) {
    if (!recordingMenu) return;
    
    // Check if user has valid access
    const userHasValidAccess = hasValidAccess();
    const manualPauseAllowed = isManualPauseAllowed();
    
    // Disable all recording controls if user doesn't have valid access
    recordingMenu.querySelectorAll('[data-pause]')?.forEach(el => {
      if (isPaused || !userHasValidAccess || !manualPauseAllowed) el.classList.add('disabled'); else el.classList.remove('disabled');
    });
    if (resumeNowBtn) {
      if (isPaused && userHasValidAccess && manualPauseAllowed) resumeNowBtn.classList.remove('disabled'); else resumeNowBtn.classList.add('disabled');
    }
    if (pauseTodayBtn) {
      if (isPaused || !userHasValidAccess || !manualPauseAllowed) pauseTodayBtn.classList.add('disabled'); else pauseTodayBtn.classList.remove('disabled');
    }
  }

  recordingBtn?.addEventListener('click', () => toggleRecordingMenu());
  document.addEventListener('click', (e) => {
    if (!recordingMenu || !recordingBtn) return;
    if (!recordingMenu.contains(e.target) && !recordingBtn.contains(e.target)) {
      recordingMenu.classList.add('hidden');
    }
  });
  // Pause durations
  recordingMenu?.querySelectorAll('[data-pause]')?.forEach(btn => {
    btn.addEventListener('click', () => {
      // Check if user has valid access before allowing pause
      if (!hasValidAccess() || !isManualPauseAllowed()) {
        return;
      }
      const ms = Number(btn.getAttribute('data-pause')) || 0;
      if (ms > 0) ipcRenderer.send('pauseForMs', ms);
      toggleRecordingMenu(false);
    });
  });
  pauseTodayBtn?.addEventListener('click', () => { 
    // Check if user has valid access before allowing pause
    if (!hasValidAccess() || !isManualPauseAllowed()) {
      return;
    }
    if (!pauseTodayBtn.classList.contains('disabled')) { 
      ipcRenderer.send('pauseForToday'); 
      toggleRecordingMenu(false); 
    } 
  });
  resumeNowBtn?.addEventListener('click', () => { 
    // Check if user has valid access before allowing resume
    if (!hasValidAccess() || !isManualPauseAllowed()) {
      return;
    }
    if (!resumeNowBtn.classList.contains('disabled')) { 
      ipcRenderer.send('resumeRecording'); 
      toggleRecordingMenu(false); 
    } 
  });

  // Update recording text on pause/resume changes
  function setRecordingIcon(isPaused) {
    if (!recordingText || !recordingBtn) return;
    lastKnownPauseState = !!isPaused;
    if (isPaused) {
      recordingText.textContent = 'Resume';
      recordingText.classList.remove('active');
      recordingBtn?.classList.remove('active');
      recordingBtn?.setAttribute('title', 'Resume');
    } else {
      recordingText.textContent = 'Pause';
      recordingText.classList.add('active'); // orange text when recording
      recordingBtn?.classList.add('active'); // orange border when recording
      recordingBtn?.setAttribute('title', 'Pause');
    }
    updateRecordingMenuState(isPaused);
  }
  // Get initial recording state from main process
  ipcRenderer.invoke('getInitialPauseState').then((isPaused) => {
    setRecordingIcon(isPaused);
  }).catch(() => {
    // Fallback: assume recording unless told otherwise
    setRecordingIcon(false);
  });

  ipcRenderer.on('pauseStateChanged', (isPaused) => {
    setRecordingIcon(isPaused);
  });

  document.addEventListener('manual-pause-policy-updated', () => {
    updateRecordingMenuState(lastKnownPauseState);
  });

  updateDashboardCaptureWarning();
  ensurePortalActive('dom-content-loaded');

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;

    try {
      const url = new URL(link.href);
      const protocol = url.protocol.toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') return;

      e.preventDefault();
      routeLink(url.toString(), { source: 'index' });
    } catch (_) {}
  });

  // In-app notification logic moved to notify.js

  // Handle notification requests from main process - routes through showBanner()
  ipcRenderer.on('request-notification', (payload) => {
    if (payload && payload.message) {
      showBanner(payload.message, {
        title: payload.title || null,
        sticky: payload.sticky || false,
        action: payload.action || null,
        id: payload.id || null,
        noFocus: payload.noFocus || false,
        alsoNative: payload.alsoNative || false
      });
    }
  });
});

// Keep portal session in sync with desktop auth
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    pendingPortalBridge.logout = true;
    pendingPortalBridge.customToken = null;
    pendingPortalBridge.reauthResult = null;
    if (portalView && portalDomReady) {
      try { portalView.send('auth:logout'); } catch (e) { console.error('[PortalSync] Error sending logout', e); }
      pendingPortalBridge.logout = false;
    }
    resetPortalAuthSyncState();
    return;
  }

  if (!portalView || !portalDomReady) return;
  if (user) {
    kickPortalAuthHandshake();
  }
});

onIdTokenChanged(auth, async (user) => {
  if (!portalView || !portalDomReady) return;
  if (user) {
    kickPortalAuthHandshake();
  }
});

// Function to create an overlay that blocks interactions
function showBlockingSpinner() {
  const globalSpinner = document.getElementById("globalSpinner");
  if (globalSpinner) {
    // Show the spinner without affecting layout
    globalSpinner.classList.remove("hidden");
    // Ensure content remains visible
    globalSpinner.style.opacity = "1";
    globalSpinner.style.transition = "opacity 0.2s ease-in-out";
  }
}

// Function to hide the blocking spinner
function hideBlockingSpinner() {
  const globalSpinner = document.getElementById("globalSpinner");
  if (globalSpinner) {
    // Hide the spinner
    globalSpinner.classList.add("hidden");
    // Reset opacity
    globalSpinner.style.opacity = "0";
  }
}

// Function to update topbar visibility based on permissions
function updateTopbarVisibility() {
  const appTopbar = document.getElementById('appTopbar');
  const currentView = getCurrentView();
  const isAuthScreen = (currentView === 'signin' || currentView === 'signup' || currentView === 'reset' || currentView === 'mfa');
  
  if (appTopbar) {
    const shouldHideTopbar = isAuthScreen;
    if (shouldHideTopbar) appTopbar.classList.add('hidden');
    else appTopbar.classList.remove('hidden');
  }
}

// Add IPC listener for navigation
ipcRenderer.on('navigate', (viewName) => {
  navigateToView(viewName);
});

ipcRenderer.on('app:window-hidden', () => {
  isAppWindowVisible = false;
  destroyPortalView('app-window-hidden');
});

ipcRenderer.on('app:window-shown', () => {
  isAppWindowVisible = true;
  ensurePortalActive('app-window-shown');
  if (getCurrentView() === 'dashboard') {
    schedulePortalKickAfterDashboardNavigation();
  }
  scheduleBlurTopbarChromeFocus();
});

// Add pause state handler
ipcRenderer.on('pauseStateChanged', (isPaused) => {
  updatePauseState(isPaused);
});

// Handle donethat:// forwarded from main as internal navigation
ipcRenderer.on('router:open-link', (url) => {
  try {
    if (url) {
      routeLink(url, { source: 'main' });
    }
  } catch (e) {}
});

// Calendar link success from desktop (donethat://auth?action=linked&success=true)
ipcRenderer.on('auth:calendar-linked', () => {
  try {
    if (portalView && portalDomReady) {
      safePortalReload('calendar-linked');
      schedulePortalKickAfterDashboardNavigation();
    } else if (portalView) {
      pendingPortalBridge.reloadAfterLoad = true;
    }
  } catch (_) {}
});

ipcRenderer.on('auth:custom-token-for-portal', (payload) => {
  try {
    if (!payload || !payload.customToken) return;
    if (portalView && portalDomReady) {
      portalView.send('auth:setCustomToken', payload);
      return;
    }
    pendingPortalBridge.customToken = payload;
  } catch (e) {}
});
ipcRenderer.on('auth:reauth-result-for-portal', (payload) => {
  try {
    if (!payload) return;
    if (portalView && portalDomReady) {
      portalView.send('auth:reauth-result', payload);
      return;
    }
    pendingPortalBridge.reauthResult = payload;
  } catch (e) {}
});

// Initialize centralized chat (state-managed)
initializeChat();

// Export functions for use in other modules
module.exports = {
  updateTopbarVisibility
};
