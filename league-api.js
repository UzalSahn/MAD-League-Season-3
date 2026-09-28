async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}

export async function getCurrentUser() {
  return (await request('/api/session')).user;
}

export async function signIn(name, pin) {
  const user = (await request('/api/session', { method: 'POST', body: JSON.stringify({ name, pin }) })).user;
  window.dispatchEvent(new Event('league-session-change'));
  return user;
}

export async function signOut() {
  await request('/api/session', { method: 'DELETE' });
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
  const events = new EventSource('/api/league/events');
  events.addEventListener('league', event => {
    try {
      onChange({ exists: () => true, data: () => JSON.parse(event.data).league });
    }
    catch (error) { onError(error); }
  });
  events.onerror = onError;
  return () => events.close();
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