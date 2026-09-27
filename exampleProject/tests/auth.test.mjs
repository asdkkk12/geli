import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/server/app.js';
import { hashPassword, checkPassword, digest } from '../dist/server/security.js';
import { migrate, seedUser } from '../dist/server/store.js';
function memoryDb(hash) {
  const sessions = new Map();
  return { sessions, async query(sql, values = []) {
    if (sql === 'SELECT 1') return { rows: [{}] };
    if (sql.startsWith('SELECT * FROM example_users')) return { rows: values[0] === 'student' ? [{ id:'user-1', username:'student', password_hash:hash }] : [] };
    if (sql.startsWith('INSERT INTO example_sessions')) { sessions.set(values[0],values[1]); return { rows:[] }; }
    if (sql.startsWith('DELETE FROM example_sessions')) { sessions.delete(values[0]); return { rows:[] }; }
    if (sql.startsWith('SELECT u.username')) return { rows:sessions.has(values[0]) ? [{username:'student'}] : [] };
    throw new Error('Unexpected SQL');
  }};
}
const password = 'Example-test-1234';
test('salted password hashes reject wrong passwords', async () => {
  const a = await hashPassword(password), b = await hashPassword(password);
  assert.notEqual(a,b); assert(!a.includes(password));
  assert(await checkPassword(password,a)); assert.equal(await checkPassword('wrong',a),false);
});
test('login, cookie restoration, rotation and logout revoke old tokens', async () => {
  const db = memoryDb(await hashPassword(password));
  const app = createApp(db,'http://127.0.0.1:8080');
  await request(app).get('/api/me').expect(401);
  await request(app).post('/api/login').set('Origin','http://evil.test').send({username:'student',password}).expect(403);
  await request(app).post('/api/login').send({username:'student',password}).expect(403);
  await request(app).post('/api/login').set('Origin','http://127.0.0.1:8080').send({username:'student',password:'bad'}).expect(401);
  const login = await request(app).post('/api/login').set('Origin','http://127.0.0.1:8080').send({username:'student',password}).expect(200);
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Lax/); assert(!cookie.includes('Secure'));
  const token = cookie.split(';')[0].split('=')[1];
  assert(db.sessions.has(digest(token))); assert(!db.sessions.has(token));
  await request(app).get('/api/me').set('Cookie',cookie).expect(200,{username:'student'});
  const relogin = await request(app).post('/api/login').set('Cookie',cookie).set('Origin','http://127.0.0.1:8080').send({username:'student',password}).expect(200);
  await request(app).get('/api/me').set('Cookie',cookie).expect(401);
  const next = relogin.headers['set-cookie'][0];
  await request(app).post('/api/logout').set('Cookie',next).set('Origin','http://127.0.0.1:8080').send({}).expect(200);
  await request(app).get('/api/me').set('Cookie',next).expect(401);
});
test('rate limit, invalid input, HTTPS cookie and database failure', async () => {
  const db = memoryDb(await hashPassword(password));
  const app = createApp(db,'https://example.test');
  await request(app).post('/api/login').set('Origin','https://example.test').send({username:[],password}).expect(400);
  const login = await request(app).post('/api/login').set('Origin','https://example.test').send({username:'student',password}).expect(200);
  assert.match(login.headers['set-cookie'][0],/Secure/);
  for(let i=0;i<10;i++) await request(app).post('/api/login').set('Origin','https://example.test').send({username:'student',password:'bad'}).expect(401);
  await request(app).post('/api/login').set('Origin','https://example.test').send({username:'student',password}).expect(429);
  const broken = createApp({query:async()=>{throw new Error('SECRET connection details')}},'http://127.0.0.1:8080');
  const health = await request(broken).get('/health').expect(503);
  assert(!JSON.stringify(health.body).includes('SECRET'));
});
test('real PostgreSQL migration, idempotent seed and expiry', { skip: !process.env.EXAMPLE_TEST_DATABASE_URL }, async () => {
  const db = new pg.Pool({connectionString:process.env.EXAMPLE_TEST_DATABASE_URL});
  try {
    await migrate(db); await migrate(db);
    const username = 'test_' + randomUUID().slice(0,8);
    assert(await seedUser(db,username,password));
    assert.equal(await seedUser(db,username,'Another-password-1234'),false);
    const user = (await db.query('SELECT * FROM example_users WHERE username=$1',[username])).rows[0];
    assert(await checkPassword(password,user.password_hash));
    const app = createApp(db,'http://127.0.0.1:8080');
    const login = await request(app).post('/api/login').set('Origin','http://127.0.0.1:8080').send({username,password}).expect(200);
    const cookie = login.headers['set-cookie'][0];
    await request(app).get('/api/me').set('Cookie',cookie).expect(200);
    await db.query("UPDATE example_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",[user.id]);
    await request(app).get('/api/me').set('Cookie',cookie).expect(401);
  } finally { await db.end(); }
});

