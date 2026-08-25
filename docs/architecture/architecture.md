# AshML Architecture

## 1. Scope of this document

This describes the architecture as built, not as dreamed. Sections marked
**[planned: Phase N]** are not implemented yet. See `docs/roadmap.md`.

## 2. Plane separation

AshML is split into two planes, and this boundary is load-bearing.

**Control plane** decides what should happen. It is stateful, Node.js, and never runs user code.
- `ashml-server` — REST API, validation, authorization, domain state
- `ashml-scheduler` — queue draining, placement decisions, resource accounting
- PostgreSQL — durable state, job events, audit log

**Compute plane** does the work. It is stateless from AshML's perspective and runs
untrusted-ish user containers.
- Kubernetes Jobs (training), Deployments (inference)
- GPU devices, exposed through the `GpuProvider` contract
- MinIO / S3 — artifacts and checkpoints

**The rule:** infrastructure logic never leaks into training containers. A training
container's only contract with AshML is the Python SDK reporting metrics and checkpoints
over the public API.

```
                 ash CLI  /  Ashcode [planned: Phase 9]
                              │
                        REST /api/v1
                              │
                    ┌─────────▼─────────┐
                    │   ashml-server    │  ── validation, authz, domain state
                    └─────────┬─────────┘
                              │  Postgres (jobs, queue, events)
                    ┌─────────▼─────────┐
                    │ ashml-scheduler   │  ── placement, quotas, GPU accounting
                    └─────────┬─────────┘
                              │  @kubernetes/client-node
                    ┌─────────▼─────────┐
                    │    Kubernetes     │
                    └─────────┬─────────┘
              ┌───────────────┼───────────────┐
         Training Job    Inference Deploy   GPU devices
              │               │               │
              └──── MinIO ────┴──── Prometheus / Loki / Tempo

An inference deployment, once it serves more than one version:

         deployment Service        ── the address callers hold; never moves
                    │
         ┌──────────▼──────────┐
         │    ashml-router     │  ── weighted choice, per request
         └──────────┬──────────┘   reads the split from ashml-server
              ┌─────┴─────┐
           v6 Service  v7 Service  ── one Deployment and Service per version
              │            │
           v6 pods      v7 pods
```

## 3. Component boundaries

| Component | Owns | Must not |
|---|---|---|
| `ashml-server` | API surface, domain validation, state transitions, events | Talk to Kubernetes directly |
| `ashml-scheduler` | Placement decisions, resource accounting, quota enforcement | Own the API or mutate domain objects outside job state |
| `GpuProvider` | Device discovery and telemetry | Know about Kubernetes or jobs |
| Python SDK | Reporting metrics, checkpoints, artifacts | Read the database or call Kubernetes |
| CLI | Rendering, auth token handling | Contain business logic |
| `ashml-router` | Choosing which model version answers a request, and saying which did | Hold a model, transform a payload, or decide what the split should be |

Only `ashml-scheduler` writes placement fields. Only `ashml-server` accepts user input.
Every state change appends to `job_events` — no silent mutations.

**As built, `ashml-scheduler` is not yet a separate process.** The executor added in
Phase 2 (§6) runs inside `ashml-server`, so today that table's "must not talk to
Kubernetes directly" is enforced at the *module* boundary — only `src/k8s/**` imports the
Kubernetes client — rather than at a process boundary. It is deployed as one binary
because there is nothing yet to gain from two: the split earns its keep when placement
decisions and quota accounting arrive in Phase 3 and want to scale and fail
independently of the API. Setting `ASHML_EXECUTOR_ENABLED=false` already produces an
API-only replica, which is the seam that split will follow.

## 4. Why the scheduler is separate from Kubernetes' scheduler

Kubernetes schedules *pods that already exist*. AshML needs to decide whether a pod
should exist at all: queueing under quota exhaustion, priority ordering across projects,
and GPU-shape matching (count **and** per-device free memory) before admission.

Creating a Pod and letting it sit `Pending` forever is not queueing — it is an
unobservable failure. So AshML holds jobs in its own queue and only creates Kubernetes
objects once placement is decided. Kubernetes then does what it is good at: running and
supervising the container.

## 5. GPU abstraction (AshGPU pluggability)

`packages/server/src/gpu/provider.js` is the single seam through which all GPU knowledge enters the
platform:

```js
// Every provider exposes exactly this:
//   get name()   -> string
//   discover()   -> Promise<Device[]>
```

Implementations:

| Provider | Status | Use |
|---|---|---|
| `nvidia` | **Real.** Shells out to `nvidia-smi`. | Default on GPU hosts |
| `sim` | **Simulated.** Clearly labelled; every device carries `simulated: true`. | CI, laptops, multi-node testing |
| `ashgpu` | **Does not exist.** [planned: Phase 8] | Future |

Nothing above this seam knows which provider is active. Adding AshGPU later means writing
one module and registering it — no scheduler, API, or schema changes. That is the entire
point of introducing the seam now, before it is needed.

Simulated devices are flagged all the way to the API response so a demo can never
silently pass off fake telemetry as real (spec Rule 5).

## 6. Execution layer

`packages/server/src/k8s/backend.js` is the single seam through which all Kubernetes
knowledge enters AshML, in the same shape as the GPU provider seam above. Two
implementations exist: `kubernetes` (real, the default) and `sim` (in-memory, opt-in,
and self-labelling). Nothing above this seam imports `@kubernetes/client-node`.

The layer splits into three parts, each isolated for a different reason:

| Module | Responsibility | Why it is separate |
|---|---|---|
| `k8s/manifest.js` | AshML job → Kubernetes Job manifest | Pure. The part most likely to be subtly wrong, and the part a test can check exactly |
| `k8s/kubernetes.js` | Talking to the API server | The only place credentials, retries and HTTP status codes exist |
| `services/executor.js` | Which transition follows which observation | Testable against `sim` without a cluster or a clock |

**The executor owns the whole round trip.** Each pass reconciles every job that has (or
may have) a workload, then admits new jobs from the queue. Reconciling first is not
cosmetic: it frees finished jobs before new ones are admitted, so a full cluster drains
before it fills again.

Three decisions in this layer are load-bearing:

- **`backoffLimit: 0` on every Job.** If Kubernetes retried on its own, a failed attempt
  would restart without passing through `FAILED → RETRYING → QUEUED`, so the event log
  would not explain why a job ran twice and `max_retries` would mean nothing. AshML owns
  retries (ADR 0003); this is what keeps the state machine authoritative.
- **The Kubernetes Job name is derived from the job id and attempt**, never generated
  randomly. That makes launching idempotent — a crash between creating the Job and
  recording it is recovered by re-launching, which adopts the existing Job rather than
  starting a second container. It is also what lets a cancel that arrives mid-launch
  delete a workload the database does not yet know the name of.
- **A vanished workload fails the job.** If the Job is gone and AshML never observed it
  finish, the outcome is unknown, and unknown is recorded as `FAILED` with a reason —
  never as success. Reporting a result that was not observed is precisely what spec
  Rule 5 forbids.

The status loop polls rather than watches; ADR 0007 explains why, and what it costs.

## 7. Scheduling

Two pure modules decide whether a job runs, and a thin service applies what they decide:

| Module | Question it answers |
|---|---|
| `domain/quota.js` | May this project afford another job at all? |
| `domain/placement.js` | Is there a node this job fits on, and which is best? |
| `services/scheduler.js` | Gathers the inputs, applies the verdict, writes down why |

Quota is checked **first**, and the order is deliberate: a project over its own limit
should be told so even when the cluster is idle. Evaluating nodes first would report "no
capacity" for what is actually a limit the user set themselves, sending them to
investigate a cluster that is fine.

Both gates are pure — no database, no clock, no randomness — so the same job against the
same cluster always produces the same decision. That is not tidiness: a placement that
cannot be reproduced cannot be debugged, and this is the logic the platform exists to
demonstrate.

**Policy is best fit, not first fit.** GPU jobs are packed onto the node that will have
the fewest GPUs left over, because spreading them fragments the cluster — two nodes with
one free GPU each cannot run a two-GPU job, while one node with two free can. CPU-only
jobs are steered towards nodes with the fewest schedulable GPUs, so a GPU does not end up
idle behind a CPU shortage. Ties break on node name, so placement is deterministic.

**Capacity is what the cluster will grant, not what the hardware has.** A node's usable
CPU is its `allocatable` minus the requests of Pods AshML did not create, and its
schedulable GPUs are `min(nvidia.com/gpu advertised, healthy devices discovered)`. ADR
0008 covers why, and what went wrong before it did.

**Every pass leaves a record.** `scheduling_decisions` holds one row per node considered,
with the numbers that produced the verdict — not just the winner, because "why not the
other node?" is as much a part of explaining a placement as "why this one". A node that
fit but lost the ranking is recorded `VIABLE`, distinct from `SELECTED`; marking every
fitting node selected would show several winners for one job.

**A refused job returns to the queue, and the pass moves on.** It does not stop the pass:
one job asking for more GPUs than any node has would otherwise block every job behind it
— textbook head-of-line blocking, and something the executor's admission loop explicitly
walks past by tracking what it has already refused this pass.

What the scheduler deliberately does **not** do in v1: preempt running work (eviction
without a checkpoint to resume from destroys results — Phase 4 first), or model every
Kubernetes predicate. Because placement is expressed as a `nodeSelector` rather than
`spec.nodeName`, a gap in AshML's model surfaces as a visible Pending Pod rather than an
over-committed node.

## 8. State model

Job state lives in Postgres, never only in memory (spec §9). `packages/server/src/domain` owns the
legal transition table; any transition not in that table is rejected and returns an
error. Terminal states (`SUCCEEDED`, `CANCELLED`) accept no outgoing edges. `FAILED` is
deliberately *not* terminal — the retry path `FAILED → RETRYING → QUEUED` depends on it.

The scheduler and the Kubernetes status-sync loop both drive transitions, so the
transition table is the only thing preventing two writers from corrupting state. It is
unit-tested exhaustively.

## 9. Reproducibility model

A result is worth nothing if nobody can say what produced it, so the pieces are pinned
by identity rather than by name:

| Recorded on the experiment | Why not the obvious alternative |
|---|---|
| `git_commit` | A branch name moves; a commit does not |
| `image_digest` | A tag is mutable, so `:latest` pins nothing |
| `dataset_version_id` | A dataset *name* says nothing about which bytes were read |
| `hyperparameters`, `random_seed` | Without the seed the run is not repeatable at all |

Two invariants enforce this rather than merely encouraging it:

1. **Dataset versions are immutable.** There is no update path in the repo or the
   service — re-registering an existing version is a `409`. An experiment pinned to a
   version therefore keeps describing the same data indefinitely.
2. **A dataset reference is all-or-nothing.** Supplying a dataset without a version is
   a `400`, not a row with a null version id. A partially pinned run is more dangerous
   than an unpinned one, because it looks reproducible.

Jobs carry an optional `experiment_id`, validated to belong to the same project as the
job — quotas and scheduling are per project, so cross-project attribution would corrupt
both sides' accounting.

`experiments.started_at` / `ended_at` are stamped by the run itself, through
`POST /api/v1/experiments/{id}/report`. They are left null until a run reports; deriving
them from job timestamps would be a guess presented as a record, because a container
starting is not training starting — image pull, dataset download and framework init sit
in between. The same call records what the run *observed* (framework, hardware, SDK
version) alongside what it was *asked for* (dataset version, hyperparameters, seed);
spec §34 needs both halves.

## 10. Storage split

- **PostgreSQL** — metadata, state, events, audit. Small rows.
- **MinIO / S3** — checkpoints, model binaries, evaluation outputs. Large blobs.

Blobs never go in Postgres (spec §19). The `artifacts` table stores a URI and a digest.

Because the row and the bytes cannot be written in one transaction, artifacts carry a
status: a run registers what it is about to write (`PENDING`), uploads, then confirms
with the digest and size it computed (`READY`). Only `READY` means the bytes exist, and
nothing may resume from, register, or serve an artifact in any other status. An
abandoned upload is marked `FAILED` and kept, so the gap stays visible rather than
looking like it was never attempted.

Marking it is the SDK's job when an upload *errors*, and a background reaper's when the
pod does not survive to say so. The reaper's window has to be longer than the run-token
grace, because a successful run confirms its final checkpoint after the pod has exited —
so the two settings that look unrelated are coupled, and the server refuses to start with
them the wrong way round. It settles the record and never deletes the object: a reaped
row is inspectable, a file deleted on a timer is not, and the file in question is the one
nobody has managed to look at yet.

Uploads are **presigned**: registration returns a PUT URL and the pod writes straight to
the bucket. Blobs never traverse the control plane, so the API's memory limit is not in
the path of every model size.

Completion is **verified against the store** — AshML issues a HEAD and refuses an object
that is not there or whose size disagrees with what the run claimed. Storage sits behind
a seam (`src/storage/store.js`) in the same shape as the GPU provider and the execution
backend, with `s3` (real: MinIO locally, S3 unchanged in a cluster) and `none`. `none` is
not a simulation: it is a control plane with no bucket, where artifacts may still be
registered against a URI the caller supplies and completion is recorded as
`verified: false` rather than being allowed to resemble a checked one.

## 11. Observability contract

Every component emits structured JSON logs via `pino`, carrying whichever of
`request_id`, `job_id`, `experiment_id`, `deployment_id`, `node_id` are in scope.
Traces are OpenTelemetry **[planned: Phase 5]**.

Metrics are split by what the number describes (ADR 0009). **Training** metrics — loss,
accuracy, learning rate — are *pushed* by the run to
`POST /api/v1/jobs/{id}/metrics`, because only the training loop knows what step a value
belongs to, and a scraper sampling on a timer records the wrong axis. **Infrastructure**
metrics — GPU utilisation, memory, temperature — are scraped by Prometheus
**[planned: Phase 5]**, which is what Prometheus is for.

The specific question the observability stack must answer: *why is this job slow, and
what is the bottleneck?* If a dashboard cannot contribute to that answer, it is decoration.

## 12. Identity and authorization

Two things call this API, and conflating them is the mistake this section exists to
prevent: **people**, who hold long-lived tokens and belong to projects, and **workloads**,
which hold a credential the platform minted for one pod and revokes when that pod is done.

```
person ──token──▶ api_tokens ──▶ project_members(role) ─┐
                                                        ├──▶ domain/roles.js ──▶ yes / no
pod ────token──▶ workload_tokens(RUN | SERVING) ────────┘
```

`domain/roles.js` is the whole decision, and it is a pure function: principal plus
permission plus scope in, boolean out. No database, no request, no clock. That is not
tidiness — an authorization bug produces *no symptom in a working system*, so the only way
to know it is right is to enumerate it in a test, and nothing that reaches for I/O can be
enumerated.

**Authentication is global; authorization is per route.** A hook resolves the caller on
every request; the route declares what it takes to call it. The declaration is checked
when the route is *registered*, so an endpoint that declares nothing makes the process
fail to start. The alternative — open until protected — fails silently and in the
dangerous direction each time a route is added.

**A run may write only what it observed, and nobody else may write it at all.** Metric and
artifact ingest carry `RUN_REPORT`, which no person holds, not even a platform
administrator. This follows from ADR 0009: the record is worth something because the pod
reported what it measured, and an endpoint a human can post to is an endpoint where the
number might have been chosen instead.

**Quotas belong to the platform, not the project.** A limit its subject can raise is not a
limit, so `PLATFORM_ADMIN` — not `OWNER` — changes a quota and reads cluster inventory.

**How often a caller may call is decided before we know who they are.** Two token buckets:
a generous one keyed by identity for requests that authenticated, and a tight one keyed by
source address for requests that did not. The second is the one with a reason to exist —
checking a token means hashing it and querying PostgreSQL, so it is peeked at in a hook
installed *ahead of* authentication and charged only once a 401 has happened. Probes and
`/metrics` are exempt, because a limiter that throttles them converts an overload into the
outage it was there to prevent. ADR 0014 has the numbers and why they are what they are.

**Refusals are recorded where they are decided, not where they are sent.** `job_events`
covers what the platform did; `authz_denials` covers what it declined to do. The
distinction is forced by the 404-not-403 rule above: on exactly the refusals an audit
exists to surface, the API answers "not found" on purpose, so a hook reading status codes
would file an outsider enumerating project names as a series of typos. Each row carries
the refusal *and* what the caller was told, and lets the two disagree. Denials are
buffered and batched — an INSERT on a path whose rate the caller chooses is the same
hazard the rate limiter above addresses — and overflow is dropped with a counter rather
than queued. ADR 0015.

**Not built:** no identity provider, no Kubernetes RBAC or per-project service accounts.
AshML's own service account creates every workload, so a project's pods are isolated by
AshML's admission checks and not by the cluster's. Rate limiting counts in one process, so
two API replicas are two budgets, and the audit trail records refusals rather than
successful privileged actions. ADR 0013 has the reasoning and the full list.
