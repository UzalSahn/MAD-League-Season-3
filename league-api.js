import { API_BASE_URL } from './site-config.js';

const SESSION_KEY = 'madLeagueSessionToken';
const API_ROOT = API_BASE_URL.replace(/\/+$/, '');

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
  if (!sessionStorage.getItem(SESSION_KEY)) return null;
  return (await request('/api/session')).user;
}

export async function signIn(name, pin) {
  const result = await request('/api/session', { method: 'POST', body: JSON.stringify({ name, pin }) });
  sessionStorage.setItem(SESSION_KEY, result.token);
  window.dispatchEvent(new Event('league-session-change'));
  return result.user;
}

export async function signOut() {
  try { await request('/api/session', { method: 'DELETE' }); }
  finally { sessionStorage.removeItem(SESSION_KEY); }
  window.dispatchEvent(new Event('league-session-change'));
}

export async function updateLeague(updates) {
  return request('/api/league', { method: 'PATCH', body: JSON.stringify({ updates }) });
}

export function appendValue(value) {
  return { __appendToLeague: true, value };
}

export async function fetchLeague() {
  return (await request('/api/league')).league;
}

export function subscribeLeague(onChange, onError = () => {}) {
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
  return request('/api/players', { method: 'POST', body: JSON.stringify({ name, pin }) });
}

export async function fetchPlayers() {
  return (await request('/api/players')).players;
}

export async function updatePlayer(id, updates) {
  return request('/api/players/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(updates) });
}