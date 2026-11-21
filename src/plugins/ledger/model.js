export const YUANBAO = 100016;
export const JADE_SEAL = 21223901;
export const JADE_SHARDS = 21272501;
const JADE_EXCHANGE_IDS = [1620301, 1630701];
// Alert eligibility is independent of seasonal inventory visibility.
export const ALERT_ITEMS = Object.freeze([YUANBAO, JADE_SEAL, 21356801, 21337401]);
export const canAlert = (id, name) => ALERT_ITEMS.includes(Number(id)) || name === '祈福灯';
export function defaultThreshold(id, name) {
  return ({ [YUANBAO]: 5000, [JADE_SEAL]: 10, 21356801: 50, 21337401: 50 })[Number(id)] ?? (name === '祈福灯' ? 30 : 0);
}
export function isOtherJadeSeal(id, name) {
  const baseId = Number(id);
  // Known exchange IDs can arrive before the goods table is loaded.
  return baseId !== JADE_SEAL && (JADE_EXCHANGE_IDS.includes(baseId) || name === '传世玉玺');
}
export const integer = n => Number.isSafeInteger(n) && n >= 0;
export function goodsDefinitions(config) {
  const root = config?.root, fields = new Map((root?.abbreviation?.field || []).map(f => [f.Short, f.Long]));
  return new Map((root?.goodslist?.goods || []).map(row => {
    const data = Object.fromEntries(Object.entries(row).map(([k, v]) => [fields.get(k) || k, v]));
    return [Number(data.ID), data];
  }));
}
export function importantItems(defs, activeKnots = null) {
  const result = [{ ID: YUANBAO, name: '元宝', PicID: 70 }];
  const jade = defs.get(JADE_SEAL);
  if (jade) result.push(jade);
  const groups = new Map(['祈福灯', '绘卷毛笔', '秘钥', '玉玺碎片', '如意结'].map(name => [name, []]));
  for (const row of defs.values()) {
    const name = row.name === '密钥' ? '秘钥' : row.name;
    if (name === '如意结' && activeKnots && !activeKnots.has(Number(row.ID))) continue;
    groups.get(name)?.push(row);
  }
  for (const rows of groups.values()) result.push(...rows);
  return result;
}
export function totals(records) {
  const result = new Map();
  for (const record of records) for (const item of record.items || []) {
    if (!Number.isSafeInteger(item.delta) || !item.delta) continue;
    const row = result.get(item.id) || { income: 0, expense: 0 };
    if (item.delta > 0) row.income += item.delta; else row.expense -= item.delta;
    result.set(item.id, row);
  }
  return result;
}
export function filterRecords(records, { from = 0, to = Infinity, item = '', kind = 'all', session = '' } = {}) {
  const query = item.toLocaleLowerCase('zh-CN');
  return records.filter(row => row.at >= from && row.at <= to && (!session || row.session === session) &&
    (kind === 'all' || row.kind === kind || kind === 'prayer' && (row.prayerReward || row.source === 'DbsCcUserGoodshintNtf' && row.type === 2010)) &&
    (!query || [...(row.items || []), ...(row.rewards || [])].some(i => String(i.id) === query || i.name.toLocaleLowerCase('zh-CN').includes(query)) ||
      row.prayer?.name?.toLocaleLowerCase('zh-CN').includes(query) || String(row.prayer?.itemId) === query));
}
// A hint and an instance notification describe the same balance change. Match
// opposite streams only, same sign/base ID, consuming each overlap once. Keep
// separate observations in one stream, including equal consecutive purchases.
export function createReconciler() {
  let pending = [];
  return {
    reset() { pending = []; },
    accept(stream, items, at, recordId) {
      pending = pending.filter(p => at - p.at <= 8000);
      const changes = [], output = [];
      for (const item of items) {
        let left = item.delta;
        for (const prior of pending) {
          if (!left) break;
          if (prior.stream === stream || prior.id !== item.id || Math.sign(prior.left) !== Math.sign(left)) continue;
          const match = Math.sign(left) * Math.min(Math.abs(left), Math.abs(prior.left));
          prior.left -= match;
          if (stream === 'hint') changes.push({ recordId: prior.recordId, id: item.id, delta: match });
          else left -= match;
          // Hints retain the canonical amount; a later hint replaces a fallback.
          if (stream === 'hint') left -= match;
        }
        if (left) pending.push({ stream, id: item.id, left, at, recordId });
        const delta = stream === 'hint' ? item.delta : left;
        if (delta) output.push({ ...item, delta });
      }
      pending = pending.filter(p => p.left);
      return { items: output, changes };
    },
  };
}
export function prayerSummary(records) {
  const groups = new Map();
  for (const row of records) if (row.kind === 'prayer' && row.prayer) {
    const p = row.prayer, key = `${p.secId}:${p.itemId || ''}`, group = groups.get(key) || { ...p, times: 0, pending: 0, rewards: new Map() };
    group.times += p.times; if (!p.matched) group.pending++;
    for (const i of row.rewards || []) group.rewards.set(i.id, { ...i, delta: (group.rewards.get(i.id)?.delta || 0) + i.delta });
    groups.set(key, group);
  }
  return [...groups.values()];
}
