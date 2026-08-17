/**
 * Test support for integration tests that need a real PostgreSQL.
 *
 * We test against real Postgres rather than an in-memory fake because the behaviour
 * that matters most here — `FOR UPDATE SKIP LOCKED`, transaction isolation, unique
 * violations — is exactly the behaviour a fake would get wrong.
 */

import pg from 'pg';

const { Pool } = pg;

export const TEST_DATABASE_URL =
  process.env.ASHML_TEST_DATABASE_URL
  ?? process.env.ASHML_DATABASE_URL
  ?? 'postgresql://ashml:ashml@127.0.0.1:5432/ashml';

/**
 * Returns a pool if Postgres is reachable and migrated, otherwise null.
 *
 * Callers skip their tests when this returns null, so `npm test` still passes on a
 * machine with no database — but the skip is visible in the output rather than
 * silently reported as success.
 */
export async function connectOrNull() {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 2000 });
  try {
    await pool.query('SELECT 1 FROM training_jobs LIMIT 0');
    return pool;
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
}

export const SKIP_MESSAGE =
  `PostgreSQL not reachable or not migrated at ${TEST_DATABASE_URL} — `
  + 'run `npm run db:up && npm run migrate` to include these tests';

/**
 * Deletes all rows created by tests, leaving the schema and the seeded local user.
 * Cascades handle jobs, events and quotas.
 */
export async function truncateAll(pool) {
  await pool.query('TRUNCATE projects CASCADE');
}

/** Unique project name per test, so tests do not collide on the name unique index. */
export function uniqueName(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
