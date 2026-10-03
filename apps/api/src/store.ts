import { Pool, PoolClient } from 'pg';
export const db = new Pool({ connectionString: process.env.DATABASE_URL });
export async function transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
export async function migrate() {
  await transaction(async c => {
    await c.query('SELECT pg_advisory_xact_lock(720001)');
    await c.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('USER','APPROVER','ADMIN')), active BOOLEAN NOT NULL DEFAULT true);
      CREATE TABLE IF NOT EXISTS applications (
        id UUID PRIMARY KEY, owner_id UUID NOT NULL REFERENCES users(id), spec JSONB NOT NULL,
        status TEXT NOT NULL, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS containers (
        id UUID PRIMARY KEY REFERENCES applications(id), owner_id UUID NOT NULL REFERENCES users(id),
        server_id TEXT NOT NULL, spec JSONB NOT NULL, status TEXT NOT NULL,
        docker_id TEXT, upstream TEXT, expires_at TIMESTAMPTZ NOT NULL,
        error TEXT, observed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY, container_id UUID NOT NULL REFERENCES containers(id), action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING', error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_task ON tasks(container_id) WHERE status IN ('PENDING','RUNNING');
      CREATE TABLE IF NOT EXISTS audit (
        id BIGSERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
        resource TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('USER','APPROVER','ADMIN'));
    `);
  });
}
export async function audit(actor: string, action: string, resource: string, detail = {}, c: Pool | PoolClient = db) {
  await c.query('INSERT INTO audit(actor,action,resource,detail) VALUES($1,$2,$3,$4)', [actor, action, resource, detail]);
}
