import { EMPTY_LEDGER } from './sync-ledger-records.js';
import { PREFERENCE_GROUPS } from '../shared/sync-preferences.js';

export function vaultRecords({ matches, ledger, preferences }) {
  const { events, ...ledgerDetails } = ledger;
  return [
    ['ledger', 'details', ledgerDetails],
    ...events.map(({ id, ...details }) => ['event', id, details]),
    ...matches.map(({ gameId, ...details }) => ['match', gameId, details]),
    ...Object.entries(preferences ?? {}).map(([group, value]) => ['preferences', group, value]),
  ];
}

export function vaultSnapshot(records) {
  const matches = [], events = [], preferences = {};
  let ledger = EMPTY_LEDGER;
  for (const [kind, id, details] of records) {
    if (kind === 'match') matches.push({ gameId: id, ...details });
    else if (kind === 'event') events.push({ id, ...details });
    else if (kind === 'ledger') ledger = details;
    else if (kind === 'preferences' && PREFERENCE_GROUPS.includes(id)) preferences[id] = details;
  }
  return { matches, ledger: { ...ledger, events }, ...(Object.keys(preferences).length && { preferences }) };
}
