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
const leagueRef = db.collection('leagues').doc('main');
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
      transaction.get(leagueRef)
    ]);
    if (existingName.exists) return;
    if (existingLeague.exists) {
      fail('failed-precondition', 'League data exists without a commissioner account.');
    }
    transaction.create(accounts.doc(commissioner.id), commissioner);
    transaction.create(nameRef, { uid: commissioner.id });
    transaction.create(leagueRef, emptyLeague(commissioner));
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

  const token = await auth.createCustomToken(account.id, {
    role: account.role,
    displayName: account.name
  });
  return { token, user: publicAccount(account) };
});

export const createPlayer = onCall({ cors: true }, async request => {
  await requireAccount(request, true);
  const name = normalizedName(request.data?.name);
  const pin = String(request.data?.pin || '');
  if (name.length < 2 || name.length > 40) fail('invalid-argument', 'Name must be 2-40 characters.');
  if (!validPin(pin)) fail('invalid-argument', 'PIN must contain 4-12 digits.');

  const player = createAccount(name, pin);
  const nameRef = names.doc(nameDocumentId(player.nameKey));
  const accountRef = accounts.doc(player.id);
  await db.runTransaction(async transaction => {
    const [existingName, leagueSnapshot] = await Promise.all([
      transaction.get(nameRef),
      transaction.get(leagueRef)
    ]);
    if (existingName.exists) fail('already-exists', 'That name already has an account.');
    if (!leagueSnapshot.exists) fail('failed-precondition', 'The league has not been initialized.');
    const league = leagueSnapshot.data();
    const maxTeams = Number(league.settings?.maxTeams) || Infinity;
    if (Object.keys(league.members || {}).length >= maxTeams) {
      fail('resource-exhausted', 'Maximum team accounts reached.');
    }
    league.members ||= {};
    league.members[player.id] = { displayName: player.name, joinedAt: Date.now() };
    transaction.create(accountRef, player);
    transaction.create(nameRef, { uid: player.id });
    transaction.set(leagueRef, league);
  });
  return { player: publicAccount(player) };
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
    const [accountSnapshot, leagueSnapshot] = await Promise.all([
      transaction.get(accountRef),
      transaction.get(leagueRef)
    ]);
    if (!accountSnapshot.exists || accountSnapshot.get('role') === 'commissioner') {
      fail('not-found', 'Player not found.');
    }
    if (!leagueSnapshot.exists) fail('failed-precondition', 'The league has not been initialized.');
    player = accountSnapshot.data();
    const league = leagueSnapshot.data();
    if (updates.enabled !== undefined && Boolean(updates.enabled) !== player.enabled && league.draft) {
      fail('failed-precondition', 'Player accounts cannot be changed after the draft starts.');
    }
    if (updates.enabled === false) {
      player.enabled = false;
      delete league.members?.[player.id];
    }
    if (updates.enabled === true) {
      const maxTeams = Number(league.settings?.maxTeams) || Infinity;
      if (!player.enabled && Object.keys(league.members || {}).length >= maxTeams) {
        fail('resource-exhausted', 'Maximum team accounts reached.');
      }
      player.enabled = true;
      league.members ||= {};
      league.members[player.id] ||= { displayName: player.name, joinedAt: Date.now() };
    }
    if (updates.pin !== undefined) {
      if (!validPin(updates.pin)) fail('invalid-argument', 'PIN must contain 4-12 digits.');
      player.pinSalt = randomBytes(16).toString('hex');
      player.pinHash = hashPin(updates.pin, player.pinSalt);
    }
    transaction.set(accountRef, player);
    transaction.set(leagueRef, league);
  });
  return { player: publicAccount(player) };
});

export const updateLeague = onCall({ cors: true }, async request => {
  const account = await requireAccount(request);
  const updates = request.data?.updates;
  checkUpdates(updates, account);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(leagueRef);
    if (!snapshot.exists) fail('failed-precondition', 'The league has not been initialized.');
    const league = snapshot.data();
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
