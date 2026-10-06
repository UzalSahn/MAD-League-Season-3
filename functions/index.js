import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';

initializeApp();

const db = getFirestore();
const auth = getAuth();
const commissionerNameSecret = defineSecret('COMMISSIONER_NAME');
const commissionerPinSecret = defineSecret('COMMISSIONER_PIN');
const leagues = db.collection('leagues');
const seasons = db.collection('seasons');
const accounts = db.collection('accounts');
const names = db.collection('accountNames');

function normalizedName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function nameKey(name) {
  return normalizedName(name).toLocaleLowerCase('en-US');
}

function nameDocumentId(key) {
  return createHash('sha256').update(key).digest('hex');
}

function validPin(pin) {
  return /^\d{4,12}$/.test(String(pin || ''));
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
  return { uid: account.id, displayName: account.name, role: account.role, enabled: account.enabled };
}

function emptyLeague(commissioner) {
  return {
    id: 'main',
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

function seasonName(value) {
  return normalizedName(value).slice(0, 60);
}

function validSeasonId(id) {
  return typeof id === 'string' && id.length > 0 && !id.includes('/');
}

async function ensureMainSeason() {
  await db.runTransaction(async transaction => {
    const seasonRef = seasons.doc('main');
    const [seasonSnapshot, leagueSnapshot] = await Promise.all([
      transaction.get(seasonRef),
      transaction.get(leagues.doc('main'))
    ]);
    if (seasonSnapshot.exists || !leagueSnapshot.exists) return;
    const league = leagueSnapshot.data();
    transaction.create(seasonRef, {
      name: 'Season 1',
      createdAt: Date.now(),
      memberIds: Object.keys(league.members || {})
    });
  });
}

function requireSeasonMember(league, account) {
  if (account.role !== 'commissioner' && !league.members?.[account.id]) {
    fail('permission-denied', 'You are not a member of this season.');
  }
}

function fail(code, message) {
  throw new HttpsError(code, message);
}

function requireAuth(request) {
  if (!request.auth) fail('unauthenticated', 'Sign in to continue.');
  return request.auth;
}

async function requireAccount(request, commissionerOnly = false) {
  const identity = requireAuth(request);
  const snapshot = await accounts.doc(identity.uid).get();
  const account = snapshot.data();
  if (!account || !account.enabled || account.role !== identity.token.role) {
    fail('unauthenticated', 'Sign in to continue.');
  }
  if (commissionerOnly && account.role !== 'commissioner') {
    fail('permission-denied', 'Commissioner access required.');
  }
  return account;
}

function verifyPin(account, pin) {
  if (!validPin(pin)) return false;
  const expected = Buffer.from(account.pinHash, 'hex');
  const actual = Buffer.from(hashPin(pin, account.pinSalt), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function findAccountByName(key) {
  const nameSnapshot = await names.doc(nameDocumentId(key)).get();
  if (!nameSnapshot.exists) return null;
  const accountSnapshot = await accounts.doc(nameSnapshot.get('uid')).get();
  if (!accountSnapshot.exists) throw new HttpsError('internal', 'The account index is inconsistent.');
  return accountSnapshot.data();
}

async function createInitialCommissioner(name, pin) {
  const configuredName = normalizedName(commissionerNameSecret.value());
  const configuredPin = commissionerPinSecret.value();
  if (!configuredName || !validPin(configuredPin)) {
    fail('failed-precondition', 'Initial commissioner credentials are not configured.');
  }
  if (nameKey(name) !== nameKey(configuredName) || String(pin) !== configuredPin) return null;

  const commissioner = createAccount(configuredName, configuredPin, 'commissioner');
  const nameRef = names.doc(nameDocumentId(commissioner.nameKey));
  await db.runTransaction(async transaction => {
    const [existingName, existingLeague] = await Promise.all([
      transaction.get(nameRef),
      transaction.get(leagues.doc('main'))
    ]);
    if (existingName.exists) return;
    if (existingLeague.exists) {
      fail('failed-precondition', 'League data exists without a commissioner account.');
    }
    transaction.create(accounts.doc(commissioner.id), commissioner);
    transaction.create(nameRef, { uid: commissioner.id });
    transaction.create(leagues.doc('main'), emptyLeague(commissioner));
    transaction.create(seasons.doc('main'), {
      name: 'Season 1',
      createdAt: Date.now(),
      memberIds: [commissioner.id]
    });
  });
  return findAccountByName(commissioner.nameKey);
}

function checkUpdates(updates, account) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    fail('invalid-argument', 'Updates must be an object.');
  }
  for (const field of Object.keys(updates)) {
    const parts = field.split('.');
    if (!field || parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) {
      fail('invalid-argument', 'Invalid update path.');
    }
    const topLevel = parts[0];
    if (account.role !== 'commissioner'
        && ['settings', 'logo', 'commissionerUid', 'seasonComplete', 'championUid'].includes(topLevel)) {
      fail('permission-denied', 'Commissioner access required for this change.');
    }
    if (account.role !== 'commissioner' && topLevel === 'members' && parts[1] !== account.id) {
      fail('permission-denied', 'You can only edit your own player profile.');
    }
  }
}

function setPath(target, field, value) {
  const parts = field.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function currentAtPath(target, field) {
  return field.split('.').reduce((value, part) => value && value[part], target);
}

export const signInWithPin = onCall({
  secrets: [commissionerNameSecret, commissionerPinSecret],
  cors: true
}, async request => {
  const name = normalizedName(request.data?.name);
  const pin = String(request.data?.pin || '');
  if (name.length < 2 || name.length > 40 || !validPin(pin)) {
    fail('unauthenticated', 'Name or PIN is incorrect.');
  }

  let account = await findAccountByName(nameKey(name));
  if (!account) account = await createInitialCommissioner(name, pin);
  if (!account || !account.enabled || !verifyPin(account, pin)) {
    fail('unauthenticated', 'Name or PIN is incorrect.');
  }
  await ensureMainSeason();

  const token = await auth.createCustomToken(account.id, {
    role: account.role,
    displayName: account.name
  });
  return { token, user: publicAccount(account) };
});

export const createPlayer = onCall({ cors: true }, async request => {
  const commissioner = await requireAccount(request, true);
  const seasonId = String(request.data?.seasonId || 'main');
  if (!validSeasonId(seasonId)) fail('invalid-argument', 'Season ID is invalid.');
  const leagueRef = leagues.doc(seasonId);
  const seasonRef = seasons.doc(seasonId);
  const name = normalizedName(request.data?.name);
  const pin = String(request.data?.pin || '');
  if (name.length < 2 || name.length > 40) fail('invalid-argument', 'Name must be 2-40 characters.');
  if (!validPin(pin)) fail('invalid-argument', 'PIN must contain 4-12 digits.');

  const player = createAccount(name, pin);
  const nameRef = names.doc(nameDocumentId(player.nameKey));
  const accountRef = accounts.doc(player.id);
  await db.runTransaction(async transaction => {
    const [existingName, leagueSnapshot, seasonSnapshot] = await Promise.all([
      transaction.get(nameRef),
      transaction.get(leagueRef),
      transaction.get(seasonRef)
    ]);
    if (existingName.exists) fail('already-exists', 'That name already has an account.');
    if (!leagueSnapshot.exists) fail('failed-precondition', 'The league has not been initialized.');
    if (!seasonSnapshot.exists) fail('not-found', 'Season not found.');
    const league = leagueSnapshot.data();
    const maxTeams = Number(league.settings?.maxTeams) || Infinity;
    if (Object.keys(league.members || {}).length >= maxTeams) {
      fail('resource-exhausted', 'Maximum team accounts reached.');
    }
    league.members ||= {};
    league.members[player.id] = { displayName: player.name, joinedAt: Date.now() };
    const season = seasonSnapshot.data();
    season.memberIds = [...new Set([...(season.memberIds || []), player.id])];
    transaction.create(accountRef, player);
    transaction.create(nameRef, { uid: player.id });
    transaction.set(leagueRef, league);
    transaction.set(seasonRef, season);
  });
  return { player: publicAccount(player) };
});

export const listSeasons = onCall({ cors: true }, async request => {
  const account = await requireAccount(request);
  await ensureMainSeason();
  const snapshot = await seasons.get();
  const result = snapshot.docs
    .map(document => ({ id: document.id, ...document.data() }))
    .filter(season => account.role === 'commissioner' || (season.memberIds || []).includes(account.id))
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  return {
    seasons: result.map(({ id, name, createdAt, memberIds }) => ({
      id, name, createdAt, memberCount: (memberIds || []).length
    }))
  };
});

export const createSeason = onCall({ cors: true }, async request => {
  const commissioner = await requireAccount(request, true);
  const name = seasonName(request.data?.name);
  if (name.length < 2) fail('invalid-argument', 'Season name must be 2-60 characters.');
  const seasonRef = seasons.doc();
  const league = emptyLeague(commissioner);
  league.id = seasonRef.id;
  await db.runTransaction(async transaction => {
    transaction.create(seasonRef, {
      name,
      createdAt: Date.now(),
      memberIds: [commissioner.id]
    });
    transaction.create(leagues.doc(seasonRef.id), league);
  });
  return { season: { id: seasonRef.id, name } };
});

export const deleteSeason = onCall({ cors: true }, async request => {
  await requireAccount(request, true);
  const seasonId = String(request.data?.seasonId || '');
  if (!validSeasonId(seasonId)) fail('invalid-argument', 'Season ID is invalid.');
  const seasonRef = seasons.doc(seasonId);
  const leagueRef = leagues.doc(seasonId);
  await db.runTransaction(async transaction => {
    const [seasonSnapshot, leagueSnapshot, allSeasons] = await Promise.all([
      transaction.get(seasonRef),
      transaction.get(leagueRef),
      transaction.get(seasons)
    ]);
    if (!seasonSnapshot.exists || !leagueSnapshot.exists) fail('not-found', 'Season not found.');
    if (allSeasons.size <= 1) fail('failed-precondition', 'The last season cannot be deleted.');
    transaction.delete(seasonRef);
    transaction.delete(leagueRef);
  });
  return { ok: true };
});

export const setSeasonMember = onCall({ cors: true }, async request => {
  await requireAccount(request, true);
  const seasonId = String(request.data?.seasonId || '');
  const playerId = String(request.data?.playerId || '');
  if (!validSeasonId(seasonId) || !playerId || typeof request.data?.included !== 'boolean') {
    fail('invalid-argument', 'Season, player, and membership state are required.');
  }
  const included = request.data.included;
  const leagueRef = leagues.doc(seasonId);
  const seasonRef = seasons.doc(seasonId);
  const accountRef = accounts.doc(playerId);
  await db.runTransaction(async transaction => {
    const [leagueSnapshot, seasonSnapshot, accountSnapshot] = await Promise.all([
      transaction.get(leagueRef),
      transaction.get(seasonRef),
      transaction.get(accountRef)
    ]);
    if (!leagueSnapshot.exists || !seasonSnapshot.exists) fail('not-found', 'Season not found.');
    if (!accountSnapshot.exists || accountSnapshot.get('role') === 'commissioner') fail('not-found', 'Player not found.');
    const league = leagueSnapshot.data();
    const season = seasonSnapshot.data();
    if (Boolean(league.members?.[playerId]) === included) return;
    if (league.draft) fail('failed-precondition', 'Season membership cannot be changed after the draft starts.');
    if (included) {
      const maxTeams = Number(league.settings?.maxTeams) || Infinity;
      if (Object.keys(league.members || {}).length >= maxTeams) fail('resource-exhausted', 'Maximum team accounts reached.');
      league.members ||= {};
      league.members[playerId] = { displayName: accountSnapshot.get('name'), joinedAt: Date.now() };
    } else {
      delete league.members[playerId];
    }
    season.memberIds = Object.keys(league.members || {});
    transaction.set(leagueRef, league);
    transaction.set(seasonRef, season);
  });
  return { ok: true };
});

export const fetchPlayers = onCall({ cors: true }, async request => {
  await requireAccount(request, true);
  const snapshot = await accounts.get();
  return {
    players: snapshot.docs.map(document => publicAccount(document.data()))
  };
});

export const updatePlayer = onCall({ cors: true }, async request => {
  await requireAccount(request, true);
  const id = String(request.data?.id || '');
  const updates = request.data?.updates;
  if (!id || !updates || typeof updates !== 'object' || Array.isArray(updates)) {
    fail('invalid-argument', 'Player update is invalid.');
  }
  const accountRef = accounts.doc(id);
  let player;
  await db.runTransaction(async transaction => {
    const accountSnapshot = await transaction.get(accountRef);
    if (!accountSnapshot.exists || accountSnapshot.get('role') === 'commissioner') {
      fail('not-found', 'Player not found.');
    }
    player = accountSnapshot.data();
    if (updates.enabled !== undefined) player.enabled = Boolean(updates.enabled);
    if (updates.pin !== undefined) {
      if (!validPin(updates.pin)) fail('invalid-argument', 'PIN must contain 4-12 digits.');
      player.pinSalt = randomBytes(16).toString('hex');
      player.pinHash = hashPin(updates.pin, player.pinSalt);
    }
    transaction.set(accountRef, player);
  });
  return { player: publicAccount(player) };
});

export const updateLeague = onCall({ cors: true }, async request => {
  const account = await requireAccount(request);
  const seasonId = String(request.data?.seasonId || 'main');
  if (!validSeasonId(seasonId)) fail('invalid-argument', 'Season ID is invalid.');
  const leagueRef = leagues.doc(seasonId);
  const updates = request.data?.updates;
  checkUpdates(updates, account);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(leagueRef);
    if (!snapshot.exists) fail('failed-precondition', 'The league has not been initialized.');
    const league = snapshot.data();
    requireSeasonMember(league, account);
    for (const [field, value] of Object.entries(updates)) {
      if (value && typeof value === 'object' && value.__appendToLeague === true) {
        const current = currentAtPath(league, field);
        setPath(league, field, (Array.isArray(current) ? current : []).concat([value.value]));
      } else {
        setPath(league, field, value);
      }
    }
    transaction.set(leagueRef, league);
  });
  return { ok: true };
});
