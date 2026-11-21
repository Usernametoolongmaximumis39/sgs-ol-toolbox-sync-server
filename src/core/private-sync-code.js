import { base64url, fromBase64url } from './sync-pairing-code.js';

const prefix = 'SGSD1.';
const utf8 = new TextEncoder();
const context = utf8.encode(prefix);

async function credentialKey(crypto, gameKey, salt) {
  const material = await crypto.subtle.importKey('raw', utf8.encode(gameKey), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealPrivateCredential(crypto, gameKey, { origin, signer, grant }) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await credentialKey(crypto, gameKey, salt);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context }, key,
    utf8.encode(JSON.stringify([origin, signer, grant])));
  return prefix + base64url(Uint8Array.of(...salt, ...iv, ...new Uint8Array(encrypted)));
}

export async function openPrivateCredential(crypto, gameKey, value) {
  const code = value.trim();
  if (code.length > 700 || !code.startsWith(prefix)) throw new Error('invalid_private_credential');
  const bytes = fromBase64url(code.slice(prefix.length));
  const iv = bytes.slice(16, 28);
  const key = await credentialKey(crypto, gameKey, bytes.slice(0, 16));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: context }, key, bytes.slice(28));
  const [origin, signer, grant] = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted));
  fromBase64url(signer, 65);
  fromBase64url(grant, 32);
  if (typeof origin !== 'string') throw new Error('invalid_private_credential');
  return { origin, signer, grant };
}
