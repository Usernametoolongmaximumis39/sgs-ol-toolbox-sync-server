import { validatePluginPresentation } from './plugin-contract.js';
export const PACKAGE_FORMAT = 'sgs-toolbox-plugin-v1';
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function packageDigest(manifest, code, cryptoImpl = globalThis.crypto) {
  const bytes = new TextEncoder().encode(canonical(manifest) + '\n' + code);
  return Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export function validateManifest(m, options) {
  if (!m || !/^[a-z][a-z0-9.-]{0,63}$/.test(m.id) || typeof m.name !== 'string' || !m.name.trim() || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(m.version)) throw new Error('插件名称、ID 或版本无效。');
  if (m.apiVersion !== 1) throw new Error('插件需要不兼容的核心 API。');
  validatePluginPresentation(m, options);
}
export async function verifyPackage(pkg) {
  if (pkg?.format !== PACKAGE_FORMAT || typeof pkg.code !== 'string' || pkg.code.length > 10 * 1024 * 1024) throw new Error('插件包格式不正确或超过 10 MB。');
  validateManifest(pkg.manifest);
  if (await packageDigest(pkg.manifest, pkg.code) !== String(pkg.sha256).toLowerCase()) throw new Error('插件包校验失败，文件可能损坏。');
  return pkg;
}
export function compilePackage(pkg) {
  let module;
  try { module = new Function('"use strict";\n' + pkg.code)(); } catch (e) { throw new Error('插件代码加载失败（可能受页面 CSP 限制）：' + e.message); }
  if (!module || canonical(module.manifest) !== canonical(pkg.manifest) || typeof module.activate !== 'function') throw new Error('插件代码与清单不匹配。');
  return module;
}
