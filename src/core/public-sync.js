import { base64url, fromBase64url } from './sync-pairing-code.js';
import { EMPTY_LEDGER, ledgerDownload, mergeLedgerUpload } from './sync-ledger-records.js';
import { vaultRecords, vaultSnapshot } from './sync-vault-records.js';
import { MATCH_SYNC_LIMIT, sameSyncMatch } from '../shared/match-sync-records.js';
import { BACKUP_READ_PATH, LEDGER_SYNC_PATH, PUBLIC_CHANGES_PATH, SYNC_CHANGES_PATH } from '../shared/sync-paths.js';
import { cleanPreferences, mergePreferenceUpload, PREFERENCES_SYNC_PATH } from '../shared/sync-preferences.js';

const encode = new TextEncoder(), decode = new TextDecoder('utf-8', { fatal: true });
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const passFormat = /^[2-9A-HJ-NP-Z]{6}$/;
const tokenFormat = /^[A-Za-z0-9_-]{43}$/;
const invalid = () => new Error('公共同步凭据格式无效');
function ledgerVersion(crypto) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function publicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的 HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请输入 HTTPS 服务器地址，地址中无需填写路径');
  }
  return url.origin;
}
export function randomPass(crypto) {
  let value;
  do { value = Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => alphabet[byte & 31]).join(''); }
  while (!/[2-9]/.test(value) || !/[A-Z]/.test(value));
  return value;
}
const pack = (prefix, values) => prefix + '.' + base64url(encode.encode(JSON.stringify(values)));
function unpack(prefix, value, count) {
  try {
    if (!value.startsWith(prefix + '.') || value.length > 1600) throw invalid();
    const data = JSON.parse(decode.decode(fromBase64url(value.slice(prefix.length + 1))));
    if (!Array.isArray(data) || data.length !== count || data.some(value => typeof value !== 'string')) throw invalid();
    return data;
  } catch { throw invalid(); }
}

export const publicRecovery = ({ origin, signer, vault, credential, seed, password, gameKey }) =>
  pack('SGSC1', [origin, signer, vault, credential, seed, password, gameKey]);
export function readPublicRecovery(value) {
  const [origin, signer, vault, credential, seed, password, gameKey] = unpack('SGSC1', value.trim(), 7);
  if (![vault, credential, seed].every(item => tokenFormat.test(item)) || !passFormat.test(password)
    || !/^[a-f0-9]{64}$/.test(gameKey)) throw invalid();
  fromBase64url(signer, 65);
  return { origin: publicOrigin(origin), signer, vault, credential, seed, password, gameKey };
}
export const publicViewCode = ({ origin, vault, seed }) => pack('SGSV1', [origin, vault, seed]);

export async function createVaultCipher(crypto, { vault, seed, password }) {
  const material = await crypto.subtle.importKey('raw', encode.encode(seed + ':' + password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256',
    salt: encode.encode('sgs-public-vault-v1:' + vault), iterations: 600000 }, material, 512));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const params = (iv, kind, id) => ({ name: 'AES-GCM', iv, additionalData: encode.encode(JSON.stringify([vault, kind, id])) });
  return {
    verifier: base64url(bits.slice(32)),
    async seal([kind, id, details]) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await crypto.subtle.encrypt(params(iv, kind, id), key, encode.encode(JSON.stringify(details))));
      const envelope = new Uint8Array(iv.length + data.length);
      envelope.set(iv);
      envelope.set(data, iv.length);
      return [kind, id, base64url(envelope)];
    },
    async open([kind, id, envelope]) {
      const bytes = fromBase64url(envelope);
      const data = await crypto.subtle.decrypt(params(bytes.subarray(0, 12), kind, id), key, bytes.subarray(12));
      return [kind, id, JSON.parse(decode.decode(data))];
    },
  };
}
export function createPublicTransport(crypto, post) {
  const states = new WeakMap();
  const authorize = ({ vault, credential }) => ({ vault, credential });
  async function stateFor(entry) {
    if (!states.has(entry)) states.set(entry, createVaultCipher(crypto, entry).then(cipher => ({
      cipher, revision: -1, snapshot: { ledger: EMPTY_LEDGER, matches: [] }, pending: Promise.resolve(),
    })));
    return states.get(entry);
  }
  async function exchange(entry, origin, path, data, signal) {
    if (path === BACKUP_READ_PATH) {
      const { cipher } = await stateFor(entry);
      const reply = await post(origin, '/v2/vault/backup', { ...authorize(entry), device: entry.device }, { signal });
      if (reply.retryAfter) return reply;
      return { snapshot: vaultSnapshot(await Promise.all(reply.snapshot.map(cipher.open))), cursor: reply.cursor };
    }
    if (path === SYNC_CHANGES_PATH) {
      const { cipher } = await stateFor(entry);
      const reply = await post(origin, PUBLIC_CHANGES_PATH, { ...authorize(entry), after: data.after }, { signal });
      if (reply.reset) return reply;
      const records = await Promise.all(reply.records.map(row => row[2] === null ? row : cipher.open(row)));
      return { ...reply, records };
    }
    const state = await stateFor(entry), auth = authorize(entry);
    let keys;
    if (data.uploadOnly) {
      if (path === PREFERENCES_SYNC_PATH) keys = data.groups.map(group => ['preferences', group]);
      else if (path === LEDGER_SYNC_PATH) keys = [['ledger', 'details'], ...data.events.map(row => ['event', row.id])];
      else keys = [...(data.names ? [['ledger', 'details']] : []), ...data.matches.map(row => ['match', row.gameId])];
    }
    const run = state.pending.then(async () => {
      let revision = keys ? -1 : state.revision, before = state.snapshot;
      for (let attempt = 0; attempt < 5; attempt++) {
        const parameters = keys ? { ...auth, keys } : auth;
        const reply = await post(origin, '/v2/vault/exchange', { ...parameters, revision, records: [] }, { signal });
        if (reply.records !== null) before = vaultSnapshot(await Promise.all(reply.records.map(state.cipher.open)));
        revision = reply.revision;
        if (!keys) { state.snapshot = before; state.revision = revision; }
        let next = before, result;
        if (path === PREFERENCES_SYNC_PATH) {
          const known = before.preferences ?? {};
          if (data.values) next = { ...before, preferences: mergePreferenceUpload(known, cleanPreferences(data.values), data) };
          result = { values: Object.fromEntries(data.groups.filter(group => known[group] !== undefined).map(group => [group, known[group]])) };
        } else if (path === LEDGER_SYNC_PATH) {
          const { entry: ledger, conflicts } = mergeLedgerUpload(before.ledger, data, Date.now(), () => ledgerVersion(crypto));
          if (ledger !== before.ledger) next = { ...before, ledger };
          result = { conflicts, ...(data.pull && { download: ledgerDownload(ledger, data.pull) }) };
        } else {
          const matches = new Map(before.matches.map(row => [row.gameId, row]));
          for (const row of data.matches) {
            const old = matches.get(row.gameId);
            if (!old || !old.frame && row.frame && sameSyncMatch(old, row)) matches.set(row.gameId, row);
          }
          if (matches.size > MATCH_SYNC_LIMIT) throw new Error('云端战绩达到容量上限');
          const names = data.names ? { ...before.ledger.names, ...data.names } : before.ledger.names;
          next = { matches: [...matches.values()], ledger: { ...before.ledger, names } };
          result = data.uploadOnly ? { ok: true } : { matches: next.matches };
        }
        if (next === before) return result;
        const originals = new Map(vaultRecords(before).map(([kind, id, details]) => [kind + ':' + id, JSON.stringify(details)]));
        const changed = vaultRecords(next).filter(([kind, id, details]) => originals.get(kind + ':' + id) !== JSON.stringify(details));
        if (!changed.length) return result;
        const records = await Promise.all(changed.map(state.cipher.seal));
        const commit = await post(origin, '/v2/vault/exchange', { ...parameters, revision, records }, { signal });
        if (commit.records !== null) continue;
        if (!keys) { state.revision = commit.revision; state.snapshot = next; }
        return result;
      }
      throw new Error('云端记录正在被其他设备修改，请重试');
    });
    state.pending = run.catch(() => {});
    return run;
  }
  return {
    exchange,
    async register(entry) {
      const { cipher } = await stateFor(entry);
      return post(entry.origin, '/v2/vault/register', { ...authorize(entry), verifier: cipher.verifier });
    },
    async stage(entry, device) {
      const { cipher } = await stateFor(entry);
      const { snapshot, fingerprint } = await post(entry.origin, '/v2/migrate/read', {}, { device });
      const records = await Promise.all(vaultRecords(snapshot).map(cipher.seal));
      await post(entry.origin, '/v2/migrate/stage', { ...authorize(entry), verifier: cipher.verifier, fingerprint, records }, { device });
    },
    check: entry => post(entry.origin, '/v2/vault/exchange', { ...authorize(entry), revision: -1, keys: [], records: [] }),
    async preview(code, pass) {
      const [address, vault, seed] = unpack('SGSV1', code.trim(), 3);
      const password = pass.trim().toUpperCase();
      if (!tokenFormat.test(vault) || !tokenFormat.test(seed) || !passFormat.test(password)) throw invalid();
      const origin = publicOrigin(address);
      const cipher = await createVaultCipher(crypto, { vault, seed, password });
      const { records } = await post(origin, '/v2/vault/view', { vault, verifier: cipher.verifier });
      return vaultSnapshot(await Promise.all(records.map(cipher.open)));
    },
  };
}
