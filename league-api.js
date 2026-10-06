import { API_BASE_URL, BACKEND, FIREBASE_CONFIG } from './site-config.js';

const SESSION_KEY = 'madLeagueSessionToken';
const API_ROOT = API_BASE_URL.replace(/\/+$/, '');
const FIREBASE_VERSION = '10.12.2';
let firebaseClientPromise;

async function firebaseClient() {
  if (!firebaseClientPromise) {
    firebaseClientPromise = Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-functions.js`)
    ]).then(([appSdk, authSdk, firestoreSdk, functionsSdk]) => {
      const app = appSdk.initializeApp(FIREBASE_CONFIG);
      return {
        auth: authSdk.getAuth(app),
        signInWithCustomToken: authSdk.signInWithCustomToken,
        signOut: authSdk.signOut,
        onAuthStateChanged: authSdk.onAuthStateChanged,
        getIdTokenResult: authSdk.getIdTokenResult,
        db: firestoreSdk.getFirestore(app),
        doc: firestoreSdk.doc,
        getDoc: firestoreSdk.getDoc,
        onSnapshot: firestoreSdk.onSnapshot,
        functions: functionsSdk.getFunctions(app),
        httpsCallable: functionsSdk.httpsCallable
      };
    });
  }
  return firebaseClientPromise;
}

function isFirebase() {
  return BACKEND === 'firebase';
}

function firebaseError(error) {
  if (error && error.message) return new Error(error.message);
  return new Error('Firebase request failed.');
}

async function firebaseCall(name, data = {}) {
  const client = await firebaseClient();
  try {
    return (await client.httpsCallable(client.functions, name)(data)).data;
  } catch (error) {
    throw firebaseError(error);
  }
}

async function firebaseUser(user) {
  if (!user) return null;
  const token = await user.getIdTokenResult();
  const claims = token.claims;
  return {
    uid: user.uid,
    displayName: claims.displayName || user.displayName || '',
    role: claims.role || 'player'
  };
}

function apiUrl(path) {
  return API_ROOT + path;
}

function sessionHeaders() {
  const token = sessionStorage.getItem(SESSION_KEY);
  return token ? { authorization: 'Bearer ' + token } : {};
}

async function request(path, options = {}) {
  const headers = { ...sessionHeaders(), ...(options.headers || {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(apiUrl(path), {
    ...options,
    mode: 'cors',
    credentials: 'omit',
    headers
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}

export async function getCurrentUser() {
  if (isFirebase()) {
    const client = await firebaseClient();
    return firebaseUser(client.auth.currentUser);
  }
  if (!sessionStorage.getItem(SESSION_KEY)) return null;
  return (await request('/api/session')).user;
}

export async function signIn(name, pin) {
  if (isFirebase()) {
    const client = await firebaseClient();
    const result = await firebaseCall('signInWithPin', { name, pin });
    try {
      const credential = await client.signInWithCustomToken(client.auth, result.token);
      window.dispatchEvent(new Event('league-session-change'));
      return firebaseUser(credential.user);
    } catch (error) {
      throw firebaseError(error);
    }
  }
  const result = await request('/api/session', { method: 'POST', body: JSON.stringify({ name, pin }) });
  sessionStorage.setItem(SESSION_KEY, result.token);
  window.dispatchEvent(new Event('league-session-change'));
  return result.user;
}

export async function signOut() {
  if (isFirebase()) {
    const client = await firebaseClient();
    await client.signOut(client.auth);
    window.dispatchEvent(new Event('league-session-change'));
    return;
  }
  try { await request('/api/session', { method: 'DELETE' }); }
  finally { sessionStorage.removeItem(SESSION_KEY); }
  window.dispatchEvent(new Event('league-session-change'));
}

export async function updateLeague(updates) {
  if (isFirebase()) return firebaseCall('updateLeague', { updates });
  return request('/api/league', { method: 'PATCH', body: JSON.stringify({ updates }) });
}

export function appendValue(value) {
  return { __appendToLeague: true, value };
}

export async function fetchLeague() {
  if (isFirebase()) {
    const client = await firebaseClient();
    const snapshot = await client.getDoc(client.doc(client.db, 'leagues', 'main'));
    if (!snapshot.exists()) throw new Error('The league has not been initialized.');
    return snapshot.data();
  }
  return (await request('/api/league')).league;
}

export function subscribeLeague(onChange, onError = () => {}) {
  if (isFirebase()) {
    let active = true;
    let unsubscribe = () => {};
    firebaseClient().then(client => {
      if (!active) return;
      unsubscribe = client.onSnapshot(
        client.doc(client.db, 'leagues', 'main'),
        snapshot => {
          if (!snapshot.exists()) {
            onError(new Error('The league has not been initialized.'));
            return;
          }
          onChange(snapshot);
        },
        onError
      );
    }).catch(onError);
    return () => {
      active = false;
      unsubscribe();
    };
  }
  const controller = new AbortController();
  let active = true;
  let retryDelay = 1000;

  async function connect() {
    while (active) {
      try {
        const response = await fetch(apiUrl('/api/league/events'), {
          mode: 'cors',
          credentials: 'omit',
          headers: sessionHeaders(),
          cache: 'no-store',
          signal: controller.signal
        });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || 'Could not connect to league updates.');
        }
        if (!response.body) throw new Error('Live updates are not supported by this browser.');

        retryDelay = 1000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (active) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || '';
          for (const message of events) {
            const lines = message.split(/\r?\n/);
            if (!lines.some(line => line === 'event: league')) continue;
            const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            try {
              onChange({ exists: () => true, data: () => JSON.parse(data).league });
            } catch (error) { onError(error); }
          }
        }
      } catch (error) {
        if (!active || error.name === 'AbortError') return;
        onError(error);
      }
      if (active) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 10000);
      }
    }
  }

  connect();
  return () => {
    active = false;
    controller.abort();
  };
}

export function onUserChange(callback) {
  let active = true;
  if (isFirebase()) {
    let unsubscribe = () => {};
    firebaseClient().then(client => {
      if (!active) return;
      unsubscribe = client.onAuthStateChanged(client.auth, user => {
        firebaseUser(user).then(account => {
          if (active) callback(account);
        }).catch(error => {
          if (active) {
            console.error('Could not read Firebase sign-in details.', error);
            callback(null);
          }
        });
      }, error => {
        if (active) {
          console.error('Firebase authentication state could not be read.', error);
          callback(null);
        }
      });
    }).catch(error => {
      console.error('Firebase could not be initialized.', error);
      if (active) callback(null);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }
  const refresh = () => {
    getCurrentUser().then(user => { if (active) callback(user); })
      .catch(() => { if (active) callback(null); });
  };
  window.addEventListener('league-session-change', refresh);
  refresh();
  return () => {
    active = false;
    window.removeEventListener('league-session-change', refresh);
  };
}

export async function createPlayer(name, pin) {
  if (isFirebase()) return firebaseCall('createPlayer', { name, pin });
  return request('/api/players', { method: 'POST', body: JSON.stringify({ name, pin }) });
}

export async function fetchPlayers() {
  if (isFirebase()) return (await firebaseCall('fetchPlayers')).players;
  return (await request('/api/players')).players;
}

export async function updatePlayer(id, updates) {
  if (isFirebase()) return firebaseCall('updatePlayer', { id, updates });
  return request('/api/players/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(updates) });
}