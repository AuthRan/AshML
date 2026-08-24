/**
 * PostgreSQL advisory locks: serialising work that spans more than one row.
 *
 * Row locks (`FOR UPDATE`) protect a row. They cannot protect a *decision* that reads an
 * aggregate over many rows and then writes one, because nothing about locking the row
 * being written stops a concurrent transaction from reading the same aggregate first.
 * That is the shape of a scheduling pass, and an advisory lock is the standard answer.
 *
 * Every lock here is transaction-scoped (`pg_advisory_xact_lock`) rather than
 * session-scoped. The difference matters more than it looks: a session lock has to be
 * released by hand, so any path that throws between acquire and release leaks it for the
 * lifetime of the pooled connection — and a pooled connection outlives the request that
 * leaked it, so the next unrelated caller inherits a lock it never took. A transaction
 * lock is released by COMMIT and by ROLLBACK, which means the failure modes are the two
 * the code already handles.
 *
 * Keys use the two-argument form so they read as (namespace, what) rather than as one
 * opaque bigint. The namespace exists because advisory locks share a single cluster-wide
 * space with every other application on the database: an unprefixed key of `1` is a
 * collision waiting for the first other tool that also thought `1` was reasonable.
 */

/** ASCII 'AS', for AshML. Arbitrary, but ours, and never reused for a row id. */
const NAMESPACE = 0x4153;

export const AdvisoryLock = Object.freeze({
  /**
   * Held for the whole of one scheduling pass (`services/scheduler.js`).
   *
   * This is what makes more than one control-plane replica safe. `lockNextQueuedJob`
   * already stops two schedulers from claiming the *same* job — `FOR UPDATE SKIP LOCKED`
   * gives the row to exactly one of them. The race this closes is the one between passes
   * on *different* jobs: both read `clusterView`, which aggregates over `training_jobs`
   * with no lock, so under READ COMMITTED each sees a cluster in which the other's
   * binding has not been committed yet. Two jobs are then bound to the same free GPU and
   * both are correct about what they read.
   *
   * Serialising the pass costs nothing worth having. Placement is CPU-bound arithmetic
   * over a node list — microseconds — and the alternative, SERIALIZABLE isolation, turns
   * the same conflict into a retry loop the executor would have to grow anyway.
   */
  SCHEDULING_PASS: 1,
});

/**
 * Takes an advisory lock for the rest of the current transaction, waiting if another
 * transaction holds it.
 *
 * Must be called on a client inside a transaction. Called on a pool, it would acquire
 * the lock on an arbitrary connection in an implicit transaction and release it one
 * statement later, which looks like locking and is not.
 *
 * @param {import('pg').PoolClient} client
 * @param {number} lock one of AdvisoryLock
 */
export async function takeAdvisoryLock(client, lock) {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [NAMESPACE, lock]);
}
