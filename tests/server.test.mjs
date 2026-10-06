import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, 'server.mjs');

test('commissioner provisions designated player sessions', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mad-league-'));
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      COMMISSIONER_NAME: 'Commissioner',
      COMMISSIONER_PIN: '1357',
      ALLOWED_ORIGINS: 'https://league-owner.github.io',
      DATA_DIR: dataDir,
      PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let port;
  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/listening on port (\d+)/);
      if (match) { port = Number(match[1]); resolve(); }
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => { if (!port) reject(new Error(`Server exited (${code}): ${output}`)); });
  });

  async function call(route, { method = 'GET', body, cookie, token, origin = 'https://league-owner.github.io' } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { response, data: response.status === 204 ? {} : await response.json() };
  }

  try {
    await started;
    const homepage = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(homepage.status, 200);
    assert.match(await homepage.text(), /<!DOCTYPE html>/i);

    const preflight = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://league-owner.github.io',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type'
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://league-owner.github.io');
    const blockedOrigin = await call('/api/league', { origin: 'https://unrelated-site.example' });
    assert.equal(blockedOrigin.response.status, 403);

    const unauthenticatedRead = await call('/api/league');
    assert.equal(unauthenticatedRead.response.status, 401);

    const unauthenticatedWrite = await call('/api/league', { method: 'PATCH', body: { updates: { name: 'Changed' } } });
    assert.equal(unauthenticatedWrite.response.status, 401);

    const badLogin = await call('/api/session', { method: 'POST', body: { name: 'Commissioner', pin: '0000' } });
    assert.equal(badLogin.response.status, 401);
    const login = await call('/api/session', { method: 'POST', body: { name: 'Commissioner', pin: '1357' } });
    assert.equal(login.response.status, 200);
    assert.ok(login.data.token);
    const commissionerToken = login.data.token;
    const authenticatedRead = await call('/api/league', { token: commissionerToken });
    assert.equal(authenticatedRead.response.status, 200);
    assert.equal(authenticatedRead.data.league.name, 'MAD League');
    const publicChampionRead = await call('/api/champions');
    assert.equal(publicChampionRead.response.status, 200);
    assert.deepEqual(publicChampionRead.data.champions, []);
    const deniedChampionWrite = await call('/api/champions', {
      method: 'POST', body: { champion: { season: 'Legacy Season', winner: 'The Winners', roster: [] } }
    });
    assert.equal(deniedChampionWrite.response.status, 401);
    const invalidChampion = await call('/api/champions', {
      method: 'POST', body: { champion: { season: 'Legacy Season', winner: 'The Winners', roster: [''] } },
      token: commissionerToken
    });
    assert.equal(invalidChampion.response.status, 400);
    const savedChampion = await call('/api/champions', {
      method: 'POST',
      body: { champion: { season: 'Legacy Season', winner: 'The Winners', coach: 'Coach One', roster: ['Pikachu', 'Gengar'] } },
      token: commissionerToken
    });
    assert.equal(savedChampion.response.status, 201);
    const championId = savedChampion.data.champion.id;
    assert.deepEqual((await call('/api/champions')).data.champions[0].roster, ['Pikachu', 'Gengar']);
    const localDatabase = new Database(path.join(dataDir, 'league.sqlite'), { readonly: true });
    const savedData = localDatabase.prepare('SELECT payload FROM league_state WHERE id = 1').get().payload;
    localDatabase.close();
    assert.ok(savedData.includes('pinHash'));
    assert.ok(!savedData.includes('1357'));

    const created = await call('/api/players', {
      method: 'POST', body: { name: 'Trainer One', pin: '2468' }, token: commissionerToken
    });
    assert.equal(created.response.status, 201);
    const playerId = created.data.player.uid;
    const duplicate = await call('/api/players', {
      method: 'POST', body: { name: 'trainer one', pin: '8642' }, token: commissionerToken
    });
    assert.equal(duplicate.response.status, 409);

    const playerLogin = await call('/api/session', { method: 'POST', body: { name: 'Trainer One', pin: '2468' } });
    assert.equal(playerLogin.response.status, 200);
    const playerToken = playerLogin.data.token;
    assert.equal(playerLogin.data.user.uid, playerId);
    const deniedPlayerChampionWrite = await call('/api/champions', {
      method: 'POST',
      body: { champion: { id: championId, season: 'Tampered Season', winner: 'Tampered', roster: [] } },
      token: playerToken
    });
    assert.equal(deniedPlayerChampionWrite.response.status, 403);
    const editedChampion = await call('/api/champions', {
      method: 'POST',
      body: { champion: { id: championId, season: 'Updated Legacy Season', winner: 'The Winners', coach: '', roster: ['Raichu'] } },
      token: commissionerToken
    });
    assert.equal(editedChampion.response.status, 200);
    assert.equal(editedChampion.data.champion.season, 'Updated Legacy Season');
    const deniedPlayerChampionDelete = await call('/api/champions/' + championId, { method: 'DELETE', token: playerToken });
    assert.equal(deniedPlayerChampionDelete.response.status, 403);
    const deletedChampion = await call('/api/champions/' + championId, { method: 'DELETE', token: commissionerToken });
    assert.equal(deletedChampion.response.status, 200);
    assert.deepEqual((await call('/api/champions')).data.champions, []);
    const deniedPlayerManagement = await call('/api/players', { token: playerToken });
    assert.equal(deniedPlayerManagement.response.status, 403);
    const deniedSettingsChange = await call('/api/league', {
      method: 'PATCH', body: { updates: { settings: { maxTeams: 100 } } }, token: playerToken
    });
    assert.equal(deniedSettingsChange.response.status, 403);

    const createdSeason = await call('/api/seasons', {
      method: 'POST', body: { name: 'Season Two' }, token: commissionerToken
    });
    assert.equal(createdSeason.response.status, 201);
    const seasonId = createdSeason.data.season.id;
    const commissionerSeasons = await call('/api/seasons', { token: commissionerToken });
    assert.deepEqual(commissionerSeasons.data.seasons.map(season => season.name), ['Season 1', 'Season Two']);
    const freshLeague = await call('/api/league?id=' + seasonId, { token: commissionerToken });
    assert.equal(freshLeague.response.status, 200);
    assert.equal(freshLeague.data.league.id, seasonId);
    assert.deepEqual(Object.keys(freshLeague.data.league.members), [login.data.user.uid]);

    const deniedSeasonRead = await call('/api/league?id=' + seasonId, { token: playerToken });
    assert.equal(deniedSeasonRead.response.status, 403);
    const joinedSeason = await call(`/api/seasons/${seasonId}/members/${playerId}`, {
      method: 'PATCH', body: { included: true }, token: commissionerToken
    });
    assert.equal(joinedSeason.response.status, 200);
    const playerSeasons = await call('/api/seasons', { token: playerToken });
    assert.deepEqual(playerSeasons.data.seasons.map(season => season.id), ['main', seasonId]);
    const grantedSeasonRead = await call('/api/league?id=' + seasonId, { token: playerToken });
    assert.equal(grantedSeasonRead.response.status, 200);
    await call('/api/league?id=' + seasonId, {
      method: 'PATCH', body: { updates: { name: 'Season Two League' } }, token: commissionerToken
    });
    const unchangedMain = await call('/api/league', { token: commissionerToken });
    assert.equal(unchangedMain.data.league.name, 'MAD League');

    const removedSeason = await call(`/api/seasons/${seasonId}/members/${playerId}`, {
      method: 'PATCH', body: { included: false }, token: commissionerToken
    });
    assert.equal(removedSeason.response.status, 200);
    const deniedAfterRemoval = await call('/api/league?id=' + seasonId, { token: playerToken });
    assert.equal(deniedAfterRemoval.response.status, 403);
    const deniedPlayerDelete = await call('/api/seasons/' + seasonId, { method: 'DELETE', token: playerToken });
    assert.equal(deniedPlayerDelete.response.status, 403);
    const deletedMain = await call('/api/seasons/main', { method: 'DELETE', token: commissionerToken });
    assert.equal(deletedMain.response.status, 200);
    const remainingSeasons = await call('/api/seasons', { token: commissionerToken });
    assert.deepEqual(remainingSeasons.data.seasons.map(season => season.id), [seasonId]);
    const deniedLastSeasonDelete = await call('/api/seasons/' + seasonId, { method: 'DELETE', token: commissionerToken });
    assert.equal(deniedLastSeasonDelete.response.status, 409);
    const stillSharedAccount = await call('/api/session', { method: 'POST', body: { name: 'Trainer One', pin: '2468' } });
    assert.equal(stillSharedAccount.response.status, 200);
    assert.equal(stillSharedAccount.data.user.uid, playerId);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});