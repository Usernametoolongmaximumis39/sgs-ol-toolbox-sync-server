import { read } from './safe-read.js';
export { read } from './safe-read.js';

export function field(packet, key) {
  for (const node of [packet, read(() => packet.Protocol), read(() => packet.ProtoObj), read(() => packet.protoObj),
    read(() => packet.data.protoObj), read(() => packet.data.ProtoObj)]) {
    const value = read(() => node[key]); if (value !== undefined && value !== null) return value;
  }
}
export function generalNames(config) {
  const names = {};
  for (const row of config?.GameCharacters?.character || []) {
    const id = Number(row.id ?? row.a), name = row.name ?? row.b;
    if (id > 0 && name) names[id] = String((row.name_prefix ?? row.ai ?? '') + name);
  }
  return names;
}
export function downloadJSON(ctx, filename, value) {
  const url = ctx.window.URL.createObjectURL(new ctx.window.Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = ctx.document.createElement('a'); a.href = url; a.download = filename; a.click();
  const release = ctx.scope.add(() => ctx.window.URL.revokeObjectURL(url)); ctx.scope.timeout(release, 1000);
}
