import { GENERAL_POOL_LIMIT } from './general-pool-storage.js';

export { PREFERENCES_SYNC_PATH } from './sync-paths.js';
export const PREFERENCES_LIMIT = 4 * 1024 * 1024;
export const PREFERENCE_GROUPS = Object.freeze(['toolbox', 'generalPools', 'friends', 'friendLamps', 'pluginSettings']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const oneOf = (...values) => value => values.includes(value);
const boolean = value => typeof value === 'boolean';
const text = limit => value => typeof value === 'string' && value.length <= limit;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const userId = value => typeof value === 'string' && /^\d{10}$/.test(value) && Number(value) > 0 && Number(value) <= 0xffffffff;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const listOf = (test, max) => value => Array.isArray(value) && value.length <= max && value.every(test);
const boolFields = keys => Object.fromEntries(keys.split(' ').map(key => [key, boolean]));
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
  cardStyle: text(96),
  cardFaceStyle: text(96),
  cardBackStyle: text(96),
  cardStyleScope: oneOf('self', 'all'),
  cardStyleExpanded: boolean,
});
export const TOOLBOX_SYNC_KEYS = Object.freeze(Object.keys(fields));

const watchFields = {
  watchVersion: oneOf(2), cards: boolean, lamps: boolean, scheme: oneOf('default', 'custom'),
  landlord: listOf(text(48), 10), farmer: listOf(text(48), 10),
  ...Object.fromEntries(['landlordIds', 'farmerIds', 'defaultLandlordIds', 'defaultFarmerIds']
    .map(key => [key, listOf(value => value === null || positiveId(value), 10)])),
};
const pluginFields = {
  backgrounds: boolFields('animated attackEffects'),
  cards: {
    ...boolFields('recent deck discard reveals labels fourColors handSort countdown skillCounts skillHints handGroupSpacing queryExpanded'),
    revealOpacity: oneOf(60, 80, 100), revealColumns: oneOf(4, 5, 6, 7, 8),
    discardMode: oneOf('time', 'suit', 'type', 'number'), recentMode: oneOf('player', 'current'), deckGroup: oneOf('name', 'suit', 'number'),
    lockedSort: value => value === null || Number.isSafeInteger(value),
  },
  effects: boolFields('selection sha shan trick equip shake heal kill skill selfSkin otherSkin tianshu ad version banner notice redDot slogan emotion rogue entrance result package prob download'),
  'play-assist': { ...boolFields('skillLock autoConfirm fireAttack skipWuxie skipTao skipAssist quandaoCount rapid'),
    rememberedSkillIds: listOf(positiveId, 10000) },
  'player-info': { settings: isObject },
  shanhetu: boolFields('labels enemies events optionImpact keepBattleBackground'),
  skins: { ...boolFields('advanced quickDownload backgroundShortcut unlockSkin unlockDynamic otherPlayers crossServer yjcmDynamicOptimization'),
    nativeGroup: oneOf('country', 'quality') },
  social: boolFields('onlyPasswordFreeRooms'),
};
const pluginSettingFields = Object.fromEntries(Object.entries(pluginFields).flatMap(([id, config]) =>
  Object.entries(config).map(([key, test]) => [id + ':' + key, test])));
export const PLUGIN_SYNC_KEYS = Object.freeze(Object.keys(pluginSettingFields));

const accountFields = {
  'gaizhu:account:@:options-v1': {
    pick: oneOf('off', 'random', 'order'), wait: boolean, autoMode: oneOf('identity', 'nation', 'training'),
    stopMode: oneOf('manual', 'tavern', 'timed'), stopHours: value => Number.isFinite(value) && value > 0 && Number.isSafeInteger(Math.ceil(value * 3600000)),
  },
  'daily-rewards:account:@:options': {
    schemaVersion: oneOf(2), ...boolFields('sign mail tasks welfare activities autoFlip codes serverCodes clipboardCodes shareCodes excludeRecruit excludeCoupon excludeTrial excludeBeans'),
  },
};
const accountListFields = { 'shanhetu:followedSchools:@': listOf(positiveId, 512) };
export const ACCOUNT_SYNC_KEYS = Object.freeze([...Object.keys(accountFields), ...Object.keys(accountListFields)]);
export const syncPluginStorageKey = (key, account) => key.replace(':@', ':' + account);
export const LEDGER_THRESHOLD_PREFIX = 'ledger:threshold:';
const ledgerThresholdKey = /^ledger:threshold:@:[1-9]\d{0,15}$/;

const cleanFields = (value, validators) => Object.fromEntries(Object.entries(validators)
  .filter(([key, test]) => has(value, key) && test(value[key])).map(([key]) => [key, value[key]]));

function cleanPluginSettings(value) {
  if (!isObject(value)) throw new Error('插件设置格式无效');
  const result = cleanFields(value, { ...pluginSettingFields, ...accountListFields });
  for (const [key, validators] of Object.entries({ 'player-info:settings': watchFields, ...accountFields })) {
    if (has(value, key) && isObject(value[key])) result[key] = cleanFields(value[key], validators);
  }
  for (const [key, threshold] of Object.entries(value)) {
    if (ledgerThresholdKey.test(key) && Number.isFinite(threshold) && threshold >= 0) result[key] = threshold;
  }
  return result;
}

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

function cleanFriends(value) {
  if (value?.version !== 1 || !isObject(value.friends) || !listOf(userId, 2000)(value.pins) ||
      !Array.isArray(value.changes) || value.changes.length > 200) throw new Error('好友记录格式无效');
  const entries = Object.entries(value.friends);
  if (entries.length > 2000 || !entries.every(([id, row]) => userId(id) && text(128)(row?.name) &&
      timestamp(row.seenAt) && (row.missingAt === undefined || timestamp(row.missingAt)))) throw new Error('好友列表格式无效');
  const changes = value.changes.map(row => {
    if (!userId(row?.id) || !text(128)(row.from) || !text(128)(row.to) || !timestamp(row.at)) throw new Error('好友改名记录格式无效');
    return { id: row.id, from: row.from, to: row.to, at: row.at };
  });
  return { version: 1, pins: [...new Set(value.pins)], friends: Object.fromEntries(entries.map(([id, row]) =>
    [id, { name: row.name, seenAt: row.seenAt, ...(row.missingAt && { missingAt: row.missingAt }) }])), changes };
}

function cleanFriendLamps(value) {
  if (value?.version !== 1 || !isObject(value.friends)) throw new Error('好友水表格式无效');
  const entries = Object.entries(value.friends);
  if (entries.length > 2000) throw new Error('好友水表数量超出上限');
  return { version: 1, friends: Object.fromEntries(entries.map(([id, row]) => {
    if (!userId(id) || !text(128)(row?.name) || !timestamp(row.at) || !listOf(positiveId, 10000)(row.ids) ||
        (row.names !== undefined && !isObject(row.names))) throw new Error('好友水表格式无效');
    const ids = [...new Set(row.ids)].sort((a, b) => a - b);
    const names = Object.fromEntries(ids.filter(key => row.names && has(row.names, key) && text(128)(row.names[key]))
      .map(key => [key, row.names[key]]));
    return [id, { name: row.name, ids, names, at: row.at }];
  })) };
}

export function cleanPreferences(value) {
  if (!isObject(value)) throw new Error('同步设置格式无效');
  const result = {};
  if (has(value, 'toolbox')) result.toolbox = cleanToolbox(value.toolbox);
  if (has(value, 'generalPools')) result.generalPools = cleanGeneralPools(value.generalPools);
  if (has(value, 'friends')) result.friends = cleanFriends(value.friends);
  if (has(value, 'friendLamps')) result.friendLamps = cleanFriendLamps(value.friendLamps);
  if (has(value, 'pluginSettings')) result.pluginSettings = cleanPluginSettings(value.pluginSettings);
  if (new TextEncoder().encode(JSON.stringify(result)).length > PREFERENCES_LIMIT) throw new Error('同步备份超过 4 MB');
  return result;
}

export function mergePreferenceUpload(previous, values, { patch, preservePins } = {}) {
  const next = { ...previous, ...values };
  if (!patch) return next;
  for (const group of ['toolbox', 'pluginSettings']) {
    if (values[group]) next[group] = { ...previous[group], ...values[group] };
  }
  if (preservePins && values.friends && previous.friends) next.friends = { ...values.friends, pins: previous.friends.pins };
  return cleanPreferences(next);
}
