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
    const localDatabase = new Database(path.join(dataDir, 'league.sqlite'), { readonly: true });
    const savedData = localDatabase.prepare('SELECT payload FROM league_state WHERE id = 1').get().payload;
    localDatabase.close();
    assert.ok(savedData.includes('pinHash'));
    assert.ok(!savedData.includes('1357'));

    const created = await call('/api/players', {
      method: 'POST', body: { name: 'Trainer One', pin: '2468' }, token: commissionerToken
    });
    assert.equal(created.response.status, 201);
    const duplicate = await call('/api/players', {
      method: 'POST', body: { name: 'trainer one', pin: '8642' }, token: commissionerToken
    });
    assert.equal(duplicate.response.status, 409);

    const playerLogin = await call('/api/session', { method: 'POST', body: { name: 'Trainer One', pin: '2468' } });
    assert.equal(playerLogin.response.status, 200);
    const playerToken = playerLogin.data.token;
    const deniedPlayerManagement = await call('/api/players', { token: playerToken });
    assert.equal(deniedPlayerManagement.response.status, 403);
    const deniedSettingsChange = await call('/api/league', {
      method: 'PATCH', body: { updates: { settings: { maxTeams: 100 } } }, token: playerToken
    });
    assert.equal(deniedSettingsChange.response.status, 403);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});