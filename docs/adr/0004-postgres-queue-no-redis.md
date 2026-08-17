# ADR 0004 — Postgres job queue; no Redis in v1

**Status:** Accepted · **Date:** 2026-08-17 · **Phase:** 1

## Context
The scheduler needs a work queue. The spec (§43) lists Redis as a candidate, but §44
demands that every dependency justify its existence.

## Decision
Implement the job queue in PostgreSQL using `SELECT ... FOR UPDATE SKIP LOCKED`.
No Redis, no Kafka, no NATS in v1.

## Rationale
- The queue must be **durable** — a lost job is a lost training run. Redis would need
  persistence configured anyway.
- Jobs already live in Postgres. A separate queue introduces a two-system consistency
  problem for no benefit at our throughput (tens of jobs, not millions).
- `SKIP LOCKED` is a well-understood pattern that safely supports multiple scheduler
  replicas.
- One fewer service to deploy, monitor, and explain.

## Revisit when
Measured queue contention or scheduler latency becomes a real bottleneck. Per spec §59,
that decision must be driven by a benchmark, not by intuition.

## Consequences
- Queue depth is a SQL query, which is convenient for observability.
- Polling interval sets a floor on scheduling latency. Use `LISTEN/NOTIFY` if it matters.
