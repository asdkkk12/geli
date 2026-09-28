import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
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
const relativePath=z.string().min(1).max(240).refine(v=>!v.startsWith('/')&&!v.split('/').includes('..'),'invalid path');
const envName=z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).refine(v=>!['PORT','PUBLIC_ORIGIN','HOME','PATH'].includes(v)&&!v.startsWith('GELI_'),'reserved environment name');
export const deploymentSchema=z.object({
  containerName:z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),purpose:z.string().min(3).max(1000),
  source:z.object({type:z.literal('github'),repositoryUrl:z.string().url().max(300),gitRef:z.string().min(1).max(120).default('HEAD'),dockerfilePath:relativePath.default('Dockerfile'),contextPath:relativePath.default('.')}).strict(),
  runtime:z.object({cpu:z.number().int().min(1).max(16),memoryMb:z.number().int().min(256).max(65536),diskGb:z.number().int().min(1).max(2000),runtimeHours:z.number().int().min(1).max(720),internalPort:z.number().int().min(1024).max(65535),command:z.array(z.string().max(1000)).max(32).nullable().default(null),environment:z.record(envName,z.string().max(4000)).default({}),secrets:z.record(envName,z.string().min(1).max(16000)).default({}),healthPath:z.string().regex(/^\/(?!\/)[^\s?#]{0,255}$/).default('/health')}).strict()
}).strict();
export function githubRepository(value:string) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||url.port||url.search||url.hash)throw new HttpException('仅支持公开 github.com 仓库',400);
  const match=url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if(!match)throw new HttpException('GitHub 仓库地址不合法',400);
  return `https://github.com/${match[1]}/${match[2]}.git`;
}
function encryptionKey() {
  const raw=process.env.SECRET_ENCRYPTION_KEY||'';
  const key=/^[a-f0-9]{64}$/i.test(raw)?Buffer.from(raw,'hex'):Buffer.from(raw,'base64');
  if(key.length!==32)throw new Error('SECRET_ENCRYPTION_KEY must encode 32 bytes');
  return key;
}
export function encryptSecret(value:string) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return {ciphertext:encrypted.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
export function decryptSecret(value:{ciphertext:string;iv:string;tag:string}) {
  const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(value.iv,'base64'));
  decipher.setAuthTag(Buffer.from(value.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]).toString('utf8');
}
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
