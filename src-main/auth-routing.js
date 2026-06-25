const log = require('electron-log');

// Tracks whether the next auth callback should be treated as a portal reauth flow
let pendingPortalReauth = false;

function markPortalReauthPending() {
  pendingPortalReauth = true;
}

function clearPortalReauthPending() {
  pendingPortalReauth = false;
}

// Tracks whether the next auth callback came from a portal-initiated sign-in (e.g. calendar linking)
let pendingPortalSignin = false;
let pendingPortalSigninRequestCalendar = false;

function markPortalSigninPending(requestCalendar) {
  pendingPortalSignin = true;
  pendingPortalSigninRequestCalendar = !!requestCalendar;
}

function clearPortalSigninPending() {
  pendingPortalSignin = false;
  pendingPortalSigninRequestCalendar = false;
}

/**
 * Route donethat:// callbacks (login, calendar, reauth) to the right target.
 * - login / calendar: custom token to portal or shell
 * - reauth: idToken/accessToken to portal
 */
function handleDonethatUrl(urlString, mainWindow, enqueueDeepLinkToken) {
  if (!urlString || !urlString.startsWith('donethat://')) return;
  try {
    const url = new URL(urlString);
    const host = (url.hostname || '').toLowerCase();
    const path = (url.pathname || '').toLowerCase();
    const action = url.searchParams.get('action');
    const success = url.searchParams.get('success') === 'true';
    const token = url.searchParams.get('token');
    const idToken = url.searchParams.get('idToken');
    const accessToken = url.searchParams.get('accessToken');

    if (!mainWindow || mainWindow.isDestroyed()) return;

    // Calendar linking success: donethat://auth?action=linked&success=true
    if (host === 'auth' && action === 'linked' && success) {
      try {
        mainWindow.webContents.send('auth:calendar-linked');
      } catch (e) {
        log.warn('Failed to send auth:calendar-linked to renderer:', e);
      }
      return;
    }

    // Reauth with Google tokens
    if (idToken) {
      clearPortalReauthPending();
      try {
        mainWindow.webContents.send('auth:reauth-result-for-portal', {
          idToken,
          accessToken: accessToken || null,
        });
      } catch (e) {
        log.warn('Failed to send auth:reauth-result-for-portal (donethat) to renderer:', e);
      }
      return;
    }

    // Token-only callbacks: portal login or shell login
    if (token) {
      clearPortalReauthPending();
      if (host === 'auth' || path === '/auth' || path.startsWith('/auth')) {
        const requestCalendar = url.searchParams.get('requestCalendar') === 'true';
        try {
          mainWindow.webContents.send('auth:custom-token-for-portal', {
            customToken: token,
            requestCalendar,
          });
        } catch (e) {
          log.warn('Failed to send auth:custom-token-for-portal to renderer:', e);
        }
      } else {
        enqueueDeepLinkToken(token);
      }
      return;
    }

    // Fallback: route as generic deep link
    try {
      mainWindow.webContents.send('router:open-link', urlString);
    } catch (e) {
      log.warn('Failed to send router:open-link to renderer:', e);
    }
  } catch (error) {
    log.error('Error parsing donethat URL:', error);
  }
}

/**
 * Route localhost /auth callbacks from AuthServer.
 * - calendar link success -> portal reload
 * - reauth with Google tokens -> portal
 * - token-only -> shell
 */
function handleAuthServerToken(token, googleTokens, mainWindow, enqueueDeepLinkToken) {
  const desktopFlow = googleTokens?.desktopFlow || null;
  log.info('[handleAuthServerToken] callback:', {
    hasToken: !!token,
    hasGoogleTokens: !!(googleTokens && googleTokens.idToken),
    desktopFlow: desktopFlow || 'legacy',
    requestCalendar: !!(googleTokens && googleTokens.requestCalendar)
  });
  if (googleTokens && googleTokens.action === 'linked' && googleTokens.success && mainWindow && !mainWindow.isDestroyed()) {
    clearPortalReauthPending();
    clearPortalSigninPending();
    try {
      mainWindow.webContents.send('auth:calendar-linked');
    } catch (e) {
      log.warn('Failed to send auth:calendar-linked (localhost) to renderer:', e);
    }
    return;
  }

  const hasGoogleTokens = googleTokens && googleTokens.idToken;
  if (hasGoogleTokens && (desktopFlow === 'reauth' || pendingPortalReauth) && mainWindow && !mainWindow.isDestroyed()) {
    clearPortalReauthPending();
    clearPortalSigninPending();
    try {
      mainWindow.webContents.send('auth:reauth-result-for-portal', {
        idToken: googleTokens.idToken,
        accessToken: googleTokens.accessToken || null,
      });
    } catch (e) {
      log.warn('Failed to send auth:reauth-result-for-portal (localhost) to renderer:', e);
    }
    return;
  }

  if (pendingPortalReauth) clearPortalReauthPending();

  // Portal-initiated sign-in (e.g. calendar linking): route token back to portal
  if ((desktopFlow === 'portal-signin' || pendingPortalSignin) && token && mainWindow && !mainWindow.isDestroyed()) {
    const requestCalendar = desktopFlow === 'portal-signin'
      ? !!googleTokens?.requestCalendar
      : pendingPortalSigninRequestCalendar;
    clearPortalSigninPending();
    try {
      mainWindow.webContents.send('auth:custom-token-for-portal', {
        customToken: token,
        requestCalendar,
      });
    } catch (e) {
      log.warn('Failed to send auth:custom-token-for-portal (localhost) to renderer:', e);
    }
    return;
  }

  if (pendingPortalSignin) clearPortalSigninPending();
  enqueueDeepLinkToken(token);
}

module.exports = {
  markPortalReauthPending,
  markPortalSigninPending,
  handleDonethatUrl,
  handleAuthServerToken,
};
