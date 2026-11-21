import http from 'node:http';
import https from 'node:https';
import { createSecureContext } from 'node:tls';
import { randomBytes, randomInt, sign, webcrypto, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isIPv4 } from 'node:net';
import { base64url, readPairingRequest, sealPairing, syncProofBytes } from '../../src/core/sync-pairing-code.js';
import { sealPrivateCredential } from '../../src/core/private-sync-code.js';
import { describeSyncDevice } from './device-info.mjs';
import { vaultRecords } from '../../src/core/sync-vault-records.js';
import { EXISTING_SYNC_FILE, openAppearanceSyncData, readJson, send, syncOrigins } from '../appearance-sync.mjs';
import { equal, hash, isToken, openState, requireValue, SyncError, token } from './state.mjs';
import { openPublicVaults, VAULT_BYTES } from './public-vault.mjs';
import { openPrivatePreferences } from './preferences.mjs';
import { PREFERENCES_LIMIT, PREFERENCES_SYNC_PATH } from '../../src/shared/sync-preferences.js';
import { SYNC_SOURCE_HEADER } from '../../src/shared/private-sync-http.js';
import { openUpdateMirror } from './update-mirror.mjs';
import { openServerUpdate } from './server-update.mjs';

const host = '127.0.0.1';
const grace = 60 * 60000;
const settings = { requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 2000 };
const assets = { '/admin/': ['index.html', 'text/html'], '/admin/app.js': ['app.js', 'text/javascript'], '/admin/style.css': ['style.css', 'text/css'] };
const pairingPaths = new Set(['/v1/proof', '/v1/bind', '/v1/recover', '/v1/confirm', '/v1/unbind',
  '/v1/private/request', '/v1/private/join', '/v1/private/release', '/v1/private/view', '/v1/private/bind-credential', PREFERENCES_SYNC_PATH]);
const vaultPaths = new Set(['/v2/vault/register', '/v2/vault/exchange', '/v2/vault/view', '/v2/migrate/read', '/v2/migrate/stage']);
const nonceFormat = /^[A-Za-z0-9_-]{22}$/;
const maxAdminBody = 128 * 1024;
const httpUrl = port => new URL(`http://${host}:${port}`).origin;
const endpointUrl = ({ tls, domain, port }) => new URL(`${tls ? 'https' : 'http'}://${domain || host}:${port}`).origin;
const asInvite = config => ({ ...config, ipv4: host, local: true });
const isLocalDomain = domain => !domain || /^(?:[a-z0-9-]+\.)*localhost$/.test(domain) || /^127\./.test(domain);

const listen = (server, port, address = host) => new Promise((ready, reject) => {
  server.once('error', reject);
  server.listen(port, address, () => { server.off('error', reject); ready(); });
});
const closeServer = server => new Promise(done => {
  if (!server?.listening) return done();
  server.close(done);
  server.closeIdleConnections();
});
function safeHandler(handler) {
  return (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    Promise.resolve().then(() => handler(request, response)).catch(error => {
      if (response.destroyed) return;
      if (response.headersSent) return response.destroy();
      const status = error instanceof SyncError ? error.status : error instanceof RangeError ? 413 : error instanceof SyntaxError ? 400 : 500;
      send(response, status, { error: error instanceof SyncError ? error.message : status === 500 ? 'storage_error' : 'invalid_request' });
    });
  };
}
async function readPost(request, limit) {
  requireValue(request.method === 'POST', 'method_not_allowed', 405);
  requireValue(/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? ''), 'invalid_type', 415);
  const body = await readJson(request, limit);
  requireValue(body && typeof body === 'object' && !Array.isArray(body));
  return body;
}
function validateConfig(input, previous, external, privateMode) {
  const { port, tls, redirectPort = 0 } = input;
  const domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : '';
  requireValue(Number.isInteger(port) && port > 0 && port <= 65535
    && Number.isInteger(redirectPort) && redirectPort >= 0 && redirectPort <= 65535
    && (!redirectPort || tls && redirectPort !== port) && typeof tls === 'boolean', 'invalid_port');
  const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  requireValue(!domain || domain.length <= 253 && (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*localhost$/.test(domain)
    || external && (isIPv4(domain) ? privateMode : dnsName.test(domain))), 'invalid_loopback_domain');
  if (!tls) return { port, tls, domain, redirectPort };
  const cert = input.cert || previous.cert;
  const key = input.key || previous.key;
  requireValue(typeof cert === 'string' && typeof key === 'string' && cert.length <= 65536 && key.length <= 16384, 'invalid_certificate');
  try {
    const blocks = cert.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    if (!blocks.length || cert.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim()) throw new Error();
    const chain = blocks.map(block => new X509Certificate(block));
    for (const [index, item] of chain.entries()) {
      if (Date.now() < Date.parse(item.validFrom) || Date.now() >= Date.parse(item.validTo)) throw new Error();
      if (index && (!chain[index - 1].checkIssued(item) || !chain[index - 1].verify(item.publicKey))) throw new Error();
    }
    if (domain && !isIPv4(domain) ? !chain[0].checkHost(domain, { subject: 'never' }) : !chain[0].checkIP(domain || host)) throw new Error();
    createSecureContext({ key, cert, minVersion: 'TLSv1.2' });
    return { port, tls, domain, redirectPort, cert, key, certificateExpires: chain[0].validTo };
  } catch { throw new SyncError(400, 'invalid_certificate'); }
}

function statusOf(config) {
  const { port, tls, domain, redirectPort, certificateExpires } = config;
  return { port, tls, domain, redirectPort, certificateExpires };
}

export async function startManagedSync({ dataDir, dataFile, catalogue, legacy = false, port = 17429, adminPort = 17430, now = Date.now,
  interval = true, allowedOrigins = syncOrigins, publicNetwork = false, privateNetwork = false, relocate = false, legacyInvitations = false,
  httpsAdmin = false, updateFetch, updateToken, serverUpdateDir } = {}) {
  requireValue(!httpsAdmin || publicNetwork, 'https_admin_requires_public_network');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const adminFile = join(dataDir, 'admin-token');
  try { await writeFile(adminFile, token() + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const adminDigest = hash((await readFile(adminFile, 'utf8')).trim());
  const store = openState(join(dataDir, 'sync.sqlite3'), port, now);
  const vaults = openPublicVaults(store, now);
  const preferences = openPrivatePreferences(store);
  let data;
  try { data = await openAppearanceSyncData({ file: dataFile ?? join(dataDir, 'store.json'), catalogue }); }
  catch (error) { store.close(); throw error; }
  const updates = await openUpdateMirror({ dataDir, enabled: () => store.get('updateMirror') !== false,
    auto: interval, fetchImpl: updateFetch, token: updateToken, now });
  const serverUpdate = openServerUpdate(serverUpdateDir);
  let network = store.get('network'), active, candidate, admin, counter, closed = false, migrationError = '', retryAt = 0;
  let legacyPort = legacy ? store.get('legacyPort') : null;
  let pending = Promise.resolve();
  const sessions = new Map(), attempts = new Map(), httpsAdminAttempts = new Map(), privateRequests = new Map();
  const publicMode = () => store.get('mode') === 'public';
  const externalSync = () => publicMode() ? publicNetwork : privateNetwork;
  const externalEndpoint = config => externalSync() && !isLocalDomain(config.domain) && (config.tls || !publicMode());
  const publicConfig = () => [candidate?.config, active?.config].find(config => config?.tls);
  const canPreview = () => publicMode() && store.get('publicPreview') !== false;
  const snapshot = key => {
    const dataSnapshot = data.snapshot(key);
    const saved = preferences.snapshot(key);
    if (Object.keys(saved).length) dataSnapshot.preferences = saved;
    return { snapshot: dataSnapshot, fingerprint: hash(JSON.stringify(dataSnapshot)) };
  };
  const activeHistory = () => [...new Map([...preferences.accounts(), ...data.listAccounts()].map(row => [row.key, row])).values()]
    .filter(({ key }) => !store.isArchivedStore(key));
  const migrationStatus = () => activeHistory().map(({ key, label }) => ({
    key, label, ready: vaults.staged(key, snapshot(key).fingerprint), hasStage: vaults.hasStage(key),
  }));
  function confirmCandidate(listener, remote) {
    if (externalEndpoint(listener.config) && remote === host) return;
    if (listener === candidate && !network.candidate.confirmedAt) {
      save({ ...network, candidate: { ...network.candidate, confirmedAt: now() } });
    }
  }
  async function finishConversion() {
    await data.clearPlaintext();
    preferences.clear();
    store.clearPrivateCredentials();
    vaults.clearMigrationIndex();
    store.set('plaintextCleanupPending', false);
  }
  async function purgeRemoved() {
    const expired = store.archivedStores().filter(row => row.recoverUntil <= now());
    if (!expired.length) return;
    await data.serialize(async () => {
      for (const row of expired) {
        await data.removeAccount(row.storeKey);
        preferences.remove(row.storeKey);
        if (vaults.hasStage(row.storeKey)) vaults.resetStage(row.storeKey);
        store.markPurged(row.id);
      }
    });
  }
  const existingKeyFor = key => typeof key === 'string' && data.hasAccount(key) && !store.isManagedStore(key) ? key : null;
  function prunePrivateRequests() {
    for (const [pin, item] of privateRequests) if (now() >= item.expires) privateRequests.delete(pin);
  }

  async function issuePrivate(pin) {
    prunePrivateRequests();
    const item = privateRequests.get(pin);
    requireValue(item, 'private_request_expired', 404);
    const inviteToken = token();
    const entry = store.issue({ ...item, inviteToken, privatePair: true });
    try {
      const code = await sealPairing(item.recipient, asInvite((candidate ?? active).config),
        Math.floor(entry.expires / 1000), store.identity.signer, inviteToken);
      privateRequests.delete(pin);
      return { code };
    } catch (error) { store.revoke('invitation', entry.id); throw error; }
  }
  const save = next => { store.set('network', next); network = next; };
  function serialize(work) {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  }
  function attempt(key, limit, duration, attemptsBySource = attempts) {
    const time = now();
    if (attemptsBySource.size >= 1024) {
      for (const [key, attempt] of attemptsBySource) if (attempt.until <= time) attemptsBySource.delete(key);
      requireValue(attemptsBySource.size < 1024 || attemptsBySource.has(key), 'rate_limited', 429);
    }
    const previous = attemptsBySource.get(key);
    const entry = !previous || previous.until <= time ? { until: time + duration, count: 0 } : previous;
    entry.count++;
    attemptsBySource.set(key, entry);
    requireValue(entry.count <= limit, 'rate_limited', 429);
  }
  const checkHost = (request, expected, external = false) => requireValue((external || request.socket.remoteAddress === host)
    && expected.includes(request.headers.host), 'invalid_host', 403);
  function redirectToHttps(request, response, config) {
    requireValue(config && (request.method === 'GET' || request.method === 'HEAD'), 'https_required', 426);
    const path = request.url.startsWith('/') && !request.url.startsWith('//') ? request.url : '/';
    return response.writeHead(308, { Location: endpointUrl(config) + path }).end();
  }

  async function openData(config, enabled = true, previous = null) {
    const listener = { config, enabled, challenges: new Map(), redirect: null };
    const handler = safeHandler(async (request, response) => {
      requireValue(listener.enabled, 'listener_unavailable', 503);
      const current = listener.config;
      const origins = [current.domain, host].filter(Boolean).map(domain => endpointUrl({ ...current, domain }));
      const external = externalEndpoint(current);
      const authorities = current.domain && (current.tls || external) ? origins.slice(0, 1) : origins;
      checkHost(request, authorities.map(origin => new URL(origin).host), external);
      if (publicMode() && !current.tls) return redirectToHttps(request, response, publicConfig());
      const browserOrigin = request.headers.origin;
      const bridgeOrigin = request.headers[SYNC_SOURCE_HEADER.toLowerCase()];
      const usingBridge = !current.tls && external && request.method === 'POST' && allowedOrigins.has(bridgeOrigin) &&
        (!browserOrigin || /^(?:null|(?:chrome|moz|safari-web)-extension:\/\/[^/]+)$/.test(browserOrigin));
      const origin = usingBridge ? bridgeOrigin : browserOrigin;
      if (httpsAdmin && publicMode() && current.tls && (request.url === '/admin' || request.url.startsWith('/admin/'))) {
        return handleAdmin(request, response, origins[0]);
      }
      if (request.url.startsWith('/updates/')) return updates.serve(request, response);
      if (request.method === 'GET' && request.url === '/health') {
        return send(response, 200, { ok: true, service: 'appearances-sync', mode: publicMode() ? 'public' : 'private' });
      }
      if (!pairingPaths.has(request.url) && !vaultPaths.has(request.url)) {
        requireValue(!publicMode(), 'public_mode_required', 404);
        const url = new URL(request.url, origins[0]);
        if (url.pathname === '/ledger/' || url.pathname === '/ledger/read') {
          const view = url.searchParams.get('view');
          if (view !== null) {
            const previewAccount = store.privatePreview(view);
            requireValue(previewAccount, 'not_found', 404);
            return data.handle(request, response, { preview: true, previewAccount, previewUrl: url.pathname,
              allowPreviewAccount: key => store.privatePreview(view) === key });
          }
        }
        if (['/ledger/preview.css', '/ledger/preview.js'].includes(request.url)) return data.handle(request, response, { preview: true });
        const compatibility = current.port === legacyPort && !request.headers.authorization;
        if (compatibility && request.method === 'GET' && request.url === '/ledger/' && admin?.listening) {
          return response.writeHead(302, { Location: httpUrl(admin.address().port) + '/admin/' }).end();
        }
        return data.handle(request, response, { allowedOrigins, origin, preview: false,
          device: store.authenticate(request.headers.authorization), legacy: compatibility && !usingBridge,
          deviceStillAuthorized: () => Boolean(store.authenticate(request.headers.authorization)),
          allowLegacyAccount: compatibility ? key => data.hasAccount(key) && !store.isManagedStore(key) : undefined,
          canWrite: key => publicMode() ? 'public_mode_required' : vaults.hasStage(key) ? 'migration_staged' : true });
      }
      requireValue(allowedOrigins.has(origin), 'origin_not_allowed', 403);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'POST');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (request.headers['access-control-request-private-network'] === 'true') response.setHeader('Access-Control-Allow-Private-Network', 'true');
        return response.writeHead(204).end();
      }
      if (vaultPaths.has(request.url)) {
        requireValue(current.tls, 'https_required', 426);
        const migrating = request.url.startsWith('/v2/migrate/');
        const body = await readPost(request, request.url.endsWith('/stage') || request.url.endsWith('/exchange') ? VAULT_BYTES : 4096);
        if (migrating) {
          return data.serialize(() => {
            requireValue(!publicMode(), 'public_mode_required', 409);
            const device = store.authenticate(request.headers.authorization);
            requireValue(device, 'binding_required', 401);
            const row = snapshot(device.storeKey);
            if (request.url.endsWith('/read')) return send(response, 200, row);
            requireValue(row.fingerprint === body.fingerprint, 'migration_records_changed', 409);
            const keys = vaultRecords(row.snapshot).map(([kind, id]) => kind + ':' + id);
            vaults.stage(device.storeKey, row.fingerprint, keys, body);
            return send(response, 200, { ok: true });
          });
        }
        requireValue(publicMode(), 'not_public', 409);
        if (request.url.endsWith('/register')) {
          attempt('vault-register:' + request.socket.remoteAddress, 15, 3600000);
          vaults.register(body);
          return send(response, 200, { signer: store.identity.signer, revision: network.revision });
        }
        if (request.url.endsWith('/exchange')) {
          const reply = vaults.exchange(body);
          await serialize(() => confirmCandidate(listener, request.socket.remoteAddress));
          return send(response, 200, reply);
        }
        requireValue(canPreview(), 'public_preview_disabled', 403);
        return send(response, 200, vaults.preview(body, request.socket.remoteAddress));
      }
      if (request.url === PREFERENCES_SYNC_PATH) {
        const body = await readPost(request, PREFERENCES_LIMIT + 4096);
        return data.serialize(() => {
          requireValue(!publicMode(), 'public_mode_required', 409);
          const device = store.authenticate(request.headers.authorization);
          requireValue(device, 'binding_required', 401);
          requireValue(body.account === device.gameKey, 'account_mismatch', 403);
          requireValue(body.values === undefined || !vaults.hasStage(device.storeKey), 'migration_staged', 409);
          return send(response, 200, preferences.exchange(device.storeKey, body));
        });
      }
      const body = await readPost(request, 4096);
      const address = authorities.find(value => new URL(value).host === request.headers.host);
      if (publicMode()) requireValue(current.tls && request.url === '/v1/proof', 'public_mode_required', 409);
      if (request.url === '/v1/private/request') {
        attempt('request:' + request.socket.remoteAddress, 10, 60000);
        const recipient = await readPairingRequest(webcrypto, body.request).catch(() => null);
        requireValue(recipient, 'invalid_pairing_request');
        prunePrivateRequests();
        requireValue(privateRequests.size < 100, 'rate_limited', 429);
        let pin;
        do { pin = String(randomInt(10000)).padStart(4, '0'); } while (privateRequests.has(pin));
        privateRequests.set(pin, { recipient, request: body.request.trim(), requestId: base64url(recipient.id), expires: now() + 5 * 60000 });
        return send(response, 200, { pin });
      }
      if (request.url === '/v1/private/join') {
        attempt('join:' + request.socket.remoteAddress, 30, 60000);
        return send(response, 200, store.joinPrivate(body, existingKeyFor(body.gameKey)));
      }
      if (request.url === '/v1/private/bind-credential') {
        attempt('private-credential:' + request.socket.remoteAddress, 20, 60000);
        const recipient = await readPairingRequest(webcrypto, body.request).catch(() => null);
        requireValue(recipient && base64url(recipient.id) === body.requestId, 'invalid_pairing_request');
        return send(response, 200, store.bindPrivateGrant(body));
      }
      if (request.url === '/v1/private/release') {
        store.detachInstallation(body.installation);
        return send(response, 200, { ok: true });
      }
      if (request.url === '/v1/proof') {
        requireValue(typeof body.nonce === 'string' && nonceFormat.test(body.nonce), 'invalid_nonce');
        const time = now();
        if (listener.challenges.size >= 256) {
          for (const [key, expires] of listener.challenges) if (expires <= time) listener.challenges.delete(key);
          if (listener.challenges.size >= 256) listener.challenges.delete(listener.challenges.keys().next().value);
        }
        const challenge = randomBytes(16).toString('base64url');
        listener.challenges.set(challenge, time + 60000);
        const proof = { nonce: body.nonce, origin: address, revision: network.revision, challenge,
          next: listener === active && candidate?.enabled ? endpointUrl(candidate.config) : null };
        const signature = sign('sha256', syncProofBytes(proof), { key: store.identity.privateKey, dsaEncoding: 'ieee-p1363' });
        return send(response, 200, { ...proof, signature: signature.toString('base64url') });
      }
      if (request.url === '/v1/bind') {
        attempt('bind:' + request.socket.remoteAddress, 120, 60000);
        return send(response, 200, store.bind(body, existingKeyFor(body.gameKey)));
      }
      if (request.url === '/v1/recover') {
        attempt('recover:' + request.socket.remoteAddress, 20, 60000);
        const recipient = await readPairingRequest(webcrypto, body.request).catch(() => null);
        requireValue(recipient && base64url(recipient.id) === body.requestId, 'invalid_pairing_request');
        return send(response, 200, store.recover(body));
      }
      const device = store.authenticate(request.headers.authorization);
      requireValue(device, 'binding_required', 401);
      if (request.url === '/v1/private/view') {
        return send(response, 200, { view: store.privateViewToken(device.account) });
      }
      if (request.url === '/v1/unbind') {
        store.revoke('device', device.id);
        return send(response, 200, { ok: true });
      }
      requireValue(listener.challenges.get(body.challenge) > now(), 'invalid_challenge', 403);
      listener.challenges.delete(body.challenge);
      store.noteDevice(device, describeSyncDevice(request.headers['user-agent'], body.clientInfo));
      await serialize(() => confirmCandidate(listener, request.socket.remoteAddress));
      return send(response, 200, { ok: true });
    });
    listener.server = config.tls
      ? https.createServer({ ...settings, cert: config.cert, key: config.key, minVersion: 'TLSv1.2' }, handler)
      : http.createServer(settings, handler);
    await listen(listener.server, config.port, externalEndpoint(config) ? '0.0.0.0' : host);
    listener.config = { ...config, port: listener.server.address().port };
    try {
      if (config.redirectPort) {
        listener.redirect = previous?.config.redirectPort === config.redirectPort
          ? previous.redirect : await openRedirect(listener, config.redirectPort);
      }
    } catch (error) { await closeServer(listener.server); throw error; }
    return listener;
  }
  async function openRedirect(listener, port) {
    const redirect = { listener };
    redirect.server = http.createServer(settings, safeHandler((request, response) => {
      requireValue(redirect.listener.enabled, 'listener_unavailable', 503);
      const current = redirect.listener.config;
      checkHost(request, [host, current.domain].filter(Boolean).map(domain => new URL(`http://${domain}:${port}`).host), externalSync() && Boolean(current.domain));
      return redirectToHttps(request, response, current);
    }));
    await listen(redirect.server, port, (publicNetwork || privateNetwork) && listener.config.domain ? '0.0.0.0' : host);
    return redirect;
  }
  const closeData = async (listener, retained = null) => {
    if (!listener) return;
    listener.enabled = false;
    await Promise.all([closeServer(listener.server), listener.redirect !== retained && closeServer(listener.redirect?.server)]);
  };
  async function settle() {
    await purgeRemoved();
    if (!network.candidate || closed) return;
    if (!candidate && retryAt <= now()) {
      try {
        candidate = await openData(network.candidate.config, true, active);
        migrationError = '';
      } catch {
        retryAt = now() + 5000;
        migrationError = 'candidate_unavailable';
        if (network.candidate.confirmedAt !== null) save({ ...network, candidate: { ...network.candidate, confirmedAt: null } });
      }
    }
    const confirmedAt = network.candidate.confirmedAt;
    if (!candidate || confirmedAt === null || now() < confirmedAt + grace) return;
    const previous = active;
    save({ active: candidate.config, candidate: null, revision: network.revision });
    active = candidate;
    if (active.redirect) active.redirect.listener = active;
    candidate = null;
    await closeData(previous, active.redirect);
  }
  async function changeNetwork(input) {
    requireValue(!network.candidate, 'migration_in_progress', 409);
    const config = validateConfig(input, active.config, externalSync(), !publicMode());
    requireValue(!publicMode() || config.tls, 'https_required', 426);
    requireValue(!publicMode() || !publicNetwork || config.domain && !/(^|\.)localhost$/.test(config.domain), 'public_domain_required');
    const adminPort = admin.address().port;
    requireValue(config.port !== adminPort && config.redirectPort !== adminPort, 'port_in_use', 409);
    if (config.port === active.config.port) {
      requireValue(config.tls === active.config.tls && config.domain === active.config.domain, 'new_port_required', 409);
      const oldRedirect = active.redirect;
      let redirect = oldRedirect;
      try {
        if (config.redirectPort !== active.config.redirectPort) redirect = config.redirectPort ? await openRedirect(active, config.redirectPort) : null;
        if (config.tls) active.server.setSecureContext({ key: config.key, cert: config.cert, minVersion: 'TLSv1.2' });
        save({ ...network, active: config });
      } catch (error) {
        if (redirect !== oldRedirect) await closeServer(redirect?.server);
        if (config.tls) active.server.setSecureContext({ key: active.config.key, cert: active.config.cert, minVersion: 'TLSv1.2' });
        throw error;
      }
      active.config = config;
      active.redirect = redirect;
      if (oldRedirect !== redirect) await closeServer(oldRedirect?.server);
      return;
    }
    const next = await openData(config, false, active);
    try {
      save({ ...network, revision: network.revision + 1, candidate: { config: next.config, confirmedAt: null } });
      candidate = next;
      candidate.enabled = true;
      migrationError = '';
      retryAt = 0;
    } catch (error) { await closeData(next, active.redirect); throw error; }
  }
  async function cancelNetwork() {
    const previous = candidate;
    if (!network.candidate) return;
    requireValue(!publicMode() || active.config.tls, 'https_required', 426);
    save({ ...network, revision: network.revision + 1, candidate: null });
    candidate = null;
    migrationError = '';
    await closeData(previous, active.redirect);
  }
  async function status() {
    const serverUpdateStatus = await serverUpdate.status();
    const staged = network.candidate;
    const shared = publicMode(), tls = publicConfig();
    const info = store.list(), labels = new Map(shared ? [] : data.listAccounts().map(row => [row.key, row.label]));
    return { ...info, accounts: shared ? [] : info.accounts.map(row => ({ ...row, label: labels.get(row.storeKey) ?? row.userCode })),
      activeEndpoint: statusOf(network.active),
      mode: shared ? 'public' : 'private', publicUrl: tls ? endpointUrl(tls) : null, publicPreview: canPreview(), publicNetwork,
      privateNetwork: !shared && privateNetwork,
      recoveryPending: !shared && store.archivedStores().length > 0,
      updates: { ...updates.status(), url: endpointUrl(active.config) + '/updates' },
      serverUpdate: serverUpdateStatus,
      publicAccounts: shared ? vaults.accountStatus() : null,
      vaults: shared ? vaults.list() : [],
      migration: !shared && tls ? migrationStatus() : [],
      existingAccounts: !shared && legacy ? activeHistory().filter(row => !store.isManagedStore(row.key)).map(({ key, label }) => ({ key, label })) : [],
      candidate: staged ? { ...statusOf(staged.config), listening: Boolean(candidate), confirmedAt: staged.confirmedAt,
        deadline: staged.confirmedAt === null ? null : staged.confirmedAt + grace, error: migrationError } : null };
  }

  async function handleAdmin(request, response, adminAddress) {
    const secure = adminAddress.startsWith('https:');
    const site = request.headers['sec-fetch-site'];
    const landing = request.method === 'GET' && ['/admin', '/admin/'].includes(request.url)
      && request.headers['sec-fetch-mode'] === 'navigate';
    requireValue(!site || site === 'none' || site === 'same-origin' || landing, 'origin_not_allowed', 403);
    if (request.method === 'POST') requireValue(request.headers.origin === adminAddress, 'origin_not_allowed', 403);
    response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.method === 'GET' && request.url === '/admin') {
      return response.writeHead(308, { Location: '/admin/' }).end();
    }
    const cookieName = secure ? '__Host-sgs_sync_admin' : 'sgs_sync_admin';
    const cookie = (request.headers.cookie ?? '').split(';').map(value => value.trim())
      .find(value => value.startsWith(cookieName + '='));
    const sessionKey = cookie?.slice(cookieName.length + 1);
    const session = isToken(sessionKey) && sessions.get(hash(sessionKey));
    const loggedIn = session && session.origin === adminAddress && session.expires > now();
    if (request.url === '/admin/login') {
      const body = await readPost(request, 1024);
      if (secure) attempt(request.socket.remoteAddress, 12, 60000, httpsAdminAttempts);
      else attempt('admin-login', 12, 60000);
      requireValue(isToken(body.token) && equal(hash(body.token), adminDigest), 'invalid_admin_token', 401);
      for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
      if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
      const session = token();
      sessions.set(hash(session), { origin: adminAddress, expires: now() + 8 * 3600000 });
      response.setHeader('Set-Cookie', `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}`);
      return send(response, 200, { ok: true });
    }
    if (request.method === 'GET' && Object.hasOwn(assets, request.url)) {
      const [file, type] = assets[request.url];
      response.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      return response.end(await readFile(new URL('./' + file, import.meta.url)));
    }
    requireValue(loggedIn, 'admin_required', 401);
    if (request.url.startsWith('/ledger/')) {
      requireValue(!publicMode(), 'public_mode_required', 404);
      return data.handle(request, response, { preview: true, allowPreviewAccount: key => !store.isArchivedStore(key) });
    }
    if (request.method === 'GET' && request.url === '/admin/status') return send(response, 200, await status());
    const body = await readPost(request, maxAdminBody);
    if (publicMode()) requireValue(['/admin/network', '/admin/cancel', '/admin/public/preview', '/admin/public/revoke',
      '/admin/public/limit', '/admin/updates', '/admin/server-update'].includes(request.url),
      'public_mode_required', 409);
    switch (request.url) {
      case '/admin/public/enable':
        requireValue(body.confirm === '转为公共', 'confirmation_required', 400);
        await serialize(async () => {
          await purgeRemoved();
          await data.serialize(async () => {
            requireValue(!publicMode(), 'public_mode_required', 409);
            requireValue(publicConfig(), 'https_required', 426);
            requireValue(!publicNetwork || publicConfig().domain && !/(^|\.)localhost$/.test(publicConfig().domain), 'public_domain_required', 400);
            requireValue(!store.archivedStores().length, 'recovery_pending', 409);
            requireValue(migrationStatus().every(row => row.ready), 'history_not_staged', 409);
            store.transaction(() => {
              store.set('mode', 'public');
              store.set('plaintextCleanupPending', true);
            });
            await finishConversion();
          });
        });
        break;
      case '/admin/public/reset-stage':
        vaults.resetStage(body.key);
        break;
      case '/admin/public/preview':
        requireValue(publicMode() && typeof body.enabled === 'boolean');
        store.set('publicPreview', body.enabled);
        break;
      case '/admin/public/limit':
        requireValue(publicMode(), 'not_public', 409);
        vaults.setAccountLimit(body.limit);
        break;
      case '/admin/updates':
        requireValue(typeof body.enabled === 'boolean');
        store.set('updateMirror', body.enabled);
        if (body.enabled) void updates.check();
        break;
      case '/admin/server-update':
        await serverUpdate.request(body.action, body.version);
        break;
      case '/admin/public/revoke':
        requireValue(publicMode() && isToken(body.id));
        vaults.revoke(body.id);
        break;
      case '/admin/network':
        await serialize(() => changeNetwork(body)).catch(error => {
          if (error.code === 'EADDRINUSE' || error.code === 'EACCES') throw new SyncError(409, 'port_unavailable');
          throw error;
        });
        break;
      case '/admin/cancel':
        await serialize(cancelNetwork);
        break;
      case '/admin/limit':
        requireValue(legacyInvitations, 'not_found', 404);
        store.setLimit(body.limit);
        break;
      case '/admin/revoke':
        await serialize(() => data.serialize(() => store.revoke(body.type, body.id)));
        break;
      case '/admin/release-installation':
        await serialize(() => data.serialize(() => store.releasePrivate()));
        break;
      case '/admin/private/invite':
        return send(response, 200, await serialize(() => issuePrivate(body.pin)));
      case '/admin/private/credential':
        return send(response, 200, await serialize(async () => {
          const { gameKey, grant, expires } = store.issuePrivateGrant();
          const origin = endpointUrl((candidate ?? active).config);
          return { expires, code: await sealPrivateCredential(webcrypto, gameKey, { origin, signer: store.identity.signer, grant }) };
        }));
      case '/admin/private/restore-child':
        await serialize(() => data.serialize(() => store.restoreChild(body.id)));
        break;
      case '/admin/private/promote-child':
        await serialize(() => store.promoteChild(body.id));
        break;
      case '/admin/device/name':
        store.nameDevice(body.id, body.name);
        break;
      case '/admin/invite': {
        requireValue(legacyInvitations, 'not_found', 404);
        requireValue(typeof body.request === 'string', 'invalid_pairing_request');
        const legacyKey = body.legacyKey ?? null;
        requireValue(legacyKey === null || legacy && typeof legacyKey === 'string' && data.hasAccount(legacyKey)
          && !store.isManagedStore(legacyKey), 'existing_account_unavailable', 409);
        const recipient = await readPairingRequest(webcrypto, body.request).catch(() => null);
        requireValue(recipient, 'invalid_pairing_request');
        const inviteToken = token();
        const entry = store.issue({ ...body, legacyKey, request: body.request.trim(), requestId: base64url(recipient.id), inviteToken });
        try {
          const code = await sealPairing(recipient, asInvite((candidate ?? active).config), Math.floor(entry.expires / 1000), store.identity.signer, inviteToken);
          return send(response, 200, { ...entry, code });
        } catch (error) { store.revoke('invitation', entry.id); throw error; }
      }
      case '/admin/update-code': {
        const request = store.deviceRequest(body.id);
        requireValue(request, 'not_found', 404);
        const recipient = await readPairingRequest(webcrypto, request);
        const code = await sealPairing(recipient, asInvite((candidate ?? active).config), Math.floor(now() / 1000) + 86400, store.identity.signer);
        return send(response, 200, { code });
      }
      default: throw new SyncError(404, 'not_found');
    }
    return send(response, 200, await status());
  }
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(counter);
    await pending;
    await Promise.all([closeData(active), closeData(candidate, active?.redirect), closeServer(admin), updates.close()]);
    await data.close();
    store.close();
  }
  try {
    if (relocate) {
      requireValue(!publicMode() && store.privateOwner(), 'primary_required', 409);
      store.transaction(() => {
        store.db.exec('DELETE FROM private_grants');
        save({ active: { port, tls: false, domain: '', redirectPort: 0 }, candidate: null, revision: network.revision + 1 });
      });
      if (legacy) legacyPort = null;
    }
    if (publicMode() && store.get('plaintextCleanupPending')) {
      await finishConversion();
    }
    active = await openData(network.active);
    if (network.active.port === 0) save({ ...network, active: active.config });
    if (legacy && legacyPort === null) {
      legacyPort = active.config.port;
      store.set('legacyPort', legacyPort);
    }
    await serialize(settle);
    admin = http.createServer(settings, safeHandler((request, response) => {
      const address = httpUrl(admin.address().port);
      checkHost(request, [new URL(address).host]);
      return handleAdmin(request, response, address);
    }));
    await listen(admin, adminPort);
    if (interval) counter = setInterval(() => { void serialize(settle).catch(() => { migrationError = 'storage_error'; }); }, 1000);
  } catch (error) { await close(); throw error; }
  return { adminUrl: httpUrl(admin.address().port), adminFile, get syncUrl() { return endpointUrl(active.config); },
    settle: () => serialize(settle), checkUpdates: updates.check, close };
}

export async function runManagedSync(args) {
  const { values } = parseArgs({ args, options: {
    'data-dir': { type: 'string', default: 'data/appearance-sync' },
    port: { type: 'string', default: '17429' },
    'admin-port': { type: 'string', default: '17430' },
    'existing-data': { type: 'boolean', default: false },
    'public-network': { type: 'boolean', default: false },
    'https-admin': { type: 'boolean', default: false },
    'server-update-dir': { type: 'string' },
    'private-network': { type: 'boolean', default: false },
    relocate: { type: 'boolean', default: false },
  } });
  const port = Number(values.port), adminPort = Number(values['admin-port']);
  if (![port, adminPort].every(value => Number.isInteger(value) && value >= 1 && value <= 65535) || port === adminPort) throw new Error('端口无效');
  const legacy = values['existing-data'];
  if (legacy) await readFile(EXISTING_SYNC_FILE).catch(error => {
    if (error.code === 'ENOENT') throw new Error('现有同步数据文件不存在');
    throw error;
  });
  const service = await startManagedSync({ dataDir: resolve(values['data-dir']), port, adminPort,
    dataFile: legacy ? EXISTING_SYNC_FILE : undefined, legacy, publicNetwork: values['public-network'],
    privateNetwork: values['private-network'], httpsAdmin: values['https-admin'], relocate: values.relocate,
    updateToken: process.env.SGS_TOOLBOX_GITHUB_READ_TOKEN,
    serverUpdateDir: values['server-update-dir'] && resolve(values['server-update-dir']) });
  console.log('账本与战绩同步 ' + service.syncUrl);
  console.log('同步管理页 ' + service.adminUrl + '/admin/');
  console.log('管理员登录凭据文件 ' + service.adminFile);
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => { void service.close(); });
}
