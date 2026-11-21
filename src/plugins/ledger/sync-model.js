import { JADE_SEAL, JADE_SHARDS, YUANBAO, integer, isOtherJadeSeal } from './model.js';
import { INSTANCE_SOURCES } from '../../shared/ledger-sync-records.js';
export { LEDGER_SYNC_BATCH, LEDGER_SYNC_BYTES, LEDGER_SETTLE_MS, mergeLedgerEvent, observedLedgerEvents } from '../../shared/ledger-sync-records.js';

export const LEDGER_SYNC_INTERVAL = 60000;
export const validLedgerVersion = value => value === null || typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const GOODS_SOURCES = new Set(['DbsCcUserGoodshintNtf', 'DbsCcUpdategoodsAttribNtf', 'DbsCcUserDelgoodsNtf', 'DbsCUpdatauserYaunbaoNtf']);
const BAG_NAMES = new Set(['祈福灯', '绘卷毛笔', '秘钥', '密钥', '如意结']);
const validKey = value => typeof value === 'string' && /^[a-z0-9-]{8,80}$/i.test(value);
const positive = value => integer(value) && value > 0;
const label = value => typeof value === 'string' ? value.trim().slice(0, 100) : '';

export function projectLedgerProfile(code, name, session) {
  if (typeof code !== 'string' || !/^\d{1,10}$/.test(code) || Number(code) <= 0 || Number(code) > 0xffffffff
    || !validKey(session?.id) || !positive(session.at)) return null;
  return { userCode: code.padStart(10, '0'), name: label(typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '') : ''),
    session: { id: session.id, at: session.at } };
}

export function projectLedgerBalance(row) {
  if (!positive(row?.id) || !integer(row.count) || !positive(row.at)) return null;
  const { id, count, at } = row;
  if (id === YUANBAO) return row.basis === 'all-yuanbao' ? { id, name: '元宝', count, at, basis: row.basis } : null;
  const name = id === JADE_SEAL ? '传世玉玺' : id === JADE_SHARDS ? '玉玺碎片' : label(row.name);
  if (name === '如意结' && row.expiresAt !== undefined) {
    return positive(row.expiresAt) && row.expiresAt > at && row.expiresAt <= 8640000000000000 && !isOtherJadeSeal(id, name)
      ? { id, name, count, at, expiresAt: row.expiresAt } : null;
  }
  return (id === JADE_SEAL || id === JADE_SHARDS || BAG_NAMES.has(name)) && !isOtherJadeSeal(id, name)
    ? { id, name, count, at } : null;
}

function projectItems(items) {
  if (!Array.isArray(items) || items.length > 4096) return null;
  const grouped = new Map();
  for (const item of items) {
    if (!positive(item?.id) || !Number.isSafeInteger(item.delta) || item.delta === 0) return null;
    const { id, delta } = item, name = label(item.name) || `物品 ${id}`;
    if (isOtherJadeSeal(id, name)) continue;
    const key = `${id}:${Math.sign(delta)}`, combined = (grouped.get(key)?.delta ?? 0) + delta;
    if (!Number.isSafeInteger(combined)) return null;
    grouped.set(key, { id, delta: combined, name });
  }
  return [...grouped.values()].sort((a, b) => a.id - b.id || Math.sign(a.delta) - Math.sign(b.delta));
}

export function projectLedgerEvent(row) {
  if (!validKey(row?.id) || !validKey(row.session) || !positive(row.at)) return null;
  const { id, session, at, kind, source } = row;
  if (kind === 'prayer') {
    const { secId, times, itemId, name } = row.prayer ?? {};
    if (source !== 'decodeClientSecretExploreRep' || !positive(secId) || !positive(times)) return null;
    // The receipt confirms the draw count. A time-paired reward is still a separate observation.
    return { id, session, at, kind, source, items: [], prayer: { secId, times,
      itemId: positive(itemId) ? itemId : null, name: label(name) || `祈愿活动 ${secId}` } };
  }
  if (kind !== 'goods' || !GOODS_SOURCES.has(source)) return null;
  const items = projectItems(row.items);
  const reconciled = row.reconciled === true && INSTANCE_SOURCES.has(source);
  if (!items || !items.length && !reconciled) return null;
  if (items.some(item => (source === 'DbsCUpdatauserYaunbaoNtf') !== (item.id === YUANBAO))) return null;
  return { id, session, at, kind, source, items, type: integer(row.type) ? row.type : null, reconciled };
}
