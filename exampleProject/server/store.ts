import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { hashPassword } from './security.js';
export function connect() {
  if (!process.env.DATABASE_URL) throw new Error('请设置 DATABASE_URL');
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
}
export async function migrate(db: pg.Pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS example_users (
      id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS example_sessions (
      token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES example_users(id),
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS example_sessions_expiry ON example_sessions(expires_at);
  `);
}
export async function seedUser(db: pg.Pool, username: string, password: string) {
  if (!/^[a-zA-Z0-9_-]{3,80}$/.test(username) || password.length < 12 || password.length > 200)
    throw new Error('用户名须为3～80位字母、数字、下划线或连字符；密码须为12～200字符');
  const result = await db.query('INSERT INTO example_users VALUES ($1,$2,$3) ON CONFLICT(username) DO NOTHING',
    [randomUUID(), username, await hashPassword(password)]);
  return result.rowCount === 1;
}

