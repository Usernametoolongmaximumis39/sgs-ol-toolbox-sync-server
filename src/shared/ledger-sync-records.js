export const LEDGER_SYNC_BATCH = 200;
export const LEDGER_SYNC_BYTES = 8 * 1024 * 1024;
export const LEDGER_SETTLE_MS = 8000;
export const INSTANCE_SOURCES = new Set(['DbsCcUpdategoodsAttribNtf', 'DbsCcUserDelgoodsNtf']);

const itemKey = item => `${item.id}:${Math.sign(item.delta)}`;
const amounts = row => JSON.stringify(row.items.map(({ id, delta }) => [id, delta]));

export function mergeLedgerEvent(previous, next) {
  if (!previous) return next;
  if (previous.session !== next.session || previous.at !== next.at || previous.kind !== next.kind || previous.source !== next.source) return null;
  if (next.kind === 'prayer') return previous.prayer.secId === next.prayer.secId && previous.prayer.times === next.prayer.times ? previous : null;
  if (previous.type !== next.type) return null;
  if (amounts(previous) === amounts(next)) return next.reconciled && !previous.reconciled ? next : previous;

  // Reconciliation can only consume an instance delta. A late retry with the
  // pre-correction row must never restore a consumed quantity.
  const isCorrection = (before, after) => {
    if (!after.reconciled) return false;
    const prior = new Map(before.items.map(item => [itemKey(item), Math.abs(item.delta)]));
    return after.items.every(item => Math.abs(item.delta) <= prior.get(itemKey(item)));
  };
  if (isCorrection(previous, next)) return next;
  if (isCorrection(next, previous)) return previous;
  return null;
}

function markNearby(group, range, opposite) {
  if (group.length < 2) return;
  group.sort((a, b) => a.at - b.at);
  for (let pass = 0; pass < 2; pass++, group.reverse()) {
    const nearestByStream = new Map();
    for (const row of group) {
      const stream = opposite ? Number(INSTANCE_SOURCES.has(row.source)) : 0;
      const [nearest, other] = nearestByStream.get(opposite ? 1 - stream : stream) ?? [];
      const candidate = nearest?.session === row.session ? other : nearest;
      if (candidate && Math.abs(candidate.at - row.at) <= range) row.review = true;
      const [prior, second] = nearestByStream.get(stream) ?? [];
      nearestByStream.set(stream, [row, prior?.session === row.session ? second : prior]);
    }
  }
}

export function observedLedgerEvents(events) {
  const groups = new Map(), overlaps = new Map(), rows = [];
  for (const event of events) {
    if (event.kind === 'goods' && !event.items.length) continue;
    const key = event.kind === 'goods' ? amounts(event) : `prayer:${event.prayer.secId}:${event.prayer.times}`;
    const row = { ...event, review: event.review === true };
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
    if (event.source === 'DbsCcUserGoodshintNtf' || INSTANCE_SOURCES.has(event.source)) for (const item of event.items) {
      const key = itemKey(item);
      if (!overlaps.has(key)) overlaps.set(key, []);
      overlaps.get(key).push(row);
    }
    rows.push(row);
  }
  for (const group of groups.values()) markNearby(group, 2000, false);
  // Another session can see only part of an item notification in its bag update.
  for (const group of overlaps.values()) markNearby(group, LEDGER_SETTLE_MS, true);
  return rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}
