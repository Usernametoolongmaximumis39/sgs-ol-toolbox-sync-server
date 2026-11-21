import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { equal, hash, isToken, token } from './state.mjs';

const deriveKey = promisify(scrypt);
const storedHash = /^scrypt:([a-f0-9]{32}):([a-f0-9]{64})$/;
const generatePassword = () => 'A1' + token();

export function validAdminPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128
    && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && !/[\x00-\x1f\x7f]/.test(value);
}

async function encode(password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 32);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

async function replace(file, record) {
  const temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`;
  await writeFile(temporary, record + '\n', { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary); throw error; }
}

export async function openAdminPassword(file) {
  // Older installations and manual starts can still read their initial password from this file.
  try { await writeFile(file, token() + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  let record = (await readFile(file, 'utf8')).trim();
  if (!storedHash.test(record) && !isToken(record)) throw new Error('管理员密码文件无效，请使用重置命令');
  return {
    async verify(password) {
      const current = record;
      const match = storedHash.exec(current);
      if (!match) return isToken(password) && equal(hash(password), hash(current));
      if (!validAdminPassword(password)) return false;
      const key = await deriveKey(password, Buffer.from(match[1], 'hex'), 32);
      return current === record && timingSafeEqual(key, Buffer.from(match[2], 'hex'));
    },
    async change(password) {
      const next = await encode(password);
      await replace(file, next);
      record = next;
    },
  };
}

export async function resetAdminPassword(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const password = generatePassword();
  await replace(join(directory, 'admin-token'), await encode(password));
  return password;
}
