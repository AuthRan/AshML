# ADR 0016 — The cluster's own admission, not only AshML's

**Status:** Accepted · **Date:** 2026-08-25 · **Phase:** 10

## Context
Spec §31 says: do not allow arbitrary users to submit unrestricted Kubernetes resources.
A user submits an image and a command; AshML builds a Job from them and runs it on the
platform's cluster.

Two thirds of that was already true and nobody had written down why. `k8s/manifest.js`
assembles a container field by field — image, pull policy, command, args, env, resources —
so a job spec has no path to `privileged`, `hostNetwork` or a `hostPath` mount. There is
nothing to strip because nothing is copied. It is a strong property and an accidental one:
it holds because of the shape of a function, and one refactor to `{...job.spec}` would
remove it silently.

The third that was not true is what a Pod gets by *default*. Kubernetes mounts a
credential for its own API into every Pod unless told otherwise, and every AshML pod —
training, model server, router — had one at
`/var/run/secrets/kubernetes.io/serviceaccount`. Checked on the development cluster, not
assumed. No line of AshML has ever read it.

And all of it is AshML checking AshML. The roadmap has said since Phase 10 that a
project's pods are isolated by AshML's admission checks and not by the cluster's, which
means anything else with write access to that namespace is unconstrained — including a
future version of AshML with that refactor in it.

## Decision
Three things, in increasing order of who they bind.

**Every AshML pod sets `automountServiceAccountToken: false`**, plus
`allowPrivilegeEscalation: false`, `capabilities: { drop: ['ALL'] }`, `privileged: false`
and `seccompProfile: RuntimeDefault`. Training pods, model servers and routers alike.

**The allowlist property is asserted by a test.** A job spec carrying `hostNetwork`,
`hostPID`, `privileged`, `volumes` and a `securityContext` is built, and the resulting Pod
is checked to contain none of them — so a change to a merge fails loudly instead of
quietly.

**The workload namespace carries `pod-security.kubernetes.io/enforce=baseline`**, applied
by `ensureNamespace` on every startup, patching an existing namespace rather than only
labelling a new one.

## Rationale
- **A credential nothing reads can only ever be taken.** The `default` service account is
  granted nothing in a stock k3s install, so what that token could do was small. That is a
  property of the cluster *today*: one RoleBinding to `default` — added for something
  unrelated, by someone who does not know AshML's pods are in that namespace — hands
  whatever it gains to every training pod at once. The fix costs one field.
- **The other three cannot break a workload that was not already doing something a
  training job has no business doing.** Verified rather than assumed: `make e2e` passes
  7/7 against the real cluster with them on, and both serving images start under them.
- **The namespace label is the only part that binds anything other than AshML.** That is
  the whole reason it is here. `ensureNamespace` had to start patching for it to mean
  anything, because applying admission labels only on *creation* would mean every cluster
  that had already run AshML — which is every cluster that matters — was the one cluster
  that never got them. Verified by asking the cluster to admit a privileged pod and
  reading the refusal.
- **`baseline`, not `restricted`, and the gap is exactly one requirement.** `restricted`
  demands `runAsNonRoot`, which refuses any image that does not declare a `USER` —
  including `busybox`, the image this platform's own end-to-end test runs. Enforcing it
  would convert a security default into "your job does not start", for images their
  authors had every right to build that way. Everything else `restricted` asks for is
  already satisfied above, so this is a one-word change the day every image in use
  declares a user. `audit=restricted` is set meanwhile, so a cluster with audit logging
  records what it would have refused.
- **`warn` is deliberately unset.** It would attach the same warning to every Job this
  server creates. A warning that appears on every successful operation is one an operator
  learns to skip, which costs more than the two paragraphs of documentation it replaces.

## Revisit when
Every image in use declares a `USER` — then `enforce` becomes `restricted`.

Sooner than that: **projects are still not isolated from one another.** All pods share one
namespace and one service account, so a training pod in one project can open a socket to a
model server in another. Nothing above changes that; they constrain what a pod *is*, not
who it can reach. The next real step is a namespace per project or a default-deny
NetworkPolicy, and the second is cheaper — k3s ships a NetworkPolicy controller, so it
would be enforced rather than declarative.

> **Done, by the second route.** [ADR 0017](0017-egress-is-the-side-that-can-be-enforced.md)
> gives each project a NetworkPolicy — written as egress, for a reason the ingress version
> only reveals on a two-node cluster. What remains of the paragraph above is the namespace
> and the service account, which are still shared.

## Consequences
- Training pods on the development cluster now mount no volumes at all.
- No image needs rebuilding: this is in the manifests, not in the containers. Running
  Jobs are unaffected — a Job's Pod spec is immutable, so it reaches training pods on the
  next attempt and serving pods on the next apply.
- A privileged or host-networked Pod in the workload namespace is refused by the API
  server, whoever submits it — AshML included.
- `restricted` is now one label away rather than a paragraph of intent.
