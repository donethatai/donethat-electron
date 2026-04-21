const {
  drainPendingPortalBridge,
  shouldSendGenericPortalToken
} = require('../../src/portal-pending-bridge');

describe('portal pending bridge helpers', () => {
  test('queued custom token flushes on next ready portal and suppresses generic token sync', () => {
    const pendingPortalBridge = {
      customToken: { customToken: 'abc', requestCalendar: true },
      reauthResult: null,
      logout: false,
      reloadAfterLoad: false
    };

    expect(shouldSendGenericPortalToken(pendingPortalBridge)).toBe(false);

    const result = drainPendingPortalBridge(pendingPortalBridge);
    expect(result.actions).toEqual([
      { type: 'customToken', payload: { customToken: 'abc', requestCalendar: true } }
    ]);
    expect(result.suppressGenericTokenSync).toBe(true);
    expect(shouldSendGenericPortalToken(pendingPortalBridge)).toBe(true);
  });

  test('queued reauth payload flushes on next ready portal', () => {
    const pendingPortalBridge = {
      customToken: null,
      reauthResult: { idToken: 'id-token', accessToken: 'access-token' },
      logout: false,
      reloadAfterLoad: false
    };

    const result = drainPendingPortalBridge(pendingPortalBridge);
    expect(result.actions).toEqual([
      { type: 'reauthResult', payload: { idToken: 'id-token', accessToken: 'access-token' } }
    ]);
    expect(result.suppressGenericTokenSync).toBe(false);
  });

  test('logout flushes first after queued auth payloads have been cleared', () => {
    const pendingPortalBridge = {
      customToken: null,
      reauthResult: null,
      logout: true,
      reloadAfterLoad: false
    };

    const result = drainPendingPortalBridge(pendingPortalBridge);
    expect(result.actions).toEqual([{ type: 'logout' }]);
    expect(result.suppressGenericTokenSync).toBe(false);
  });

  test('generic token sync is blocked while logout is pending', () => {
    const pendingPortalBridge = {
      customToken: null,
      reauthResult: null,
      logout: true,
      reloadAfterLoad: false
    };

    expect(shouldSendGenericPortalToken(pendingPortalBridge)).toBe(false);
  });

  test('deferred reload flag is stored locally without affecting queued auth actions', () => {
    const pendingPortalBridge = {
      customToken: null,
      reauthResult: null,
      logout: false,
      reloadAfterLoad: true
    };

    const result = drainPendingPortalBridge(pendingPortalBridge);
    expect(result.actions).toEqual([]);
    expect(result.suppressGenericTokenSync).toBe(false);
    expect(pendingPortalBridge.reloadAfterLoad).toBe(true);
  });
});
