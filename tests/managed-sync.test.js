import assert from 'node:assert/strict';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, readdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startAppearanceSync } from '../tools/appearance-sync.mjs';
import { startManagedSync } from '../tools/sync-admin/server.mjs';
import { createSetupCode } from '../tools/sync-admin/initial-setup.mjs';
import { resetAdminPassword } from '../tools/sync-admin/admin-password.mjs';
import { openState } from '../tools/sync-admin/state.mjs';
import { openPublicVaults } from '../tools/sync-admin/public-vault.mjs';
import { createPublicTransport, createVaultCipher, randomPass } from '../src/core/public-sync.js';
import { openPrivateCredential } from '../src/core/private-sync-code.js';
import { base64url, createPairingRequest, fromBase64url, openPairing, readPairingRequest, sealPairing, syncProofBytes,
  PAIR_INVITE, PAIR_UPDATE } from '../src/core/sync-pairing-code.js';

const site = 'http://127.0.0.1:17321';
const token = (length = 32) => randomBytes(length).toString('base64url');
const gameKey = id => createHash('sha256').update('sgstoolbox-appearances-test:' + id).digest('hex');
const post = (base, path, body, extra = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site, ...extra }, body: JSON.stringify(body),
});
const auth = device => ({ Authorization: 'Bearer ' + device });
const listen = (port = 0) => new Promise(resolve => {
  const server = createServer((_, response) => response.end());
  server.listen(port, '127.0.0.1', () => resolve(server));
});
const stop = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
async function freePort() {
  const server = await listen();
  const { port } = server.address();
  await stop(server);
  return port;
}
async function fixture(t, { legacy = false, seed, relocate = false, ...options } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sgs-managed-sync-'));
  let now = Date.now(), server;
  const start = async () => {
    server = await startManagedSync({ dataDir: dir, port: 0, adminPort: 0, now: () => now, interval: false,
      legacy, relocate, legacyInvitations: true, ...options });
    return server;
  };
  t.after(async () => {
    await server?.close();
    for (const file of await readdir(dir)) await unlink(join(dir, file));
    await rmdir(dir);
  });
  await seed?.(dir);
  await start();
  return { get server() { return server; }, dir, now: () => now, advance: ms => { now += ms; }, start };
}
async function admin(server, password) {
  const origin = server.adminUrl;
  const login = await post(origin, '/admin/login', { token: password ?? (await readFile(server.adminFile, 'utf8')).trim() }, { Origin: origin });
  assert.equal(login.status, 200);
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  return {
    get: path => fetch(origin + path, { headers: { Cookie } }),
    send: (path, value) => post(origin, '/admin/' + path, value, { Cookie, Origin: origin }),
  };
}

test('changing and resetting the administrator password preserve storage and revoke prior logins', async t => {
  const env = await fixture(t);
  const server = env.server;
  const original = (await readFile(server.adminFile, 'utf8')).trim();
  const first = await admin(server), second = await admin(server);
  const password = 'NewAdmin8#🙂';
  assert.equal((await first.send('password', { current: original, password: 'onlyletters' })).status, 400);
  assert.equal((await first.send('password', { current: 'WrongPass1', password })).status, 401);
  assert.equal((await first.send('password', { current: original, password })).status, 200);
  assert.equal((await second.get('/admin/status')).status, 401);
  const signIn = (value, target = env.server) => post(target.adminUrl, '/admin/login', { token: value }, { Origin: target.adminUrl });
  assert.equal((await signIn(original)).status, 401);
  const record = await readFile(server.adminFile, 'utf8');
  assert.match(record, /^scrypt:[a-f0-9]{32}:[a-f0-9]{64}\n$/);
  assert.equal(record.includes(password), false);
  const current = await admin(server, password);
  assert.equal((await current.send('limit', { limit: 3 })).status, 200);
  const originalState = await (await current.get('/admin/status')).json();
  await server.close();
  await env.start();
  assert.equal((await signIn(password)).status, 200);
  await env.server.close();
  const reset = await resetAdminPassword(env.dir);
  assert.match(reset, /^A1[A-Za-z0-9_-]{43}$/);
  await env.start();
  assert.equal((await signIn(password)).status, 401);
  const restoredState = await (await (await admin(env.server, reset)).get('/admin/status')).json();
  assert.equal(restoredState.mode, originalState.mode);
  assert.equal(restoredState.limit, originalState.limit);
});
async function invite(operator, options = {}, request = null) {
  request ??= await createPairingRequest(webcrypto);
  const response = await operator.send('invite', { request: request.code, uses: 1, hours: 24, ...options });
  assert.equal(response.status, 200);
  const entry = await response.json();
  assert.match(entry.pin, /^[0-9]{4}$/);
  const decoded = await openPairing(entry.code, PAIR_INVITE, id => id === request.id ? request.keys : null);
  return { ...entry, decoded, request };
}
function bindBody(invitation, game = '41') {
  return { device: token(), recovery: token(), gameKey: gameKey(game), requestId: invitation.request.id,
    invite: invitation.decoded.token, pin: invitation.pin };
}
async function privateInvite(base, operator) {
  const request = await createPairingRequest(webcrypto);
  const { pin } = await (await post(base, '/v1/private/request', { request: request.code })).json();
  assert.match(pin, /^\d{4}$/);
  const response = await operator.send('private/invite', { pin });
  assert.equal(response.status, 200);
  const { code } = await response.json();
  return { request, decoded: await openPairing(code, PAIR_INVITE, () => request.keys) };
}
async function privateCredentialBody(opened, game) {
  const request = await createPairingRequest(webcrypto);
  return { grant: opened.grant, gameKey: gameKey(game), userCode: String(game), installation: token(), device: token(),
    request: request.code, requestId: request.id };
}
async function proof(base, signer) {
  const nonce = token(16);
  const response = await post(base, '/v1/proof', { nonce });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.nonce, nonce);
  assert.equal(body.origin, base);
  const key = await webcrypto.subtle.importKey('raw', fromBase64url(signer, 65), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64url(body.signature, 64), syncProofBytes(body)), true);
  return body;
}

test('HPKE invitations preserve endpoint fields and require the device key', async () => {
  const request = await createPairingRequest(webcrypto), other = await createPairingRequest(webcrypto);
  const recipient = await readPairingRequest(webcrypto, request.code);
  assert.equal(request.code.length, 114);
  assert.equal(request.keys.privateKey.extractable, false);
  const signer = base64url(randomBytes(65)), inviteToken = token();
  const endpoint = { local: false, tls: true, ipv4: '192.0.2.1', ipv6: '2001:db8::1', domain: 'example.test', port: 17429 };
  const expires = Math.floor(Date.now() / 1000) + 60;
  const code = await sealPairing(recipient, endpoint, expires, signer, inviteToken);
  assert.match(code, /^SGSI2\.[A-Za-z0-9_-]+$/);
  await assert.rejects(openPairing(code, PAIR_INVITE, () => other.keys));
  const changed = fromBase64url(code.slice(6));
  changed[changed.length - 1] ^= 1;
  await assert.rejects(openPairing('SGSI2.' + base64url(changed), PAIR_INVITE, () => request.keys));
  assert.deepEqual(await openPairing(' ' + code + '\n', PAIR_INVITE, () => request.keys), {
    ...endpoint, ipv6: '2001:db8:0:0:0:0:0:1', expiry: expires, token: inviteToken, requestId: request.id, signer,
  });
});

test('the managed sync command starts via the current-release symlink with private loopback defaults', { timeout: 8000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sgs-sync-cli-'));
  const syncPort = await freePort(), adminPort = await freePort(), setupPort = await freePort();
  const entry = fileURLToPath(new URL('../tools/appearance-sync.mjs', import.meta.url));
  const current = join(dir, 'current');
  await symlink(dirname(entry), current, 'junction');
  const child = spawn(process.execPath, [join(current, 'appearance-sync.mjs'), '--data-dir', dir, '--port', syncPort, '--admin-port', adminPort,
    '--setup-port', setupPort],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exit;
    for (const file of await readdir(dir)) await unlink(join(dir, file));
    await rmdir(dir);
  });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  const started = new Promise(resolve => child.stdout.on('data', chunk => {
    output += chunk;
    if (output.includes(`http://127.0.0.1:${adminPort}/admin/`)) resolve();
  }));
  await Promise.race([started, exit.then(() => { throw new Error(errors || 'Sync command exited before startup'); })]);
  const health = await fetch(`http://127.0.0.1:${syncPort}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).mode, 'private');
  assert.equal((await fetch(`http://127.0.0.1:${adminPort}/admin/`)).status, 200);
  await assert.rejects(fetch(`http://127.0.0.1:${setupPort}/admin/`));
  assert.equal(output.includes((await readFile(join(dir, 'admin-token'), 'utf8')).trim()), false);
});

test('managed local sync authenticates admin and devices, accounts, invitation quotas and recovery', async t => {
  const env = await fixture(t), server = env.server, base = server.syncUrl;
  assert.equal((await fetch(server.adminUrl + '/admin/status')).status, 401);
  assert.equal((await fetch(base + '/ledger/')).status, 404);
  assert.equal((await post(base, '/ledger/sync', { account: gameKey('41'), balances: [], events: [] })).status, 401);
  const operator = await admin(server);
  assert.equal((await operator.get('/ledger/')).status, 200);
  assert.equal((await operator.send('limit', { limit: 3 })).status, 200);
  const inviteA = await invite(operator), inviteB = await invite(operator, { group: inviteA.group });
  const regA = bindBody(inviteA), regB = bindBody(inviteB, '42');
  const [boundA, boundB] = await Promise.all([post(base, '/v1/bind', regA), post(base, '/v1/bind', regB)]);
  assert.deepEqual([boundA.status, boundB.status].sort(), [200, 403]);
  const accepted = boundA.ok ? regA : regB;
  const reply = await (boundA.ok ? boundA : boundB).json();
  assert.deepEqual(await (await post(base, '/v1/bind', accepted)).json(), reply);
  assert.equal((await operator.send('limit', { limit: 1 })).status, 200);
  const overLimit = await invite(operator);
  assert.equal((await (await post(base, '/v1/bind', bindBody(overLimit, '43'))).json()).error, 'account_limit');
  assert.equal((await post(base, '/ledger/sync', { account: gameKey('91'), balances: [], events: [] }, auth(accepted.device))).status, 403);
  const expired = await invite(operator, { hours: 1 });
  env.advance(3600001);
  assert.equal((await post(base, '/v1/bind', bindBody(expired))).status, 403);
  const locked = await invite(operator);
  const body = bindBody(locked);
  for (let i = 0; i < 5; i++) {
    const response = await post(base, '/v1/bind', { ...body, pin: locked.pin === '0726' ? '0727' : '0726' });
    assert.equal((await response.json()).error, 'wrong_pin');
  }
  assert.equal((await (await post(base, '/v1/bind', body)).json()).error, 'invitation_unavailable');
  const next = await createPairingRequest(webcrypto);
  const recovered = { device: token(), requestId: next.id, request: next.code, recovery: accepted.recovery, gameKey: accepted.gameKey };
  assert.deepEqual(await (await post(base, '/v1/recover', recovered)).json(), reply);
  let status = await (await operator.get('/admin/status')).json();
  assert.equal(status.active, 1);
  assert.equal(status.groups.find(group => group.id === overLimit.group).remaining, 1);
  const response = await post(base, '/ledger/sync', { account: accepted.gameKey, balances: [], events: [], pull: { version: null, offset: 0 } }, auth(recovered.device));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).account, accepted.gameKey);
  const match = { account: accepted.gameKey, matches: [{ gameId: '111', mode: 26, rawMode: 132, rawGroup: 3,
    endedAt: env.now(), duration: 33, result: 0, general: [1], position: 4 }] };
  assert.equal((await post(base, '/appearances/sync', match, auth(accepted.device))).status, 200);
  assert.equal((await (await post(base, '/appearances/sync', { account: accepted.gameKey, matches: [] }, auth(recovered.device))).json()).matches.length, 1);
  const device = status.devices[0];
  assert.equal((await operator.send('revoke', { type: 'account', id: device.account })).status, 200);
  assert.equal((await post(base, '/appearances/sync', { account: accepted.gameKey, matches: [] }, auth(accepted.device))).status, 401);
  status = await (await operator.get('/admin/status')).json();
  assert.equal(status.active, 0);
  for (const data of [accepted.recovery, accepted.device, inviteA.code]) assert.equal(JSON.stringify(status).includes(data), false);
});

test('four-digit invitations bind installations and share five isolated accounts', async t => {
  const { server } = await fixture(t), base = server.syncUrl, operator = await admin(server);
  const request = () => privateInvite(base, operator);
  assert.equal((await operator.send('private/credential', {})).status, 409);
  const expired = await request(), valid = await request();
  const installation = token(), owner = { ...bindBody(valid), installation };
  assert.equal((await post(base, '/v1/bind', { ...bindBody(expired), installation: token() })).status, 403);
  const first = await post(base, '/v1/bind', owner);
  assert.equal(first.status, 200);
  const firstAccount = (await first.json()).account;
  assert.equal((await post(base, '/v1/bind', { ...owner, device: token() })).status, 403);
  const secondPin = { ...bindBody(await request()), installation: token() };
  const second = await post(base, '/v1/bind', secondPin);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).account, firstAccount);
  const join = id => ({ installation, gameKey: gameKey(id), recovery: token(), device: token() });
  assert.equal((await post(base, '/v1/private/join', { ...join(42), installation: token() })).status, 401);
  const entries = await Promise.all([42, 43, 44, 45].map(async id => {
    const body = join(id);
    const response = await post(base, '/v1/private/join', body);
    assert.equal(response.status, 200);
    return { ...body, ...await response.json() };
  }));
  assert.equal((await post(base, '/v1/private/join', join(46))).status, 409);
  const isolated = await post(base, '/ledger/sync', { account: owner.gameKey, balances: [], events: [] }, auth(entries[0].device));
  assert.equal(isolated.status, 403);
  const view = await (await post(base, '/v1/private/view', {}, auth(entries[0].device))).json();
  assert.equal((await fetch(base + '/ledger/?view=' + view.view)).status, 200);
  assert.equal((await operator.send('revoke', { type: 'account', id: entries[0].account })).status, 200);
  assert.equal((await post(base, '/v1/private/join', join(42))).status, 403);
  assert.equal((await fetch(base + '/ledger/?view=' + view.view)).status, 404);
  assert.equal((await post(base, '/v1/private/join', join(46))).status, 200);
  assert.equal((await operator.send('public/enable', { confirm: '转为公共' })).status, 426);
  assert.equal((await operator.send('release-installation', {})).status, 200);
  assert.equal((await post(base, '/v1/private/join', join(41))).status, 401);
});

test('upgrading a single-installation store keeps the original primary and automatically joined accounts', async t => {
  const fixtureState = await fixture(t), { server } = fixtureState, base = server.syncUrl, operator = await admin(server);
  const invite = await privateInvite(base, operator);
  const primary = { ...bindBody(invite), installation: token() };
  const primaryId = (await (await post(base, '/v1/bind', primary)).json()).account;
  const second = { gameKey: gameKey(42), installation: primary.installation, device: token(), recovery: token() };
  const secondId = (await (await post(base, '/v1/private/join', second)).json()).account;
  await server.close();
  const previous = openState(join(fixtureState.dir, 'sync.sqlite3'), 0, fixtureState.now);
  previous.transaction(() => {
    previous.set('privateOwner', { digest: previous.privateOwner().digest, requestId: invite.request.id, request: invite.request.code });
    previous.db.exec('DELETE FROM private_installations; UPDATE devices SET installation = NULL');
  });
  previous.close();
  const upgraded = await fixtureState.start(), after = await admin(upgraded);
  const state = await (await after.get('/admin/status')).json();
  assert.deepEqual(state.accounts.map(({ id, role }) => ({ id, role })), [{ id: primaryId, role: 'main' }, { id: secondId, role: 'child' }]);
  assert.equal(state.installationCount, 1);
  assert.equal((await post(upgraded.syncUrl, '/v1/private/view', {}, auth(second.device))).status, 200);
  const switched = await post(upgraded.syncUrl, '/v1/private/join', { ...second, gameKey: gameKey(43), device: token(), recovery: token() });
  assert.equal(switched.status, 200);
});

test('device labels update on confirmation and a saved name follows the installation across accounts', async t => {
  const env = await fixture(t), { server } = env, base = server.syncUrl, operator = await admin(server);
  const invite = await privateInvite(base, operator);
  const first = { ...bindBody(invite), installation: token() };
  assert.equal((await post(base, '/v1/bind', first)).status, 200);
  const second = { gameKey: gameKey(42), installation: first.installation, device: token(), recovery: token() };
  assert.equal((await post(base, '/v1/private/join', second)).status, 200);
  const status = async adminClient => (await (await adminClient.get('/admin/status')).json()).devices;
  const before = await status(operator);
  assert.equal(before.length, 2);
  assert.ok(before.every(row => !row.client && !row.system && row.deviceName === null));
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
  const confirmDevice = async (device, clientInfo, agent = edge) => {
    const { challenge } = await proof(base, invite.decoded.signer);
    return post(base, '/v1/confirm', { challenge, clientInfo }, { ...auth(device), 'User-Agent': agent });
  };
  assert.equal((await confirmDevice(token(), { windows: 11 })).status, 401);
  assert.equal((await confirmDevice(first.device)).status, 200);
  assert.ok((await status(operator)).every(row => row.client === 'Edge' && row.system === 'Windows'));
  assert.equal((await confirmDevice(first.device, { windows: 11 })).status, 200);
  assert.equal((await confirmDevice(second.device)).status, 200);
  assert.ok((await status(operator)).every(row => row.client === 'Edge' && row.system === 'Windows 11'));
  assert.equal((await operator.send('device/name', { id: before[0].id, name: 'bad\nname' })).status, 400);
  assert.equal((await operator.send('device/name', { id: before[0].id, name: ' DESKTOP-EXAMPLE ' })).status, 200);
  const electron = edge.replace('Edg/143.0.0.0', 'Electron/10.4.7');
  assert.equal((await confirmDevice(first.device, { microclient: true }, electron)).status, 200);
  assert.equal((await confirmDevice(second.device, undefined, electron)).status, 200);
  await server.close();
  const restarted = await admin(await env.start());
  assert.ok((await status(restarted)).every(row => row.client === '微端' && row.system === 'Windows 11' && row.deviceName === 'DESKTOP-EXAMPLE'));
  assert.equal((await restarted.send('device/name', { id: before[1].id, name: '' })).status, 200);
  assert.ok((await status(restarted)).every(row => row.deviceName === null));
});

test('primary credentials bind another device, follow ownership transfer and restore migrated history', async t => {
  const source = await fixture(t), base = source.server.syncUrl, operator = await admin(source.server);
  const first = { ...bindBody(await privateInvite(base, operator)), installation: token(), userCode: '41' };
  const firstReply = await post(base, '/v1/bind', first);
  assert.equal(firstReply.status, 200);
  const main = (await firstReply.json()).account;
  const issue = async (adminClient, game) => {
    const response = await adminClient.send('private/credential', {});
    assert.equal(response.status, 200);
    const { code } = await response.json();
    await assert.rejects(openPrivateCredential(webcrypto, gameKey(game === 41 ? 42 : 41), code));
    return openPrivateCredential(webcrypto, gameKey(game), code);
  };
  const opened = await issue(operator, 41);
  assert.equal(opened.origin, base);
  const device = await privateCredentialBody(opened, 41);
  const redeem = (body, url = base) => post(url, '/v1/private/bind-credential', body);
  const wrong = await redeem({ ...device, gameKey: gameKey(42) });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error, 'account_mismatch');
  assert.equal((await redeem({ ...device, userCode: '42' })).status, 403);
  for (let retry = 0; retry < 2; retry++) {
    const response = await redeem(device);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).account, main);
  }
  assert.equal((await redeem({ ...device, device: token(), installation: token() })).status, 403);
  assert.equal((await post(base, '/v1/private/release', { installation: device.installation })).status, 200);
  assert.equal((await post(base, '/v1/private/view', {}, auth(first.device))).status, 200);
  assert.equal((await post(base, '/v1/private/view', {}, auth(device.device))).status, 401);

  assert.equal((await operator.send('private/edit-child', { userCode: '0000000042' })).status, 404);
  assert.equal((await operator.send('private/view', { id: main })).status, 404);
  const switchTo = (id, installation = first.installation, url = base) => {
    const values = { installation, gameKey: gameKey(id), recovery: token(), device: token() };
    return { values, response: post(url, '/v1/private/join', values) };
  };
  const child = switchTo(42), childReply = await child.response;
  assert.equal(childReply.status, 200);
  const childId = (await childReply.json()).account;
  const saveMatch = (key, bearer) => post(base, '/appearances/sync', { account: key, matches: [
    { gameId: '999', mode: 26, rawMode: 132, rawGroup: 3, endedAt: source.now(), duration: 33, result: 0, general: [1], position: 4 },
  ] }, auth(bearer));
  assert.equal((await saveMatch(gameKey(42), child.values.device)).status, 200);
  const ledger = await post(base, '/ledger/sync', { account: gameKey(42), balances: [], events: [],
    profile: { userCode: '0000000042', name: '附属演练', session: { id: 'primary-test', at: 3000 } },
  }, auth(child.values.device));
  assert.equal(ledger.status, 200);
  assert.equal((await operator.send('revoke', { type: 'account', id: childId })).status, 200);
  assert.equal((await switchTo(42).response).status, 403);
  const earlyPair = { ...bindBody(await privateInvite(base, operator), '42'), installation: token() };
  assert.equal((await post(base, '/v1/bind', earlyPair)).status, 403);
  assert.equal((await post(base, '/v1/private/view', {}, auth(child.values.device))).status, 401);
  assert.equal((await operator.send('private/restore-child', { id: childId })).status, 200);
  const restored = switchTo(42), restoredReply = await restored.response;
  assert.equal(restoredReply.status, 200);
  assert.equal((await restoredReply.json()).account, childId);
  const restoredMatches = await post(base, '/appearances/sync', { account: gameKey(42), matches: [] }, auth(restored.values.device));
  assert.equal((await restoredMatches.json()).matches.length, 1);

  const oldGrant = await issue(operator, 41);
  assert.equal((await operator.send('private/promote-child', { id: childId })).status, 200);
  assert.equal((await redeem(await privateCredentialBody(oldGrant, 41))).status, 403);
  const removed = await operator.send('revoke', { type: 'account', id: main });
  assert.equal(removed.status, 200);
  const recoveryDeadline = (await removed.json()).accounts.find(row => row.id === main).recoverUntil;
  assert.equal(recoveryDeadline - source.now(), 30 * 86400000);
  await source.server.close();

  const destination = await fixture(t, { relocate: true, seed: async dir => {
    for (const name of ['sync.sqlite3', 'store.json', 'store.json.ledger']) await copyFile(join(source.dir, name), join(dir, name));
  } });
  const target = destination.server.syncUrl, targetAdmin = await admin(destination.server);
  const migrationCode = await issue(targetAdmin, 42);
  assert.equal(migrationCode.origin, target);
  const migrated = await privateCredentialBody(migrationCode, 42);
  const migratedReply = await redeem(migrated, target);
  assert.equal(migratedReply.status, 200);
  assert.equal((await migratedReply.json()).account, childId);
  const history = await post(target, '/appearances/sync', { account: gameKey(42), matches: [] }, auth(migrated.device));
  assert.equal((await history.json()).matches[0].gameId, '999');
  const recovered = await targetAdmin.send('private/restore-child', { id: main });
  assert.equal(recovered.status, 200);
  const oldMain = switchTo(41, migrated.installation, target), oldReply = await oldMain.response;
  assert.equal(oldReply.status, 200);
  assert.equal((await oldReply.json()).account, main);
  const match = { gameId: '998', mode: 26, rawMode: 132, rawGroup: 3, endedAt: destination.now(), duration: 33, result: 0, general: [1], position: 4 };
  assert.equal((await post(target, '/appearances/sync', { account: gameKey(41), matches: [match] }, auth(oldMain.values.device))).status, 200);
  assert.equal((await post(target, '/ledger/sync', { account: gameKey(41), balances: [], events: [],
    profile: { userCode: '0000000041', name: '待移除账号', session: { id: 'cleanup-test', at: destination.now() } },
  }, auth(oldMain.values.device))).status, 200);
  const beforeExpiry = await targetAdmin.send('revoke', { type: 'account', id: main });
  assert.equal(beforeExpiry.status, 200);
  for (const name of ['store.json', 'store.json.ledger']) assert.ok(Object.hasOwn(JSON.parse(await readFile(join(destination.dir, name))), main));
  destination.advance(30 * 86400000);
  await destination.server.settle();
  const afterExpiry = await admin(destination.server);
  assert.equal((await afterExpiry.send('private/restore-child', { id: main })).status, 409);
  for (const name of ['store.json', 'store.json.ledger']) assert.ok(!Object.hasOwn(JSON.parse(await readFile(join(destination.dir, name))), main));
  assert.equal((await switchTo(41, migrated.installation, target).response).status, 403);
  const freshPair = { ...bindBody(await privateInvite(target, afterExpiry), '41'), installation: token() };
  assert.equal((await post(target, '/v1/bind', freshPair)).status, 200);
  const freshMatches = await post(target, '/appearances/sync', { account: gameKey(41), matches: [] }, auth(freshPair.device));
  assert.deepEqual((await freshMatches.json()).matches, []);
});

test('public vault keeps record IDs open, authenticates ciphertext, merges concurrent writes and persists IP lockout', async () => {
  let time = Date.now();
  const state = openState(':memory:', 0, () => time);
  try {
    const vaults = openPublicVaults(state, () => time), entry = {
      origin: 'https://localhost:17429', vault: token(), seed: token(), credential: token(), password: randomPass(webcrypto),
    };
    const cipher = await createVaultCipher(webcrypto, entry);
    assert.match(entry.password, /[2-9]/);
    assert.match(entry.password, /[A-Z]/);
    const post = async (_, path, body) => {
      if (path.endsWith('/register')) return vaults.register(body);
      return vaults.exchange(body);
    };
    const first = createPublicTransport(webcrypto, post), second = createPublicTransport(webcrypto, post);
    await first.register(entry);
    const match = (id, general) => ({ gameId: id, mode: 26, endedAt: time, result: 0, duration: 8, general });
    await Promise.all([first.exchange(entry, entry.origin, '/appearances/sync', { matches: [match('12345', [321])] }),
      second.exchange(entry, entry.origin, '/appearances/sync', { matches: [match('12346', [121])] })]);
    const reply = await first.exchange(entry, entry.origin, '/appearances/sync', { matches: [] });
    assert.deepEqual(reply.matches.map(row => row.gameId).sort(), ['12345', '12346']);
    const raw = vaults.exchange({ ...entry, revision: -1, records: [] });
    assert.deepEqual(raw.records.map(row => row[1]).sort(), ['12345', '12346']);
    assert.equal(JSON.stringify(raw).includes('general'), false);
    assert.throws(() => vaults.exchange({ ...entry, credential: token(), revision: -1, records: [] }), /binding_required/);
    await assert.rejects(cipher.open([raw.records[0][0], '5555', raw.records[0][2]]));
    const wrong = (await createVaultCipher(webcrypto, { ...entry, password: entry.password + '9' })).verifier;
    for (let i = 0; i < 49; i++) assert.throws(() => vaults.preview({ ...entry, verifier: wrong }, '192.0.2.1'), /invalid_view/);
    assert.throws(() => vaults.preview({ ...entry, verifier: wrong }, '192.0.2.1'), /view_locked/);
    const restarted = openPublicVaults(state, () => time);
    const correct = { vault: entry.vault, verifier: cipher.verifier };
    assert.throws(() => restarted.preview(correct, '192.0.2.1'), /view_locked/);
    assert.equal(restarted.preview(correct, '192.0.2.2').records.length, 2);
    time += 30 * 60000;
    assert.equal(restarted.preview(correct, '192.0.2.1').records.length, 2);
  } finally { state.close(); }
});

test('public account limits survive restart and apply only to new bindings', async t => {
  const env = await fixture(t);
  const filename = join(env.dir, 'sync.sqlite3');
  const registrations = Array.from({ length: 11 }, () => ({ vault: token(), credential: token(), verifier: token() }));
  let state = openState(filename, 0, Date.now);
  try {
    const vaults = openPublicVaults(state, Date.now);
    assert.deepEqual(vaults.accountStatus(), { active: 0, limit: 10 });
    for (const entry of registrations.slice(0, 10)) vaults.register(entry);
    assert.throws(() => vaults.register(registrations[10]), { status: 409, message: 'account_limit' });
    assert.throws(() => vaults.setAccountLimit(-1), { status: 400, message: 'invalid_public_account_limit' });
    vaults.setAccountLimit(1);
    vaults.register(registrations[0]);
    assert.doesNotThrow(() => vaults.authenticate(registrations[0]));
    assert.deepEqual(vaults.accountStatus(), { active: 10, limit: 1 });
  } finally { state.close(); }

  state = openState(filename, 0, Date.now);
  try {
    const vaults = openPublicVaults(state, Date.now);
    assert.deepEqual(vaults.accountStatus(), { active: 10, limit: 1 });
    vaults.setAccountLimit(10);
    vaults.revoke(registrations[0].vault);
    assert.throws(() => vaults.register(registrations[0]), { status: 401, message: 'binding_required' });
    vaults.register(registrations[10]);
    assert.deepEqual(vaults.accountStatus(), { active: 10, limit: 10 });
  } finally { state.close(); }
});

test('the managed service keeps existing history and moves an explicitly linked account to device authentication', async t => {
  const id = gameKey('41'), now = Date.now();
  const match = { gameId: '213', mode: 26, rawMode: 132, rawGroup: 3, endedAt: now, duration: 120, result: 0, general: [1], position: 4 };
  const event = { id: 'old-expense', session: 'old-login', at: now, kind: 'goods',
    source: 'DbsCcUserGoodshintNtf', type: 8, items: [{ id: 20260001, name: '祈福灯', delta: 7 }] };
  const env = await fixture(t, { legacy: true, async seed(dir) {
    const old = await startAppearanceSync({ port: 0, file: join(dir, 'store.json') });
    const base = `http://127.0.0.1:${old.address().port}`;
    try {
      assert.equal((await post(base, '/appearances/sync', { account: id, matches: [match] })).status, 200);
      assert.equal((await post(base, '/ledger/sync', { account: id, balances: [], events: [event],
        profile: { userCode: '0000000041', name: '已有账本', session: { id: event.session, at: now } } })).status, 200);
    } finally { await stop(old); }
  } });
  let server = env.server;
  const first = server.syncUrl, operator = await admin(server);
  assert.equal((await (await operator.get('/admin/status')).json()).existingAccounts[0].key, id);
  const before = (await (await post(first, '/appearances/sync', { account: id, matches: [] })).json()).matches;
  assert.equal(before.length, 1);
  assert.equal((await post(first, '/appearances/sync', { account: gameKey('42'), matches: [] })).status, 401);
  assert.match((await fetch(first + '/ledger/', { redirect: 'manual' })).headers.get('location'), /\/admin\/$/);
  const ticket = await invite(operator, { legacyKey: id });
  const wrongAccount = await post(first, '/v1/bind', bindBody(ticket, '42'));
  assert.equal((await wrongAccount.json()).error, 'account_mismatch');
  const body = bindBody(ticket);
  const binding = await post(first, '/v1/bind', body);
  assert.equal(binding.status, 200);
  const { account } = await binding.json();
  assert.notEqual(account, id);
  assert.equal((await post(first, '/appearances/sync', { account: id, matches: [] })).status, 401);
  assert.equal((await post(first, '/appearances/sync', { account, matches: [] })).status, 401);
  assert.equal((await (await operator.get('/admin/status')).json()).existingAccounts.length, 0);
  assert.equal((await operator.send('invite', { request: ticket.request.code, uses: 1, hours: 24, legacyKey: id })).status, 409);
  await server.close();
  server = await env.start();
  const headers = auth(body.device);
  assert.deepEqual((await (await post(server.syncUrl, '/appearances/sync', { account: id, matches: [] }, headers)).json()).matches, before);
  const ledger = await post(server.syncUrl, '/ledger/sync', { account: id, balances: [], events: [], pull: { version: null, offset: 0 } }, headers);
  assert.equal(ledger.status, 200);
  assert.equal((await ledger.json()).download.events[0].id, event.id);
  assert.equal((await post(server.syncUrl, '/ledger/sync', { account: id, balances: [], events: [] })).status, 401);
});

test('a staged local port needs an authenticated confirmation and persists the 60-minute grace period', async t => {
  const env = await fixture(t);
  let { server } = env, operator = await admin(server);
  const old = server.syncUrl, slot = await listen();
  const busyPort = slot.address().port;
  const item = await invite(operator), registration = bindBody(item);
  assert.equal((await post(old, '/v1/bind', registration)).status, 200);
  assert.equal((await operator.send('network', { port: busyPort, tls: false })).status, 409);
  await stop(slot);
  const nextPort = await freePort(), target = `http://127.0.0.1:${nextPort}`;
  assert.equal((await operator.send('network', { port: nextPort, tls: false })).status, 200);
  assert.equal((await proof(old, item.decoded.signer)).next, target);
  assert.equal((await fetch(target + '/health')).status, 200);
  const candidateProof = await proof(target, item.decoded.signer);
  assert.equal((await post(target, '/v1/confirm', { challenge: candidateProof.challenge }, auth(token()))).status, 401);
  assert.equal((await (await operator.get('/admin/status')).json()).candidate.deadline, null);
  env.advance(61 * 60000);
  await server.settle();
  assert.equal((await fetch(old + '/health')).status, 200);
  const valid = await proof(target, item.decoded.signer);
  assert.equal((await post(target, '/v1/confirm', { challenge: valid.challenge }, auth(registration.device))).status, 200);
  const firstConfirmation = env.now();
  const status = await (await operator.get('/admin/status')).json();
  assert.equal(status.candidate.deadline, firstConfirmation + 60 * 60000);
  const update = await (await operator.send('update-code', { id: status.devices[0].id })).json();
  assert.equal((await openPairing(update.code, PAIR_UPDATE, () => item.request.keys)).port, nextPort);
  env.advance(59 * 60000);
  await server.close();
  server = await env.start();
  operator = await admin(server);
  assert.equal((await (await operator.get('/admin/status')).json()).candidate.deadline, firstConfirmation + 60 * 60000);
  assert.equal((await fetch(old + '/health')).status, 200);
  env.advance(60000);
  await server.settle();
  await assert.rejects(fetch(old + '/health'));
  assert.equal((await fetch(target + '/health')).status, 200);
  const later = await freePort();
  assert.equal((await operator.send('network', { port: later, tls: false })).status, 200);
  const staged = `http://127.0.0.1:${later}`;
  const pending = await proof(staged, item.decoded.signer);
  assert.equal((await post(staged, '/v1/confirm', { challenge: pending.challenge }, auth(registration.device))).status, 200);
  await server.close();
  const collision = await listen(later);
  try {
    server = await env.start();
    operator = await admin(server);
    assert.equal((await (await operator.get('/admin/status')).json()).candidate.confirmedAt, null);
    assert.equal((await fetch(target + '/health')).status, 200);
  } finally { await stop(collision); }
  env.advance(5001);
  await server.settle();
  assert.equal((await fetch(staged + '/health')).status, 200);
  assert.equal((await (await operator.get('/admin/status')).json()).candidate.deadline, null);
  assert.equal((await operator.send('cancel', {})).status, 200);
  await assert.rejects(fetch(staged + '/health'));
});

async function testCertificate(dir, domain = 'localhost') {
  const certPath = join(dir, 'cert.pem'), keyPath = join(dir, 'key.pem');
  const args = ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:' + domain, '-keyout', keyPath, '-out', certPath];
  const openssl = process.platform === 'win32' ? ['openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'] : ['openssl'];
  for (const command of openssl) {
    try {
      execFileSync(command, args, { stdio: 'ignore' });
      const [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
      return { cert, key };
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

test('the HTTP admin URL survives first setup and HTTPS login', async t => {
  const setupPort = await freePort();
  let code, password;
  const env = await fixture(t, { setupHost: '127.0.0.1', setupPort, publicNetwork: true, privateNetwork: true, httpsAdmin: true,
    async seed(dir) { password = await resetAdminPassword(dir); code = await createSetupCode(dir); } });
  const setup = `http://127.0.0.1:${setupPort}`;
  assert.match(await (await fetch(setup + '/admin/')).text(), /data-initial-setup/);
  assert.equal((await fetch(setup + '/health')).status, 404);
  assert.equal((await post(setup, '/admin/login', { token: code }, { Origin: site })).status, 403);
  assert.equal((await post(setup, '/admin/login', { token: password }, { Origin: setup })).status, 200);
  const setupLogin = await post(setup, '/admin/login', { token: code }, { Origin: setup });
  assert.equal(setupLogin.status, 200);
  const Cookie = setupLogin.headers.get('set-cookie').split(';')[0];
  assert.match(Cookie, /^sgs_sync_http_admin=/);
  assert.equal((await fetch(env.server.adminUrl + '/admin/status', { headers: { Cookie } })).status, 401);
  const status = await (await fetch(setup + '/admin/status', { headers: { Cookie } })).json();
  assert.equal(status.initialSetup, true);
  assert.equal(Object.hasOwn(status, 'accounts'), false);
  const setupPost = (path, body) => post(setup, '/admin/' + path, body, { Origin: setup, Cookie });
  assert.equal((await setupPost('password', { current: code, password: 'NewPassword1' })).status, 403);
  assert.equal((await setupPost('network', { port: 8888, domain: 'sync.example.test', tls: false })).status, 403);
  const domain = 'sync.example.test', port = await freePort();
  const network = { port, domain, tls: true };
  let response = await setupPost('network', network);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'setup_pem_missing');
  const certificate = await testCertificate(env.dir, domain);
  if (!certificate) return t.skip('OpenSSL CLI unavailable');
  await writeFile(join(env.dir, 'setup-fullchain.pem'), certificate.cert);
  await writeFile(join(env.dir, 'setup-privkey.pem'), certificate.key);
  assert.equal((await setupPost('network', network)).status, 200);
  assert.equal((await setupPost('public/enable', { confirm: '转为公共' })).status, 200);
  const authority = `${domain}:${port}`;
  const secure = value => new Promise((resolve, reject) => {
    const request = httpsRequest({ host: '127.0.0.1', port, path: '/admin/login', servername: domain, ca: certificate.cert,
      method: 'POST', headers: { Host: authority, Origin: 'https://' + authority, 'Content-Type': 'application/json' } },
    result => { result.resume(); resolve(result.statusCode); });
    request.on('error', reject).end(JSON.stringify({ token: value }));
  });
  assert.equal(await secure(code), 401);
  assert.equal(await secure(password), 200);
  await assert.rejects(readFile(join(env.dir, 'initial-setup.json')), { code: 'ENOENT' });
  const panel = await (await fetch(setup + '/admin/')).text();
  assert.match(panel, /data-http-admin/);
  assert.doesNotMatch(panel, /data-initial-setup/);
  assert.equal((await setupPost('status', {})).status, 401);
  assert.equal((await post(setup, '/admin/login', { token: code }, { Origin: setup })).status, 401);
  assert.equal((await post(setup, '/admin/login', { token: password }, { Origin: setup })).status, 200);
});

test('the default HTTP admin listener needs no preselected hostname and survives setup-code expiry', async t => {
  const setupPort = await freePort();
  let code, password;
  const env = await fixture(t, { httpAdminEnabled: true, setupPort,
    async seed(dir) { code = await createSetupCode(dir); password = await resetAdminPassword(dir); } });
  const setup = `http://127.0.0.1:${setupPort}`;
  assert.equal((await fetch(setup + '/admin/')).status, 200);
  assert.equal((await fetch(setup + '/health')).status, 404);
  env.advance(61 * 60_000);
  assert.equal((await post(setup, '/admin/login', { token: code }, { Origin: setup })).status, 401);
  assert.equal((await post(setup, '/admin/login', { token: password }, { Origin: setup })).status, 200);
});

test('a signed-in administrator can rename and close the persistent HTTP entry', async t => {
  const env = await fixture(t), setupPort = await freePort();
  const operator = await admin(env.server);
  const config = { path: 'admin', enabled: true, host: '127.0.0.1', port: setupPort };
  const base = `http://127.0.0.1:${setupPort}`;
  assert.equal((await operator.send('entry', { ...config, path: '/v1' })).status, 400);
  assert.equal((await operator.send('entry', { ...config, port: Number(new URL(env.server.syncUrl).port) })).status, 409);
  assert.equal((await operator.send('entry', config)).status, 200);
  assert.equal((await fetch(base + '/health')).status, 404);
  const password = (await readFile(env.server.adminFile, 'utf8')).trim();
  const login = async path => {
    const response = await post(base, path + '/login', { token: password }, { Origin: base });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie');
  };
  const Cookie = (await login('/admin')).split(';')[0];
  const input = { ...config, path: '/sync-panel/' };
  assert.equal((await post(base, '/admin/entry', input, { Origin: site, Cookie })).status, 403);
  const renamed = await post(base, '/admin/entry', input, { Origin: base, Cookie });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).adminEntry.httpUrl, base + '/sync-panel/');
  assert.equal((await fetch(base + '/admin/')).status, 404);
  assert.equal((await fetch(base + '/sync-panel', { redirect: 'manual' })).headers.get('location'), '/sync-panel/');
  assert.match(await (await fetch(base + '/sync-panel/')).text(), /\.\/app.js/);
  assert.equal((await fetch(base + '/sync-panel/app.js')).status, 200);
  assert.equal((await fetch(env.server.adminUrl + '/admin/')).status, 200);
  await env.server.close();
  await env.start();
  assert.equal((await fetch(base + '/admin/')).status, 404);
  const nextCookie = await login('/sync-panel');
  assert.match(nextCookie, /Path=\/sync-panel\//);
  const disabled = await post(base, '/sync-panel/entry', { ...input, enabled: false }, { Origin: base, Cookie: nextCookie.split(';')[0] });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).adminEntry.httpUrl, null);
  await assert.rejects(fetch(base + '/sync-panel/'));
  await env.server.close();
  await env.start();
  await assert.rejects(fetch(base + '/sync-panel/'));
  assert.equal((await fetch(env.server.adminUrl + '/admin/')).status, 200);
});

test('loopback TLS validates certificate names and restricts plaintext redirects', async t => {
  const env = await fixture(t), operator = await admin(env.server);
  const certificate = await testCertificate(env.dir);
  if (!certificate) return t.skip('OpenSSL CLI unavailable');
  const { cert, key } = certificate;
  const port = await freePort(), redirectPort = await freePort();
  const initial = await invite(operator), registration = bindBody(initial);
  assert.equal((await post(env.server.syncUrl, '/v1/bind', registration)).status, 200);
  assert.equal((await operator.send('network', { port, tls: true, domain: 'other.localhost', cert, key })).status, 400);
  assert.equal((await operator.send('public/enable', { confirm: '转为公共' })).status, 426);
  assert.equal((await operator.send('network', { port, tls: true, cert, key, redirectPort })).status, 200);
  assert.equal((await post(env.server.syncUrl, '/v1/bind', {})).status, 426);
  const discovery = await post(env.server.syncUrl, '/v1/proof', { nonce: token(16) });
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json()).next, `https://127.0.0.1:${port}`);
  const secure = (port, path, data) => new Promise((resolve, reject) => {
    const body = data && JSON.stringify(data);
    const request = httpsRequest(`https://127.0.0.1:${port}${path}`, { ca: cert, method: body ? 'POST' : 'GET',
      headers: { Origin: site, 'Content-Type': 'application/json', ...auth(registration.device) } }, async response => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
      } catch (error) { reject(error); }
    });
    request.on('error', reject).end(body);
  });
  assert.equal((await secure(port, '/health')).status, 200);
  const redirect = `http://127.0.0.1:${redirectPort}`;
  const response = await fetch(redirect, { redirect: 'manual' });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), `https://127.0.0.1:${port}/`);
  assert.equal((await post(redirect, '/v1/bind', {})).status, 426);
  const status = await (await operator.get('/admin/status')).json();
  assert.equal(status.candidate.tls, true);
  assert.equal(status.mode, 'private');
  assert.equal(status.httpsReady, true);
  assert.equal(status.httpsRequired, true);
  assert.equal(JSON.stringify(status).includes('PRIVATE KEY'), false);
  const migrate = async port => {
    const { body } = await secure(port, '/v1/proof', { nonce: token(16) });
    assert.equal((await secure(port, '/v1/confirm', { challenge: body.challenge })).status, 200);
    env.advance(60 * 60000);
    await env.server.settle();
  };
  await migrate(port);
  const nextPort = await freePort();
  assert.equal((await operator.send('network', { port: nextPort, tls: true, redirectPort })).status, 200);
  assert.equal((await fetch(redirect + '/health', { redirect: 'manual' })).headers.get('location'), `https://127.0.0.1:${port}/health`);
  await migrate(nextPort);
  assert.equal((await fetch(redirect + '/health', { redirect: 'manual' })).headers.get('location'), `https://127.0.0.1:${nextPort}/health`);
  env.advance(3 * 86400_000);
  assert.equal((await (await admin(env.server)).send('public/enable', { confirm: '转为公共' })).status, 426);
});

test('HTTPS admin requires a password and limits sessions to the authenticated origin', async t => {
  const domain = 'sync.example.test';
  const env = await fixture(t, { publicNetwork: true, privateNetwork: true, httpsAdmin: true });
  const certificate = await testCertificate(env.dir, domain);
  if (!certificate) return t.skip('OpenSSL CLI unavailable');
  const operator = await admin(env.server), port = await freePort();
  assert.equal((await operator.send('network', { port, domain, tls: true, ...certificate })).status, 200);
  const authority = domain + ':' + port;
  const origin = 'https://' + authority;
  const secure = (path, payload, headers) => new Promise((resolve, reject) => {
    const request = httpsRequest(`https://127.0.0.1:${port}${path}`, {
      servername: domain, ca: certificate.cert, method: payload ? 'POST' : 'GET',
      headers: { Host: authority, Origin: origin, 'Content-Type': 'application/json', ...headers },
    }, async response => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() });
      } catch (error) { reject(error); }
    });
    request.on('error', reject).end(payload ? JSON.stringify(payload) : undefined);
  });
  assert.notEqual((await secure('/admin/')).status, 200);
  assert.equal((await operator.send('public/enable', { confirm: '转为公共' })).status, 200);
  const previousHttp = await fetch(env.server.syncUrl + '/updates/lite/toolbox.user.js', { redirect: 'manual' });
  assert.equal(previousHttp.status, 308);
  assert.equal(previousHttp.headers.get('location'), origin + '/updates/lite/toolbox.user.js');
  assert.equal((await post(env.server.syncUrl, '/v2/vault/register', {})).status, 426);

  const redirect = await secure('/admin');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/admin/');
  const landing = await secure('/admin/');
  assert.equal(landing.status, 200);
  assert.match(landing.text, /管理员登录/);
  assert.equal(landing.headers['cache-control'], 'no-store');
  assert.equal((await secure('/admin/status')).status, 401);
  const password = (await readFile(env.server.adminFile, 'utf8')).trim();
  assert.equal((await secure('/admin/login', { token: password }, { Origin: site })).status, 403);
  assert.equal((await secure('/admin/login', { token: token() })).status, 401);
  const loggedIn = await secure('/admin/login', { token: password });
  assert.equal(loggedIn.status, 200);
  const [cookie] = loggedIn.headers['set-cookie'];
  assert.match(cookie, /^__Host-sgs_sync_admin=/);
  assert.match(cookie, /Path=\/; HttpOnly; SameSite=Strict;.*; Secure$/);
  const Cookie = cookie.split(';')[0];
  const status = await secure('/admin/status', null, { Cookie });
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.text).mode, 'public');
  assert.equal(JSON.parse(status.text).publicPreview, true);
  assert.equal(JSON.parse(status.text).updates.url, origin + '/updates');
  assert.equal((await secure('/admin/public/preview', { enabled: false }, { Cookie })).status, 200);
  assert.equal(JSON.parse((await secure('/admin/status', null, { Cookie })).text).publicPreview, false);
  assert.equal((await fetch(env.server.adminUrl + '/admin/status', { headers: { Cookie } })).status, 401);
  assert.equal((await secure('/admin/status', null, { Cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await secure('/admin/public/limit', { limit: 3 }, { Cookie, Origin: site })).status, 403);
  assert.equal((await secure('/admin/public/limit', { limit: 10 }, { Cookie })).status, 200);

  for (let i = 0; i < 10; i++) assert.equal((await secure('/admin/login', { token: token() })).status, 401);
  assert.equal((await secure('/admin/login', { token: password })).status, 429);
  assert.equal((await operator.get('/admin/status')).status, 200);
  env.advance(60_000);
  const relogin = await secure('/admin/login', { token: password });
  assert.equal(relogin.status, 200);
  const session = relogin.headers['set-cookie'][0].split(';')[0];
  const change = await secure('/admin/entry', { path: 'maintenance', enabled: false, host: '', port: 17431 }, { Cookie: session });
  assert.equal(change.status, 200);
  assert.equal(JSON.parse(change.text).adminEntry.httpsUrl, origin + '/maintenance/');
  assert.equal((await secure('/admin/')).status, 404);
  assert.equal((await secure('/maintenance/')).status, 200);
  assert.equal((await secure('/maintenance/status', null, { Cookie: session })).status, 200);
  assert.equal((await operator.get('/admin/status')).status, 200);
});
