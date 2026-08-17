# ADR 0001 — PostgreSQL for control-plane state

**Status:** Accepted · **Date:** 2026-08-17 · **Phase:** 0

## Context
The control plane needs durable state for jobs, experiments, models, and events. Spec §9
requires that state transitions are persisted and that the system does not rely on
in-memory state. Spec §19/§46 require that large binaries stay out of the database.

## Decision
PostgreSQL 16 for all control-plane metadata and state. Access via the `pg` driver with
hand-written SQL in a thin data-access layer. No ORM. Migrations via `node-pg-migrate`.

Artifacts (checkpoints, model binaries) go to S3-compatible object storage; the database
stores only a URI and a digest.

## Rationale
- Transactions give us correct state transitions without a distributed lock service.
- `SELECT ... FOR UPDATE SKIP LOCKED` provides a durable work queue (see ADR 0004).
- Hand-written SQL keeps the query patterns visible; this project exists partly to
  demonstrate them. An ORM would hide exactly the parts worth showing.
- `SKIP LOCKED`, partial indexes, and `JSONB` are all things an ORM makes awkward.

## Consequences
- Single point of failure in v1. Acceptable; HA Postgres is a post-v1 concern.
- Schema changes require migrations, which is the point.
