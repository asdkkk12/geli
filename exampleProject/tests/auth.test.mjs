import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import request from 'supertest';
import { createApp } from '../dist/server/app.js';
import { digest, safeEqual } from '../dist/server/security.js';

const origin = 'http://127.0.0.1:8080';
const username = 'student';
const password = 'Example-test-1234';

function app(extra = {}) {
  return createApp({ origin, username, password, ...extra });
}

async function running(t, application) {
  const server = application.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return request(server);
}

test('constant-time credential comparison and health endpoint work without a database', async t => {
  assert.equal(safeEqual('same', 'same'), true);
  assert.equal(safeEqual('same', 'different'), false);
  assert.equal(digest('value').length, 64);
  const http = await running(t, app());
  await http.get('/health').expect(200, { status: 'ok' });
});

test('login restores the session, rotates it, and logout revokes it', async t => {
  const server = app();
  const http = await running(t, server);
  await http.get('/api/me').expect(401);
  await http.post('/api/login').set('Origin', 'http://evil.test').send({ username, password }).expect(403);
  await http.post('/api/login').send({ username, password }).expect(403);
  await http.post('/api/login').set('Origin', origin).send({ username, password: 'bad' }).expect(401);

  const login = await http.post('/api/login').set('Origin', origin).send({ username, password }).expect(200);
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(cookie.includes('Secure'), false);
  await http.get('/api/me').set('Cookie', cookie).expect(200, { username });

  const relogin = await http.post('/api/login').set('Cookie', cookie).set('Origin', origin).send({ username, password }).expect(200);
  await http.get('/api/me').set('Cookie', cookie).expect(401);
  const nextCookie = relogin.headers['set-cookie'][0];
  await http.post('/api/logout').set('Cookie', nextCookie).set('Origin', origin).send({}).expect(200);
  await http.get('/api/me').set('Cookie', nextCookie).expect(401);
});

test('sessions expire and malformed cookies are rejected', async t => {
  let timestamp = 1_700_000_000_000;
  const server = app({ now: () => timestamp });
  const http = await running(t, server);
  const login = await http.post('/api/login').set('Origin', origin).send({ username, password }).expect(200);
  const cookie = login.headers['set-cookie'][0];
  timestamp += 8 * 3600_000 + 1;
  await http.get('/api/me').set('Cookie', cookie).expect(401);
  await http.get('/api/me').set('Cookie', 'example_session=invalid').expect(401);
});

test('rate limits failed logins and sets Secure cookies for HTTPS', async t => {
  const httpsOrigin = 'https://example.test';
  const secureApp = createApp({ origin: httpsOrigin, username, password });
  const secureHttp = await running(t, secureApp);
  await secureHttp.post('/api/login').set('Origin', httpsOrigin).send({ username: [], password }).expect(400);
  const login = await secureHttp.post('/api/login').set('Origin', httpsOrigin).send({ username, password }).expect(200);
  assert.match(login.headers['set-cookie'][0], /Secure/);

  const limitedApp = createApp({ origin: httpsOrigin, username, password });
  const limitedHttp = await running(t, limitedApp);
  for (let index = 0; index < 10; index++) {
    await limitedHttp.post('/api/login').set('Origin', httpsOrigin).send({ username, password: 'bad' }).expect(401);
  }
  await limitedHttp.post('/api/login').set('Origin', httpsOrigin).send({ username, password }).expect(429);
});
