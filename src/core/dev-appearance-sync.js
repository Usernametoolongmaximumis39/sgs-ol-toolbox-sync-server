import { compareVersions } from '../market/updates.js';
import { LEDGER_SYNC_PATH, MATCH_SYNC_PATH } from '../shared/sync-paths.js';
import { confirmedLedgerEvents, EMPTY_LEDGER, ledgerDownload, visibleBalances } from './sync-ledger-records.js';

export const syncAccountSeed = account => `sgstoolbox-appearances-test:${account}`;

export async function installLocalAppearanceSyncPackage(manager, settings, pkg) {
  const key = 'localAppearanceSyncPackage';
  if (settings.get(key, '') === pkg.sha256) return;
  const installed = manager.list().find(plugin => plugin.id === pkg.manifest.id);
  if (!installed || compareVersions(installed.version, pkg.manifest.version) < 0) await manager.install(pkg);
  settings.set(key, pkg.sha256);
}

export async function syncGameAccountKey(win, account) {
  const bytes = new TextEncoder().encode(syncAccountSeed(account));
  const hash = new Uint8Array(await win.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

function createExchange(win, path, managed) {
  return async (account, data, signal) => {
    if (!managed.available(account)) throw new Error('请先在「管理 → 云同步」绑定当前账号');
    const accountKey = await syncGameAccountKey(win, account);
    const payload = await managed.exchange(account, path, data, accountKey, signal);
    if (payload?.account !== accountKey) throw new Error('同步回复账号不符');
    return payload;
  };
}

export function createDevAppearanceSync(win, managed, backup) {
  const exchange = createExchange(win, MATCH_SYNC_PATH, managed);
  if (!backup) return Object.assign(
    async (account, matches, signal, names) => (await exchange(account, { matches, names }, signal)).matches,
    { available: managed.available, cacheKey: managed.cacheKey });
  let binding, acknowledged = new Map(), oldNames;
  const sync = async (account, matches, signal, names) => {
    const key = managed.cacheKey(account);
    if (key !== binding) { binding = key; acknowledged = new Map(); oldNames = undefined; }
    const queued = acknowledged;
    const current = await backup.history(account);
    const cloud = new Map(current?.matches.map(row => [row.gameId, JSON.stringify(row)]));
    const changed = matches.filter(row => {
      const encoded = JSON.stringify(row);
      return queued.get(row.gameId) !== encoded && cloud.get(row.gameId) !== encoded;
    });
    const nextNames = names && JSON.stringify(names);
    if (changed.length || nextNames && nextNames !== oldNames) {
      const reply = await exchange(account, { matches: changed, names: nextNames !== oldNames ? names : undefined, uploadOnly: true }, signal);
      if (reply.ok !== true) throw new Error('战绩上传回执无效，请更新同步服务');
      for (const row of changed) queued.set(row.gameId, JSON.stringify(row));
      if (queued === acknowledged && nextNames) oldNames = nextNames;
    }
    return (await backup.history(account))?.matches ?? [];
  };
  return Object.assign(sync, { localBackup: true, available: backup.canUpload, cacheKey: managed.cacheKey });
}

export function createDevLedgerSync(win, managed, backup) {
  const exchange = createExchange(win, LEDGER_SYNC_PATH, managed);
  const pages = new WeakMap();
  const confirmed = ledger => {
    if (!pages.has(ledger)) pages.set(ledger, confirmedLedgerEvents(ledger.events));
    return pages.get(ledger);
  };
  return Object.freeze({
    available: backup?.canUpload ?? managed.available,
    cacheKey: id => (!backup || backup.canUpload(id)) ? managed.cacheKey(id) : undefined,
    localBackup: Boolean(backup),
    ...(backup && { async readHistory(account) {
      const ledger = (await backup.history(account))?.ledger ?? EMPTY_LEDGER;
      return { version: ledger.eventVersion, events: confirmed(ledger), balances: visibleBalances(ledger) };
    } }),
    async exchange(account, data, signal) {
      const { pull, ...upload } = data;
      const reply = backup && pull?.offset ? { conflicts: 0 }
        : await exchange(account, backup ? { ...upload, uploadOnly: true } : data, signal);
      if (!Number.isSafeInteger(reply.conflicts) || reply.conflicts < 0) throw new Error('账本同步回执无效');
      if (backup && pull) {
        const ledger = (await backup.history(account))?.ledger ?? EMPTY_LEDGER;
        return { ...reply, download: ledgerDownload(ledger, pull, confirmed(ledger)) };
      }
      return reply;
    },
  });
}
