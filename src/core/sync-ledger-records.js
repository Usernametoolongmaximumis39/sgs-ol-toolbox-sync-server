import { LEDGER_SYNC_BATCH, LEDGER_SYNC_BYTES, mergeLedgerEvent, observedLedgerEvents } from '../shared/ledger-sync-records.js';

const FUTURE_LIMIT = 120000;
const bytes = new TextEncoder();
const byteLength = value => bytes.encode(value).length;
export const EMPTY_LEDGER = { updatedAt: null, balances: [], events: [], names: {}, eventVersion: null };
export const confirmedLedgerEvents = events => observedLedgerEvents(events).filter(row => !row.review);
export const visibleBalances = (entry, now = Date.now()) => entry.balances.filter(row => row.name !== '如意结'
  || row.expiresAt > now && (!entry.knotWindow || row.at > entry.knotWindow.at || entry.knotWindow.active.includes(row.id)));

export function ledgerDownload(entry, pull, confirmed = confirmedLedgerEvents(entry.events)) {
  const version = entry.eventVersion, { offset } = pull;
  const balances = visibleBalances(entry);
  // Continue a single version so changes during a paged read cannot skip rows.
  if (offset && pull.version !== version) return { version, offset: 0, next: null, events: null, balances };
  if (!offset && pull.version === version) return { version, offset, next: null, events: null, balances };
  const page = [];
  let bytes = byteLength(JSON.stringify(balances)) + 512;
  for (let i = offset; i < confirmed.length && page.length < LEDGER_SYNC_BATCH; i++) {
    const row = confirmed[i], size = byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > LEDGER_SYNC_BYTES && page.length) break;
    page.push(row); bytes += size;
  }
  const next = offset + page.length;
  return { version, offset, next: next < confirmed.length ? next : null, events: page, balances };
}

export function mergeLedgerUpload(previous, { balances, events, profile, knotWindow }, now, version) {
  const latest = balances.length ? new Map(previous.balances.map(row => [row.id, row])) : null;
  const history = events.length ? new Map(previous.events.map(row => [row.id, row])) : null;
  let conflicts = 0, balanceChanged = false, eventChanged = false;
  for (const row of balances) {
    if (row.name === '如意结' && !row.expiresAt) continue;
    const old = latest.get(row.id);
    if (row.at > now + FUTURE_LIMIT) { conflicts++; continue; }
    if (old?.at === row.at && old.count !== row.count) {
      conflicts++;
      if (!old.review) { latest.set(row.id, { ...old, review: true }); balanceChanged = true; }
    } else if (!old || row.at > old.at) {
      latest.set(row.id, row); balanceChanged = true;
    }
  }
  for (const row of events) {
    if (row.at > now + FUTURE_LIMIT) { conflicts++; continue; }
    const old = history.get(row.id), merged = mergeLedgerEvent(old, row);
    if (!merged) {
      conflicts++;
      if (!old.review) { history.set(row.id, { ...old, review: true }); eventChanged = true; }
    } else if (merged !== old) {
      history.set(row.id, old?.review ? { ...merged, review: true } : merged); eventChanged = true;
    }
  }
  let entry = previous;
  const nextProfile = profile && profile.session.at <= now + FUTURE_LIMIT && profile.session.at >= (previous.profile?.session.at || 0)
    ? { ...profile, name: profile.name || previous.profile?.name || '' } : previous.profile;
  const window = knotWindow?.at > (previous.knotWindow?.at || 0) && knotWindow.at <= now + FUTURE_LIMIT
    ? knotWindow : previous.knotWindow;
  const profileChanged = JSON.stringify(nextProfile) !== JSON.stringify(previous.profile);
  if (balanceChanged || eventChanged || profileChanged || window !== previous.knotWindow) {
    entry = { ...previous, updatedAt: now, balances: balanceChanged ? [...latest.values()] : previous.balances,
      events: eventChanged ? [...history.values()] : previous.events, eventVersion: eventChanged ? version() : previous.eventVersion,
      profile: nextProfile, knotWindow: window };
  }
  return { entry, conflicts };
}
