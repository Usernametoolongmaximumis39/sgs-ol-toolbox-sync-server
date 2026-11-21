import { GENERAL_POOL_LIMIT } from './general-pool-storage.js';

export const PREFERENCES_SYNC_PATH = '/v1/preferences/sync';
export const PREFERENCES_LIMIT = 512 * 1024;
export const PREFERENCE_GROUPS = Object.freeze(['toolbox', 'generalPools']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const oneOf = (...values) => value => values.includes(value);
const boolean = value => typeof value === 'boolean';
const fields = Object.freeze({
  fontSize: oneOf('tiny', 'small', 'standard', 'large'),
  fontSettingsCollapsed: boolean,
  theme: value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/i.test(value),
  themeWorkshopCollapsed: boolean,
  hudEdgeBehavior: oneOf('none', 'hide', 'fixed'),
  compactOpacity: oneOf(60, 80, 100),
  screenshotHideUI: boolean,
  screenshotShortcut: value => value === null || isObject(value) && typeof value.code === 'string'
    && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(value.code) && ['ctrl', 'shift', 'alt', 'meta'].every(key => boolean(value[key])),
  compatEnabled: boolean,
  compatPolicy: oneOf('hide', 'exit-known'),
  marketOnlyUninstalled: boolean,
  refreshReentryEnabled: boolean,
});
export const TOOLBOX_SYNC_KEYS = Object.freeze(Object.keys(fields));

function cleanToolbox(value) {
  if (!isObject(value)) throw new Error('工具箱设置格式无效');
  return Object.fromEntries(TOOLBOX_SYNC_KEYS.filter(key => has(value, key) && fields[key](value[key])).map(key => {
    const setting = value[key];
    if (key !== 'screenshotShortcut' || setting === null) return [key, setting];
    const { code, ctrl, shift, alt, meta } = setting;
    return [key, { code, ctrl, shift, alt, meta }];
  }));
}

function cleanGeneralPools(value) {
  if (!Array.isArray(value) || value.length > GENERAL_POOL_LIMIT) throw new Error('拓展将池方案格式无效');
  const seen = new Set();
  return value.map(row => {
    if (!isObject(row) || typeof row.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(row.id) || seen.has(row.id)
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 32 || !Array.isArray(row.ids)
      || row.ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('拓展将池方案格式无效');
    seen.add(row.id);
    return { id: row.id, name: row.name, ids: [...new Set(row.ids)].sort((a, b) => a - b) };
  });
}

export function cleanPreferences(value) {
  if (!isObject(value)) throw new Error('同步设置格式无效');
  const result = {};
  if (has(value, 'toolbox')) result.toolbox = cleanToolbox(value.toolbox);
  if (has(value, 'generalPools')) result.generalPools = cleanGeneralPools(value.generalPools);
  if (new TextEncoder().encode(JSON.stringify(result)).length > PREFERENCES_LIMIT) throw new Error('所选同步内容超过 512 KB');
  return result;
}
