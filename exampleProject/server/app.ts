import express from 'express';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkPassword, digest, hashPassword } from './security.js';
export function createApp(db: pg.Pool, origin: string) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('PUBLIC_ORIGIN 必须是完整 origin，无路径或尾部斜杠');
  const app = express();
  app.disable('x-powered-by');
  const options = { httpOnly: true, sameSite: 'lax' as const, secure: url.protocol === 'https:', path: '/' };
  const dummy = hashPassword(randomBytes(32).toString('hex'));
  const attempts = new Map<string, { count: number; until: number }>();
  function cookie(req: express.Request) {
    return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('example_session='))?.slice(16) || '';
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
  app.get('/health', async (_req, res) => { await db.query('SELECT 1'); res.json({ status: 'ok' }); });
  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.length || username.length > 80 || !password.length || password.length > 200) {
      res.status(400).json({ message: '请输入合法用户名和密码' }); return;
    }
    const now = Date.now();
    for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key);
    const key = req.ip || 'unknown';
    let bucket = attempts.get(key);
    if (!bucket) {
      if (attempts.size >= 10000) { res.status(429).json({ message: '服务繁忙，请稍后重试' }); return; }
      bucket = { count: 0, until: now + 15 * 60_000 }; attempts.set(key, bucket);
    }
    if (bucket.count >= 10) { res.status(429).json({ message: '尝试过多，请15分钟后重试' }); return; }
    bucket.count++;
    const result = await db.query('SELECT * FROM example_users WHERE username=$1', [username]);
    const user = result.rows[0];
    const valid = await checkPassword(password, user?.password_hash || await dummy);
    if (!user || !valid) { res.status(401).json({ message: '用户名或密码错误' }); return; }
    const token = randomBytes(32).toString('hex');
    await db.query('DELETE FROM example_sessions WHERE expires_at <= now() OR token_hash=$1', [digest(cookie(req))]);
    await db.query("INSERT INTO example_sessions VALUES ($1,$2,now()+interval '8 hours')", [digest(token), user.id]);
    attempts.delete(key);
    res.cookie('example_session', token, { ...options, maxAge: 8 * 3600_000 }).json({ username: user.username });
  });
  app.get('/api/me', async (req, res) => {
    const result = await db.query('SELECT u.username FROM example_sessions s JOIN example_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()', [digest(cookie(req))]);
    if (!result.rows[0]) { res.status(401).json({ message: '请先登录' }); return; }
    res.json(result.rows[0]);
  });
  app.post('/api/logout', async (req, res) => {
    await db.query('DELETE FROM example_sessions WHERE token_hash=$1', [digest(cookie(req))]);
    res.clearCookie('example_session', options).json({ ok: true });
  });
  app.use('/api', (_req, res) => { res.status(404).json({ message: '接口不存在' }); });
  app.use(express.static(fileURLToPath(new URL('../web/', import.meta.url))));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const bad = err.type === 'entity.parse.failed' || err.type === 'entity.too.large';
    res.status(bad ? 400 : 503).json({ message: bad ? '请求格式错误或过大' : '服务暂不可用' });
  });
  return app;
}

