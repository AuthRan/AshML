# ADR 0015 — Audit the decision, not the response

**Status:** Accepted · **Date:** 2026-08-25 · **Phase:** 10

## Context
`job_events` has audited state changes since Phase 1: what the platform *did*. What it
*declined to do* left no trace. `api_tokens.last_used_at` was the whole trail, and it is
deliberately coarse — it records that a credential was presented, never what it was
refused. Phase 10 listed this as unbuilt and it is the last small item on that list.

The obvious way to build it is a hook that records every 403. That would have been wrong,
and wrong in a way that only shows up when the log is finally read.

Phase 10 also decided that **a project you are not a member of answers 404, not 403**,
because a 403 confirms the name is real and is therefore how an outsider enumerates
projects. The same rule covers everything addressed by an opaque id: a job, an artifact, a
deployment. So on precisely the refusals an audit exists to surface — an account reaching
for things it has no business reaching for — the API answers "not found" on purpose.

An audit built on status codes would record that probing as a series of 404s,
indistinguishable from someone mistyping a name, and the absence would be discovered by
whoever went looking for it after an incident.

## Decision
Denials are described where the decision is made. `authorize`, `resolveProject`,
`requireEntity` and `listScope` attach a `denial` descriptor — the permission, the project
— to the error they throw. `app.js`'s error handler, the one funnel every error already
passes through, turns that into a row and adds the request's half: method, route,
address, request id, and the status the caller was actually given.

Each row carries **both** the refusal and the status. They are allowed to disagree, and
where they disagree is the interesting part. `ash audit denials` heads that column TOLD.

Three constraints on what goes in:

- **Only refusals of an identified caller.** 401s are counted
  (`ashml_auth_failures_total`), not stored.
- **Buffered, batched, and dropped rather than queued** when writes cannot keep up.
- **No foreign keys.**

## Rationale
- **The status code is an unreliable narrator, by design.** Any mechanism that reads it to
  learn what happened inherits that. The only place the truth exists is the frame that
  decided.
- **A 401 has no subject.** What it has is an address and a token prefix, and no ceiling
  on how many a stranger can produce. A row per 401 is an INSERT-per-packet amplifier —
  the failure ADR 0014's rate limiter exists to prevent, handed back through its own audit
  trail. A rate is the right shape for that fact; a row is not.
- **Writing inline puts an INSERT on a path the caller chooses the rate of.** Buffering is
  not a latency optimisation here, it is the same containment argument as above applied to
  callers who *do* hold a token, which is a strictly easier bar to clear.
- **Overflow is dropped, not queued.** An audit that grows without limit under load is a
  memory leak that fires exactly when the platform is already in trouble. The honest
  failure is a gap with `ashml_audit_dropped_total` attached; the dishonest one is a
  process that dies holding the record. A failed write loses its batch for the same
  reason — re-queueing turns a database that is down into a buffer that never drains.
- **No foreign keys**, which is the one thing in the schema that reads as an oversight.
  Every other id in this database cascades or nulls when its subject is deleted. An audit
  row a `DELETE` can erase or anonymise is not an audit row, so the subject is copied in
  as text at the time and the record still reads after the account it names has gone.
- **Reading it is `PLATFORM_ADMIN`.** The trail names people and what they reached for, so
  a project owner who could read it would learn which of their members had been trying
  what — and a caller who could read *their own* refusals would have a way to map the
  boundary they had just been stopped at, one probe at a time.

## Revisit when
Successful privileged actions need auditing too. This records refusals because that was
the stated gap; "an administrator raised a quota" is currently only a `job_events`-shaped
absence. The table's shape already fits — an `outcome` column and a wider set of call
sites — but adding it before anyone asks would mean auditing every successful request,
which is a log, not an audit.

Retention is the other one. A denial is rare in a working system and the table is
indexed for "lately", so nothing prunes it. A caller who *is* misbehaving is bounded by
ADR 0014's limits, which puts a ceiling on the growth; a ceiling is not a policy, and the
day someone asks how large this table is, the answer should be a `DELETE` on a schedule
rather than a shrug.

## Consequences
- The refusals that matter most are now visible as refusals, including the ones the API
  told the caller were 404s.
- `ash audit denials` and `ash audit summary` exist. The summary is one row per caller
  rather than one per refusal, because an account with four hundred denials is the
  finding, and reading it off four hundred rows is how it gets missed.
- An audit row can be joined to the log line that describes the same request:
  `request_id` is the id `pino` already correlates on.
- `truncateAll` in the test support has to name `authz_denials` explicitly. The property
  that makes an audit row survive a deleted user is the same one that makes it survive a
  cascade.
