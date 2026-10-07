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
const champions = db.collection('champions');

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

function validPoolPointOverrides(overrides) {
  return overrides && typeof overrides === 'object' && !Array.isArray(overrides)
    && Object.keys(overrides).length <= 2000
    && Object.entries(overrides).every(([id, points]) => /^\d+$/.test(id) && Number.isInteger(points) && points >= 1 && points <= 100);
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
    if (topLevel === 'poolPointOverrides'
        && (account.role !== 'commissioner' || field !== 'poolPointOverrides' || !validPoolPointOverrides(updates[field]))) {
      fail(account.role !== 'commissioner' ? 'permission-denied' : 'invalid-argument',
        account.role !== 'commissioner' ? 'Commissioner access required for this change.' : 'Pool point overrides are invalid.');
    }
    if (account.role !== 'commissioner'
        && ['settings', 'logo', 'commissionerUid', 'seasonComplete', 'championUid'].includes(topLevel)) {
      fail('permission-denied', 'Commissioner access required for this change.');
    }
    if (account.role !== 'commissioner' && topLevel === 'schedule'
        && !(/^schedule\.results\.\d+_\d+$/.test(field)
          || /^schedule\.results\.\d+_\d+\.games\.\d+\.pokemonStats\.[A-Za-z0-9_-]+$/.test(field))) {
      fail('permission-denied', 'Commissioner access required to change the match schedule.');
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

function validateScheduleRetraction(league, updates) {
  const currentSchedule = league.schedule;
  const nextSchedule = updates.schedule;
  if (!currentSchedule || currentSchedule.progression !== 'commissioner' || !nextSchedule || typeof nextSchedule !== 'object') return;
  const currentWeeks = currentSchedule.weeks;
  const nextWeeks = nextSchedule.weeks;
  if (!Array.isArray(currentWeeks) || !Array.isArray(nextWeeks) || nextWeeks.length >= currentWeeks.length) return;
  if (currentWeeks.length - nextWeeks.length !== 1 || nextSchedule.progression !== 'commissioner'
      || nextSchedule.totalWeeks !== currentSchedule.totalWeeks) {
    fail('failed-precondition', 'Only the latest announced week can be undone.');
  }
  const removedWeekIndex = currentWeeks.length - 1;
  if (Object.keys(currentSchedule.results || {}).some(key => key.startsWith(removedWeekIndex + '_'))) {
    fail('failed-precondition', 'A week with result data cannot be undone.');
  }
}

function pokemonStatsPatchContext(league, field, stats, account) {
  const regular = field.match(/^schedule\.results\.(\d+)_(\d+)\.games\.(\d+)\.pokemonStats\.([A-Za-z0-9_-]+)$/);
  const playoff = field.match(/^playoffBracket\.rounds\.(\d+)\.matches\.(\d+)\.games\.(\d+)\.pokemonStats\.([A-Za-z0-9_-]+)$/);
  const match = regular || playoff;
  if (!match) return null;

  let matchRecord, games, scope, weekIndex, matchIndex;
  if (regular) {
    weekIndex = Number(regular[1]); matchIndex = Number(regular[2]);
    matchRecord = league.schedule?.weeks?.[weekIndex]?.matches?.[matchIndex];
    games = league.schedule?.results?.[weekIndex + '_' + matchIndex]?.games;
    scope = 'schedule:' + weekIndex + '_' + matchIndex;
  } else {
    const roundIndex = Number(playoff[1]);
    matchIndex = Number(playoff[2]);
    matchRecord = league.playoffBracket?.rounds?.[roundIndex]?.matches?.[matchIndex];
    games = matchRecord?.games;
    scope = 'playoff:' + roundIndex + '_' + matchIndex;
  }
  const gameIndex = Number(match[3]);
  const statsUid = match[4];
  if (!matchRecord || !Array.isArray(games) || !games[gameIndex]
      || ![matchRecord.a, matchRecord.b].includes(statsUid)) {
    fail('invalid-argument', 'Pokémon stats do not match a saved game.');
  }
  if (account.role !== 'commissioner' && (account.id !== statsUid || ![matchRecord.a, matchRecord.b].includes(account.id))) {
    fail('permission-denied', 'You can only submit Pokémon stats for your own team.');
  }
  if (!Array.isArray(stats) || (stats.length !== 0 && stats.length !== 4)) {
    fail('invalid-argument', 'Submit exactly four Pokémon per game, or an empty list to clear stats.');
  }
  const ids = new Set();
  for (const stat of stats) {
    if (!stat || !Number.isInteger(Number(stat.pokemonId)) || Number(stat.pokemonId) < 1
        || ids.has(String(stat.pokemonId))
        || !Number.isInteger(stat.kills) || stat.kills < 0 || stat.kills > 6
        || !Number.isInteger(stat.deaths) || stat.deaths < 0 || stat.deaths > 1) {
      fail('invalid-argument', 'Pokémon stats are invalid.');
    }
    ids.add(String(stat.pokemonId));
  }
  return { field, stats, games, gameIndex, statsUid, scope };
}

function validatePokemonStatsPatches(patches) {
  const groups = new Map();
  patches.forEach(patch => groups.set(patch.scope + ':' + patch.statsUid, patch));
  for (const [groupKey, firstPatch] of groups) {
    const [scope, matchKey, uid] = groupKey.split(':');
    const overridden = new Map();
    patches.filter(patch => patch.scope === scope + ':' + matchKey && patch.statsUid === uid)
      .forEach(patch => overridden.set(patch.gameIndex, patch.stats));
    const uniqueIds = new Set();
    firstPatch.games.forEach((game, gameIdx) => {
      const stats = overridden.has(gameIdx) ? overridden.get(gameIdx) : ((game.pokemonStats || {})[uid] || []);
      stats.forEach(stat => uniqueIds.add(String(stat.pokemonId)));
    });
    if (uniqueIds.size > 6) fail('invalid-argument', 'No more than six unique Pokémon can be selected across a match.');
  }
}

function preserveExistingPokemonStats(league, field, value) {
  if (!value || typeof value !== 'object') return value;
  const regular = field.match(/^schedule\.results\.(\d+)_(\d+)$/);
  if (regular && Array.isArray(value.games)) {
    const previous = league.schedule?.results?.[regular[1] + '_' + regular[2]]?.games || [];
    return Object.assign({}, value, {
      games: value.games.map((game, index) => Object.assign({}, game, {
        pokemonStats: Object.assign({}, previous[index] && previous[index].pokemonStats || {}, game.pokemonStats || {})
      }))
    });
  }
  if (field === 'playoffBracket' && Array.isArray(value.rounds)) {
    return Object.assign({}, value, {
      rounds: value.rounds.map((round, roundIndex) => Object.assign({}, round, {
        matches: (round.matches || []).map((match, matchIndex) => {
          const previousGames = league.playoffBracket?.rounds?.[roundIndex]?.matches?.[matchIndex]?.games || [];
          return Object.assign({}, match, {
            games: (match.games || []).map((game, gameIndex) => Object.assign({}, game, {
              pokemonStats: Object.assign({}, previousGames[gameIndex] && previousGames[gameIndex].pokemonStats || {}, game.pokemonStats || {})
            }))
          });
        })
      }))
    });
  }
  return value;
}

export const signInWithPin = onCall({
  secrets: [commissionerNameSecret, commissionerPinSecret],
  cors: true,
  invoker: 'public'
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

export const createPlayer = onCall({ cors: true, invoker: 'public' }, async request => {
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

export const listSeasons = onCall({ cors: true, invoker: 'public' }, async request => {
  try {
    const account = await requireAccount(request);
    await ensureMainSeason();
    const snapshot = await seasons.get();
    const result = snapshot.docs
      .map(document => ({ id: document.id, ...document.data() }))
      .filter(season => account.role === 'commissioner'
        || (Array.isArray(season.memberIds) && season.memberIds.includes(account.id)))
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    return {
      seasons: result.map(season => ({
        id: season.id,
        name: typeof season.name === 'string' ? season.name : 'Unnamed season',
        createdAt: typeof season.createdAt === 'number' ? season.createdAt : null,
        memberCount: Array.isArray(season.memberIds) ? season.memberIds.length : 0
      }))
    };
  } catch (error) {
    console.error('listSeasons failed.', error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'Could not load seasons. Check the Cloud Function logs for details.');
  }
});

export const createSeason = onCall({ cors: true, invoker: 'public' }, async request => {
  try {
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
  } catch (error) {
    console.error('createSeason failed.', error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'Could not create season. Check the Cloud Function logs for details.');
  }
});

export const deleteSeason = onCall({ cors: true, invoker: 'public' }, async request => {
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

export const setSeasonMember = onCall({ cors: true, invoker: 'public' }, async request => {
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

export const fetchPlayers = onCall({ cors: true, invoker: 'public' }, async request => {
  await requireAccount(request, true);
  const snapshot = await accounts.get();
  return {
    players: snapshot.docs.map(document => publicAccount(document.data()))
  };
});

export const updatePlayer = onCall({ cors: true, invoker: 'public' }, async request => {
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

export const updateLeague = onCall({ cors: true, invoker: 'public' }, async request => {
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
    if (account.role === 'commissioner') validateScheduleRetraction(league, updates);
    const pokemonStatsPatches = [];
    for (const [field, value] of Object.entries(updates)) {
      const patch = pokemonStatsPatchContext(league, field, value, account);
      if (patch) pokemonStatsPatches.push(patch);
      else if (account.role !== 'commissioner' && field.split('.')[0] === 'schedule'
          && !/^schedule\.results\.\d+_\d+$/.test(field)) {
        fail('permission-denied', 'Commissioner access required to change the match schedule.');
      }
    }
    validatePokemonStatsPatches(pokemonStatsPatches);
    for (const [field, value] of Object.entries(updates)) {
      if (value && typeof value === 'object' && value.__appendToLeague === true) {
        const current = currentAtPath(league, field);
        setPath(league, field, (Array.isArray(current) ? current : []).concat([value.value]));
      } else {
        setPath(league, field, preserveExistingPokemonStats(league, field, value));
      }
    }
    stampCompletedScheduleWeeks(league, updates);
    transaction.set(leagueRef, league);
  });
  return { ok: true };
});

export const listPoolPointOverrides = onCall({ cors: true, invoker: 'public' }, async request => {
  const seasonId = String(request.data?.seasonId || 'main');
  if (!validSeasonId(seasonId)) fail('invalid-argument', 'Season ID is invalid.');
  const snapshot = await leagues.doc(seasonId).get();
  if (!snapshot.exists) fail('not-found', 'Season not found.');
  return { overrides: snapshot.get('poolPointOverrides') || {} };
});

function championRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid-argument', 'Champion details are required.');
  }
  if (typeof input.season !== 'string' || typeof input.winner !== 'string'
      || (input.coach !== undefined && typeof input.coach !== 'string')
      || (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim()))) {
    fail('invalid-argument', 'Season, winner, coach, or record ID is invalid.');
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
    fail('invalid-argument', 'Season, winner, coach, or roster details are invalid.');
  }
  return { season, winner, coach, mvp, roster: roster.map(normalizedName) };
}

export const listChampions = onCall({ cors: true, invoker: 'public' }, async () => {
  const snapshot = await champions.get();
  return {
    champions: snapshot.docs.map(document => ({ id: document.id, ...document.data() }))
  };
});

export const saveChampion = onCall({ cors: true, invoker: 'public' }, async request => {
  await requireAccount(request, true);
  const record = championRecord(request.data?.champion);
  const requestedId = request.data?.champion?.id;
  if (requestedId !== undefined && typeof requestedId !== 'string') {
    fail('invalid-argument', 'Champion record ID is invalid.');
  }
  const id = requestedId ? String(requestedId) : randomUUID();
  if (id.length > 100 || id.includes('/')) fail('invalid-argument', 'Champion record ID is invalid.');
  const ref = champions.doc(id);
  const snapshot = requestedId ? await ref.get() : null;
  if (requestedId && !snapshot.exists) fail('not-found', 'Champion record not found.');
  const now = Date.now();
  const champion = {
    ...record,
    createdAt: snapshot ? snapshot.get('createdAt') || now : now,
    updatedAt: now
  };
  await ref.set(champion);
  return { champion: { id, ...champion } };
});

export const deleteChampion = onCall({ cors: true, invoker: 'public' }, async request => {
  await requireAccount(request, true);
  const id = String(request.data?.id || '');
  if (!id || id.length > 100 || id.includes('/')) fail('invalid-argument', 'Champion record ID is invalid.');
  const ref = champions.doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) fail('not-found', 'Champion record not found.');
  await ref.delete();
  return { ok: true };
});
