# ADR 0018 — Logs that outlive the pod

**Status:** Accepted · **Date:** 2026-08-26 · **Phase:** 9

## Context

`ash job logs` reads a Pod through the Kubernetes API. That is the right answer for a
running job and it has a property nobody wrote down: it answers for exactly as long as the
Pod object exists.

A Pod stops existing when a cancellation deletes its Job, when an eviction replaces it,
when a node is reclaimed, or when somebody tidies the namespace. So AshML keeps a job's
*state* forever — every transition, with its reason, in `job_events` — and its *output*
for as long as Kubernetes happened to feel like it. For the runs worth explaining
afterwards that is exactly backwards: the failed attempt whose last twenty lines would say
why is the one most likely to have had its pod removed.

The roadmap has carried this since Phase 9, and was specific about the shape of the work:
*"the control plane already emits structured JSON logs with `request_id`/`job_id`
correlation, so shipping them is a collector and a query language rather than a design."*

## Decision

**Loki in `ashml-observability`, and Grafana Alloy reading pod logs through the Kubernetes
API.** Single binary, filesystem storage, one replica, a PersistentVolumeClaim, thirty
days' retention. Plain YAML in `deploy/observability/`, applied by `make observability`,
exactly like Prometheus and Grafana and for the reasons in ADR 0010 — no operator, no Helm,
no CRDs.

`ash job logs` is unchanged. It still asks the cluster, and still says plainly when the
cluster no longer knows.

## Rationale

### Alloy, because Promtail is dead

Promtail is the agent every Loki tutorial still shows. It was deprecated in February 2025
and reached end of life in March 2026. Choosing it today would be choosing an agent that
receives no fixes, in order to match documentation.

### Read through the API, not off the node's disk

The standard shape is a DaemonSet with `/var/log/pods` mounted from the host. It is faster,
and it survives an agent restart by remembering its position in a file.

It also puts a hostPath mount on every node, in a cluster whose entire Phase 10 argument is
that a workload should not be able to reach the host (ADR 0016, ADR 0017) — and it makes
the collector's correctness depend on the container runtime's log layout. One Deployment
holding an API watch has neither problem, and needs no NetworkPolicy exception either:
Alloy never opens a connection *to* a training pod, so the per-project egress policies
neither block it nor have to make room for it.

**What it costs is a pod that starts and finishes while Alloy is down.** There is no file
to catch up from, and those lines are gone. That is the honest trade for a development
cluster; a deployment that must not lose a line wants the DaemonSet and the hostPath.

**What it does not cost is duplication, and that was worth checking rather than assuming.**
The API-based source has no positions file, so on every restart it re-reads each existing
pod from the beginning. Measured: a job's three lines were in Loki, Alloy was restarted, it
re-tailed the same pod, and the count was still three. Lines carry the container's own
timestamps, so a re-read produces entries identical in stream, timestamp and content, and
Loki discards them. Without that property this shape would double its storage on every
rollout.

### `job_id` is a label, and that is a deliberate cardinality decision

Every AshML pod has carried `ashml.io/job-id` and `ashml.io/project` since Phase 2, so the
labels cost nothing to produce. Alloy turns them into Loki labels, which makes the query
the same identifier as everything else:

    {job_id="6993051b-a577-47cf-ad92-3eaf083b68a6"}

One stream per attempt is high cardinality, and Loki's own advice is to keep labels low
cardinality. It is here anyway, because it is the question people actually ask — *what did
that run print* — and on a platform with hundreds of jobs rather than millions the index
cost is nothing. The day that stops being true it moves to structured metadata and the
queries gain a filter expression. The note is in the Alloy config so that is a change
somebody makes on purpose.

**Two labels the collector adds are dropped.** `job` holds the constant
`loki.source.kubernetes.ashml_pods` — a label named for the central noun of this entire
platform whose value has nothing to do with any training job, sitting next to `job_id` in
every autocomplete. `instance` is `namespace/pod:container`, which `pod` and `container`
already say.

### The control plane does not know Loki exists

`ash job logs` could fall back to querying Loki when the Pod is gone, and it does not. That
would give the control plane a required dependency on a log store, a client to configure, a
timeout to tune, and a new way for a log request to be slow — for a fallback path. The
division here is the one ADR 0010 already draws: the API reports what it observed, and
Grafana is where the history is read. The API's honest answer when a pod is gone is that
the cluster no longer knows, which is what it says.

It is the obvious next step if the archive turns out to be what people reach for first.

## Revisit when

- **Losing a line becomes unacceptable.** Then the DaemonSet and the hostPath, with a
  positions file, and the PSA labels on `ashml-observability` chosen to allow it.
- **The job count reaches the range where `job_id` as a label hurts.** Structured metadata,
  and a filter expression in every query.
- **The control plane moves into the cluster.** Its own logs would then be collectable by
  the same Alloy; today it runs on the workstation, so Loki holds the workloads' output and
  not the platform's — the same asymmetry Prometheus has, which scrapes the control plane
  over `host.k3d.internal`.
- **Someone wants alerts on log content.** Loki's ruler is not enabled, for the same reason
  Alertmanager is not deployed (ADR 0010): where an alert goes is a decision this cluster
  cannot answer.

## Consequences

- Grafana has a third datasource. ADR 0010's "two datasources, one story" becomes three,
  and the third is not a number: scraped metrics, pushed training curves, and printed
  output.
- A failed run's output survives its pod. Demonstrated end to end: a job that exits 3, its
  logs read through `ash job logs`, the Kubernetes Job deleted, `ash job logs` then
  answering *"the Pod for this job no longer exists in the cluster"* — and Loki returning
  all six lines with the job's own id as the label.
- `make observability` deploys four components rather than two, and
  `make observability-down` now says it deletes every log as well as every sample.
- Alloy's grant is a Role in `ashml-jobs` rather than a ClusterRole: it can read pods and
  their logs in the one namespace AshML runs workloads in, and nowhere else. A monitoring
  identity is a standing credential that nothing ever rotates, so its scope is the part
  worth writing by hand instead of copying.

  > **Amended by ADR 0019: the grant is in two halves now, and the reason it had to change
  > is worth stating.** Each project runs in a namespace of its own, created when that
  > project first runs something — so "the one namespace AshML runs workloads in" stopped
  > being one namespace, and a Role pinned to `ashml-jobs` would have shipped nothing for
  > every job launched afterwards. The failure mode is the bad one: not an error, an empty
  > panel, which reads as *this run printed nothing*.
  >
  > Alloy's `discovery.kubernetes` can only filter namespaces by a fixed list, and a fixed
  > list cannot name a namespace that will be created next week, so *discovering* pods is
  > now a ClusterRole granting `pods` — names, labels, phases. **`pods/log` was kept out of
  > it.** That half is still a Role, per namespace, created by AshML alongside the
  > namespace itself (`ensureLogReaderGrant`), because the control plane is the only
  > component that knows a new namespace exists.
  >
  > So the sentence above survives where it matters, in a longer form: Alloy can see that a
  > pod exists anywhere in the cluster, and can read what it printed only inside AshML's
  > own namespaces. Listing pods reveals names and labels; `pods/log` reveals what the code
  > printed — a secret in a stack trace, a row of the dataset — and that is the half a
  > standing credential should not hold cluster-wide.
