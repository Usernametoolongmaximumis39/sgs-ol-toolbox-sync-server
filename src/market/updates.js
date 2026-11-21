// Compare numeric components without converting them to lossy JS numbers.
const numeric = (a, b) => {
  a = a.replace(/^0+(?=\d)/, ''); b = b.replace(/^0+(?=\d)/, '');
  return Math.sign(a.length - b.length) || (a === b ? 0 : a > b ? 1 : -1);
};
function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  return match && { core: match.slice(1, 4), pre: match[4]?.split('.') || [] };
}
export function compareVersions(a, b) {
  const left = parse(a), right = parse(b);
  if (!left || !right) throw new Error('插件版本格式无效。');
  for (let i = 0; i < 3; i++) { const order = numeric(left.core[i], right.core[i]); if (order) return order; }
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length) - Math.sign(left.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    const order = xn && yn ? numeric(x, y) : xn !== yn ? (xn ? -1 : 1) : x > y ? 1 : -1;
    if (order) return order;
  }
  return 0;
}

/** Only stable, installable releases are suggested; preview/demo packages remain manual installs. */
export function findPluginUpdates(installed, entries) {
  const latest = new Map();
  for (const entry of entries) {
    if (!/^\d+\.\d+\.\d+$/.test(entry.version)) continue;
    const previous = latest.get(entry.id);
    if (!previous || compareVersions(entry.version, previous.version) > 0) latest.set(entry.id, entry);
  }
  return installed.map(plugin => {
    const entry = latest.get(plugin.id);
    const order = entry ? compareVersions(entry.version, plugin.version) : null;
    return { id: plugin.id, entry, status: order === null ? 'unavailable' : order > 0 ? 'update' : order < 0 ? 'newer' : 'current' };
  });
}
