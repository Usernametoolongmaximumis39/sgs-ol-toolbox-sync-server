import { isIPv4 } from 'node:net';
import { requireValue } from './state.mjs';

const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const reservedPaths = new Set(['health', 'ledger', 'updates', 'v1', 'v2']);
export const localAdminPath = '/admin';
const validHost = host => host.length <= 253 && (host === 'localhost' || isIPv4(host) || dnsName.test(host) && !/^[\d.]+$/.test(host));

export function validateAdminEntry(input) {
  const { enabled, port } = input;
  const path = typeof input.path === 'string' ? input.path.trim().replace(/^\/|\/$/g, '') : '';
  const host = typeof input.host === 'string' ? input.host.trim().toLowerCase() : '';
  requireValue(/^[a-z][a-z0-9_-]{0,31}$/.test(path) && !reservedPaths.has(path), 'invalid_admin_path');
  requireValue(typeof enabled === 'boolean');
  requireValue(Number.isInteger(port) && port >= 1 && port <= 65535, 'invalid_port');
  requireValue(!host || validHost(host), 'invalid_admin_host');
  return { path: '/' + path, enabled, host, port };
}

export function adminPathMatches(url, path) {
  return url === path || url.startsWith(path + '/');
}

export function httpAdminOrigin({ host, port }) {
  return new URL(`http://${host}:${port}`).origin;
}

export function httpAdminRequestOrigin(config, authority) {
  const match = /^([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(authority ?? '');
  requireValue(match && validHost(match[1]) && Number(match[2] ?? 80) === config.port && (!config.host || config.host === match[1]),
    'invalid_host', 403);
  return httpAdminOrigin({ host: match[1], port: config.port });
}
