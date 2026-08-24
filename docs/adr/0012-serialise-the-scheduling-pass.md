# ADR 0012 — Serialise the scheduling pass with a Postgres advisory lock

**Status:** Accepted · **Date:** 2026-08-24 · **Phase:** 10

## Context
ADR 0004 chose `SELECT ... FOR UPDATE SKIP LOCKED` for the job queue and said it "safely
supports multiple scheduler replicas". That is true of the *claim* and was mistaken as
being true of the *pass*.

Claiming and scheduling are two transactions. `lockNextQueuedJob` takes one QUEUED row
with `FOR UPDATE ... SKIP LOCKED`, so two replicas never claim the same job — the loser
skips the row. `scheduleJob` then opens its own transaction, re-locks that job row, and
runs two gates: quota (`projectUsage`) and placement (`clusterView`). Both gates read
**aggregates over other jobs' rows**, and neither read takes a lock.

Under READ COMMITTED — the default, and what this project runs on — that is a lost
update. Two replicas scheduling two *different* jobs each hold a row lock on their own
job and are entirely correct about the row they hold, while each reads a snapshot in
which the other's binding has not been committed. Both find the same free GPU. Both
promise it away. The node is over-committed and the audit trail records two decisions
that were each defensible on the evidence available to them.

This was not hypothetical. Removing the lock and running two concurrent passes against a
2-GPU node, with each job requesting both GPUs, binds both jobs — reproducibly, in
`scheduler.integration.test.js`.

## Decision
`scheduleJob` opens its transaction by taking a transaction-scoped Postgres advisory lock
(`pg_advisory_xact_lock`), so exactly one scheduling pass runs at a time across every
control-plane replica. Keys live in `db/locks.js` under a namespace, not as bare integers.

## Rationale
- **A row lock cannot protect an aggregate.** The thing being protected is a decision
  derived from many rows, so the lock has to cover the decision, not the row it writes.
- **Transaction-scoped, not session-scoped.** A session lock must be released by hand, so
  any path that throws between acquire and release leaks it for the life of the pooled
  connection — and the next unrelated caller inherits a lock it never took. `_xact_` is
  released by COMMIT *and* by ROLLBACK, which are the two paths `withTransaction` already
  has.
- **Cheaper than the alternative.** SERIALIZABLE isolation would detect the same conflict
  and turn it into a serialization failure the executor would have to retry — a retry
  loop, on the hot path, to solve a problem that a lock solves outright.
- **The cost is nil at this scale.** A pass is CPU-bound arithmetic over a node list. The
  contended window is microseconds, and scheduling is already bounded by a poll interval
  measured in seconds (ADR 0004).
- **Acquired before the row lock**, fixing a consistent acquisition order so two passes
  cannot deadlock against one another.

## Revisit when
Scheduling throughput becomes a measured bottleneck — per spec §59, measured, not
intuited. The next step is not a bigger lock but a smaller one: a lock per node, or
per project for the quota gate, so passes touching disjoint capacity proceed in parallel.
That is more machinery than the current throughput justifies.

## Consequences
- More than one control-plane replica is now safe to run. It was not before, and nothing
  in the deployment said so.
- Scheduling throughput has a ceiling of one pass at a time. Far above current load.
- `pg_locks` shows a waiting pass, which is what the mechanism test asserts against
  rather than guessing at a sleep duration.
