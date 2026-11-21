import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isIPv4 } from 'node:net';
import { equal, hash, isDigest, isToken, requireValue, token } from './state.mjs';

const validFor = 60 * 60000;
const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const fileFor = dataDir => join(dataDir, 'initial-setup.json');

export async function createSetupCode(dataDir) {
  const code = token();
  await writeFile(fileFor(dataDir), JSON.stringify({ digest: hash(code), expiresAt: Date.now() + validFor }), { flag: 'wx', mode: 0o600 });
  return code;
}

export async function readInitialSetup(dataDir, domain, port, now) {
  if (!domain) return null;
  domain = domain.toLowerCase();
  requireValue(domain.length <= 253 && (isIPv4(domain) || dnsName.test(domain)), 'invalid_setup_host');
  const file = fileFor(dataDir);
  const record = await readFile(file, 'utf8').then(JSON.parse).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!record || !isDigest(record.digest) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now()) return null;
  const address = new URL(`http://${domain}:${port}`).origin;
  return {
    address,
    expiresAt: record.expiresAt,
    verify: code => isToken(code) && equal(hash(code), record.digest),
    disable: () => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }),
  };
}
