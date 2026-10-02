#!/usr/bin/env node
// Foreground local-demo supervisor. Never connects to a remote Docker context.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const project = crypto.createHash('sha256').update(root).digest('hex').slice(0, 10);
const prefix = `geli-demo-${project}`;
const pgName = `${prefix}-postgres`, redisName = `${prefix}-redis`;
const imageName = `lab/dev:demo-${project}`;
const logsDir = path.join(root, '.demo', 'logs');
const ports = { web: 5173, api: 3000, agent: 3100, postgres: 55433, redis: 56380, control: 35179 };
const children = [];
const startedContainers = new Set();
let control, dockerHost, stopping = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = crypto.randomBytes(32).toString('hex');
const secretKey = crypto.createHash('sha256').update('geli-demo-secret:'+root).digest('hex');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit', ...options });
    if (!stopping) children.push(p);
    let text = '';
    p.stdout?.on('data', chunk => { text += chunk; });
    p.once('error', reject);
    p.once('exit', code => code === 0 ? resolve(text.trim()) : reject(new Error(`${command} 执行失败，退出码 ${code}`)));
  });
}
const capture = (cmd, args) => run(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const docker = (...args) => capture('docker', ['--host', dockerHost, ...args]);

function dockerAddress() {
  const value = process.env.DOCKER_HOST || execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
  if (!value.startsWith('unix://')) throw new Error('演示脚本只允许本机 Unix Socket；请切换本地 Docker context。');
  return value;
}
async function freePort(port) {
  const s = net.createServer();
  await new Promise((resolve, reject) => { s.once('error', () => reject(new Error(`端口 ${port} 已占用，请先停止占用服务。`))); s.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => s.close(resolve));
}
async function inspectContainer(name) {
  const names = await docker('container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}');
  if (!names) return null;
  return JSON.parse(await docker('inspect', name))[0];
}
async function infra(name, port, args) {
  const existing = await inspectContainer(name);
  if (existing) {
    if (existing.Config.Labels?.['lab.demo.project'] !== project) throw new Error(`拒绝操作非本项目容器：${name}`);
    if (!existing.State.Running) { await freePort(port); await docker('start', name); startedContainers.add(name); }
    return;
  }
  await freePort(port);
  await run('docker', ['--host', dockerHost, 'run', '-d', '--name', name, '--label', `lab.demo.project=${project}`, ...args]);
  startedContainers.add(name);
}
async function waitFor(check, label, limit = 60000) {
  const deadline = Date.now() + limit;
  while (!stopping && Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await delay(500);
  }
  throw new Error(`${label} 未就绪，请查看 .demo/logs/ 下的日志。`);
}
async function password() {
  // Local demo bootstrap only; production API has no default password.
  const value = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'yywzy26233a3';
  if (value.length < 12) throw new Error('管理员密码至少 12 个字符。');
  return value;
}
function launch(label, file, args, env) {
  const logfile = path.join(logsDir, label + '.log');
  const fd = fs.openSync(logfile, 'a', 0o600);
  const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  children.push(child);
  child.on('error', e => { console.error(`${label}: ${e.message}`); void shutdown(1); });
  child.on('exit', code => { if (!stopping) { console.error(`${label} 已退出（${code}），查看 ${logfile}`); void shutdown(1); } });
  return child;
}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\n正在停止演示服务……');
  if (control) control.close();
  for (const p of children.slice().reverse()) {
    if (p.exitCode !== null || p.signalCode) continue;
    p.kill('SIGTERM');
    await Promise.race([new Promise(resolve => p.once('exit', resolve)), delay(8000)]);
    if (p.exitCode === null && !p.signalCode) p.kill('SIGKILL');
  }
  // Only infrastructure started by this invocation; user containers keep running.
  for (const name of startedContainers) {
    try { await docker('stop', name); } catch (e) { console.error(e.message); }
  }
  console.log('已停止平台及本次启动的数据库。容器和数据库文件均保留；用户容器不会自动停止。');
  process.exit(code);
}
function sign(method, url) {
  const time = String(Date.now()), nonce = crypto.randomUUID();
  return { 'x-time': time, 'x-nonce': nonce, 'x-signature': crypto.createHmac('sha256', id).update([method, url, time, nonce, ''].join('\n')).digest('hex') };
}
async function start() {
  // Reserve a supervisor port before doing any work, so concurrent starts fail safely.
  control = http.createServer((req, res) => {
    if (req.headers['x-demo-project'] !== project || req.headers.origin) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' && req.url === '/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ project, pid: process.pid, url: 'http://127.0.0.1:5173', logs: logsDir })); return; }
    if (req.method === 'POST' && req.url === '/stop') { res.end('stopping'); setImmediate(() => void shutdown()); return; }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { control.once('error', () => reject(new Error('演示已运行或控制端口35179被占用；可执行 npm run demo:status。'))); control.listen(ports.control, '127.0.0.1', resolve); });
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  dockerHost = dockerAddress();
  await docker('info', '--format', '{{.ServerVersion}}');
  for (const port of [ports.web, ports.api, ports.agent]) await freePort(port);
  if (!fs.existsSync(path.join(root, 'node_modules', 'typescript'))) {
    console.log('安装锁定版本依赖……');
    await run('npm', ['ci']);
  }
  const localNode = path.join(root, 'node_modules', '.bin', 'node');
  const runtime = fs.existsSync(localNode) ? localNode : process.execPath;
  const version = await capture(runtime, ['-p', 'process.versions.node.split(".")[0]']);
  if (Number(version) < 22) throw new Error('需要 Node.js 22 或更高版本。');
  console.log('编译项目……');
  await run('npm', ['run', 'build']);
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  await infra(pgName, ports.postgres, ['-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=geli_demo', '-p', '127.0.0.1:55433:5432', 'postgres:15-alpine']);
  await infra(redisName, ports.redis, ['-p', '127.0.0.1:56380:6379', 'redis:6-alpine', 'redis-server', '--appendonly', 'yes']);
  await waitFor(async () => (await docker('exec', pgName, 'pg_isready', '-U', 'postgres', '-d', 'geli_demo')).includes('accepting connections'), 'PostgreSQL');
  await waitFor(async () => (await docker('exec', redisName, 'redis-cli', 'ping')) === 'PONG', 'Redis');
  let bootstrapPassword;
  const exists = await docker('exec', pgName, 'psql', '-U', 'postgres', '-d', 'geli_demo', '-tAc', "SELECT to_regclass('public.users') IS NOT NULL");
  const adminExists = exists === 't' && (await docker('exec', pgName, 'psql', '-U', 'postgres', '-d', 'geli_demo', '-tAc', "SELECT count(*) FROM users WHERE username='admin' AND role='ADMIN'")) !== '0';
  if (adminExists) console.log('沿用已有 admin 密码（不重置）。');
  else bootstrapPassword = await password();
  const dockerfile = path.join(root, 'deploy', 'images', 'Dockerfile');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(dockerfile)).digest('hex');
  let current = '';
  try { current = await docker('image', 'inspect', imageName, '--format', '{{index .Config.Labels "lab.demo.recipe"}}'); } catch {}
  if (current !== hash) {
    console.log('首次构建开发镜像，需要下载 Node、Python、Java 等组件……');
    await run('docker', ['--host', dockerHost, 'build', '--label', `lab.demo.recipe=${hash}`, '-t', imageName, '-f', dockerfile, '.']);
  }
  // Inherit PATH/proxy for development, but explicitly clear production transport settings.
  const env = { ...process.env, NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://postgres@127.0.0.1:55433/geli_demo', REDIS_URL: 'redis://127.0.0.1:56380',
    PUBLIC_ORIGIN: 'http://127.0.0.1:5173', APP_DOMAIN: 'apps.example.test', PORT: '3000', BIND_ADDRESS: '127.0.0.1',
    AGENT_PORT: '3100', AGENT_BIND_ADDRESS: '127.0.0.1', AGENT_TLS_CERT_FILE: '', AGENT_TLS_KEY_FILE: '',
    AGENT_SHARED_SECRET: id, AGENT_A_SECRET: id, GATEWAY_TOKEN: crypto.randomBytes(32).toString('hex'),
    SECRET_ENCRYPTION_KEY: secretKey, BUILDKIT_HOST: process.env.BUILDKIT_HOST || '', BUILDCTL_BIN: process.env.BUILDCTL_BIN || 'buildctl',
    IMAGE_TEMPLATES_JSON: JSON.stringify({ 'lab-dev': imageName }),
    SERVERS_JSON: JSON.stringify([{ id: 'local-demo', url: 'http://127.0.0.1:3100', secretEnv: 'AGENT_A_SECRET', cpu: 4, memoryMb: 4096, diskGb: 40 }]),
    DOCKER_SOCKET: dockerHost.slice(7), APP_BIND_IP: '127.0.0.1', APP_UPSTREAM_HOST: '127.0.0.1',
    VOLUME_DRIVER: 'local', VOLUME_OPTIONS_JSON: JSON.stringify({ type: 'tmpfs', device: 'tmpfs', o: 'size={sizeGiB}g,uid=1000,gid=1000,mode=0700' }),
    BOOTSTRAP_ADMIN_USERNAME: 'admin', BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword || '' };
  const agentEnv = { ...env };
  delete agentEnv.BOOTSTRAP_ADMIN_PASSWORD;
  delete agentEnv.DATABASE_URL;
  delete agentEnv.REDIS_URL;
  launch('agent', runtime, ['apps/agent/dist/main.js'], agentEnv);
  await waitFor(async () => (await fetch('http://127.0.0.1:3100/agent/resources', { headers: sign('GET', '/agent/resources'), signal: AbortSignal.timeout(2000) })).ok, 'Agent');
  launch('api', runtime, ['apps/api/dist/main.js'], env);
  await waitFor(async () => (await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(2000) })).ok, 'API');
  const webEnv = { ...process.env };
  delete webEnv.BOOTSTRAP_ADMIN_PASSWORD;
  launch('web', runtime, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', 'apps/web', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], webEnv);
  await waitFor(async () => (await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(2000) })).ok, '网页');
  console.log('\n演示启动成功：http://127.0.0.1:5173\n管理员：admin（首次使用演示默认密码，可用环境变量覆盖；已有账号沿用原密码）\n日志：.demo/logs/\n流程：用户可申请开发容器，也可提交公开 GitHub 源码或公开 GHCR 镜像，由 admin 审核后自动部署。\n源码构建要求 Agent 配置可用的 BUILDKIT_HOST；GHCR 镜像部署不依赖 BuildKit。\nCtrl+C 或另一个终端 npm run demo:stop 可停止平台。\n注意：演示使用 tmpfs，工作目录不是持久化存储；应用域名网关未启动。');
}
async function command() {
  const op = process.argv[2] || 'start';
  if (op === '--help' || op === 'help') { console.log('npm run demo        启动本机交互演示\nnpm run demo:stop   停止平台，不删除数据\nnpm run demo:status 查看运行状态\n首次启动需 Docker Desktop、本机端口空闲和网络下载依赖/镜像。'); return; }
  if (op === 'start') { await start(); return; }
  if (!['stop', 'status'].includes(op)) throw new Error('未知命令，请使用 start / stop / status');
  const response = await fetch(`http://127.0.0.1:${ports.control}/${op}`, { method: op === 'stop' ? 'POST' : 'GET', headers: { 'x-demo-project': project }, signal: AbortSignal.timeout(3000) }).catch(() => { throw new Error('演示未运行，或不是通过本脚本启动。'); });
  if (!response.ok) throw new Error('控制端口不属于当前项目，拒绝操作。');
  console.log(await response.text());
}
command().catch(async e => { console.error(e.message); if (control?.listening) await shutdown(1); else process.exitCode = 1; });
