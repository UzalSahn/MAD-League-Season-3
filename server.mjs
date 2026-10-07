import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '..', 'mad-league-data'));
const storePath = path.join(dataDir, 'league.sqlite');
const port = Number(process.env.PORT || 3000);
const sessions = new Map();
const loginAttempts = new Map();
const listeners = new Map();
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean));
let store;
let database;

function normalizedName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function nameKey(name) {
  return normalizedName(name).toLocaleLowerCase('en-US');
}

function hashPin(pin, salt) {
  return scryptSync(String(pin), salt, 64).toString('hex');
}

function createAccount(name, pin, role = 'player') {
  const salt = randomBytes(16).toString('hex');
  return {
    id: randomUUID(),
    name: normalizedName(name),
    nameKey: nameKey(name),
    pinSalt: salt,
    pinHash: hashPin(pin, salt),
    role,
    enabled: true
  };
}

function publicAccount(account) {
  return { uid: account.id, displayName: account.name, role: account.role };
}

function createEmptyLeague(commissioner, id = 'main') {
  return {
    id,
    name: process.env.LEAGUE_NAME || 'MAD League',
    commissionerUid: commissioner.id,
    members: {
      [commissioner.id]: { displayName: commissioner.name, joinedAt: Date.now() }
    },
    settings: { maxTeams: 12, draftBudget: 100, rosterSize: 10 },
    announcements: [],
    trades: [],
    pendingMoves: [],
    waivers: [],
    transactionLog: []
  };
}

async function initializeStore() {
  await mkdir(dataDir, { recursive: true });
  database = new Database(storePath);
  database.pragma('journal_mode = WAL');
  database.exec('CREATE TABLE IF NOT EXISTS league_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)');
  const existing = database.prepare('SELECT payload FROM league_state WHERE id = 1').get();
  if (existing) {
    store = JSON.parse(existing.payload);
    if (!store || !Array.isArray(store.accounts) || (!store.league && !store.leagues?.main)) throw new Error('Invalid league store.');
    if (!store.leagues) store.leagues = { main: store.league };
    if (!store.seasons) store.seasons = {
      main: { id: 'main', name: 'Season 1', createdAt: Date.now(), memberIds: Object.keys(store.leagues.main.members || {}) }
    };
    delete store.league;
    return;
  }

  const commissionerName = normalizedName(process.env.COMMISSIONER_NAME);
  const commissionerPin = String(process.env.COMMISSIONER_PIN || '');
  if (!commissionerName || !/^\d{4,12}$/.test(commissionerPin)) {
    throw new Error('First run requires COMMISSIONER_NAME and a 4-12 digit COMMISSIONER_PIN.');
  }
  const commissioner = createAccount(commissionerName, commissionerPin, 'commissioner');
  const league = createEmptyLeague(commissioner);
  store = {
    accounts: [commissioner],
    leagues: { main: league },
    seasons: {
      main: { id: 'main', name: 'Season 1', createdAt: Date.now(), memberIds: Object.keys(league.members) }
    },
    champions: [],
    revision: 1
  };
  await persistStore();
}

function persistStore() {
  database.prepare(`
    INSERT INTO league_state (id, payload) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
  `).run(JSON.stringify(store));
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map(part => {
    const separator = part.indexOf('=');
    return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function getAccount(request) {
  const authorization = request.headers.authorization || '';
  const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearerToken || parseCookies(request).league_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  const account = store.accounts.find(item => item.id === session.accountId && item.enabled);
  return account || null;
}

function send(response, status, data, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(data === undefined ? '' : JSON.stringify(data));
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  const protocol = (request.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const sameOrigin = `${protocol}://${request.headers.host}`;
  if (origin !== sameOrigin && !allowedOrigins.has(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

function sendLeagueEvent(response, seasonId) {
  response.write(`event: league\ndata: ${JSON.stringify({ revision: store.revision, league: store.leagues[seasonId] })}\n\n`);
}

function broadcastLeague(seasonId) {
  const seasonListeners = listeners.get(seasonId);
  if (!seasonListeners) return;
  for (const listener of seasonListeners) {
    const account = store.accounts.find(item => item.id === listener.accountId && item.enabled);
    if (!account || (account.role !== 'commissioner' && !store.leagues[seasonId].members?.[account.id])) {
      listener.response.end();
      seasonListeners.delete(listener);
    } else {
      sendLeagueEvent(listener.response, seasonId);
    }
  }
}

function getSeasonLeague(seasonId, account) {
  const league = store.leagues[seasonId];
  if (!league) throw Object.assign(new Error('Season not found.'), { status: 404 });
  if (account.role !== 'commissioner' && !league.members?.[account.id]) {
    throw Object.assign(new Error('You are not a member of this season.'), { status: 403 });
  }
  return league;
}

function setPath(target, field, value) {
  const parts = field.split('.');
  if (!parts.length || parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw Object.assign(new Error('Invalid update path.'), { status: 400 });
  }
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function stampCompletedScheduleWeeks(league, updates) {
  const updatedWeeks = new Set();
  for (const [field, value] of Object.entries(updates)) {
    const match = field.match(/^schedule\.results\.(\d+)_(\d+)$/);
    if (match && value && value.locked) updatedWeeks.add(Number(match[1]));
  }
  for (const weekIndex of updatedWeeks) {
    const week = league.schedule?.weeks?.[weekIndex];
    if (!week || week.endDate || !Array.isArray(week.matches)) continue;
    const complete = week.matches.every((match, matchIndex) => {
      if (match.a === 'BYE' || match.b === 'BYE') return true;
      const result = league.schedule.results?.[weekIndex + '_' + matchIndex];
      return !!(result && result.locked);
    });
    if (complete) week.endDate = Date.now();
  }
}

function scheduleRetractionError(league, updates) {
  const currentSchedule = league.schedule;
  const nextSchedule = updates.schedule;
  if (!currentSchedule || currentSchedule.progression !== 'commissioner' || !nextSchedule || typeof nextSchedule !== 'object') return null;
  const currentWeeks = currentSchedule.weeks;
  const nextWeeks = nextSchedule.weeks;
  if (!Array.isArray(currentWeeks) || !Array.isArray(nextWeeks) || nextWeeks.length >= currentWeeks.length) return null;
  if (currentWeeks.length - nextWeeks.length !== 1 || nextSchedule.progression !== 'commissioner'
      || nextSchedule.totalWeeks !== currentSchedule.totalWeeks) {
    return 'Only the latest announced week can be undone.';
  }
  const removedWeekIndex = currentWeeks.length - 1;
  if (Object.keys(currentSchedule.results || {}).some(key => key.startsWith(removedWeekIndex + '_'))) {
    return 'A week with result data cannot be undone.';
  }
  return null;
}

function validPoolPointOverrides(overrides) {
  return overrides && typeof overrides === 'object' && !Array.isArray(overrides)
    && Object.keys(overrides).length <= 2000
    && Object.entries(overrides).every(([id, points]) => /^\d+$/.test(id) && Number.isInteger(points) && points >= 1 && points <= 100);
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

async function serveStatic(request, response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const filePath = path.resolve(root, '.' + requestedPath);
  if (!filePath.startsWith(root + path.sep)) return send(response, 403, { error: 'Forbidden.' });
  const relativeToData = path.relative(dataDir, filePath);
  if (relativeToData === '' || (!relativeToData.startsWith('..') && !path.isAbsolute(relativeToData))) {
    return send(response, 403, { error: 'Forbidden.' });
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { 'content-type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    send(response, 404, { error: 'Not found.' });
  }
}

const server = createServer(async (request, response) => {
  try {
    const cors = corsHeaders(request);
    if (cors === null) return send(response, 403, { error: 'This website origin is not allowed.' });
    Object.entries(cors).forEach(([name, value]) => response.setHeader(name, value));
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      return response.end();
    }

    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const account = getAccount(request);

    if (url.pathname === '/api/pool-prices' && request.method === 'GET') {
      const seasonId = url.searchParams.get('id') || 'main';
      const league = store.leagues[seasonId];
      if (!league) return send(response, 404, { error: 'Season not found.' });
      return send(response, 200, { overrides: league.poolPointOverrides || {} });
    }
    if (url.pathname === '/api/champions' && request.method === 'GET') {
      return send(response, 200, { champions: store.champions || [] });
    }
    if (url.pathname === '/api/session' && request.method === 'GET') {
      return send(response, 200, { user: account ? publicAccount(account) : null });
    }
    if (url.pathname === '/api/session' && request.method === 'POST') {
      const body = await readBody(request);
      const name = normalizedName(body.name);
      const key = `${request.socket.remoteAddress || 'unknown'}:${nameKey(name)}`;
      const attempt = loginAttempts.get(key) || { count: 0, until: 0 };
      if (attempt.until > Date.now()) return send(response, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const candidate = store.accounts.find(item => item.nameKey === nameKey(name) && item.enabled);
      const pin = String(body.pin || '');
      const valid = candidate && /^\d{4,12}$/.test(pin) && timingSafeEqual(Buffer.from(hashPin(pin, candidate.pinSalt), 'hex'), Buffer.from(candidate.pinHash, 'hex'));
      if (!valid) {
        attempt.count++;
        if (attempt.count >= 6) { attempt.count = 0; attempt.until = Date.now() + 10 * 60 * 1000; }
        loginAttempts.set(key, attempt);
        return send(response, 401, { error: 'Name or PIN is incorrect.' });
      }
      loginAttempts.delete(key);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { accountId: candidate.id, expiresAt: Date.now() + SESSION_MS });
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      return send(response, 200, { user: publicAccount(candidate), token }, {
        'set-cookie': `league_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`
      });
    }
    if (url.pathname === '/api/session' && request.method === 'DELETE') {
      const authorization = request.headers.authorization || '';
      const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || parseCookies(request).league_session;
      if (token) sessions.delete(token);
      return send(response, 200, { user: null }, { 'set-cookie': 'league_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(request, response, url.pathname);
    if (!account) return send(response, 401, { error: 'Sign in to continue.' });

    if (url.pathname === '/api/champions' && request.method === 'POST') {
      if (account.role !== 'commissioner') return send(response, 403, { error: 'Commissioner access required.' });
      const body = await readBody(request);
      const input = body.champion;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return send(response, 400, { error: 'Champion details are required.' });
      }
      if (typeof input.season !== 'string' || typeof input.winner !== 'string'
          || (input.coach !== undefined && typeof input.coach !== 'string')
          || (input.mvp !== undefined && typeof input.mvp !== 'string')
          || (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim()))) {
        return send(response, 400, { error: 'Season, winner, coach, or record ID is invalid.' });
      }
      const season = normalizedName(input.season);
      const winner = normalizedName(input.winner);
      const coach = normalizedName(input.coach);
      const mvp = normalizedName(input.mvp);
      const roster = input.roster;
      if (season.length < 2 || season.length > 80 || winner.length < 2 || winner.length > 80
          || coach.length > 80 || !Array.isArray(roster) || roster.length > 15
          || roster.some(name => typeof name !== 'string' || normalizedName(name).length < 1 || normalizedName(name).length > 50)
          || mvp.length > 50 || (mvp && !roster.some(name => typeof name === 'string' && normalizedName(name).toLocaleLowerCase('en-US') === mvp.toLocaleLowerCase('en-US')))) {
        return send(response, 400, { error: 'Season, winner, coach, or roster details are invalid.' });
      }
      const id = typeof input.id === 'string' ? input.id : '';
      const existing = id && (store.champions || []).find(champion => champion.id === id);
      if (id && !existing) return send(response, 404, { error: 'Champion record not found.' });
      const champion = {
        id: existing ? id : randomUUID(),
        season,
        winner,
        coach,
        mvp,
        roster: roster.map(normalizedName),
        updatedAt: Date.now(),
        createdAt: existing ? existing.createdAt : Date.now()
      };
      store.champions ||= [];
      if (existing) store.champions = store.champions.map(item => item.id === id ? champion : item);
      else store.champions.push(champion);
      store.revision++;
      await persistStore();
      return send(response, existing ? 200 : 201, { champion });
    }
    const championRoute = url.pathname.match(/^\/api\/champions\/([^/]+)$/);
    if (championRoute && request.method === 'DELETE') {
      if (account.role !== 'commissioner') return send(response, 403, { error: 'Commissioner access required.' });
      const id = decodeURIComponent(championRoute[1]);
      const champions = store.champions || [];
      if (!champions.some(champion => champion.id === id)) return send(response, 404, { error: 'Champion record not found.' });
      store.champions = champions.filter(champion => champion.id !== id);
      store.revision++;
      await persistStore();
      return send(response, 200, { ok: true });
    }

    if (url.pathname === '/api/seasons' && request.method === 'GET') {
      const seasons = Object.values(store.seasons)
        .filter(season => account.role === 'commissioner' || season.memberIds.includes(account.id))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(({ id, name, createdAt, memberIds }) => ({ id, name, createdAt, memberCount: memberIds.length }));
      return send(response, 200, { seasons });
    }
    if (url.pathname === '/api/seasons' && request.method === 'POST') {
      if (account.role !== 'commissioner') return send(response, 403, { error: 'Commissioner access required.' });
      const body = await readBody(request);
      const name = normalizedName(body.name).slice(0, 60);
      if (name.length < 2) return send(response, 400, { error: 'Season name must be 2-60 characters.' });
      const id = randomUUID();
      const league = createEmptyLeague(account, id);
      store.leagues[id] = league;
      store.seasons[id] = { id, name, createdAt: Date.now(), memberIds: Object.keys(league.members) };
      store.revision++;
      await persistStore();
      return send(response, 201, { season: { id, name } });
    }
    const seasonRoute = url.pathname.match(/^\/api\/seasons\/([^/]+)$/);
    if (seasonRoute && request.method === 'DELETE') {
      if (account.role !== 'commissioner') return send(response, 403, { error: 'Commissioner access required.' });
      const seasonId = decodeURIComponent(seasonRoute[1]);
      if (!store.seasons[seasonId] || !store.leagues[seasonId]) return send(response, 404, { error: 'Season not found.' });
      if (Object.keys(store.seasons).length <= 1) return send(response, 409, { error: 'The last season cannot be deleted.' });
      for (const listener of listeners.get(seasonId) || []) listener.response.end();
      listeners.delete(seasonId);
      delete store.seasons[seasonId];
      delete store.leagues[seasonId];
      store.revision++;
      await persistStore();
      return send(response, 200, { ok: true });
    }
    const seasonMemberRoute = url.pathname.match(/^\/api\/seasons\/([^/]+)\/members\/([^/]+)$/);
    if (seasonMemberRoute && request.method === 'PATCH') {
      if (account.role !== 'commissioner') return send(response, 403, { error: 'Commissioner access required.' });
      const seasonId = decodeURIComponent(seasonMemberRoute[1]);
      const playerId = decodeURIComponent(seasonMemberRoute[2]);
      const season = store.seasons[seasonId];
      const league = store.leagues[seasonId];
      const player = store.accounts.find(item => item.id === playerId && item.role !== 'commissioner');
      if (!season || !league) return send(response, 404, { error: 'Season not found.' });
      if (!player) return send(response, 404, { error: 'Player not found.' });
      const body = await readBody(request);
      if (typeof body.included !== 'boolean') return send(response, 400, { error: 'Season membership must be true or false.' });
      const { included } = body;
      if (Boolean(league.members?.[player.id]) !== included) {
        if (league.draft) return send(response, 409, { error: 'Season membership cannot be changed after the draft starts.' });
        if (included) {
          const maxTeams = Number(league.settings && league.settings.maxTeams) || Infinity;
          if (Object.keys(league.members || {}).length >= maxTeams) return send(response, 409, { error: 'Maximum team accounts reached.' });
          league.members ||= {};
          league.members[player.id] = { displayName: player.name, joinedAt: Date.now() };
        } else {
          delete league.members[player.id];
        }
        season.memberIds = Object.keys(league.members || {});
        store.revision++;
        await persistStore();
        broadcastLeague(seasonId);
      }
      return send(response, 200, { ok: true });
    }

    if (url.pathname === '/api/league' && request.method === 'GET') {
      const seasonId = url.searchParams.get('id') || 'main';
      const league = getSeasonLeague(seasonId, account);
      return send(response, 200, { league, revision: store.revision });
    }
    if (url.pathname === '/api/league/events' && request.method === 'GET') {
      const seasonId = url.searchParams.get('id') || 'main';
      getSeasonLeague(seasonId, account);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(': connected\n\n');
      if (!listeners.has(seasonId)) listeners.set(seasonId, new Set());
      const listener = { response, accountId: account.id };
      listeners.get(seasonId).add(listener);
      sendLeagueEvent(response, seasonId);
      const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 25000);
      response.on('close', () => {
        clearInterval(heartbeat);
        listeners.get(seasonId)?.delete(listener);
      });
      return;
    }
    if (url.pathname === '/api/league' && request.method === 'PATCH') {
      const body = await readBody(request);
      const updates = body.updates;
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return send(response, 400, { error: 'Updates must be an object.' });
      const seasonId = url.searchParams.get('id') || 'main';
      const league = getSeasonLeague(seasonId, account);
      if (account.role === 'commissioner') {
        const retractionError = scheduleRetractionError(league, updates);
        if (retractionError) return send(response, 409, { error: retractionError });
      }
      for (const [field, value] of Object.entries(updates)) {
        if (account.role !== 'commissioner' && field.split('.')[0] === 'schedule'
            && !/^schedule\.results\.\d+_\d+$/.test(field)) {
          return send(response, 403, { error: 'Commissioner access required to change the match schedule.' });
        }
        if (field.split('.')[0] === 'poolPointOverrides'
            && (account.role !== 'commissioner' || field !== 'poolPointOverrides' || !validPoolPointOverrides(value))) {
          return send(response, account.role !== 'commissioner' ? 403 : 400, {
            error: account.role !== 'commissioner' ? 'Commissioner access required for this change.' : 'Pool point overrides are invalid.'
          });
        }
      }
      for (const [field, value] of Object.entries(updates)) {
        const topLevel = field.split('.')[0];
        if (account.role !== 'commissioner' && ['settings', 'logo', 'commissionerUid', 'seasonComplete', 'championUid'].includes(topLevel)) {
          return send(response, 403, { error: 'Commissioner access required for this change.' });
        }
        if (account.role !== 'commissioner' && topLevel === 'members' && field.split('.')[1] !== account.id) {
          return send(response, 403, { error: 'You can only edit your own player profile.' });
        }
        if (value && typeof value === 'object' && value.__appendToLeague === true) {
          const current = field.split('.').reduce((target, part) => target && target[part], league);
          setPath(league, field, (Array.isArray(current) ? current : []).concat([value.value]));
        } else {
          setPath(league, field, value);
        }
      }
      stampCompletedScheduleWeeks(league, updates);
      store.revision++;
      await persistStore();
      broadcastLeague(seasonId);
      return send(response, 200, { revision: store.revision });
    }
    if (url.pathname === '/api/players' && request.method === 'GET') {
      if (account.role !== 'commissioner') return send(response, 403, { error: 'Commissioner access required.' });
      return send(response, 200, { players: store.accounts.map(item => ({ ...publicAccount(item), enabled: item.enabled })) });
    }
    if (url.pathname === '/api/players' && request.method === 'POST') {
      if (account.role !== 'commissioner') return send(response, 403, { error: 'Commissioner access required.' });
      const body = await readBody(request);
      const name = normalizedName(body.name);
      const pin = String(body.pin || '');
      if (name.length < 2 || name.length > 40) return send(response, 400, { error: 'Name must be 2-40 characters.' });
      if (!/^\d{4,12}$/.test(pin)) return send(response, 400, { error: 'PIN must contain 4-12 digits.' });
      if (store.accounts.some(item => item.nameKey === nameKey(name))) return send(response, 409, { error: 'That name already has an account.' });
      const seasonId = url.searchParams.get('id') || 'main';
      const league = getSeasonLeague(seasonId, account);
      const maxTeams = Number(league.settings && league.settings.maxTeams) || Infinity;
      if (Object.keys(league.members || {}).length >= maxTeams) return send(response, 409, { error: 'Maximum team accounts reached.' });
      const player = createAccount(name, pin);
      store.accounts.push(player);
      league.members[player.id] = { displayName: player.name, joinedAt: Date.now() };
      store.seasons[seasonId].memberIds = Object.keys(league.members || {});
      store.revision++;
      await persistStore();
      broadcastLeague(seasonId);
      return send(response, 201, { player: { ...publicAccount(player), enabled: true } });
    }
    if (url.pathname.startsWith('/api/players/') && request.method === 'PATCH') {
      if (account.role !== 'commissioner') return send(response, 403, { error: 'Commissioner access required.' });
      const playerId = decodeURIComponent(url.pathname.slice('/api/players/'.length));
      const body = await readBody(request);
      const player = store.accounts.find(item => item.id === playerId && item.role !== 'commissioner');
      if (!player) return send(response, 404, { error: 'Player not found.' });
      if (body.enabled !== undefined) player.enabled = Boolean(body.enabled);
      if (body.pin !== undefined) {
        if (!/^\d{4,12}$/.test(String(body.pin))) return send(response, 400, { error: 'PIN must contain 4-12 digits.' });
        player.pinSalt = randomBytes(16).toString('hex');
        player.pinHash = hashPin(body.pin, player.pinSalt);
      }
      store.revision++;
      await persistStore();
      Object.keys(store.leagues).forEach(broadcastLeague);
      return send(response, 200, { player: { ...publicAccount(player), enabled: player.enabled } });
    }
    return send(response, 404, { error: 'Not found.' });
  } catch (error) {
    if (!response.headersSent) send(response, error.status || 500, { error: error.status ? error.message : 'Server error.' });
    else response.end();
  }
});

initializeStore().then(() => {
  server.listen(port, '0.0.0.0', () => console.log(`MAD League server listening on port ${server.address().port}`));
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});