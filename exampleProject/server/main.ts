import { createApp } from './app.js';

const username = process.env.APP_USERNAME || '';
const password = process.env.APP_PASSWORD || '';
if (!/^[A-Za-z0-9_.-]{3,80}$/.test(username)) throw new Error('APP_USERNAME 必须为3～80位字母、数字、点、下划线或连字符');
if (password.length < 12 || password.length > 200) throw new Error('APP_PASSWORD 必须为12～200个字符');

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口');

const server = createApp({
  origin: process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`,
  username,
  password
}).listen(port, '0.0.0.0', () => console.log('Example 服务启动，端口 ' + port));

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); });
