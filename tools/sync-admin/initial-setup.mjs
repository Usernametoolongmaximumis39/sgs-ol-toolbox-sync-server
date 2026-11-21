import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { equal, hash, isDigest, isToken, token } from './state.mjs';

const validFor = 60 * 60000;
const fileFor = dataDir => join(dataDir, 'initial-setup.json');

export async function createSetupCode(dataDir) {
  const code = token();
  await writeFile(fileFor(dataDir), JSON.stringify({ digest: hash(code), expiresAt: Date.now() + validFor }), { flag: 'wx', mode: 0o600 });
  return code;
}

export async function readInitialSetup(dataDir, now) {
  const file = fileFor(dataDir);
  const record = await readFile(file, 'utf8').then(JSON.parse).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!record || !isDigest(record.digest) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now()) return null;
  return {
    expiresAt: record.expiresAt,
    verify: code => isToken(code) && equal(hash(code), record.digest),
    disable: () => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }),
  };
}
