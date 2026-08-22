# ADR 0011 — A deployment's address stays still; what is behind it moves

**Status:** Accepted · **Date:** 2026-08-22 · **Phase:** 5

## Context

Spec §21 asks for weighted routing between model versions — `model:v6 → 90%`,
`model:v7 → 10%` — as the mechanism behind canaries, A/B tests, gradual rollout and
rollback. `domain/routing.js` settled what a weight *means* and how one is chosen. This
decides where that choice happens and what it does to the Kubernetes objects.

Until now a deployment was one Kubernetes Deployment behind one Service. That shape
cannot express a split at all: a Deployment has one pod template, so two versions cannot
live in one. Three things had to be decided, and they interact.

**Where a split lives.** The tempting answer is replica counts — three pods of v6 and one
of v7 for 75/25 — because it needs nothing new. `domain/routing.js` records why it is
wrong: a 99/1 canary would need a hundred pods, and it conflates "how much traffic should
this take" with "how much capacity does it need", so resizing a version silently changes
the split. So something has to choose per request, and that something is a process.

**Whether that process is always in the path.** A router in front of every deployment is
uniform and simple to reason about. It is also a hop and a hard dependency added to
deployments that have one version and nothing to decide.

**What happens to the address while any of this changes.** A deployment's name is what
callers hold. Every one of these changes — a new version, a canary, a promotion — changes
what should answer, and none of them may change where callers send requests.

## Decision

**1. Every version gets its own Deployment and its own Service.** Named
`ashml-svc-<name>-<id8>-v<N>`, selected by an `ashml.io/model-version` label that is safe
in an immutable `spec.selector` because a target *is* a version — rolling out a different
one creates a different target. Weight and replicas stay separate columns.

**2. The deployment's address is a Service whose selector moves.** It is created once,
keeps its `clusterIP` and its DNS name for life, and is repointed with a strategic merge
patch carrying `$patch: replace`. It selects one version's pods directly when one version
is taking traffic, and the router's pods when more than one is.

**3. A router exists only while there is something to decide.** `needsRouter` counts the
versions *taking traffic*, not the targets. It is created before it is needed, removed
after it stops being needed, and never while the address still points at it.

**4. The address moves only onto a destination that is ready.** Desired state
(`deployment_targets`) is applied by the request that asks for it; observed state is
written by the sync loop; the loop moves the address when — and only when — what it should
point at has a ready pod. `serving_version` records where it points now, and is null when
that is the router.

**5. A version taken out of rotation keeps its objects at zero replicas.** Weight 0 is not
deletion. `retire` is a separate command and is refused while the version takes traffic or
while the address still resolves to it.

**6. The router keeps serving on a stale split when the control plane is unreachable.**
It never empties its table and never fails readiness for that reason. It reports the age
of what it is applying instead.

## Rationale

### Why the address is a Service and not a DNS name per version

A caller holds `resnet-cifar`. Everything else here is machinery underneath that name, and
the machinery changes constantly. Kubernetes already has exactly the right primitive: a
Service's `clusterIP` and DNS name survive a selector change, so repointing it is
invisible to anything holding an address or a connection. Deleting and recreating the
Service to point somewhere else would issue a new IP and break every open connection and
cached lookup at once.

The one trap is the patch itself. A selector is a map, and both merge-patch flavours
*merge* maps: patching `{a, b}` over `{a, b, c}` leaves `c` behind. Moving the address
from a version's pods to the router's drops the `ashml.io/model-version` key, and a merge
that kept it would leave a selector matching nothing at all — a routine rollout becoming
an outage with no error anywhere. `$patch: replace` is in the request for that one reason.

### Why the router is conditional

Writing `needsRouter(targets) { return targets.length > 1 }` first was wrong in the case
that happens after every finished rollout. Promoting v7 leaves v6 as a target at weight 0,
kept deliberately so that going back is a weight change rather than a redeploy. Counting
it would leave a router — a hop and two pods — permanently in front of a decision with one
possible answer.

Taking the router back out has a cost worth naming: raising v6's weight again means
creating the router and waiting for it to be ready before the split takes effect. Nothing
drops while that happens, because the address only moves onto a ready router. The cost is
latency to effect, not availability, and that is a trade we are willing to make in exchange
for not running two pods per deployment forever.

### Why the switch is blue/green rather than a rolling update

Kubernetes' rolling update is the cheaper answer and it was what this did before: update
the Deployment's pod template, and old pods keep serving until new ones pass readiness.
Per-version Deployments make a version change into a blue/green instead — start v2
alongside v1, move the address when v2 is ready, then scale v1 down.

It costs both versions' capacity for the length of the switch. It buys the thing a rolling
update cannot: there is no window in which some requests are answered by one version and
some by the other **with nothing recording which**. For a web server that window is
invisible and harmless. For a model it is a batch of predictions that cannot be attributed
or reproduced, and unattributable predictions are precisely what §21 exists to eliminate.

The same rule produces the two exceptions that look like special cases and are not: the
outgoing version keeps its pods while the address still points at it, and the reaper
spares whatever the address currently selects. Both are the same sentence — *nothing that
is answering is taken away* — and without them tidying up on time would itself be the
outage.

### Why the split is polled by the router rather than baked into it

Weights could be environment variables on the router's pods. Then every step of a canary —
10%, 50%, promote — would be a pod restart, which restarts the thing measuring the canary
and discards its in-flight requests. Instead the router reads `GET
/api/v1/deployments/:id/routing` every few seconds, and a rollout is one row changing.

It is addressed by **id** rather than by project and name because that is what the pod is
given. A name can be changed by an operator; an id cannot, and a router asking about a
name that has moved would quietly stop working at the exact moment nobody was watching it.

### Why a stale split beats no split

The router depends on the control plane, and the control plane restarts — for a deploy, a
config change, a crash. If a failed refresh emptied the routing table, or if `/readyz`
reported the control plane's health rather than the router's, then every deployment behind
a router would go down with it. That is the coupling this platform refuses everywhere
else: `ash predict` already says in as many words that a control plane being restarted
must not take inference down.

So the last good table is kept and used indefinitely. That is genuinely worse in one way —
a stale split is a *wrong* split, sending 90% somewhere an operator has since changed —
and the answer is not to pretend otherwise but to make it visible: `age_seconds` on
`/-/routing` and `ashml_router_config_age_seconds` in Prometheus. A router that has lost
its control plane keeps working while a number climbs, which is a thing an operator can
see and alert on. An outage is not better for being honest.

### Why a transport failure fails over and an error response does not

The router retries a version that did not answer, once, on another version. It never
retries a version that *did* answer, whatever it answered.

The distinction is one line in the implementation and is the whole value of a canary. A
500 from v7 is v7 telling you something, and it is the single most important thing a
canary produces. Serving that request from v6 instead would hide exactly the failure the
canary was deployed to find, and the operator would promote a broken version on the
strength of an error rate that the router quietly suppressed.

### Why attribution is a header and never the body

Every response carries `X-AshML-Served-By`. Nothing is added to the payload. A client that
parsed a field the router injected would break the moment the deployment dropped back to a
single version and the router left the path — a dependency on the presence of an internal
component, created by the component itself. The control plane reads the header back and
prefers it over its own record in `served_by`, because with a split in place the router is
the only thing that knows which way a given request went.

## Consequences

- A deployment now owns up to `2N + 2` Kubernetes objects: a Deployment and a Service per
  version, its own Service, and a router Deployment. `kubectl get all -l
  ashml.io/deployment-id=<id>` still finds all of it.
- Versions accumulate as weight-0 targets, one per version ever deployed, each at zero
  replicas. They cost rows and objects, not compute. `ash deployment retire` is the
  bounded-growth answer, and it is deliberately manual: the alternative is the platform
  deciding on its own that a rollback target is no longer wanted.
- `deployment_targets` carries the serving state that used to be on `deployments`, because
  the target is the thing that actually runs. The deployment keeps what is about the
  address: where it points, and the router in front of it.
- Deploying a version is now `rollout --traffic 100`. One mechanism, so aborting a canary
  is `ash model deploy` and not a fourth verb.
- The router is the first Node service in AshML other than the control plane, and the first
  image built from `packages/`. It imports `domain/routing.js` by path and carries none of
  the control plane's dependencies — the file is pure, which is what makes that possible.
- A rollout's effect is not instantaneous, and the API says so rather than implying
  otherwise: weights are written immediately, and the split applies once the address has
  moved onto a ready router. `ash deployment get` shows both.
- Not done here: `X-AshML-Route-Key` is accepted from the caller and never generated. A
  sticky session that AshML invented would be a cookie, and a cookie is a product decision
  about someone else's users.
