import { vaultRecords, vaultSnapshot } from '../../src/core/sync-vault-records.js';

export function openPrivateHistory(store, changes) {
  const migrated = store.get('privateHistoryInSqlite') === true;
  const existing = new Map();
  if (migrated) for (const [account, row] of changes.privateRows()) {
    if (!existing.has(account)) existing.set(account, []);
    existing.get(account).push(row);
  }
  const matches = {}, ledgers = {};
  for (const [account, rows] of existing) {
    const snapshot = vaultSnapshot(rows);
    if (snapshot.matches.length) matches[account] = snapshot.matches;
    if (rows.some(([kind]) => kind === 'ledger')) ledgers[account] = snapshot.ledger;
  }
  const record = (account, records) => changes.record('private:' + account, records);
  return {
    matches: migrated ? matches : undefined,
    ledgers: migrated ? ledgers : undefined,
    seed(accounts, ledgerEntries) {
      if (migrated) return;
      store.transaction(() => {
        for (const [account, rows] of accounts) {
          record(account, [...rows.values()].map(({ gameId, ...value }) => ['match', gameId, value]));
        }
        for (const [account, ledger] of ledgerEntries) record(account, vaultRecords({ matches: [], ledger }));
        store.set('privateHistoryInSqlite', true);
      });
    },
    writeMatches(account, previous, rows) {
      const records = rows.filter(row => previous.get(row.gameId) !== row)
        .map(({ gameId, ...value }) => ['match', gameId, value]);
      store.transaction(() => record(account, records));
    },
    writeLedger(account, previous, entry) {
      const { events, ...details } = entry;
      const records = [['ledger', 'details', details]];
      if (events !== previous.events) {
        const old = new Map(previous.events.map(row => [row.id, row]));
        for (const row of events) {
          const { id, ...value } = row;
          if (old.get(id) !== row) records.push(['event', id, value]);
          old.delete(id);
        }
        for (const id of old.keys()) records.push(['event', id, null]);
      }
      store.transaction(() => record(account, records));
    },
    remove(account) { store.transaction(() => changes.reset('private:' + account)); },
    clear() { store.transaction(() => changes.reset('private:*')); },
  };
}
