/**
 * Test support for integration tests that need a real PostgreSQL.
 *
 * We test against real Postgres rather than an in-memory fake because the behaviour
 * that matters most here — `FOR UPDATE SKIP LOCKED`, transaction isolation, unique
 * violations — is exactly the behaviour a fake would get wrong.
 */

import pg from 'pg';

const { Pool } = pg;

/**
 * The database these tests are allowed to destroy.
 *
 * This deliberately does **not** fall back to `ASHML_DATABASE_URL`. It used to, and the
 * consequence was exactly what it sounds like: running `npm test` with the development
 * database configured truncated it, and a finished training run's experiment, metrics,
 * artifacts and registered model version went with it. The bytes in object storage
 * survived only because `connectStoreOrNull` below already defaulted to a *separate*
 * bucket — the asymmetry between the two is what made the footgun invisible.
 *
 * So the rule matches the store's: tests get their own database, named for what it is,
 * and a machine that has not created one skips these tests visibly rather than
 * borrowing whatever database happens to be configured.
 */
export const TEST_DATABASE_URL =
  process.env.ASHML_TEST_DATABASE_URL
  ?? 'postgresql://ashml:ashml@127.0.0.1:5432/ashml_test';

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
  + 'run `make db-test` to create and migrate a dedicated test database, or set '
  + 'ASHML_TEST_DATABASE_URL, to include these tests. These tests TRUNCATE every table, '
  + 'so they will not run against your development database.';

/**
 * Deletes all rows created by tests, leaving the schema and the seeded local user.
 * Cascades handle datasets, experiments, jobs, events and quotas.
 *
 * This wipes the whole database, so the integration files must not run at the same
 * time as each other — `npm test` passes `--test-concurrency=1` for exactly that reason.
 * Scoping the wipe per file would not be enough on its own: the queue tests assert on
 * global queue state, because `lockNextQueuedJob` deliberately orders across every
 * project, and narrowing that query to keep tests parallel would be distorting the
 * production path for the convenience of the tests.
 */
export async function truncateAll(pool) {
  assertDestroyable(TEST_DATABASE_URL);
  await pool.query('TRUNCATE projects CASCADE');
}

/**
 * Refuses to wipe a database that is not obviously a test database.
 *
 * Defence in depth behind the default above: pointing `ASHML_TEST_DATABASE_URL` at a
 * database with real data in it is a single mistyped variable away, and the failure is
 * silent and total — `TRUNCATE projects CASCADE` takes experiments, jobs, artifacts and
 * model versions with it, and nothing about a green test run hints that it happened.
 *
 * A name ending in `test` is the signal, which covers `ashml_test`, `ashml-test` and
 * plain `test`. Anything else needs the override, which exists so that a CI environment
 * with a differently-named ephemeral database is not forced to rename it — but has to
 * say so out loud.
 */
export function assertDestroyable(url) {
  if (process.env.ASHML_TEST_DATABASE_ALLOW_DESTRUCTIVE === 'true') return;

  let name;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`refusing to TRUNCATE: ${url} is not a parsable database URL`);
  }

  if (!/(^|[-_])test$/i.test(name)) {
    throw new Error(
      `refusing to TRUNCATE database "${name}": these tests delete every row, and the `
      + 'name does not end in "test" so it may not be a test database. Point '
      + 'ASHML_TEST_DATABASE_URL at a dedicated database (see README), or set '
      + 'ASHML_TEST_DATABASE_ALLOW_DESTRUCTIVE=true if you really mean this one.',
    );
  }
}

/** Unique project name per test, so tests do not collide on the name unique index. */
export function uniqueName(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Returns a real S3 store if MinIO is reachable, otherwise null.
 *
 * Same contract as connectOrNull above, for the same reason: the artifact tests that
 * need a bucket skip visibly on a machine without one rather than failing, but they are
 * never quietly replaced by a fake — verifying that an upload landed is the one thing a
 * fake store could not tell the truth about (spec Rule 5).
 */
export async function connectStoreOrNull() {
  const { createS3Store } = await import('../storage/s3.js');
  const store = createS3Store({
    bucket: process.env.ASHML_TEST_S3_BUCKET ?? 'ashml-test',
    endpoint: process.env.ASHML_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    accessKeyId: process.env.ASHML_S3_ACCESS_KEY ?? 'ashml',
    secretAccessKey: process.env.ASHML_S3_SECRET_KEY ?? 'ashml-dev-secret',
    forcePathStyle: true,
  });

  try {
    await store.ensureBucket();
    return store;
  } catch {
    await store.close().catch(() => {});
    return null;
  }
}

export const STORE_SKIP_MESSAGE =
  `MinIO not reachable at ${process.env.ASHML_S3_ENDPOINT ?? 'http://127.0.0.1:9000'} — `
  + 'run `npm run db:up` to include these tests';
