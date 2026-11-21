import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { syncAccountSeed } from '../src/core/dev-appearance-sync.js';
import { observedLedgerEvents, projectLedgerBalance, projectLedgerEvent, projectLedgerProfile, validLedgerVersion } from '../src/plugins/ledger/sync-model.js';
import { EMPTY_LEDGER as EMPTY, ledgerDownload, mergeLedgerUpload, visibleBalances } from '../src/core/sync-ledger-records.js';
import { filterRecords, totals } from '../src/plugins/ledger/model.js';
import { MODES } from '../src/plugins/appearances/model.js';
import { sideOf, sideName } from '../src/plugins/appearances/groups.js';

const PAGE_SIZE = 30;
const MATCH_RESULTS = { win: 0, loss: 1, draw: 255 };

async function replaceJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

export async function openLedgerSyncStore(file) {
  const saved = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; });
  const ledger = new Map(Object.entries(JSON.parse(saved)).map(([account, entry]) => [
    account, { ...entry, eventVersion: entry.eventVersion ?? (entry.events.length ? randomUUID() : null) },
  ]));
  const observed = new WeakMap();
  function observations(events) {
    if (!observed.has(events)) {
      const rows = observedLedgerEvents(events);
      observed.set(events, { rows, confirmed: rows.filter(row => !row.review) });
    }
    return observed.get(events);
  }
  async function commit(account, entry) {
    const view = Object.fromEntries(ledger);
    view[account] = entry;
    await replaceJson(file, view);
    ledger.set(account, entry);
  }

  async function exchange(account, upload) {
    const previous = ledger.get(account) ?? EMPTY;
    const { entry, conflicts } = mergeLedgerUpload(previous, upload, Date.now(), randomUUID);
    if (entry !== previous) await commit(account, entry);
    return { account, conflicts, ...(upload.pull ? { download: ledgerDownload(entry, upload.pull, observations(entry.events).confirmed) } : {}) };
  }

  async function saveNames(account, names) {
    const previous = ledger.get(account) ?? EMPTY;
    const entries = Object.entries(names).filter(([id, name]) => previous.names[id] !== name);
    if (entries.length) await commit(account, { ...previous, names: { ...previous.names, ...Object.fromEntries(entries) } });
  }

  function listAccounts(matchesByAccount, identity = '') {
    return [...new Set([...ledger.keys(), ...matchesByAccount.keys()])].map(key => {
      const entry = ledger.get(key), matches = matchesByAccount.get(key);
      const { userCode, name } = entry?.profile || {};
      return { key, userCode, name, label: userCode ? [name, userCode].filter(Boolean).join(' · ') : `账号 ${key.slice(0, 8).toUpperCase()}`,
        at: entry?.updatedAt, latestMatch: [...(matches?.values() ?? [])].reduce((latest, row) => Math.max(latest, row.endedAt), 0) };
    }).filter(row => !identity || (/^\d+$/.test(identity)
      ? row.userCode && (identity.length === 10 ? row.userCode === identity : row.userCode.includes(identity))
      : row.name?.toLocaleLowerCase('zh-CN').includes(identity)))
      .sort((a, b) => Math.max(b.at || 0, b.latestMatch) - Math.max(a.at || 0, a.latestMatch));
  }

  function preview(matchesByAccount, { account, accountQuery, stream, page, query, from, to, period, kind, allRows, battle, previewAccount, allowPreviewAccount }, catalogue) {
    const accounts = listAccounts(matchesByAccount, previewAccount ? '' : accountQuery.toLocaleLowerCase('zh-CN'))
      .filter(row => (!previewAccount || row.key === previewAccount) && allowPreviewAccount(row.key));
    const selected = account ? accounts.find(entry => entry.key === account) : accounts[0];
    const key = selected?.key, entry = ledger.get(key) ?? EMPTY;
    const matches = [...(matchesByAccount.get(key)?.values() ?? [])];
    const { rows: events, confirmed } = observations(entry.events);
    const text = query.toLocaleLowerCase('zh-CN');
    const generalName = id => catalogue?.get(id)?.name || entry.names[id] || `武将 #${id}`;
    const generalDetails = id => {
      const general = catalogue?.get(id);
      return { id, name: generalName(id), avatarUrl: general?.avatarUrl ?? null, portraitUrl: general?.portraitUrl ?? null };
    };
    const matchesGeneral = id => String(id) === text || generalName(id).toLocaleLowerCase('zh-CN').includes(text)
      || entry.names[id]?.toLocaleLowerCase('zh-CN').includes(text);
    const history = stream === 'matches'
      ? matches.filter(row => row.endedAt >= from && row.endedAt <= to
        && (!battle.mode || row.mode === battle.mode)
        && (battle.side === 'all' || sideOf(row) === battle.side)
        && (battle.result === 'all' || row.result === MATCH_RESULTS[battle.result])
        && (battle.frame === 'all' || Boolean(row.frame) === (battle.frame === 'with'))
        && (!text || MODES[row.mode].includes(text)
          || (row.frame?.general ?? row.general).some(matchesGeneral)))
        .sort((a, b) => b.endedAt - a.endedAt)
      : filterRecords(stream === 'review' ? events.filter(row => row.review) : confirmed, {
        from, to, item: query, kind, session: period === 'session' ? entry.profile?.session.id || 'no-synced-login' : '',
      });
    const summarizedMatches = stream === 'matches' ? history : matches;
    const summary = { events: confirmed.length, review: events.length - confirmed.length, matches: summarizedMatches.length,
      frames: summarizedMatches.filter(row => row.frame).length, wins: summarizedMatches.filter(row => row.result === 0).length,
      losses: summarizedMatches.filter(row => row.result === 1).length, draws: summarizedMatches.filter(row => row.result === 255).length };
    let amounts = [];
    if (stream === 'events') {
      const names = new Map(history.flatMap(row => row.items.map(({ id, name }) => [id, name])));
      amounts = [...totals(history)].map(([id, total]) => ({ id, name: names.get(id), ...total }));
    }
    const pages = Math.max(1, Math.ceil(history.length / PAGE_SIZE)), shownPage = Math.min(page, pages);
    const rows = (allRows ? history : history.slice((shownPage - 1) * PAGE_SIZE, shownPage * PAGE_SIZE)).map(row => stream === 'matches'
      ? { mode: MODES[row.mode], side: sideName(row.mode, sideOf(row)), endedAt: row.endedAt, duration: row.duration, result: row.result,
        generals: row.general.map(generalName), frame: row.frame?.general.map(generalName) ?? null,
        ...(!allRows && { generalDetails: row.general.map(generalDetails), frameDetails: row.frame?.general.map(generalDetails) ?? null }) }
      : { id: row.id, at: row.at, items: row.items, prayer: row.prayer, type: row.type, source: row.source });
    const profile = selected?.userCode ? { userCode: selected.userCode, name: selected.name } : null;
    if (allRows) return { account: profile, stream, rows, amounts, ...(stream === 'matches' ? { summary } : {}) };
    return { accounts: accounts.map(({ key, label }) => ({ key, label })), account: key ?? null, profile, updatedAt: entry.updatedAt,
      balances: visibleBalances(entry), summary, rows, amounts, count: history.length, latestLogin: entry.profile?.session.at ?? null, page: shownPage, pages };
  }
  return { exchange, saveNames, preview, listAccounts, hasAccount: key => ledger.has(key), snapshot: key => ledger.get(key) ?? EMPTY,
    async remove(key) {
      if (!ledger.has(key)) return;
      const next = Object.fromEntries(ledger);
      delete next[key];
      await replaceJson(file, next);
      ledger.delete(key);
    },
    async clear() { await replaceJson(file, {}); ledger.clear(); } };
}

export function readBattleFilters(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_battle_filter');
  const { mode = 0, side = 'all', result = 'all', frame = 'all' } = value;
  if (!Number.isInteger(mode) || mode !== 0 && !Object.hasOwn(MODES, mode)
    || !['all', 'first', 'second', 'landlord', 'farmer'].includes(side)
    || result !== 'all' && (typeof result !== 'string' || !Object.hasOwn(MATCH_RESULTS, result))
    || !['all', 'with', 'without'].includes(frame)) throw new Error('invalid_battle_filter');
  return { mode, side, result, frame };
}

export function readLedgerUpload(payload, limit) {
  if (!Array.isArray(payload.balances) || payload.balances.length > 256 || !Array.isArray(payload.events) || payload.events.length > limit)
    throw new Error('invalid_ledger_upload');
  const balances = payload.balances.map(projectLedgerBalance), events = payload.events.map(projectLedgerEvent);
  if (balances.includes(null) || events.includes(null)) throw new Error('invalid_ledger_record');
  let pull;
  if (payload.pull !== undefined) {
    const { version, offset } = payload.pull ?? {};
    if (!validLedgerVersion(version) || !Number.isSafeInteger(offset) || offset < 0 || offset && version === null)
      throw new Error('invalid_ledger_download');
    pull = { version, offset };
  }
  let profile, knotWindow;
  if (payload.profile !== undefined) {
    const { userCode, name, session } = payload.profile ?? {};
    profile = projectLedgerProfile(userCode, name, session);
    if (!profile || userCode !== profile.userCode || typeof name !== 'string' || name.length > 100 ||
      createHash('sha256').update(syncAccountSeed(String(Number(userCode)))).digest('hex') !== payload.account)
      throw new Error('invalid_ledger_profile');
  }
  if (payload.knotWindow !== undefined) {
    const { at, active } = payload.knotWindow ?? {};
    if (!Number.isSafeInteger(at) || at <= 0 || !Array.isArray(active) || active.length > 256
      || active.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('invalid_knot_window');
    knotWindow = { at, active: [...new Set(active)] };
  }
  return { balances, events, pull, profile, knotWindow };
}
