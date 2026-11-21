import http from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEDGER_PREVIEW_PATH as previewPath, LEDGER_SYNC_PATH as ledgerEndpoint, MATCH_SYNC_PATH } from '../src/shared/sync-paths.js';
import { MATCH_SYNC_LIMIT, MATCH_SYNC_BYTES, projectSyncMatch, sameSyncMatch } from '../src/plugins/appearances/match-sync.js';
import { LEDGER_SYNC_BATCH, LEDGER_SYNC_BYTES } from '../src/plugins/ledger/sync-model.js';
import { openLedgerSyncStore, readBattleFilters, readLedgerUpload } from './ledger-sync-store.mjs';
import { openGeneralCatalogue } from './general-catalogue.mjs';

export const syncOrigins = new Set(['https://web.sanguosha.com', 'http://web.sanguosha.com', 'http://127.0.0.1:17321']);
const accountPattern = /^[a-f0-9]{64}$/;
export const EXISTING_SYNC_FILE = fileURLToPath(new URL('../test-results/local-appearance-sync/store.json', import.meta.url));
const previewAssets = {
  [previewPath]: ['index.html', 'text/html'],
  [previewPath + 'preview.css']: ['preview.css', 'text/css'],
  [previewPath + 'preview.js']: ['preview.js', 'text/javascript'],
};

export function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function readMatches(rows) {
  if (!Array.isArray(rows) || rows.length > MATCH_SYNC_LIMIT) throw new Error('invalid_matches');
  const matches = rows.map(projectSyncMatch);
  if (matches.some(row => !row)) throw new Error('invalid_match');
  return matches;
}

function readNames(names, matches) {
  if (names === undefined) return {};
  if (!names || typeof names !== 'object' || Array.isArray(names)) throw new Error('invalid_names');
  const entries = Object.entries(names);
  if (entries.length > 4096) throw new Error('invalid_names');
  const referenced = new Set(matches.flatMap(row => row.frame?.general ?? row.general));
  return Object.fromEntries(entries.filter(([id, name]) => referenced.has(Number(id)) && id === String(Number(id))
    && typeof name === 'string' && name.trim() && name.length <= 60));
}

export async function readJson(request, limit) {
  if (Number(request.headers['content-length']) > limit) throw new RangeError('body_too_large');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new RangeError('body_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function openAppearanceSyncData({ file = EXISTING_SYNC_FILE, ledgerFile = `${file}.ledger`, catalogue } = {}) {
  const generals = catalogue ?? (file === EXISTING_SYNC_FILE ? await openGeneralCatalogue(`${file}.generals.json`) : null);
  const saved = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; });
  const accounts = new Map(Object.entries(JSON.parse(saved)).map(([key, rows]) => {
    if (!accountPattern.test(key)) throw new Error('invalid_stored_account');
    return [key, new Map(readMatches(rows).map(row => [row.gameId, row]))];
  }));
  const ledger = await openLedgerSyncStore(ledgerFile);
  let writes = Promise.resolve();
  async function saveMatches(snapshot) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  const matchSnapshot = () => Object.fromEntries([...accounts].map(([key, value]) => [key, [...value.values()]]));
  async function exchange(account, uploaded) {
    const previous = accounts.get(account) ?? new Map();
    const matches = new Map(previous);
    let changed = false;
    for (const row of uploaded) {
      const existing = matches.get(row.gameId);
      if (!existing) { matches.set(row.gameId, row); changed = true; }
      else if (row.frame && !existing.frame && sameSyncMatch(existing, row)) {
        matches.set(row.gameId, { ...existing, frame: row.frame }); changed = true;
      }
    }
    if (matches.size > MATCH_SYNC_LIMIT) return { status: 409, body: { error: 'account_limit' } };
    const rows = [...matches.values()];
    if (changed) {
      await saveMatches({ ...matchSnapshot(), [account]: rows });
      accounts.set(account, matches);
    }
    return { status: 200, body: { account, matches: rows } };
  }

  const hasAccount = key => accounts.has(key) || ledger.hasAccount(key);
  async function handle(request, response, { legacy = false, preview = legacy, device = null,
    allowedOrigins = syncOrigins, allowLegacyAccount, previewAccount, previewUrl = request.url, canWrite = () => true,
    allowPreviewAccount = () => true, deviceStillAuthorized = () => true, origin = request.headers.origin } = {}) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Vary', 'Origin');
    if (request.method === 'GET' && request.url === '/health') return send(response, 200, { ok: true, service: 'appearances-sync' });
    const asset = Object.hasOwn(previewAssets, previewUrl) && previewAssets[previewUrl];
    const previewRead = previewUrl === previewPath + 'read';
    if (asset || previewRead) {
      if (!preview) return send(response, 404, { error: 'not_found' });
      const site = request.headers['sec-fetch-site'];
      const navigation = asset && previewUrl === previewPath && request.headers['sec-fetch-mode'] === 'navigate';
      if (origin && origin !== `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}` || !navigation && site && !['none', 'same-origin'].includes(site))
        return send(response, 403, { error: 'preview_origin_not_allowed' });
      response.setHeader('Vary', 'Origin, Sec-Fetch-Site');
      const method = asset ? 'GET' : 'POST';
      if (request.method !== method) return send(response, 405, { error: 'method_not_allowed' });
      if (asset) {
        const [name, type] = asset;
        try {
          const data = await readFile(new URL('./ledger-preview/' + name, import.meta.url));
          response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src https://web.sanguosha.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
          response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
          response.end(data);
        } catch { send(response, 500, { error: 'preview_unavailable' }); }
      } else {
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) return send(response, 415, { error: 'invalid_type' });
        try {
          const { account, accountQuery = '', page = 1, stream = 'events', query = '', from = 0, to = 8640000000000000,
            kind = 'all', period = 'all', export: allRows = false, battle } = await readJson(request, 4096);
          if (account !== undefined && (typeof account !== 'string' || !accountPattern.test(account))
            || !['events', 'review', 'matches'].includes(stream) || !Number.isSafeInteger(page) || page < 1
            || typeof query !== 'string' || query.length > 80 || typeof accountQuery !== 'string' || accountQuery.length > 100
            || !['all', 'goods', 'prayer'].includes(kind) || !['all', 'session'].includes(period) || typeof allRows !== 'boolean'
            || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > 8640000000000000) throw new Error('invalid_view');
          send(response, 200, ledger.preview(accounts, { account: previewAccount ?? account, accountQuery: accountQuery.trim(), page, stream, query: query.trim(),
            from, to, kind, period, allRows, battle: readBattleFilters(battle), previewAccount, allowPreviewAccount }, generals));
        } catch { if (!response.destroyed) send(response, 400, { error: 'invalid_preview_request' }); }
      }
      return;
    }
    const isLedger = request.url === ledgerEndpoint;
    if (!isLedger && request.url !== MATCH_SYNC_PATH) return send(response, 404, { error: 'not_found' });
    if (!allowedOrigins.has(origin)) return send(response, 403, { error: 'origin_not_allowed' });
    response.setHeader('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method'] === 'POST') {
      response.setHeader('Access-Control-Allow-Methods', 'POST');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (request.headers['access-control-request-private-network'] === 'true') response.setHeader('Access-Control-Allow-Private-Network', 'true');
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'POST') return send(response, 405, { error: 'method_not_allowed' });
    if (!legacy && !device) return send(response, 401, { error: 'binding_required' });
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) return send(response, 415, { error: 'invalid_type' });
    let payload, uploaded, names;
    try {
      payload = await readJson(request, isLedger ? LEDGER_SYNC_BYTES : MATCH_SYNC_BYTES);
      if (typeof payload?.account !== 'string' || !accountPattern.test(payload.account)) throw new Error('invalid_account');
      if (device && payload.account !== device.gameKey) return send(response, 403, { error: 'account_mismatch' });
      if (isLedger) uploaded = readLedgerUpload(payload, LEDGER_SYNC_BATCH);
      else { uploaded = readMatches(payload.matches); names = readNames(payload.names, uploaded); }
    } catch (error) {
      if (!response.destroyed) send(response, error instanceof RangeError ? 413 : 400, { error: error instanceof RangeError ? 'body_too_large' : 'invalid_payload' });
      return;
    }
    const work = writes.then(async () => {
      if (device && !deviceStillAuthorized()) return { status: 401, body: { error: 'binding_required' } };
      if (!device && allowLegacyAccount && !allowLegacyAccount(payload.account)) {
        return { status: 401, body: { error: 'binding_required' } };
      }
      const storeKey = device?.storeKey ?? device?.account ?? payload.account;
      const blocked = canWrite(storeKey);
      if (blocked !== true) return { status: 409, body: { error: blocked } };
      if (isLedger) return { status: 200, body: { ...await ledger.exchange(storeKey, uploaded), account: payload.account } };
      const result = await exchange(storeKey, uploaded);
      if (result.status === 200) {
        if (Object.keys(names).length) await ledger.saveNames(storeKey, names);
        result.body.account = payload.account;
      }
      return result;
    });
    writes = work.catch(() => {});
    try { const { status, body } = await work; send(response, status, body); }
    catch { send(response, 500, { error: 'storage_error' }); }
  }
  generals?.start();
  return {
    handle, hasAccount, listAccounts: () => ledger.listAccounts(accounts),
    snapshot: key => ({ matches: [...(accounts.get(key)?.values() ?? [])], ledger: ledger.snapshot(key) }),
    async removeAccount(key) {
      if (accounts.has(key)) {
        const next = matchSnapshot();
        delete next[key];
        await saveMatches(next);
        accounts.delete(key);
      }
      await ledger.remove(key);
    },
    serialize(work) {
      const next = writes.then(work);
      writes = next.catch(() => {});
      return next;
    },
    async clearPlaintext() {
      await saveMatches({});
      accounts.clear();
      await ledger.clear();
    },
    async close() { await writes; await generals?.stop(); },
  };
}

export async function startAppearanceSync({ port = 17429, ...options } = {}) {
  const data = await openAppearanceSyncData(options);
  const server = http.createServer({ requestTimeout: 8000, headersTimeout: 5000 }, (request, response) => {
    if (request.headers.host !== `127.0.0.1:${server.address().port}`) return send(response, 403, { error: 'invalid_host' });
    return data.handle(request, response, { legacy: true });
  });
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); ready(); });
  });
  server.once('close', () => { void data.close(); });
  return server;
}

async function runCli() {
  if (process.argv.includes('--legacy')) {
    const server = await startAppearanceSync();
    console.log(`本机兼容同步服务 http://127.0.0.1:${server.address().port}${previewPath}`);
  } else {
    const { runManagedSync } = await import('./sync-admin/server.mjs');
    await runManagedSync(process.argv.slice(2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
