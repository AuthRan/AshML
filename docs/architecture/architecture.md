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
```

## 3. Component boundaries

| Component | Owns | Must not |
|---|---|---|
| `ashml-server` | API surface, domain validation, state transitions, events | Talk to Kubernetes directly |
| `ashml-scheduler` | Placement decisions, resource accounting, quota enforcement | Own the API or mutate domain objects outside job state |
| `GpuProvider` | Device discovery and telemetry | Know about Kubernetes or jobs |
| Python SDK | Reporting metrics, checkpoints, artifacts | Read the database or call Kubernetes |
| CLI | Rendering, auth token handling | Contain business logic |

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

## 7. State model

Job state lives in Postgres, never only in memory (spec §9). `packages/server/src/domain` owns the
legal transition table; any transition not in that table is rejected and returns an
error. Terminal states (`SUCCEEDED`, `CANCELLED`) accept no outgoing edges. `FAILED` is
deliberately *not* terminal — the retry path `FAILED → RETRYING → QUEUED` depends on it.

The scheduler and the Kubernetes status-sync loop both drive transitions, so the
transition table is the only thing preventing two writers from corrupting state. It is
unit-tested exhaustively.

## 8. Reproducibility model

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

`experiments.started_at` / `ended_at` are stamped by the training SDK **[planned:
Phase 4]**. They are left null until something real can set them; deriving them from job
timestamps would be a guess presented as a record.

## 9. Storage split

- **PostgreSQL** — metadata, state, events, audit. Small rows.
- **MinIO / S3** — checkpoints, model binaries, evaluation outputs. Large blobs.

Blobs never go in Postgres (spec §19). The `artifacts` table stores a URI and a digest.

## 10. Observability contract

Every component emits structured JSON logs via `pino`, carrying whichever of
`request_id`, `job_id`, `experiment_id`, `deployment_id`, `node_id` are in scope.
Metrics are Prometheus; traces are OpenTelemetry. **[planned: Phase 5]**

The specific question the observability stack must answer: *why is this job slow, and
what is the bottleneck?* If a dashboard cannot contribute to that answer, it is decoration.
