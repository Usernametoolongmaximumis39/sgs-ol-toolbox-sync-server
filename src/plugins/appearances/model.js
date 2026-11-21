import { MODES } from '../../shared/match-sync-records.js';
export { MODES };
const normalizedModeIds = new Set(Object.keys(MODES).map(Number));
const nativeModeIds = new Map([[132, 26], [148, 35], [149, 35], [160, 44]]);

// Native model IDs are separate from the normalized labels in older imports.
export function nativeModeId(value) { return nativeModeIds.get(Number(value)) ?? 0; }
export function modeId(value) {
  const id = Number(value);
  return normalizedModeIds.has(id) ? id : nativeModeId(id);
}
export function ids(value) {
  if (!Array.isArray(value) || value.length > 256) throw new Error('候选武将列表长度无效');
  if (value.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw new Error('候选武将 ID 无效');
  return [...new Set(value.map(Number))];
}
export function capture(draft, event) {
  if (event.type === 'frame') return { mode: modeId(event.mode), general: ids(event.general), selected: null, time: event.time };
  if (!draft) return null;
  if (event.type === 'change') return { ...draft, general: [...new Set([...draft.general, ...ids(event.general)])] };
  if (event.type === 'select') {
    const selected = ids(event.selected);
    if (!selected.length || selected.some(id => !draft.general.includes(id))) return null;
    return { ...draft, selected };
  }
  return draft;
}
export function filterRecords(records, filters, names = {}) {
  return records.filter(row => (!filters.mode || row.mode === Number(filters.mode)) && (!filters.start || row.time >= filters.start) && (!filters.end || row.time <= filters.end)
    && (!filters.search || [...row.general, ...(row.selected || [])].some(id => String(names[id] || `武将 #${id}`).includes(filters.search))));
}
export function statistics(records, names = {}, { search = '', min = 0, sort = 'appear' } = {}) {
  const result = new Map();
  for (const row of records) for (const id of new Set(row.general)) {
    const stat = result.get(id) || { id, name: names[id] || `武将 #${id}`, appear: 0, selected: 0, known: 0 };
    stat.appear++; if (row.selected !== null) { stat.known++; if (row.selected.includes(id)) stat.selected++; } result.set(id, stat);
  }
  return [...result.values()].map(row => ({ ...row, rate: row.known ? row.selected / row.known : null }))
    .filter(row => row.appear >= min && (!search || row.name.includes(search)))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh') : sort === 'rate' ? (b.rate ?? -1) - (a.rate ?? -1) || b.appear - a.appear || a.id - b.id : b[sort] - a[sort] || a.id - b.id);
}
