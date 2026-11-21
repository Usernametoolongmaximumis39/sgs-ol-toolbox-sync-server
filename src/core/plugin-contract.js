import { CORE_VERSION } from './version.js';
import { isIconSpec } from '../ui/icons.js';
import { validReleaseNotes } from '../shared/plugin-release-notes.js';

export const DEFAULT_PLUGIN_PRIORITY = 32768;
export const PANEL_CATEGORIES = Object.freeze(['game', 'automation', 'tools', 'manage', 'info', 'appearance']);
const localId = /^[a-z][a-z0-9.-]{0,63}$/;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const validPriority = value => Number.isInteger(value) && value >= 0 && value <= 65535;
function requirePriority(value) { if (!validPriority(value)) throw new Error('排序优先级必须是 0–65535 的整数。'); }
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\r\n\u0000-\u001f]/.test(value);
function compareVersions(left, right) {
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export function validatePluginPresentation(manifest, { requireContract = false, checkCompatibility = true } = {}) {
  const m = manifest;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('插件清单无效。');
  if (requireContract && m.contractVersion !== 1) throw new Error('新插件必须声明 contractVersion: 1 并遵守插件开发规范。');
  if (m.contractVersion !== undefined && m.contractVersion !== 1) throw new Error('不支持此插件开发约定版本。');
  if (!Array.isArray(m.categories) || m.categories.some(c => !PANEL_CATEGORIES.includes(c)) || new Set(m.categories).size !== m.categories.length) throw new Error('插件分类无效或重复。');
  if (m.dependencies !== undefined && (!Array.isArray(m.dependencies) || m.dependencies.length > 64 || m.dependencies.some(id => typeof id !== 'string' || !localId.test(id) || id === m.id) || new Set(m.dependencies).size !== m.dependencies.length)) throw new Error('前置插件必须是不重复的插件 ID 数组，且不能依赖自身。');
  if (m.dependencies?.length && (!stableVersion.test(m.minCoreVersion || '') || compareVersions(m.minCoreVersion, '0.5.62') < 0)) throw new Error('前置插件功能要求 minCoreVersion 至少为 0.5.62。');
  const strict = m.contractVersion === 1;
  if (strict && !text(m.name, 48)) throw new Error('插件名称必须是 1–48 字的单行文字。');
  if ((strict || m.description !== undefined) && !text(m.description, 160)) throw new Error('插件简介必须是 1–160 字的单行文字。');
  if (!validReleaseNotes(m.releaseNotes)) throw new Error('插件更新内容须为 1–2000 字的非空纯文本，可分行。');
  if ((strict || m.icon !== undefined) && !isIconSpec(m.icon)) throw new Error('插件图标必须是公共图标名或合法的 24×24 单色路径。');
  if (strict || m.priority !== undefined) requirePriority(m.priority);
  if (strict || m.minCoreVersion !== undefined) {
    if (typeof m.minCoreVersion !== 'string' || m.minCoreVersion.length > 48 || !stableVersion.test(m.minCoreVersion)) throw new Error('minCoreVersion 必须是 x.y.z 格式的稳定核心版本。');
    if (strict && compareVersions(m.minCoreVersion, '0.5.0') < 0) throw new Error('插件开发约定 v1 要求 minCoreVersion 至少为 0.5.0。');
    if (checkCompatibility && compareVersions(m.minCoreVersion, CORE_VERSION) > 0) throw new Error(`插件需要核心 ${m.minCoreVersion} 或更新版本，当前为 ${CORE_VERSION}。`);
  }
  return m;
}

export function normalizePanel(spec, manifest) {
  if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !localId.test(spec.id)) throw new Error('面板 ID 必须是稳定的小写局部标识。');
  if (typeof spec.render !== 'function') throw new Error('面板必须提供 render 函数。');
  if (spec.title !== undefined && !text(spec.title, 80)) throw new Error('面板标题必须是 1–80 字的单行文字。');
  const declared = manifest.categories, category = spec.category ?? (declared.length === 1 ? declared[0] : undefined);
  if (!PANEL_CATEGORIES.includes(category) || !declared.includes(category)) throw new Error('面板分类必须在插件 categories 中声明；多分类插件须指定 category。');
  if (spec.priority !== undefined) requirePriority(spec.priority);
  if (spec.gameView !== undefined && (category !== 'game' || !['battle', 'shanhe'].includes(spec.gameView))) throw new Error('gameView 仅用于 game 面板，值为 battle 或 shanhe。');
  if (spec.groupWith !== undefined && !manifest.dependencies?.includes(spec.groupWith)) throw new Error('面板只能并入已声明的前置插件组。');
  if (spec.groupTab !== undefined && (spec.groupTab !== true || !spec.groupWith || spec.title === undefined)) throw new Error('组内页签必须声明前置插件组和页签标题。');
  if (spec.groupTabs !== undefined && (spec.groupTabs !== true || spec.groupWith)) throw new Error('只有独立插件组的面板可以承载组内页签。');
  if ((spec.groupTab || spec.groupTabs) && (!stableVersion.test(manifest.minCoreVersion || '') || compareVersions(manifest.minCoreVersion, '0.6.121') < 0)) {
    throw new Error('组内页签要求 minCoreVersion 至少为 0.6.121。');
  }
  return { ...spec, id: manifest.id + ':' + spec.id, category, priority: spec.priority ?? DEFAULT_PLUGIN_PRIORITY,
    pluginId: manifest.id, pluginName: manifest.name, pluginIcon: manifest.icon ?? 'package',
    pluginPriority: manifest.priority ?? DEFAULT_PLUGIN_PRIORITY };
}
const ascii = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const priority = value => validPriority(value) ? value : DEFAULT_PLUGIN_PRIORITY;
export function comparePluginOrder(a, b) { return priority(a.priority) - priority(b.priority) || ascii(String(a.id), String(b.id)) || ascii(String(a.version || ''), String(b.version || '')); }
export function comparePanelOrder(a, b) {
  return priority(a.pluginPriority) - priority(b.pluginPriority)
    || ascii(String(a.pluginId || a.id), String(b.pluginId || b.id))
    || priority(a.priority) - priority(b.priority) || ascii(String(a.id), String(b.id));
}
