import { BACKUP_READ_PATH, LEDGER_SYNC_PATH, MATCH_SYNC_PATH, PREFERENCES_SYNC_PATH } from './sync-paths.js';
import { STARGAZING_SYNC_PATH } from './stargazing-source.js';

export const SYNC_SOURCE_HEADER = 'X-SGS-Toolbox-Origin';
export const PRIVATE_HTTP_TIMEOUT = 30000;
export const PRIVATE_HTTP_LIMIT = 24 * 1024 * 1024;
const privatePaths = new Set([
  '/v1/proof', '/v1/confirm', '/v1/bind', '/v1/recover', '/v1/unbind',
  '/v1/private/request', '/v1/private/join', '/v1/private/release', '/v1/private/view',
  '/v1/private/bind-credential', PREFERENCES_SYNC_PATH, LEDGER_SYNC_PATH, MATCH_SYNC_PATH, BACKUP_READ_PATH, STARGAZING_SYNC_PATH,
]);

export function privateSyncOrigin(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.href !== url.origin + '/') throw new Error('请输入完整的 HTTP 或 HTTPS 地址，无需填写路径');
  return url.origin;
}

export function privateHttpRequest({ url, body, device }, source) {
  if (typeof url !== 'string' || url.length > 512 || typeof body !== 'string' || body.length > PRIVATE_HTTP_LIMIT ||
      !/^https?:\/\/(?:web\.sanguosha\.com|127\.0\.0\.1:17321)$/.test(source) ||
      device !== undefined && (typeof device !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(device))) throw new Error('私有同步请求格式无效');
  const address = new URL(url);
  if (address.protocol !== 'http:' || !privatePaths.has(address.pathname) || url !== address.origin + address.pathname)
    throw new Error('私有同步地址无效');
  return { url, body, headers: { 'Content-Type': 'application/json', [SYNC_SOURCE_HEADER]: source,
    ...(device && { Authorization: 'Bearer ' + device }) } };
}
