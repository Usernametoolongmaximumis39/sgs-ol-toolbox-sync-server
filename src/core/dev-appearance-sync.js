import { compareVersions } from '../market/updates.js';
import { LEDGER_SYNC_PATH, MATCH_SYNC_PATH } from '../shared/sync-paths.js';

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

export function createDevAppearanceSync(win, managed) {
  const exchange = createExchange(win, MATCH_SYNC_PATH, managed);
  const sync = async (account, matches, signal, names) => (await exchange(account, { matches, names }, signal)).matches;
  return Object.assign(sync, { available: managed.available, cacheKey: managed.cacheKey });
}

export function createDevLedgerSync(win, managed) {
  const exchange = createExchange(win, LEDGER_SYNC_PATH, managed);
  return Object.freeze({
    available: managed.available, cacheKey: managed.cacheKey,
    async exchange(account, data, signal) {
      const reply = await exchange(account, data, signal);
      if (!Number.isSafeInteger(reply.conflicts) || reply.conflicts < 0) throw new Error('账本同步回执无效');
      return reply;
    },
  });
}
