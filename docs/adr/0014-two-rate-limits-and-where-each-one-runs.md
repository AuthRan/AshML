# ADR 0014 — Two rate limits, and where in the request each one runs

**Status:** Accepted · **Date:** 2026-08-24 · **Phase:** 10

## Context
Phase 10 made the API default-deny: every `/api/v1` request must present a bearer token,
which is verified by hashing it and looking the hash up in PostgreSQL.

That closed one hole and opened a smaller one. Before Phase 10 an anonymous request was
answered from memory or refused by a route that did no work. After it, an anonymous
request *costs a database query* — and the cost is paid before the server discovers it
was never going to answer. A client holding no credential at all can now make the control
plane query PostgreSQL as fast as it can send packets. Every one of those requests is
refused; the database load is the entire payload. Authentication, added on its own, is
what created this.

There is a second and duller problem, which is the one the roadmap named: nothing stopped
a caller with a *valid* token from making a million requests. That one is a runaway loop,
not an attack, and it wants a different answer.

## Decision
Two token buckets, both per minute, distinguished by what the request turned out to be
rather than by which endpoint it hit.

**Identified** — 1200/minute, keyed by *who* is calling: a user id, a job id, a deployment
id. Charged in a `preParsing` hook, which runs after authentication has resolved the
principal and before the body is read.

**Anonymous** — 600/minute, keyed by source address. **Peeked at in an `onRequest` hook
installed before the authentication hook, and charged in an `onSend` hook after a 401 has
happened.**

Refused requests are not charged. `/healthz`, `/readyz` and `/metrics` are exempt.
`domain/rate-limit.js` holds the bucket arithmetic and takes `now` as an argument;
`auth/rate-limit.js` holds the hooks.

## Rationale
- **The split of check and charge is the whole mechanism.** Checking early is what makes a
  refusal cheaper than the query it prevents; charging late is what keeps the check from
  counting traffic that turned out to be legitimate. Either half alone gives back the
  property the other was there for.
- **Identity, not credential.** Keying the identified budget by token id would mean a
  second token buys a second budget, which is not a limit, it is a formality.
- **A bucket, not a window.** A fixed window lets a caller spend the window at 11:59:59
  and again at 12:00:00, so the real short-term ceiling is twice the stated one and it
  arrives as a burst. A bucket has no boundary to stand on, and it lets a quiet client
  spend a minute at once — which is what `make bench` is.
- **600 for anonymous, which looks too generous and is not.** Every pod in a k3d cluster
  reaches the control plane from one address, so this budget is shared by everything
  behind a NAT or an ingress. A limit tuned to "a handful of 401s is suspicious" would let
  a single misconfigured workload starve every healthy pod beside it — the pre-Phase-10
  image failure the README documents, turned contagious by the mechanism meant to protect
  the platform. Ten a second sits above any real failure loop and three orders of
  magnitude below a flood. The ceiling is the point, not the number.
- **Refusals are not charged.** Otherwise a client in a retry loop never refills, and a
  rate limit becomes a ban nobody configured.
- **Probes and `/metrics` are exempt.** A throttled liveness probe is a pod Kubernetes
  restarts and throttled metrics blind the monitoring at the moment it is describing the
  overload: in both cases the limiter converts a load problem into the outage it exists to
  prevent.
- **No dependency.** `@fastify/rate-limit` is a good plugin and would have been a
  reasonable choice; what it does not have is an opinion about *where in the lifecycle*
  the anonymous check belongs, which is the only part of this that is interesting. Two
  numbers per key and one multiply per request is not the part worth outsourcing (spec
  §44).
- **`0` is an error, not "unlimited".** Zero means unlimited for a quota
  (`domain/quota.js`); the same reading here would turn a typo into an open door.

## Revisit when
A second control-plane replica is run in earnest. The counters live in this process, so
two replicas are two budgets — which is a doubled ceiling, not a broken one, but it stops
being defensible once the replica count is a number somebody tunes. The move then is a
shared counter in PostgreSQL, not a new dependency: the queue is already there (ADR 0004)
and a bucket is a row.

## Consequences
- The API can be exposed to a network it does not control without a token lookup being an
  attack. That was the last thing making "secure enough to expose" untrue; it is not the
  last thing making it *true*, which is still the audit log and Kubernetes RBAC.
- Every non-exempt response carries `RateLimit-Limit`, `RateLimit-Remaining` and
  `RateLimit-Reset`; a 429 adds `Retry-After`. The Python SDK already treats 429 as
  retryable with jittered backoff, so a training run meets this as a delay rather than a
  failure.
- An address that produces sustained authentication failures is refused wholesale,
  including its valid callers. That is deliberate — an address flooding the control plane
  is one to refuse — and it is the reason the budget is not tighter.
- `ASHML_TRUST_PROXY` now exists and defaults to false. Behind an ingress it must be set,
  or every anonymous caller shares the ingress's single bucket; without one it must stay
  unset, or any caller picks their own bucket by sending a header — which is worse than no
  limit, because it looks like one.
