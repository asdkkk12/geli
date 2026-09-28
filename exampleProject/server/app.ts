import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { digest, safeEqual } from './security.js';

export interface AppConfig {
  origin: string;
  username: string;
  password: string;
  now?: () => number;
}

export function createApp(config: AppConfig) {
  const { origin, username, password } = config;
  const now = config.now || Date.now;
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('PUBLIC_ORIGIN 必须是完整 origin，无路径或尾部斜杠');
  const app = express();
  app.disable('x-powered-by');
  const options = { httpOnly: true, sameSite: 'lax' as const, secure: url.protocol === 'https:', path: '/' };
  const attempts = new Map<string, { count: number; until: number }>();
  const sessions = new Map<string, { username: string; expiresAt: number }>();
  function cookie(req: express.Request) {
    return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('example_session='))?.slice(16) || '';
  }
  function clearExpired(timestamp: number) {
    for (const [key, session] of sessions) if (session.expiresAt <= timestamp) sessions.delete(key);
  }
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use((req, res, next) => {
    if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.headers.origin !== origin) {
      res.status(403).json({ message: '请求来源不允许' }); return;
    }
    next();
  });
  app.use(express.json({ limit: '4kb' }));
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.post('/api/login', (req, res) => {
    const input = req.body || {};
    if (typeof input.username !== 'string' || typeof input.password !== 'string' || !input.username.length || input.username.length > 80 || !input.password.length || input.password.length > 200) {
      res.status(400).json({ message: '请输入合法用户名和密码' }); return;
    }
    const timestamp = now();
    for (const [key, item] of attempts) if (item.until <= timestamp) attempts.delete(key);
    clearExpired(timestamp);
    const key = req.ip || 'unknown';
    let bucket = attempts.get(key);
    if (!bucket) {
      if (attempts.size >= 10000) { res.status(429).json({ message: '服务繁忙，请稍后重试' }); return; }
      bucket = { count: 0, until: timestamp + 15 * 60_000 }; attempts.set(key, bucket);
    }
    if (bucket.count >= 10) { res.status(429).json({ message: '尝试过多，请15分钟后重试' }); return; }
    bucket.count++;
    const valid = safeEqual(input.username, username) && safeEqual(input.password, password);
    if (!valid) { res.status(401).json({ message: '用户名或密码错误' }); return; }
    const token = randomBytes(32).toString('hex');
    sessions.delete(digest(cookie(req)));
    sessions.set(digest(token), { username, expiresAt: timestamp + 8 * 3600_000 });
    attempts.delete(key);
    res.cookie('example_session', token, { ...options, maxAge: 8 * 3600_000 }).json({ username });
  });
  app.get('/api/me', (req, res) => {
    const timestamp = now();
    clearExpired(timestamp);
    const session = sessions.get(digest(cookie(req)));
    if (!session || session.expiresAt <= timestamp) { res.status(401).json({ message: '请先登录' }); return; }
    res.json({ username: session.username });
  });
  app.post('/api/logout', (req, res) => {
    sessions.delete(digest(cookie(req)));
    res.clearCookie('example_session', options).json({ ok: true });
  });
  app.use('/api', (_req, res) => { res.status(404).json({ message: '接口不存在' }); });
  app.use(express.static(fileURLToPath(new URL('../web/', import.meta.url))));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const bad = err.type === 'entity.parse.failed' || err.type === 'entity.too.large';
    res.status(bad ? 400 : 500).json({ message: bad ? '请求格式错误或过大' : '服务暂不可用' });
  });
  return app;
}
