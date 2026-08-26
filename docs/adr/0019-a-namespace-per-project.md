# ADR 0019 — A namespace per project

**Status:** Accepted · **Date:** 2026-08-26 · **Phase:** 10

## Context
ADR 0016 moved what a pod *is* from AshML's admission checks to the cluster's, and
ADR 0017 stopped one project's pods reaching another's. Both ended by naming the same
remainder. ADR 0017 put it in its *Revisit when*:

> **A project needs to be isolated from AshML's own workloads, not only from other
> projects.** That is a namespace per project, with everything it costs.

And the roadmap, having closed three of the four things it listed under *no Kubernetes
RBAC, and no per-project service accounts*, was left with one sentence it could not
shorten further:

> every project's pods share one namespace and one service account, so the isolation is
> between projects and not between a project and the platform. […] That needs a namespace
> per project, and it is the next real step here.

The gap is not about traffic — ADR 0017 closed that. It is that a namespace is the unit
Kubernetes scopes almost everything to, and while every project's workloads sat in one,
every boundary the platform had was a boundary AshML drew rather than one the cluster
kept. A Secret belonging to one project's run was readable by anything with `get secrets`
in `ashml-jobs`, which is every project's pods. One service account stood behind all of
them. A quota, if one were ever wanted, could only be a quota on everybody.

ADR 0017 costed this option and declined it at the time, accurately:

> **A namespace per project** is the stronger boundary […] and it is a change to almost
> everything. […] It also cannot be applied to a running cluster without moving every
> existing workload.

The first half was a reason to do the NetworkPolicy *first*, not a reason never to do
this. The second half turned out to be avoidable, and avoiding it is most of this
decision.

## Decision
**Each project's workloads run in a namespace of its own**, named from the configured
base, the project's name, and the first eight characters of its id:

    ashml-jobs-vision-3f2b1c4d
    └── base ──┘└name┘└─ id ─┘

Created on demand — on the launch path and the deployment-apply path, not at startup —
and labelled with the same Pod Security Admission set the shared namespace carries, plus
`ashml.io/project`.

**The namespace a workload runs in is recorded on its row, and read back from there.** It
is never recomputed from the project at observe, delete or teardown time. `training_jobs`
gains a nullable `namespace` column; `deployments` has had one since Phase 5.

**The per-project NetworkPolicy of ADR 0017 stays**, now applied inside each project's own
namespace.

## Rationale

### Recording the namespace is what makes this applyable to a running cluster
The objection ADR 0017 raised — that this cannot be done without moving every existing
workload — assumes the namespace is derived. Derive it, and the day the rule changes every
running Job is looked for in a namespace it is not in, `observeJob` returns null, and the
executor is *required* to read that as "the workload is gone". A healthy run would be
failed and its GPU released while it still holds it. That is the migration nobody wants,
and it is caused by the deriving, not by the change.

Record it instead and the upgrade has no moving parts. A null means "created before this
column existed", which is exactly the shared namespace; every job already running keeps
being observed where it actually is, finishes there, and is cleaned up there. New jobs go
to their project's namespace. The two coexist for as long as it takes the old ones to
drain, which is the length of the longest training run and requires nothing of anyone.

The same argument applies to a project rename, and to any future change of the naming
scheme. `deployments` has carried `k8s_name` and `namespace` since Phase 5 for this
reason, stated there as: *if the naming scheme changes later, everything already deployed
must still be findable.* This extends that to jobs rather than inventing it.

The read path is not quite `job.namespace ?? backend.namespace`, and the difference
matters once. A row with no namespace **and no Job name** was never launched at all, so if
a workload exists it is because a launch created the Job and crashed before recording
either — moments ago, by the current version, in the project's namespace. `cancelWorkload`
deletes by a deterministic name precisely to catch that case, and deleting the right name
in the wrong namespace is a no-op that leaves a Pod holding a GPU.

### The name carries the id because the name alone cannot survive truncation
Project names are unique and are already DNS-1123 labels, so `<base>-<name>` looks
sufficient. It is not: a name may be the full 63 characters a label allows, and a prefix
plus a long name overflows. Truncating then hands two projects whose names agree for the
first 43 characters the same namespace — which is the exact failure this ADR exists to
prevent, reintroduced by the naming of it. The id makes it unique; the name is what makes
`kubectl get ns` legible to an operator, which is the only reason it is there at all. Same
construction as `kubeDeploymentName`, for the same reason.

### The service account was never the work
The roadmap listed "no per-project service accounts" beside the namespace. It needed no
separate decision: Kubernetes creates a `default` ServiceAccount in every namespace, so
each project has its own the moment it has a namespace. Nothing had to be built.

Nor was a Role or RoleBinding added, and that is deliberate. ADR 0016 established that
nothing AshML runs reads the Kubernetes API, and removed the credential that let it —
*every training pod carried a Kubernetes credential, and none of them ever read it*. The
right amount of RBAC for a workload that makes no API calls is none, and adding an empty
Role to be able to say the word "RBAC" would be a decoration over a permission set that is
already empty.

### The NetworkPolicy is kept, not replaced
A namespace boundary and an egress policy refuse different things, and it would be a
mistake to read the stronger one as making the other redundant. A namespace does not stop
a pod opening a TCP connection to a pod IP in another namespace; nothing about being in
`ashml-jobs-alpha-…` prevents dialling an address in `ashml-jobs-beta-…`. Kubernetes
scopes *names*, not routes. The policy is what refuses the packet, and it is still the
half a CNI has to actually enforce.

What the namespace adds is that the policy is no longer the only thing standing between
two projects, and that it now sits in a namespace where the pods it selects are the only
pods there — so the same policy is both defence in depth and, in its own namespace,
tighter than it was.

`make e2e-isolation` checks both halves, and checks them separately, because either alone
would leave a false claim in the README: the namespaces could be right while the policy is
unenforced, and the policy could be enforced while a change quietly puts two projects back
in one namespace.

### What it broke, and the half of the fix worth arguing about
A namespace per project silently broke log collection, and the shape of that failure is
the reason it is written up here rather than fixed quietly. ADR 0018 gave Alloy a Role in
`ashml-jobs` — deliberately not a ClusterRole, because `pods/log` cluster-wide is a
standing credential nothing rotates that can read every line every container in the
cluster has printed. That grant is correct exactly as long as there is one namespace.

Afterwards, no job's logs would have reached Loki, and nothing would have said so: not an
error, an empty Grafana panel, which reads as *this run printed nothing*. The run most
likely to be looked at that way is the failed one whose last twenty lines say why.

The obvious repair is to promote the Role to a ClusterRole, and it was rejected. Instead
the grant is split along the line where the sensitivity actually is:

- **Discovering pods is cluster-wide.** Alloy's `discovery.kubernetes` can only filter
  namespaces by a fixed list, and a fixed list cannot name a namespace that will be
  created next week. So the ClusterRole grants `pods` — names, labels, phases — and the
  config narrows it in practice with a label selector on `app.kubernetes.io/managed-by`.
- **Reading what a pod printed is per-namespace.** `pods/log` stays a Role, created by
  AshML in each namespace it creates, bound to the collector's service account.

Listing pods reveals that a workload exists. `pods/log` reveals a secret in a stack trace,
a row of the dataset, a token somebody echoed. Keeping the second half scoped is most of
what ADR 0018 was buying, and it survives.

That AshML creates the grant at all is the part that deserves the scrutiny: it means the
control plane holds `create` on `roles` and `rolebindings` in the namespaces it makes.
Kubernetes' own escalation check bounds that — a subject cannot grant permissions it does
not itself hold — and the identity is configuration rather than a constant
(`ASHML_LOG_COLLECTOR_SERVICE_ACCOUNT`, `none` to grant nothing), so a cluster that runs no
collector grants nobody anything. It is defaulted rather than left unset because the
alternative is a cluster that deploys the observability stack, looks healthy, and collects
nothing until somebody notices.

### On demand, not at startup
A namespace is created when a project first runs something, and projects are created long
after the server started. So the call sits on the launch and apply paths — one API call on
paths that already make several, ordered before the Secret and the Job, because both are
created *in* it and a namespace that does not exist yet turns either into a 404.

This is the same argument ADR 0017 made for applying the NetworkPolicy on the path that
needs it rather than once at boot, and it has the same consequence: a namespace deleted by
hand at noon is back the next time that project launches anything, rather than staying
gone until someone restarts the control plane.

## Revisit when
- **A project is deleted.** There is no delete-project endpoint, so nothing removes a
  namespace today and empty ones accumulate — one per project, forever. Whatever adds that
  endpoint owns deleting the namespace with it, and owns deciding what happens to a
  project whose runs are still in flight.
- **Quotas should be the cluster's rather than AshML's.** A `ResourceQuota` per namespace
  is now expressible for the first time, and would move quota enforcement from admission
  (ADR 0003) to something that also binds anything else with write access. It is not free:
  AshML's quota errors are better than the cluster's, and two enforcers can disagree.
- **A cluster wants AshML's own components isolated from workloads too.** This separates
  projects from each other and from the platform's *namespace*; the control plane still
  runs with credentials that can write to all of them.
- **The base namespace stops being one string.** `ASHML_K8S_NAMESPACE` is now a prefix as
  well as the home of pre-upgrade workloads. A cluster that wants to change it must accept
  that old workloads stay findable only while the old value is still configured.

## Consequences
- Each project gets a namespace on its first workload, carrying the Pod Security Admission
  labels and `ashml.io/project`. The shared namespace is still created at startup and is
  still where pre-upgrade workloads live.
- Each project gets its own `default` ServiceAccount, and its Secrets are no longer
  readable by another project's pods with `get secrets`.
- `training_jobs.namespace` is a new nullable column. No backfill: null means the shared
  namespace, which is what it was.
- An upgrade needs no drain and no coordination. Running jobs finish where they started;
  the next job launched goes to its project's namespace.
- `make e2e-isolation` gains a check that the two projects are in different namespaces and
  that the cluster hardens both, and it now deletes the namespaces it created — a script
  that left two behind on every run is how a cluster ends up with hundreds.
- The log collector's grant is split: a ClusterRole for pod discovery, and a
  `ashml-log-reader` Role for `pods/log` in every namespace AshML creates. The control
  plane now writes RBAC objects, which it did not before. `ASHML_LOG_COLLECTOR_SERVICE_ACCOUNT`
  names the subject and `none` disables it.
- An upgraded cluster keeps an orphaned `ashml-alloy-logs` Role and RoleBinding in
  `ashml-jobs` — the pair was renamed. `make observability-down` removes them; nothing
  else does, and they are inert either way.
- The roadmap's Phase 10 sentence *the isolation is between projects and not between a
  project and the platform* is closed. What replaces it is smaller: namespaces are never
  reclaimed, and the control plane can still write to every one of them.
