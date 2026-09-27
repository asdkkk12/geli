import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
const scrypt = promisify(scryptCallback);
export const specSchema = z.object({
  containerName: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), purpose: z.string().min(3).max(1000),
  imageTemplate: z.string().min(1).max(80), cpu: z.number().int().min(1).max(16),
  memoryMb: z.number().int().min(256).max(65536), diskGb: z.number().int().min(1).max(2000),
  runtimeHours: z.number().int().min(1).max(720), internalPort: z.number().int().min(1024).max(65535).optional()
}).strict();
export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpException('请求字段或格式不合法', 400);
  return result.data;
}
export const token = () => randomBytes(32).toString('hex');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + (await scrypt(password, salt, 64) as Buffer).toString('hex');
}
export async function checkPassword(password: string, hash: string) {
  const [salt, value] = hash.split(':');
  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(value, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function allowed(user: {id: string; role: string}, owner: string) {
  if (user.id !== owner && user.role !== 'ADMIN') throw new HttpException('无权访问该容器', 403);
}
