const { initializeApp, getApps } = require('firebase/app');
const { getFunctions, httpsCallable } = require('firebase/functions');
const firebaseConfig = require('../firebase-config.js');

let firebaseApp = null;
let functionsClient = null;
const FUNCTIONS_REGION = 'europe-west1';

function getFirebaseFunctionsClient() {
  if (!firebaseApp) {
    // Reuse existing default app if already initialized elsewhere in this process
    const existing = getApps && typeof getApps === 'function' ? getApps() : [];
    if (existing && existing.length > 0) {
      firebaseApp = existing[0];
    } else {
      firebaseApp = initializeApp(firebaseConfig);
    }
  }

  if (!functionsClient) {
    functionsClient = getFunctions(firebaseApp, FUNCTIONS_REGION);
  }

  return functionsClient;
}

async function callHttpsCallableWithAuth(functionName, params, idToken) {
  const endpoint = `https://${FUNCTIONS_REGION}-${firebaseConfig.projectId}.cloudfunctions.net/${functionName}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({ data: params }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) {
    const message = payload?.error?.message || `Callable ${functionName} failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload?.result ?? payload?.data ?? payload ?? null;
}

async function getGoogleSignInUrl({ port, redirectUrl, requestCalendar, idToken }) {
  if (requestCalendar && idToken) {
    const params = { requestCalendar: true };
    if (redirectUrl) params.redirectUrl = redirectUrl;
    else params.port = port;
    return callHttpsCallableWithAuth('authGoogleSignInStart', params, idToken);
  }

  const functions = getFirebaseFunctionsClient();
  const googleSignInStart = httpsCallable(functions, 'authGoogleSignInStart');
  const params = redirectUrl ? { redirectUrl } : { port };
  if (requestCalendar) params.requestCalendar = true;
  const result = await googleSignInStart(params);
  return result && result.data ? result.data : null;
}

async function getGoogleReauthUrl({ port, redirectUrl, idToken, requestCalendar }) {
  const params = { reauth: true };
  if (redirectUrl) params.redirectUrl = redirectUrl;
  else params.port = port;
  if (requestCalendar) params.requestCalendar = true;
  if (idToken) params.idToken = idToken;
  const functions = getFirebaseFunctionsClient();
  const googleSignInStart = httpsCallable(functions, 'authGoogleSignInStart');
  const result = await googleSignInStart(params);
  return result && result.data ? result.data : null;
}

module.exports = {
  getGoogleSignInUrl,
  getGoogleReauthUrl
};
