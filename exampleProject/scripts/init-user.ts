import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { connect, migrate, seedUser } from '../server/store.js';
let hidden = false;
const output = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
let db;
try {
  const username = await rl.question('示例用户名：');
  process.stdout.write('示例密码（至少12字符，不回显）：');
  hidden = true;
  const password = await rl.question('');
  hidden = false; process.stdout.write('\n');
  db = connect(); await migrate(db);
  console.log(await seedUser(db, username.trim(), password) ? '账号已创建' : '账号已存在，保留原密码');
} finally { rl.close(); await db?.end(); }

