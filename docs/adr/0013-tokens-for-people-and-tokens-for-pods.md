# ADR 0013 — Tokens for people, tokens for pods; default deny for both

**Status:** Accepted · **Date:** 2026-08-24 · **Phase:** 10

## Context
Everything before this ran unauthenticated. Spec §31 asks for authentication,
authorization, RBAC, service accounts and project isolation, and says security should be
"built into the architecture rather than added at the end" — which this is, so the
question is how to add it without the result being decorative.

Two facts shaped it. First, there is no identity provider and adding one would be the
largest dependency in the project (spec §44). Second, the callers are not all people: a
training pod reports its own metrics and artifacts, and a model server fetches its own
weights. The Phase 4 roadmap already recorded that those ingest paths had no
authentication at all, so anything that could reach the control plane could report
results for any job.

## Decision

**Bearer tokens, stored as SHA-256 hashes, looked up by hash.**

**Two kinds of principal, in separate tables.** `api_tokens` belongs to a person;
`workload_tokens` belongs to one attempt of one job (`RUN`) or one deployment
(`SERVING`).

**Three project roles** — VIEWER, EDITOR, OWNER — plus a `users.is_admin` flag for
platform administration. `domain/roles.js` is a pure function from principal and
permission to yes or no.

**Default deny at the route layer.** Every `/api/v1` route must declare what it takes to
call it, checked when the route is registered.

## Rationale

**SHA-256, not bcrypt or argon2.** Those exist to make *low-entropy* secrets expensive to
guess. These tokens are 256 bits from `randomBytes`; there is nothing to brute-force, and
a slow KDF would only add latency to every authenticated request.

**Looked up by hash, never compared.** The usual advice is `timingSafeEqual`, and needing
it here would have been a sign the design was wrong: comparing implies something else
selected the row — a user id, a prefix — and that selector would be the real credential.
Hashing the presented token and using the hash as the primary key removes the comparison.

**Separate tables for people and pods.** They differ in lifetime (months versus one
attempt), in blast radius (every project you are in versus one job), and in how they end
(revoked by hand versus automatically). One table with a nullable `user_id` would mean
every authorization check began by working out which kind it held — the check most likely
to be forgotten.

**A run token can report and nothing else.** Not even reading the project it runs in. A
training pod has no reason to enumerate its neighbours, and the blast radius of a token
that leaves the cluster in a log line should be one job's metrics.

**A person cannot report a run's results.** Not even a platform administrator. The value
of the record is that the pod reported what it observed (ADR 0009, spec Rule 5); an
endpoint a human can post to is an endpoint where the number might have been chosen.

**Quotas are platform administration, not project ownership.** A quota a project owner can
raise is not a quota. Cluster inventory is here for the same reason: it describes the
host, not any one project's use of it.

**Default deny, enforced at registration.** A route that declares nothing throws when it
is registered, so the server does not start. The alternative — open until somebody
remembers to protect it — fails silently and in the dangerous direction every time a route
is added. Here, forgetting produces `npm start` failing with the path in the message.

**404, not 403, for a project you cannot see.** A 403 confirms the name is real, which is
how an outsider enumerates projects. A caller who *can* read the project but not write it
gets a truthful 403, because hiding it from them would be the confusing answer.

**The serving credential lives in a Kubernetes Secret; the run credential does not.**
Both were inline at first and one of them had to move. `applyDesiredState` rewrites every
target's manifest whenever anything about a deployment changes, so an inlined serving
token made the pod template differ on every apply — and Kubernetes would then restart
every serving pod on a *traffic-weight change*, replacing a weighted rollout with an
outage. A `secretKeyRef` is the same string every time. A training Job has no such
problem: each attempt is a new Job, so a per-attempt value in the environment costs
nothing and saves a second object to create, keep in step, and garbage-collect.

**Bootstrap requires database credentials, not an environment variable.** The first token
cannot come from the API. `scripts/issue-token.mjs` writes one directly, so minting
requires access that could already read and change every row. The usual
`ASHML_BOOTSTRAP_TOKEN` alternative is worse in a specific way: it works over the network,
it is set once and never rotated, and it is invisible in `ash token list` because it is
not a row.

## What this does not do

- **No identity provider.** No OIDC, no SSO, no passwords. `ash login` stores a token
  that was issued out of band. For a platform with a handful of users this is the whole
  requirement; for more than that it is the first thing to replace.
- **No Kubernetes RBAC or per-project service accounts.** Spec §31 lists both. AshML's
  own service account creates every workload, so a project's pods are isolated by
  AshML's admission checks and not by the cluster's. Recorded in the roadmap.
- **No audit log of authorization decisions.** Job state has one; this does not.
- **The training token is readable via `kubectl describe job`** by anyone who can already
  read Jobs in that namespace. It is per-attempt and revoked when the attempt ends, which
  bounds it, but it is not hidden.

## Consequences
- Every integration suite now authenticates, so they exercise the default-deny path that
  ships rather than a switched-off variant of it.
- `ASHML_AUTH_ENABLED=false` exists for local development and the k3d end-to-end scripts.
  It acts as the seeded local administrator — a real principal through the real checks,
  not a bypass — and warns on every start.
- Adding a route is now two decisions, not one: what it does, and who may call it. The
  second is not optional and not silent.
