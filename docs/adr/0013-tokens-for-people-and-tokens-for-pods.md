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

**A deployment's credential is minted once, not rotated.** This is the correction to the
first version of this decision and it is worth recording as a mistake rather than quietly
fixing. Rotating on every apply looked obviously safer. It was not, because the two
properties combine badly: an env var sourced from a Secret is materialised when the
*container* starts and never updated, and the pod template is deliberately identical
across applies so a weight change does not restart anything. Rotating therefore revoked
the credential the running router was still holding, restarted nothing to pick up the
replacement, and the router's next poll 401'd — at which point `routing-table.js` does the
right thing for a transient failure and keeps serving its last good table. So
`ash deployment rollout` would have written the new weights, reported success, and sent
the canary no traffic at all. A deployment now holds one credential for its lifetime,
which ends when the deployment row does (`ON DELETE CASCADE`).

**The serving credential lives in a Kubernetes Secret; the run credential does not.**
Both were inline at first and one of them had to move. `applyDesiredState` rewrites every
target's manifest whenever anything about a deployment changes, so an inlined serving
token made the pod template differ on every apply — and Kubernetes would then restart
every serving pod on a *traffic-weight change*, replacing a weighted rollout with an
outage. A `secretKeyRef` is the same string every time. A training Job has no such
problem: each attempt is a new Job, so a per-attempt value in the environment costs
nothing and saves a second object to create, keep in step, and garbage-collect.

> **Superseded: the run credential is in a Secret too.** The sentence above weighed the
> cost correctly and weighed the benefit as nothing, because it read the exposure as "the
> token is visible to someone who can already read this namespace". It is not the same
> permission. `get jobs` is what an operator grants so a colleague can watch their runs;
> `get secrets` is the grant people actually stop and think about, and an inline value
> collapsed the two. The cleanup that was supposed to cost is one delete-by-label at the
> terminal state, because the Secret carries `ashml.io/job-id` and every attempt's is
> removed by the same call. Verified from inside a pod: the container reads the Secret,
> posts a metric, and the control plane records it. See *Found by review, after the fact*.

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
- ~~**The training token is readable via `kubectl describe job`** by anyone who can already
  read Jobs in that namespace.~~ **Closed.** It is a `secretKeyRef` now, so reading it
  takes `get secrets` rather than `get jobs` — and the Secret is deleted when the run
  ends, so the object stops existing at about the moment its contents stop working. What
  is still true is that anyone who can `exec` into the pod reads it out of the
  environment, which no arrangement of Kubernetes objects prevents.

## Found by review, after the fact

Recorded because the list is more useful than the impression that none of this needed a
second pass:

- The rotation bug above — the only one that would have broken a working feature.
- **Moving the run token into a Secret found a second bug in the same function.** With the
  value gone from `containerEnv`'s reserved map, a user-supplied `ASHML_RUN_TOKEN` in
  `spec.env` was no longer filtered out, and the pod would have carried two entries of
  that name. Kubernetes takes the last, so the credential would still have been the right
  one and nothing would have failed — a job would simply have shipped its own guess about
  a credential in the same pod spec, and the header comment claiming user environment
  "can never overwrite" the platform's would have been quietly false. Caught by the test
  that asserts it, which was written before the code it tests.
- **The last-owner check was advisory.** It read `countOwners` and then wrote, with no
  lock, so two owners demoting each other concurrently both saw two owners and both
  proceeded, leaving a project with none. Now serialised on the project row.
- **Two error messages named a project the caller could not see** (`ARTIFACT_PROJECT_MISMATCH`,
  `EXPERIMENT_PROJECT_MISMATCH`). Both are 400s, and a 400's message is relayed to the
  caller, so an id seen in a log was enough to read back a project name — the disclosure
  the 404 rule above exists to prevent.
- **`/readyz` returned the driver's own error**, unauthenticated. `pg` puts hosts, ports
  and role names in those.
- **`REQUIRED_ROLE[permission]` was an unguarded property read**, so inherited keys like
  `constructor` skipped the "unknown permission is denied" guard. They were still denied,
  by a later `isRole` check — correct by accident is not the same as correct.
- The uuid guard accepted 36 dashes (a 500 rather than the intended 404) and rejected the
  valid undashed form.
- The CLI truncated its credential file before rewriting it, so a crash mid-write lost
  every endpoint's token rather than one. Now written to a temporary file and renamed.

## Upgrading

**Every image must be rebuilt** — the two trainers, the model server and the router:

```bash
make image && make resnet-image && make model-server-image && make router-image
```

Each of them talks to the control plane, and an image built before this change ignores the
`ASHML_RUN_TOKEN` it is given and calls the API anonymously. What makes this worth a
section rather than a line is that neither failure names the cause:

- a **model server** dies with `HTTP 401 fetching the model`, which reads as a
  control-plane fault;
- a **training pod** runs normally and then crashes at its first artifact upload with
  `ApiError: authentication required: send a bearer token` — minutes in, on a run that had
  been reporting nothing and looking fine.

Both were found by running `make journey` against images already in the cluster, and the
second was found only after the first was fixed. The initial version of this section said
training images needed no rebuild, on the reasoning that the SDK warns rather than fails
when it has no token. That reasoning was about `init()`; it says nothing about the
*reports*, and every report is refused.

## One operational hazard, found the hard way

**A control plane from before this change, still running against the same database, undoes
it.** Not partially — completely, for anything it happens to claim. Its executor takes
jobs off the shared queue and launches them with no token, and its API accepts their
unauthenticated reports, because it predates the code that would refuse them.

This is worth writing down because of how it presents. Everything looks fine: jobs run,
metrics arrive, the journey passes. Nothing in either process complains, and the *new*
control plane is behaving perfectly — it is simply not the one that handled that job. It
was found here by noticing that a training pod had reported 22 metric points while its
Pod spec contained no `ASHML_RUN_TOKEN` at all, which is not a state either version can
produce on its own.

There is no code fix, and adding one — a version handshake, an instance registry — would
be machinery for a mistake that a sentence prevents: **stop the old control plane before
starting the new one**, and if a result looks impossible, check how many are running.

## Consequences
- Every integration suite now authenticates, so they exercise the default-deny path that
  ships rather than a switched-off variant of it.
- `ASHML_AUTH_ENABLED=false` exists for local development and the k3d end-to-end scripts.
  It acts as the seeded local administrator — a real principal through the real checks,
  not a bypass — and warns on every start.
- Adding a route is now two decisions, not one: what it does, and who may call it. The
  second is not optional and not silent.
