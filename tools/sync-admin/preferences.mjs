import { cleanPreferences, mergePreferenceUpload, PREFERENCE_GROUPS } from '../../src/shared/sync-preferences.js';
import { requireValue, SyncError } from './state.mjs';

export function openPrivatePreferences({ db, transaction }, changes) {
  db.exec(`CREATE TABLE IF NOT EXISTS private_preferences (
    account TEXT NOT NULL, scope TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (account, scope)
  )`);
  const read = db.prepare('SELECT scope, value FROM private_preferences WHERE account = ? ORDER BY scope');
  const upsert = db.prepare('INSERT OR REPLACE INTO private_preferences (account, scope, value) VALUES (?, ?, ?)');
  const snapshot = account => Object.fromEntries(read.all(account).map(row => [row.scope, JSON.parse(row.value)]));
  return {
    snapshot,
    accounts: () => db.prepare(`SELECT DISTINCT COALESCE(a.legacy_key, a.id) AS key, a.user_code AS label
      FROM private_preferences p JOIN accounts a ON p.account = COALESCE(a.legacy_key, a.id)
      WHERE a.removed_at IS NULL`).all(),
    remove: account => db.prepare('DELETE FROM private_preferences WHERE account = ?').run(account),
    clear: () => db.exec('DELETE FROM private_preferences'),
    exchange(account, { groups, values, patch, preservePins }) {
      requireValue(Array.isArray(groups) && groups.length > 0 && groups.length <= PREFERENCE_GROUPS.length
        && new Set(groups).size === groups.length && groups.every(group => PREFERENCE_GROUPS.includes(group)), 'invalid_preferences');
      if (values === undefined) {
        const current = snapshot(account);
        return { values: Object.fromEntries(groups.filter(group => Object.hasOwn(current, group)).map(group => [group, current[group]])) };
      }
      let clean;
      try { clean = cleanPreferences(values); } catch { throw new SyncError(400, 'invalid_preferences'); }
      requireValue(Object.keys(clean).length === groups.length && groups.every(group => Object.hasOwn(clean, group)), 'invalid_preferences');
      transaction(() => {
        const previous = snapshot(account);
        let next;
        try { next = mergePreferenceUpload(patch === true ? previous : {}, clean, { patch: patch === true, preservePins: preservePins === true }); }
        catch { throw new SyncError(400, 'invalid_preferences'); }
        const updated = groups.filter(group => JSON.stringify(next[group]) !== JSON.stringify(previous[group]));
        for (const group of updated) upsert.run(account, group, JSON.stringify(next[group]));
        changes.record('private:' + account, updated.map(group => ['preferences', group, next[group]]));
      });
      return { ok: true };
    },
  };
}
