import { API_BASE_URL, BACKEND, FIREBASE_CONFIG } from './site-config.js';

const SESSION_KEY = 'madLeagueSessionToken';
const SEASON_KEY = 'madLeagueSeasonId';
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

export function getCurrentSeasonId() {
  const querySeasonId = new URLSearchParams(window.location.search).get('id');
  return querySeasonId || localStorage.getItem(SEASON_KEY) || 'main';
}

function seasonApiUrl(path) {
  return apiUrl(path) + (path.includes('?') ? '&' : '?') + 'id=' + encodeURIComponent(getCurrentSeasonId());
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
  const seasonId = getCurrentSeasonId();
  if (isFirebase()) return firebaseCall('updateLeague', { seasonId, updates });
  return request(seasonApiUrl('/api/league'), { method: 'PATCH', body: JSON.stringify({ updates }) });
}

export function appendValue(value) {
  return { __appendToLeague: true, value };
}

export async function fetchLeague() {
  const seasonId = getCurrentSeasonId();
  if (isFirebase()) {
    const client = await firebaseClient();
    const snapshot = await client.getDoc(client.doc(client.db, 'leagues', seasonId));
    if (!snapshot.exists()) throw new Error('The league has not been initialized.');
    return snapshot.data();
  }
  return (await request(seasonApiUrl('/api/league'))).league;
}

export function subscribeLeague(onChange, onError = () => {}) {
  const seasonId = getCurrentSeasonId();
  if (isFirebase()) {
    let active = true;
    let unsubscribe = () => {};
    firebaseClient().then(client => {
      if (!active) return;
      unsubscribe = client.onSnapshot(
        client.doc(client.db, 'leagues', seasonId),
        snapshot => {
          if (!snapshot.exists()) {
            onError(new Error('The league has not been initialized.'));
            return;
          }
          onChange(snapshot);
        },
        error => {
          onError(error);
          if (error.code === 'permission-denied') refreshSeasonAccess();
        }
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
        const response = await fetch(seasonApiUrl('/api/league/events'), {
          mode: 'cors',
          credentials: 'omit',
          headers: sessionHeaders(),
          cache: 'no-store',
          signal: controller.signal
        });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          const error = new Error(result.error || 'Could not connect to league updates.');
          error.status = response.status;
          throw error;
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
        if ([401, 403, 404].includes(error.status)) refreshSeasonAccess();
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

function refreshSeasonAccess() {
  getCurrentUser()
    .then(user => {
      if (!user) window.dispatchEvent(new Event('league-session-change'));
      else return syncSeasonSwitcher(user);
    })
    .catch(error => console.error('Could not refresh season access.', error));
}

export function onUserChange(callback) {
  let active = true;
  if (isFirebase()) {
    let unsubscribe = () => {};
    firebaseClient().then(client => {
      if (!active) return;
      unsubscribe = client.onAuthStateChanged(client.auth, user => {
        firebaseUser(user).then(account => {
          if (active) {
            callback(account);
            syncSeasonSwitcher(account).catch(error => console.error('Could not load available seasons.', error));
          }
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
    getCurrentUser().then(user => {
      if (active) {
        callback(user);
        syncSeasonSwitcher(user).catch(error => console.error('Could not load available seasons.', error));
      }
    })
      .catch(() => { if (active) callback(null); });
  };
  window.addEventListener('league-session-change', refresh);
  refresh();
  return () => {
    active = false;
    window.removeEventListener('league-session-change', refresh);
  };
}

async function syncSeasonSwitcher(user) {
  const container = document.getElementById('navSignedIn');
  if (!container) return;
  let selector = document.getElementById('navSeasonSelect');
  if (!user) {
    selector?.remove();
    return;
  }
  if (!selector) {
    selector = document.createElement('select');
    selector.id = 'navSeasonSelect';
    selector.setAttribute('aria-label', 'Select season');
    selector.style.cssText = 'max-width:150px;margin:0 8px;padding:6px 8px;background:#1b2228;color:inherit;border:1px solid #59636b;border-radius:4px;';
    const userEmail = document.getElementById('navUserEmail');
    container.insertBefore(selector, userEmail || container.firstChild);
    selector.addEventListener('change', () => {
      localStorage.setItem(SEASON_KEY, selector.value);
      const url = new URL(window.location.href);
      url.searchParams.set('id', selector.value);
      window.location.assign(url.href);
    });
  }
  const seasons = await fetchSeasons();
  if (!seasons.length) {
    selector.hidden = true;
    return;
  }
  const currentSeasonId = getCurrentSeasonId();
  const selection = seasons.some(season => season.id === currentSeasonId) ? currentSeasonId : seasons[0].id;
  selector.innerHTML = seasons.map(season =>
    '<option value="' + escapeAttribute(season.id) + '">' + escapeHtml(season.name) + '</option>'
  ).join('');
  selector.value = selection;
  selector.hidden = false;
  localStorage.setItem(SEASON_KEY, selection);
  if (selection !== currentSeasonId) {
    const url = new URL(window.location.href);
    url.searchParams.set('id', selection);
    window.location.replace(url.href);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

export async function createPlayer(name, pin) {
  const seasonId = getCurrentSeasonId();
  if (isFirebase()) return firebaseCall('createPlayer', { name, pin, seasonId });
  return request(seasonApiUrl('/api/players'), { method: 'POST', body: JSON.stringify({ name, pin }) });
}

export async function fetchPlayers() {
  if (isFirebase()) return (await firebaseCall('fetchPlayers')).players;
  return (await request('/api/players')).players;
}

export async function updatePlayer(id, updates) {
  if (isFirebase()) return firebaseCall('updatePlayer', { id, updates });
  return request('/api/players/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(updates) });
}

export async function fetchSeasons() {
  if (isFirebase()) return (await firebaseCall('listSeasons')).seasons;
  return (await request('/api/seasons')).seasons;
}

export async function createSeason(name) {
  if (isFirebase()) return firebaseCall('createSeason', { name });
  return request('/api/seasons', { method: 'POST', body: JSON.stringify({ name }) });
}

export async function setSeasonMember(seasonId, playerId, included) {
  if (isFirebase()) return firebaseCall('setSeasonMember', { seasonId, playerId, included });
  return request('/api/seasons/' + encodeURIComponent(seasonId) + '/members/' + encodeURIComponent(playerId), {
    method: 'PATCH',
    body: JSON.stringify({ included })
  });
}