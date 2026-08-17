/**
 * PostgreSQL connection pool and transaction helper.
 *
 * All SQL in this project is hand-written and lives in `src/repos/` (ADR 0001).
 * This module owns nothing but connections.
 */

import pg from 'pg';

const { Pool } = pg;

/**
 * `pg` returns BIGINT (int8) as a string, because a 64-bit integer can exceed
 * Number.MAX_SAFE_INTEGER. Our BIGINT columns are byte counts and event ids, all far
 * below 2^53, so parsing to Number is safe and keeps the API returning JSON numbers
 * rather than strings.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export function createPool(config) {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    // Fail fast rather than hanging a request when the database is unreachable.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

/**
 * Runs `fn` inside a transaction, committing on success and rolling back on any
 * throw. The callback receives a dedicated client — never the pool — so every
 * statement lands on the same connection.
 *
 * State changes must always write both the new state and its `job_events` row
 * through one of these (spec §47).
 *
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the original error is the useful one.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Verifies the database is reachable. Backs the /readyz probe. */
export async function ping(pool) {
  await pool.query('SELECT 1');
}
