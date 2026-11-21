import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { base64url, fromBase64url } from '../shared/base64url.js';
export { base64url, fromBase64url };

const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const utf8 = new TextEncoder();
const decodeAscii = new TextDecoder('utf-8', { fatal: true });
export const PAIR_REQUEST = 'SGSP1';
export const PAIR_INVITE = 'SGSI2';
export const PAIR_UPDATE = 'SGSU2';
export const PIN_FORMAT = /^[0-9]{4}$/;
const domainFormat = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function joinBytes(...parts) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function unpack(code, prefix, limit) {
  const value = typeof code === 'string' ? code.trim() : '';
  if (value.length > limit || !value.startsWith(prefix + '.')) throw new Error('invalid_code');
  return fromBase64url(value.slice(prefix.length + 1));
}

export async function createPairingRequest(crypto) {
  const id = crypto.getRandomValues(new Uint8Array(16));
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  return { id: base64url(id), code: PAIR_REQUEST + '.' + base64url(joinBytes(id, publicKey)), keys };
}

export async function readPairingRequest(crypto, code) {
  const bytes = unpack(code, PAIR_REQUEST, 114);
  if (bytes.length !== 81) throw new Error('invalid_request');
  const id = bytes.slice(0, 16);
  const key = await crypto.subtle.importKey('raw', bytes.slice(16), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return { id, key };
}

function ipv4Bytes(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) throw new Error('invalid_address');
  return Uint8Array.from(parts, Number);
}

function ipv6Bytes(host) {
  if (!/^[a-fA-F0-9:]+$/.test(host)) throw new Error('invalid_address');
  const normalized = new URL('http://[' + host + ']').hostname.slice(1, -1);
  const [head, tail] = normalized.split('::');
  const groups = head ? head.split(':') : [];
  if (tail !== undefined) {
    const end = tail ? tail.split(':') : [];
    groups.push(...Array(8 - groups.length - end.length).fill('0'), ...end);
  }
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  groups.forEach((group, index) => view.setUint16(index * 2, Number.parseInt(group, 16)));
  return bytes;
}

function endpointBytes({ tls, local, port, ipv4, ipv6, domain = '' }, expiry, signer, token) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(expiry) || expiry < 1 || expiry > 0xffffffff
    || !ipv4 && !ipv6 || domain && !domainFormat.test(domain)) throw new Error('invalid_endpoint');
  const header = new Uint8Array(7), view = new DataView(header.buffer);
  header[0] = (tls ? 1 : 0) | (local ? 2 : 0) | (ipv4 ? 4 : 0) | (ipv6 ? 8 : 0) | (domain ? 16 : 0);
  view.setUint16(1, port);
  view.setUint32(3, expiry);
  return joinBytes(header, token ? fromBase64url(token, 32) : new Uint8Array(), fromBase64url(signer, 65),
    ipv4 ? ipv4Bytes(ipv4) : new Uint8Array(), ipv6 ? ipv6Bytes(ipv6) : new Uint8Array(),
    domain ? joinBytes(Uint8Array.of(domain.length), utf8.encode(domain)) : new Uint8Array());
}

function parseEndpoint(bytes, invite) {
  const flags = bytes[0], hasIpv4 = flags & 4, hasIpv6 = flags & 8, hasDomain = flags & 16;
  const min = 72 + (invite ? 32 : 0) + (hasIpv4 ? 4 : 0) + (hasIpv6 ? 16 : 0);
  if (flags & 224 || !hasIpv4 && !hasIpv6 || bytes.length < min) throw new Error('invalid_endpoint');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const port = view.getUint16(1), expiry = view.getUint32(3);
  if (!port || !expiry) throw new Error('invalid_endpoint');
  let offset = 7;
  const take = length => {
    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const token = invite ? base64url(take(32)) : '';
  const signer = base64url(take(65));
  const ipv4 = hasIpv4 ? [...take(4)].join('.') : '';
  const ipv6 = hasIpv6 ? take(16).reduce((groups, byte, index, ip) =>
    index % 2 ? [...groups, ((ip[index - 1] << 8) | byte).toString(16)] : groups, []).join(':') : '';
  const domain = hasDomain ? decodeAscii.decode(take(take(1)[0])) : '';
  if (offset !== bytes.length || hasDomain && !domainFormat.test(domain)) throw new Error('invalid_endpoint');
  return { tls: Boolean(flags & 1), local: Boolean(flags & 2), port, expiry, token, signer, ipv4, ipv6, domain };
}

export async function sealPairing(recipient, endpoint, expiry, signer, token) {
  const prefix = token ? PAIR_INVITE : PAIR_UPDATE;
  const context = await suite.createSenderContext({ recipientPublicKey: recipient.key, info: utf8.encode(prefix) });
  const encrypted = await context.seal(endpointBytes(endpoint, expiry, signer, token), recipient.id);
  return prefix + '.' + base64url(joinBytes(recipient.id, new Uint8Array(context.enc), new Uint8Array(encrypted)));
}

export async function openPairing(code, prefix, findRecipientKeys) {
  const bytes = unpack(code, prefix, 640);
  if (bytes.length < 173) throw new Error('invalid_code');
  const id = bytes.slice(0, 16);
  const requestId = base64url(id);
  const recipientKey = await findRecipientKeys(requestId);
  if (!recipientKey) throw new Error('pairing_device_mismatch');
  const context = await suite.createRecipientContext({ recipientKey, enc: bytes.slice(16, 81), info: utf8.encode(prefix) });
  const plaintext = await context.open(bytes.slice(81), id);
  return { ...parseEndpoint(new Uint8Array(plaintext), prefix === PAIR_INVITE), requestId };
}

export function syncProofBytes({ nonce, origin, next, revision, challenge, stargazing }) {
  const fields = [nonce, origin, next, revision, challenge];
  if (typeof stargazing === 'boolean') fields.push(stargazing);
  return utf8.encode(JSON.stringify(fields));
}
