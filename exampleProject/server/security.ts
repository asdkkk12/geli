import { randomBytes, createHash, scrypt as callback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(callback);
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + (await scrypt(password, salt, 64) as Buffer).toString('hex');
}
export async function checkPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(':');
  if (!salt || !/^[a-f0-9]{128}$/.test(hash || '')) return false;
  const actual = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

