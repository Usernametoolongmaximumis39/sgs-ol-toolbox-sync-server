import { base64url, fromBase64url } from './base64url.js';
import { MODES } from './match-sync-records.js';

const encode = new TextEncoder(), decode = new TextDecoder('utf-8', { fatal: true });
export const publicSharePath = '/ledger/share/';
export const publicViewPath = '/v2/vault/view';
export const passFormat = /^[2-9A-HJ-NP-Z]{6}$/;
export const tokenFormat = /^[A-Za-z0-9_-]{43}$/;
export const invalidPublicCode = () => new Error('公共同步凭据格式无效');

export function publicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的 HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请输入 HTTPS 服务器地址，地址中无需填写路径');
  }
  return url.origin;
}

export const packPublicCode = (prefix, values) => prefix + '.' + base64url(encode.encode(JSON.stringify(values)));
export function unpackPublicCode(prefix, value, count) {
  try {
    if (!value.startsWith(prefix + '.') || value.length > 1600) throw invalidPublicCode();
    const data = JSON.parse(decode.decode(fromBase64url(value.slice(prefix.length + 1))));
    if (!Array.isArray(data) || data.length !== count || data.some(item => typeof item !== 'string')) throw invalidPublicCode();
    return data;
  } catch { throw invalidPublicCode(); }
}

export const publicViewCode = ({ origin, vault, seed }) => packPublicCode('SGSV1', [origin, vault, seed]);
export const publicViewLink = entry => publicOrigin(entry.origin) + publicSharePath + '#' + publicViewCode(entry);

export function readPublicView(value) {
  let code = value.trim(), link;
  if (code.length > 2048) throw invalidPublicCode();
  if (code.startsWith('https://')) {
    try { link = new URL(code); } catch { throw invalidPublicCode(); }
    if (link.pathname !== publicSharePath || link.username || link.password || link.search) throw invalidPublicCode();
    code = link.hash.slice(1);
  }
  const [address, vault, seed] = unpackPublicCode('SGSV1', code, 3);
  const origin = publicOrigin(address);
  if (!tokenFormat.test(vault) || !tokenFormat.test(seed) || link && link.origin !== origin) throw invalidPublicCode();
  return { origin, vault, seed };
}

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

export async function readPublicRecords(crypto, post, share, pass) {
  const { origin, vault, seed } = share;
  const password = pass.trim().toUpperCase();
  if (!passFormat.test(password)) throw new Error('请输入有效的六位查看码');
  const cipher = await createVaultCipher(crypto, { vault, seed, password });
  const { records } = await post(origin, publicViewPath, { vault, verifier: cipher.verifier });
  return Promise.all(records.filter(([kind]) => kind === 'event' || kind === 'match').map(cipher.open));
}

export function publicRecordText(stream, row) {
  if (stream === 'events') {
    if (row.prayer) return `${row.prayer.name} × ${row.prayer.times}`;
    return Array.isArray(row.items) && row.items.filter(item => typeof item?.name === 'string' && Number.isFinite(item.delta))
      .map(item => `${item.name} ${item.delta > 0 ? '+' : ''}${item.delta}`).join('、') || '物品流水';
  }
  return [MODES[row.mode] || '对局', { 0: '胜', 1: '负', 255: '平' }[row.result],
    Array.isArray(row.general) && row.general.filter(Number.isFinite).join(' / ')]
    .filter(Boolean).join(' · ');
}
