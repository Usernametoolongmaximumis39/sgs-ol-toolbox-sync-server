import { createHash, createHmac, generateKeyPairSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { base64url, fromBase64url, PIN_FORMAT } from '../../src/core/sync-pairing-code.js';
import { syncAccountSeed } from '../../src/core/dev-appearance-sync.js';

const recoveryPeriod = 30 * 86400000;
const grantPeriod = 15 * 60000;

export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const isToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isRequestId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
export const equal = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export class SyncError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
export function requireValue(condition, code = 'invalid_request', status = 400) {
  if (!condition) throw new SyncError(status, code);
}

export function openState(path, port, now) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invite_groups (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, remaining INTEGER NOT NULL, revoked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS invitations (
      digest TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES invite_groups(id), request_id TEXT NOT NULL, request TEXT NOT NULL,
      pin TEXT NOT NULL, tries INTEGER DEFAULT 0, revoked INTEGER DEFAULT 0, redeemed_by TEXT
    );
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, game_key TEXT NOT NULL, recovery TEXT UNIQUE NOT NULL, revoked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL, request TEXT NOT NULL, revoked INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS private_installations (
      digest TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, request TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_grants (
      digest TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL, redeemed_by TEXT
    );
    CREATE TABLE IF NOT EXISTS device_profiles (id TEXT PRIMARY KEY, client TEXT, system TEXT, name TEXT);
  `);
  const get = key => JSON.parse(db.prepare('SELECT value FROM state WHERE key = ?').get(key)?.value ?? 'null');
  const set = (key, value) => db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(key, JSON.stringify(value));
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = work(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  transaction(() => {
    for (const table of ['invitations', 'accounts']) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'legacy_key')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN legacy_key TEXT`);
      }
    }
    for (const [table, column, type = 'TEXT'] of [['invitations', 'private_pair'], ['accounts', 'installation'],
      ['accounts', 'view_digest'], ['accounts', 'view_token'], ['accounts', 'user_code'], ['devices', 'installation'],
      ['accounts', 'removed_at', 'INTEGER'], ['accounts', 'purged', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(field => field.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS accounts_legacy_key ON accounts (legacy_key) WHERE legacy_key IS NOT NULL');
  });
  const identity = transaction(() => {
    const current = get('identity');
    if (current) return current;
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    const signer = base64url(Buffer.concat([Buffer.from([4]), fromBase64url(jwk.x, 32), fromBase64url(jwk.y, 32)]));
    const identity = { signer, privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), pepper: token() };
    set('identity', identity);
    return identity;
  });
  const pinDigest = (digest, pin) => createHmac('sha256', identity.pepper).update(digest).update(pin).digest('hex');
  if (!get('network')) set('network', { active: { port, tls: false, domain: '', redirectPort: 0 }, candidate: null, revision: 1 });
  if (!get('accountLimit')) set('accountLimit', 1);
  const activeCount = () => db.prepare('SELECT count(*) AS count FROM accounts WHERE revoked = 0').get().count;
  const invitation = digest => db.prepare(`SELECT i.*, g.expires, g.remaining, g.revoked AS group_revoked
    FROM invitations i JOIN invite_groups g ON i.group_id = g.id WHERE i.digest = ?`).get(digest);
  const auth = id => db.prepare(`SELECT d.id, d.installation, d.account, a.game_key AS gameKey, d.request_id AS requestId,
    COALESCE(a.legacy_key, a.id) AS storeKey
    FROM devices d JOIN accounts a ON a.id = d.account WHERE d.id = ? AND d.revoked = 0 AND a.revoked = 0`).get(id);
  const isManagedStore = key => Boolean(db.prepare('SELECT id FROM accounts WHERE id = ? OR legacy_key = ?').get(key, key));
  const privateOwner = () => get('privateOwner');
  const accountById = id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  const findAccount = gameKey => db.prepare('SELECT * FROM accounts WHERE game_key = ? AND revoked = 0 ORDER BY rowid DESC LIMIT 1').get(gameKey);
  const removedAccount = gameKey => db.prepare('SELECT * FROM accounts WHERE game_key = ? AND removed_at IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(gameKey);
  const enrolled = digest => db.prepare('SELECT * FROM private_installations WHERE digest = ?').get(digest);
  const addInstallation = (digest, owner, requestId, request) => {
    requireValue(!enrolled(digest), 'invalid_binding');
    db.prepare('INSERT INTO private_installations VALUES (?, ?, ?, ?)').run(digest, owner, requestId, request);
  };
  const addDevice = (device, account, requestId, request, installation = null) => db.prepare(
    'INSERT INTO devices (id, account, request_id, request, installation) VALUES (?, ?, ?, ?, ?)'
  ).run(device, account, requestId, request, installation);
  function noteDevice(device, { client, system }) {
    if (!client && !system) return;
    const id = device.installation ?? device.id;
    const previous = db.prepare('SELECT client, system FROM device_profiles WHERE id = ?').get(id);
    // Keep the richer result if another tab of the same installation runs an older core.
    if (previous?.client === '微端') client = previous.client;
    if (system === 'Windows' && /^Windows (?:10|11)$/.test(previous?.system ?? '')) system = previous.system;
    if ((!client || client === previous?.client) && (!system || system === previous?.system)) return;
    db.prepare(`INSERT INTO device_profiles (id, client, system) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      client = COALESCE(excluded.client, client), system = COALESCE(excluded.system, system)`).run(id, client ?? null, system ?? null);
  }
  function nameDevice(id, name) {
    requireValue(isDigest(id) && typeof name === 'string' && name.length <= 48 && !/[\p{Cc}\p{Cf}]/u.test(name), 'invalid_device_name');
    const device = db.prepare('SELECT installation FROM devices WHERE id = ?').get(id);
    requireValue(device, 'not_found', 404);
    db.prepare(`INSERT INTO device_profiles (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name`)
      .run(device.installation ?? id, name.trim() || null);
  }
  const userCodeKey = code => hash(syncAccountSeed(code.replace(/^0+(?=\d)/, '')));
  const validUserCode = code => typeof code === 'string' && /^\d{1,10}$/.test(code) && Number(code) > 0 && Number(code) <= 0xffffffff;
  function noteUserCode(account, userCode, gameKey) {
    if (validUserCode(userCode) && equal(gameKey, userCodeKey(userCode))) {
      db.prepare('UPDATE accounts SET user_code = ? WHERE id = ?').run(userCode.padStart(10, '0'), account);
    }
  }
  transaction(() => {
    const owner = privateOwner();
    if (!owner || Object.hasOwn(owner, 'main')) return;
    const main = db.prepare(`SELECT a.id FROM devices d JOIN accounts a ON a.id = d.account
      WHERE a.installation = ? AND d.request_id = ? ORDER BY a.revoked, d.rowid LIMIT 1`).get(owner.digest, owner.requestId)?.id;
    set('privateOwner', { ...owner, main: main ?? null });
    addInstallation(owner.digest, owner.digest, owner.requestId, owner.request);
    db.prepare(`UPDATE devices SET installation = ? WHERE request_id = ? AND account IN
      (SELECT id FROM accounts WHERE installation = ?)`).run(owner.digest, owner.requestId, owner.digest);
    db.prepare('UPDATE accounts SET removed_at = ?, view_digest = NULL, view_token = NULL WHERE installation = ? AND revoked = 1 AND id IS NOT ?')
      .run(now(), owner.digest, main ?? null);
  });
  function createAccount(gameKey, recovery, legacyKey, installation = null) {
    const archived = installation && db.prepare('SELECT id FROM accounts WHERE game_key = ? AND revoked = 1 AND removed_at IS NULL ORDER BY rowid DESC LIMIT 1').get(gameKey);
    const id = randomBytes(32).toString('hex'), view = token();
    if (archived) {
      db.prepare('UPDATE devices SET revoked = 1 WHERE account = ?').run(archived.id);
      db.prepare('UPDATE accounts SET revoked = 0, recovery = ?, installation = ?, view_digest = ?, view_token = ? WHERE id = ?')
        .run(hash(recovery), installation, hash(view), view, archived.id);
      return archived.id;
    }
    db.prepare('INSERT INTO accounts (id, game_key, recovery, legacy_key, installation, view_digest, view_token) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, gameKey, hash(recovery), legacyKey, installation, hash(view), view);
    return id;
  }

  function issue({ request, requestId, group, uses, hours, inviteToken, legacyKey = null, privatePair = false }) {
    const digest = hash(inviteToken);
    const pin = String(randomInt(10000)).padStart(4, '0');
    return transaction(() => {
      if (privatePair) {
        db.exec("UPDATE invitations SET revoked = 1 WHERE redeemed_by IS NULL AND private_pair = '1'");
        group = randomBytes(16).toString('hex');
        const expires = now() + 10 * 60000;
        db.prepare('INSERT INTO invite_groups (id, expires, remaining) VALUES (?, ?, 1)').run(group, expires);
        db.prepare("INSERT INTO invitations (digest, group_id, request_id, request, pin, private_pair) VALUES (?, ?, ?, ?, ?, '1')")
          .run(digest, group, requestId, request, pinDigest(digest, pin));
        return { id: digest, expires };
      }
      requireValue(!privateOwner(), 'installation_already_bound', 409);
      requireValue(!legacyKey || isDigest(legacyKey) && !isManagedStore(legacyKey), 'existing_account_unavailable', 409);
      if (!group) {
        requireValue(Number.isInteger(uses) && uses >= 1 && uses <= 100 && Number.isInteger(hours) && hours >= 1 && hours <= 168, 'invalid_quota');
        group = randomBytes(16).toString('hex');
        db.prepare('INSERT INTO invite_groups (id, expires, remaining) VALUES (?, ?, ?)').run(group, now() + hours * 3600000, uses);
      }
      const entry = db.prepare('SELECT * FROM invite_groups WHERE id = ?').get(group);
      requireValue(entry && !entry.revoked && entry.remaining > 0 && entry.expires > now(), 'invitation_unavailable', 409);
      db.prepare('INSERT INTO invitations (digest, group_id, request_id, request, pin, legacy_key) VALUES (?, ?, ?, ?, ?, ?)')
        .run(digest, group, requestId, request, pinDigest(digest, pin), legacyKey);
      return { id: digest, group, pin, expires: entry.expires };
    });
  }

  function privateAccount(owner, gameKey, recovery, existingKey, confirmedPairing = false) {
    const removed = removedAccount(gameKey);
    requireValue(!removed || confirmedPairing && removed.purged, 'account_revoked', 403);
    const entry = findAccount(gameKey);
    requireValue(!entry || entry.installation === owner.digest, 'account_already_bound', 409);
    requireValue(entry || activeCount() < 5, 'account_limit', 409);
    if (removed && !entry) {
      db.prepare('UPDATE accounts SET installation = ?, recovery = ?, revoked = 0, removed_at = NULL, purged = 0 WHERE id = ?')
        .run(owner.digest, hash(recovery), removed.id);
      return removed.id;
    }
    return entry?.id ?? createAccount(gameKey, recovery, existingKey, owner.digest);
  }

  function bind({ device, requestId, gameKey, invite, pin, recovery, installation, userCode }, existingKey) {
    requireValue(isToken(device) && isRequestId(requestId) && isDigest(gameKey) && isToken(recovery), 'invalid_binding');
    const deviceId = hash(device);
    const result = transaction(() => {
      const existing = auth(deviceId);
      if (existing) {
        requireValue(existing.gameKey === gameKey && existing.requestId === requestId, 'account_mismatch', 403);
        const row = db.prepare('SELECT installation FROM devices WHERE id = ?').get(deviceId);
        if (row.installation) requireValue(isToken(installation) && equal(hash(installation), row.installation), 'invalid_binding');
        return { account: existing.account, ...(row.installation && { privatePair: true }) };
      }
      requireValue(!db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId), 'device_revoked', 403);
      requireValue(isToken(invite), 'invalid_binding');
      const digest = hash(invite);
      const row = invitation(digest);
      requireValue(row && !row.revoked && !row.group_revoked && !row.redeemed_by && row.expires > now() &&
        row.request_id === requestId && row.remaining > 0, 'invitation_unavailable', 403);
      const privatePair = row.private_pair === '1';
      const currentOwner = privateOwner();
      requireValue(privatePair || !currentOwner, 'installation_already_bound', 409);
      requireValue(privatePair ? isToken(installation) : typeof pin === 'string' && PIN_FORMAT.test(pin), 'invalid_binding');
      if (!privatePair && !equal(row.pin, pinDigest(digest, pin))) {
        db.prepare('UPDATE invitations SET tries = tries + 1, revoked = ? WHERE digest = ?').run(row.tries + 1 >= 5 ? 1 : 0, digest);
        return { wrongPin: true };
      }
      requireValue(!row.legacy_key || row.legacy_key === gameKey, 'account_mismatch', 403);
      requireValue(!row.legacy_key || !isManagedStore(row.legacy_key), 'existing_account_unavailable', 409);
      requireValue(!db.prepare('SELECT id FROM accounts WHERE recovery = ?').get(hash(recovery)), 'invalid_binding');
      const digestInstallation = privatePair ? hash(installation) : null;
      const owner = privatePair ? currentOwner ?? { digest: digestInstallation } : null;
      if (!privatePair) requireValue(activeCount() < get('accountLimit'), 'account_limit', 409);
      const account = privatePair ? privateAccount(owner, gameKey, recovery, existingKey, true) : createAccount(gameKey, recovery, row.legacy_key);
      if (privatePair) addInstallation(digestInstallation, owner.digest, requestId, row.request);
      noteUserCode(account, userCode, gameKey);
      addDevice(deviceId, account, requestId, row.request, digestInstallation);
      db.prepare('UPDATE invite_groups SET remaining = remaining - 1 WHERE id = ?').run(row.group_id);
      db.prepare('UPDATE invitations SET redeemed_by = ? WHERE digest = ?').run(deviceId, digest);
      if (privatePair) {
        if (!currentOwner?.main || accountById(currentOwner.main)?.revoked) set('privateOwner', { digest: owner.digest, main: account });
        if (!currentOwner) db.prepare('UPDATE invitations SET revoked = 1 WHERE redeemed_by IS NULL').run();
      }
      return { account, ...(privatePair && { privatePair: true }) };
    });
    requireValue(!result.wrongPin, 'wrong_pin', 403);
    return result;
  }

  function joinPrivate({ installation, device, recovery, gameKey, userCode }, existingKey) {
    requireValue(isToken(installation) && isToken(device) && isToken(recovery) && isDigest(gameKey), 'invalid_binding');
    return transaction(() => {
      const owner = privateOwner(), digest = hash(installation), install = enrolled(digest);
      requireValue(owner && install?.owner === owner.digest, 'binding_required', 401);
      const deviceId = hash(device), previous = auth(deviceId);
      if (previous) {
        requireValue(previous.gameKey === gameKey, 'account_mismatch', 403);
        return { account: previous.account };
      }
      requireValue(!db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId), 'device_revoked', 403);
      const account = privateAccount(owner, gameKey, recovery, existingKey);
      noteUserCode(account, userCode, gameKey);
      addDevice(deviceId, account, install.request_id, install.request, digest);
      return { account };
    });
  }
  function issuePrivateGrant() {
    return transaction(() => {
      const owner = privateOwner(), main = owner?.main && accountById(owner.main);
      requireValue(main && !main.revoked, 'primary_required', 409);
      const grant = token(), expires = now() + grantPeriod;
      db.prepare('DELETE FROM private_grants WHERE expires <= ? OR redeemed_by IS NULL').run(now());
      db.prepare('INSERT INTO private_grants (digest, account, expires) VALUES (?, ?, ?)').run(hash(grant), main.id, expires);
      return { grant, expires, gameKey: main.game_key };
    });
  }
  function bindPrivateGrant({ device, installation, gameKey, grant, requestId, request, userCode }) {
    requireValue(isToken(device) && isToken(installation) && isDigest(gameKey) && isToken(grant)
      && isRequestId(requestId), 'invalid_binding');
    return transaction(() => {
      const owner = privateOwner(), main = owner?.main && accountById(owner.main);
      const digest = hash(grant), deviceId = hash(device), installationId = hash(installation);
      const issued = db.prepare('SELECT * FROM private_grants WHERE digest = ?').get(digest);
      requireValue(main && !main.revoked && issued?.account === main.id && issued.expires > now(), 'invalid_private_credential', 403);
      requireValue(validUserCode(userCode) && equal(gameKey, userCodeKey(userCode)) && equal(main.game_key, gameKey), 'account_mismatch', 403);
      if (issued.redeemed_by) {
        const previous = auth(deviceId);
        requireValue(issued.redeemed_by === deviceId && previous?.account === main.id && previous.requestId === requestId
          && enrolled(installationId)?.request_id === requestId, 'invalid_private_credential', 403);
      } else {
        requireValue(!db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId), 'device_revoked', 403);
        addInstallation(installationId, owner.digest, requestId, request);
        addDevice(deviceId, main.id, requestId, request, installationId);
        noteUserCode(main.id, userCode, gameKey);
        db.prepare('UPDATE private_grants SET redeemed_by = ? WHERE digest = ?').run(deviceId, digest);
      }
      return { account: main.id };
    });
  }
  function removeInstallation(digest, code, status) {
    transaction(() => {
      requireValue(digest && enrolled(digest), code, status);
      db.prepare('UPDATE devices SET revoked = 1 WHERE installation = ?').run(digest);
      db.prepare('DELETE FROM private_installations WHERE digest = ?').run(digest);
    });
  }
  function detachInstallation(installation) {
    requireValue(isToken(installation), 'invalid_binding');
    removeInstallation(hash(installation), 'binding_required', 401);
  }
  function releasePrivate(owner = privateOwner()) {
    requireValue(owner, 'binding_required', 401);
    transaction(() => {
      db.prepare('UPDATE accounts SET revoked = 1 WHERE installation = ?').run(owner.digest);
      db.prepare('DELETE FROM private_installations WHERE owner = ?').run(owner.digest);
      db.exec('DELETE FROM private_grants');
      set('privateOwner', null);
    });
  }

  function removeChild(owner, id) {
    const row = accountById(id);
    requireValue(owner && row?.installation === owner.digest && !row.revoked && owner.main !== id, 'child_required', 409);
    db.prepare('UPDATE devices SET revoked = 1 WHERE account = ?').run(id);
    db.prepare('UPDATE accounts SET revoked = 1, removed_at = ?, view_digest = NULL, view_token = NULL WHERE id = ?').run(now(), id);
  }
  function restoreChild(id) {
    transaction(() => {
      const row = accountById(id), owner = privateOwner();
      requireValue(row && row.removed_at !== null && row.removed_at + recoveryPeriod > now(), 'recovery_expired', 409);
      requireValue(owner?.main && !accountById(owner.main)?.revoked, 'primary_required', 409);
      requireValue(!findAccount(row.game_key), 'account_already_bound', 409);
      requireValue(activeCount() < 5, 'account_limit', 409);
      db.prepare('UPDATE accounts SET installation = ?, revoked = 0, removed_at = NULL, purged = 0 WHERE id = ?').run(owner.digest, id);
    });
  }
  function promoteChild(id) {
    transaction(() => {
      const owner = privateOwner(), row = accountById(id);
      requireValue(owner && row?.installation === owner.digest && !row.revoked && owner.main !== id, 'child_required', 409);
      set('privateOwner', { ...owner, main: id });
      db.exec('DELETE FROM private_grants');
    });
  }
  const archivedStores = () => db.prepare(`SELECT id, COALESCE(legacy_key, id) AS storeKey, removed_at + ? AS recoverUntil
    FROM accounts WHERE removed_at IS NOT NULL AND purged = 0`).all(recoveryPeriod);

  function recover({ device, gameKey, recovery, requestId, request }) {
    requireValue(isToken(device) && isDigest(gameKey) && isToken(recovery) && isRequestId(requestId), 'invalid_binding');
    return transaction(() => {
      const account = db.prepare('SELECT id FROM accounts WHERE recovery = ? AND game_key = ? AND revoked = 0 AND installation IS NULL').get(hash(recovery), gameKey);
      requireValue(account, 'invalid_recovery', 403);
      const deviceId = hash(device);
      const existing = auth(deviceId);
      if (existing) {
        requireValue(existing.account === account.id && existing.requestId === requestId, 'account_mismatch', 403);
      } else {
        requireValue(!db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId), 'device_revoked', 403);
        db.prepare('INSERT INTO devices (id, account, request_id, request) VALUES (?, ?, ?, ?)').run(deviceId, account.id, requestId, request);
      }
      return { account: account.id };
    });
  }

  return {
    identity, get, set, db, transaction, activeCount, issue, bind, recover, isManagedStore, joinPrivate, privateOwner, releasePrivate,
    issuePrivateGrant, bindPrivateGrant, detachInstallation, restoreChild, promoteChild, archivedStores,
    noteDevice, nameDevice,
    markPurged: id => db.prepare('UPDATE accounts SET purged = 1, user_code = NULL WHERE id = ?').run(id),
    isArchivedStore: key => Boolean(db.prepare('SELECT id FROM accounts WHERE removed_at IS NOT NULL AND (id = ? OR legacy_key = ?)').get(key, key)),
    privatePreview(view) {
      return isToken(view) ? db.prepare('SELECT COALESCE(legacy_key, id) AS key FROM accounts WHERE view_digest = ? AND revoked = 0')
        .get(hash(view))?.key : undefined;
    },
    privateViewToken(id) {
      const stored = db.prepare('SELECT view_token AS value FROM accounts WHERE id = ? AND revoked = 0').get(id);
      if (!stored) return null;
      if (stored.value) return stored.value;
      const value = token();
      db.prepare('UPDATE accounts SET view_token = ?, view_digest = ? WHERE id = ?').run(value, hash(value), id);
      return value;
    },
    clearPrivateCredentials() {
      transaction(() => {
        db.exec('DELETE FROM invitations; DELETE FROM invite_groups; DELETE FROM private_grants; DELETE FROM private_installations; DELETE FROM device_profiles; DELETE FROM devices; DELETE FROM accounts;');
        set('privateOwner', null);
      });
    },
    authenticate(value) {
      const device = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
      return isToken(device) ? auth(hash(device)) : null;
    },
    setLimit(limit) {
      requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 100 && limit >= activeCount(), 'invalid_account_limit');
      set('accountLimit', limit);
    },
    revoke(type, id) {
      if (type === 'installation') {
        requireValue(isDigest(id), 'invalid_request');
        const row = db.prepare('SELECT installation FROM devices WHERE id = ?').get(id);
        return removeInstallation(row?.installation, 'not_found', 404);
      }
      const statements = {
        group: 'UPDATE invite_groups SET revoked = 1 WHERE id = ?',
        invitation: 'UPDATE invitations SET revoked = 1 WHERE digest = ?',
        account: 'UPDATE accounts SET revoked = 1 WHERE id = ?',
        device: 'UPDATE devices SET revoked = 1 WHERE id = ?',
      };
      requireValue(Object.hasOwn(statements, type) && typeof id === 'string', 'invalid_request');
      const owner = type === 'account' && privateOwner();
      if (owner && accountById(id)?.installation === owner.digest) {
        return transaction(() => removeChild(owner, id));
      }
      requireValue(db.prepare(statements[type]).run(id).changes, 'not_found', 404);
    },
    deviceRequest(id) {
      return auth(id) && db.prepare('SELECT request FROM devices WHERE id = ?').get(id)?.request;
    },
    list() {
      const owner = privateOwner();
      return {
        accountLimit: owner ? 5 : get('accountLimit'), active: activeCount(), installationBound: Boolean(owner),
        installationCount: db.prepare('SELECT count(*) AS count FROM private_installations').get().count,
        primaryReady: Boolean(owner?.main && !accountById(owner.main)?.revoked),
        groups: db.prepare('SELECT id, expires, remaining, revoked FROM invite_groups ORDER BY rowid DESC LIMIT 100').all(),
        invitations: db.prepare('SELECT digest AS id, group_id AS groupId, revoked, redeemed_by IS NOT NULL AS used FROM invitations ORDER BY rowid DESC LIMIT 100').all(),
        accounts: db.prepare(`SELECT id, revoked, COALESCE(legacy_key, id) AS storeKey, user_code AS userCode,
          CASE WHEN removed_at IS NOT NULL THEN removed_at + ? END AS recoverUntil,
          CASE WHEN id = ? THEN 'main' WHEN installation = ? THEN 'child' END AS role
          FROM accounts WHERE (removed_at IS NULL OR (purged = 0 AND removed_at + ? > ?))
          ORDER BY (id = ?) DESC, revoked, rowid LIMIT 100`).all(recoveryPeriod, owner?.main ?? null, owner?.digest ?? null,
          recoveryPeriod, now(), owner?.main ?? null),
        devices: db.prepare(`SELECT d.id, d.account, d.revoked, d.installation, d.installation IS NOT NULL AS privateDevice,
          p.name AS deviceName, p.client, p.system FROM devices d LEFT JOIN device_profiles p ON p.id = COALESCE(d.installation, d.id)
          ORDER BY d.rowid DESC LIMIT 500`).all(),
      };
    },
    close: () => db.close(),
  };
}
