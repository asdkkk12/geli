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
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'DEVELOPMENT';
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS log TEXT;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS image_templates (
        id UUID PRIMARY KEY, application_id UUID UNIQUE NOT NULL REFERENCES applications(id),
        owner_id UUID NOT NULL REFERENCES users(id), source_type TEXT NOT NULL DEFAULT 'GITHUB',
        repository_url TEXT, source_ref TEXT, source_commit TEXT,
        dockerfile_path TEXT, context_path TEXT, source_image_ref TEXT, source_digest TEXT, server_id TEXT,
        image_ref TEXT, image_id TEXT, status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
        error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      ALTER TABLE image_templates ADD COLUMN IF NOT EXISTS retain_until TIMESTAMPTZ;
      ALTER TABLE image_templates ADD COLUMN IF NOT EXISTS source_image_ref TEXT;
      ALTER TABLE image_templates ADD COLUMN IF NOT EXISTS source_digest TEXT;
      ALTER TABLE image_templates ALTER COLUMN repository_url DROP NOT NULL;
      ALTER TABLE image_templates ALTER COLUMN source_ref DROP NOT NULL;
      ALTER TABLE image_templates ALTER COLUMN source_commit DROP NOT NULL;
      ALTER TABLE image_templates ALTER COLUMN dockerfile_path DROP NOT NULL;
      ALTER TABLE image_templates ALTER COLUMN context_path DROP NOT NULL;
      ALTER TABLE containers ALTER COLUMN expires_at DROP NOT NULL;
      CREATE TABLE IF NOT EXISTS application_secrets (
        application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        name TEXT NOT NULL, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL,
        PRIMARY KEY(application_id,name));
      UPDATE users SET role='ADMIN' WHERE role='APPROVER';
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('USER','ADMIN'));
    `);
  });
}
export async function audit(actor: string, action: string, resource: string, detail = {}, c: Pool | PoolClient = db) {
  await c.query('INSERT INTO audit(actor,action,resource,detail) VALUES($1,$2,$3,$4)', [actor, action, resource, detail]);
}
