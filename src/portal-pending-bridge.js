function shouldSendGenericPortalToken(pendingPortalBridge) {
  if (!pendingPortalBridge) return true;
  return !pendingPortalBridge.logout && !pendingPortalBridge.customToken;
}

function drainPendingPortalBridge(pendingPortalBridge) {
  const actions = [];
  let suppressGenericTokenSync = false;

  if (!pendingPortalBridge) {
    return { actions, suppressGenericTokenSync };
  }

  if (pendingPortalBridge.logout) {
    actions.push({ type: 'logout' });
    pendingPortalBridge.logout = false;
  }

  if (pendingPortalBridge.customToken) {
    actions.push({ type: 'customToken', payload: pendingPortalBridge.customToken });
    pendingPortalBridge.customToken = null;
    suppressGenericTokenSync = true;
  }

  if (pendingPortalBridge.reauthResult) {
    actions.push({ type: 'reauthResult', payload: pendingPortalBridge.reauthResult });
    pendingPortalBridge.reauthResult = null;
  }

  return { actions, suppressGenericTokenSync };
}

module.exports = {
  drainPendingPortalBridge,
  shouldSendGenericPortalToken
};
