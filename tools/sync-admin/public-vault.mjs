import { timingSafeEqual } from 'node:crypto';
import { equal, hash, isToken, requireValue, SyncError } from './state.mjs';
import { PREFERENCE_GROUPS, PREFERENCES_LIMIT } from '../../src/shared/sync-preferences.js';

export const VAULT_BYTES = 64 * 1024 * 1024;
const LOCK_TIME = 30 * 60000;
const recordLimit = 40001 + PREFERENCE_GROUPS.length;

function validateRecords(records, max = recordLimit) {
  requireValue(Array.isArray(records) && records.length <= max, 'vault_limit', 413);
  const keys = new Set();
  for (const item of records) {
    requireValue(Array.isArray(item) && item.length === 3, 'invalid_ciphertext');
    const [kind, id, ciphertext] = item;
    requireValue(typeof id === 'string' && (kind === 'ledger' && id === 'details'
      || kind === 'event' && /^[a-z0-9-]{8,80}$/i.test(id)
      || kind === 'match' && /^[1-9][0-9]{0,19}$/.test(id)
      || kind === 'preferences' && PREFERENCE_GROUPS.includes(id)), 'invalid_record_id');
    const limit = kind === 'preferences' ? Math.ceil((PREFERENCES_LIMIT + 28) * 4 / 3) : 12 * 1024 * 1024;
    requireValue(typeof ciphertext === 'string' && ciphertext.length >= 38 && ciphertext.length <= limit
      && /^[A-Za-z0-9_-]+$/.test(ciphertext), 'invalid_ciphertext');
    const key = kind + ':' + id;
    requireValue(!keys.has(key), 'duplicate_record_id');
    keys.add(key);
  }
  return keys;
}

export function openPublicVaults(store, now) {
  const { db, transaction } = store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY, credential TEXT NOT NULL, verifier TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vault_records (
      vault TEXT NOT NULL REFERENCES vaults(id), kind TEXT NOT NULL, record_id TEXT NOT NULL, ciphertext TEXT NOT NULL,
      PRIMARY KEY (vault, kind, record_id)
    );
    CREATE TABLE IF NOT EXISTS vault_migrations (
      source TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, vault TEXT NOT NULL UNIQUE REFERENCES vaults(id)
    );
    CREATE TABLE IF NOT EXISTS view_attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
  `);
  const lookup = db.prepare('SELECT * FROM vaults WHERE id = ? AND revoked = 0');
  const activeCount = () => db.prepare('SELECT count(*) AS count FROM vaults WHERE revoked = 0').get().count;
  const accountLimit = () => store.get('publicAccountLimit') ?? 10;
  const authenticate = ({ vault, credential }) => {
    const row = isToken(vault) && isToken(credential) && lookup.get(vault);
    requireValue(row && equal(row.credential, hash(credential)), 'binding_required', 401);
    return row;
  };
  const read = db.prepare('SELECT kind, record_id AS id, ciphertext FROM vault_records WHERE vault = ? ORDER BY rowid');
  const viewRead = db.prepare("SELECT kind, record_id AS id, ciphertext FROM vault_records WHERE vault = ? AND kind IN ('event', 'match') ORDER BY rowid");
  const upsert = db.prepare(`INSERT INTO vault_records VALUES (?, ?, ?, ?)
    ON CONFLICT (vault, kind, record_id) DO UPDATE SET ciphertext = excluded.ciphertext`);
  const readRecords = (statement, vault) => statement.all(vault).map(row => [row.kind, row.id, row.ciphertext]);
  const saveRecords = (vault, records) => {
    for (const item of records) upsert.run(vault, ...item);
    const { count, bytes } = db.prepare('SELECT count(*) AS count, COALESCE(sum(length(ciphertext) + length(record_id) + 24), 0) AS bytes FROM vault_records WHERE vault = ?').get(vault);
    requireValue(count <= recordLimit && bytes < VAULT_BYTES, 'vault_limit', 413);
    db.prepare('UPDATE vaults SET revision = revision + 1, bytes = ? WHERE id = ?').run(bytes, vault);
  };
  function register(body, enforceLimit) {
    const { vault, credential, verifier } = body;
    requireValue([vault, credential, verifier].every(isToken), 'invalid_binding');
    const current = lookup.get(vault);
    if (current) {
      authenticate(body);
      requireValue(equal(current.verifier, hash(verifier)), 'invalid_binding');
      return;
    }
    requireValue(!db.prepare('SELECT id FROM vaults WHERE id = ?').get(vault), 'binding_required', 401);
    if (enforceLimit) requireValue(activeCount() < accountLimit(), 'account_limit', 409);
    db.prepare('INSERT INTO vaults (id, credential, verifier) VALUES (?, ?, ?)').run(vault, hash(credential), hash(verifier));
  }

  return {
    register(body) { transaction(() => register(body, true)); },
    accountStatus: () => ({ active: activeCount(), limit: accountLimit() }),
    setAccountLimit(limit) {
      requireValue(Number.isSafeInteger(limit) && limit >= 0, 'invalid_public_account_limit');
      store.set('publicAccountLimit', limit);
    },
    exchange(body) {
      const { vault, revision, records } = body;
      requireValue(Number.isSafeInteger(revision) && revision >= -1, 'invalid_revision');
      validateRecords(records);
      return transaction(() => {
        const current = authenticate(body);
        if (current.revision !== revision) return { revision: current.revision, records: readRecords(read, vault) };
        if (records.length) saveRecords(vault, records);
        return { revision: current.revision + Number(records.length > 0), records: null };
      });
    },
    stage(source, fingerprint, expectedKeys, body) {
      const keys = validateRecords(body.records);
      requireValue(keys.size === expectedKeys.length && expectedKeys.every(key => keys.has(key)), 'migration_records_changed', 409);
      transaction(() => {
        const prior = db.prepare('SELECT vault FROM vault_migrations WHERE source = ?').get(source);
        requireValue(!prior || prior.vault === body.vault, 'migration_already_staged', 409);
        register(body, false);
        db.prepare('DELETE FROM vault_records WHERE vault = ?').run(body.vault);
        saveRecords(body.vault, body.records);
        db.prepare('INSERT OR REPLACE INTO vault_migrations VALUES (?, ?, ?)').run(source, fingerprint, body.vault);
      });
    },
    staged(source, fingerprint) {
      return Boolean(db.prepare('SELECT source FROM vault_migrations WHERE source = ? AND fingerprint = ?').get(source, fingerprint));
    },
    hasStage: source => Boolean(db.prepare('SELECT source FROM vault_migrations WHERE source = ?').get(source)),
    clearMigrationIndex() { db.exec('DELETE FROM vault_migrations'); },
    resetStage(source) {
      transaction(() => {
        const row = db.prepare('SELECT vault FROM vault_migrations WHERE source = ?').get(source);
        requireValue(row, 'not_found', 404);
        db.prepare('DELETE FROM vault_migrations WHERE source = ?').run(source);
        db.prepare('DELETE FROM vault_records WHERE vault = ?').run(row.vault);
        db.prepare('DELETE FROM vaults WHERE id = ?').run(row.vault);
      });
    },
    preview({ vault, verifier }, remote) {
      requireValue(isToken(vault) && isToken(verifier), 'invalid_view');
      const ip = hash(remote), time = now();
      const attempt = db.prepare('SELECT count, until FROM view_attempts WHERE ip = ?').get(ip);
      requireValue(!attempt || attempt.until <= time || attempt.count < 50, 'view_locked', 429);
      const row = lookup.get(vault);
      const digest = hash(verifier);
      const expected = row?.verifier ?? hash('unregistered-vault');
      if (timingSafeEqual(Buffer.from(expected), Buffer.from(digest)) && row) {
        return { records: readRecords(viewRead, vault) };
      }
      db.prepare('DELETE FROM view_attempts WHERE until <= ?').run(time);
      const count = attempt?.until > time ? attempt.count + 1 : 1;
      db.prepare('INSERT OR REPLACE INTO view_attempts VALUES (?, ?, ?)').run(ip, count,
        count === 50 ? time + LOCK_TIME : attempt?.until > time ? attempt.until : time + LOCK_TIME);
      throw new SyncError(count === 50 ? 429 : 403, count === 50 ? 'view_locked' : 'invalid_view');
    },
    authenticate,
    list: () => [
      ...db.prepare('SELECT id, bytes, revoked FROM vaults WHERE revoked = 0 ORDER BY rowid DESC').all(),
      ...db.prepare('SELECT id, bytes, revoked FROM vaults WHERE revoked = 1 ORDER BY rowid DESC LIMIT 100').all(),
    ],
    revoke(id) { requireValue(db.prepare('UPDATE vaults SET revoked = 1 WHERE id = ?').run(id).changes, 'not_found', 404); },
  };
}
