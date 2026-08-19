# AshML v1 Roadmap — Phased Build

**Target:** a demoable, honest v1 in ~12 weeks. Each phase ends in something you can
run end-to-end and record. Nothing moves to the next phase until the current one is
reliable, tested, and documented.

The long-term milestones in `About_Project.txt` (§51) are not abandoned — they are
resequenced so the *differentiating* work (GPU-aware scheduling) lands early instead
of at month nine.

## Guiding rule for every phase

> Ship the thinnest slice that is genuinely real. A simulated component is fine only
> if it is behind an interface, named `sim`, and off by default. (Spec Rule 5.)

---

## Phase 0 — Foundation *(complete)*

**Deliverables**
- Repository, npm workspaces, CI skeleton, lint config
- Architecture document and ADRs 0001–0006
- PostgreSQL schema (`db/migrations/0001_init.sql`)
- OpenAPI v1 specification (`api/openapi.yaml`)
- Job state machine, implemented and unit-tested
- `GpuProvider` contract with a **real** NVIDIA implementation + a `sim` implementation
- `ashml-server` serving `/healthz`, `/api/v1/version`, `/api/v1/gpus`
- `ash gpu list` returning real data from the two RTX 2080 Tis

**Exit criteria:** `npm test` passes; `ash gpu list` prints real GPU telemetry.

No database, no Kubernetes, no scheduler yet.

---

## Phase 1 — Control Plane *(complete)*

Spec milestone 1.

- PostgreSQL wired up (`pg` driver + hand-written SQL), `node-pg-migrate` runner
- Domain CRUD: Project, Dataset, Experiment, TrainingJob
- Dataset versions are immutable, and experiments pin one by id — the reproducibility
  guarantee the whole of Phase 4 rests on (spec §34)
- Job state transitions **persisted**, with an append-only `job_events` table
- Job queue in Postgres (`FOR UPDATE SKIP LOCKED`) — no Redis (ADR 0004)
- CLI: `ash project`, `ash dataset`, `ash experiment`, `ash job submit|list|get|cancel`
- Structured JSON logging (`pino`) with `request_id` / `job_id` correlation

**Exit criteria:** submit a job from the CLI, watch it move `CREATED → QUEUED`,
cancel it, and read the full event history back. Nothing executes yet. **Met** —
covered by the integration suites, which run against a real PostgreSQL.

Deferred out of this phase: nothing sets `experiments.started_at` / `ended_at` yet.
Those are stamped by the training SDK in Phase 4, when there is a run to stamp them
from — inventing them from job timestamps now would be a guess dressed as a record.

---

## Phase 2 — Kubernetes Execution *(complete)*

Spec milestone 2.

- k3d local cluster, reproducible via `make cluster`
- `@kubernetes/client-node` integration; TrainingJob → Kubernetes Job → Pod
- Status synchronisation loop: Pod phase → AshML job state
- Log streaming (`ash job logs`)
- Container images for training workloads

**Exit criteria:** `ash job submit` runs a real container in k3d and the job reaches
`SUCCEEDED` through observed Pod status, not a timer. **Met** — `make e2e` asserts it
against a real cluster, and cross-checks every claim with `kubectl` so a passing run
cannot be produced by the control plane merely believing itself.

The execution backend sits behind a seam (`src/k8s/backend.js`) in the same shape as the
GPU provider, with a `sim` implementation for tests and for running the control plane
without a cluster. As everywhere else, `sim` is opt-in and labels its output as
fabricated (spec Rule 5).

The status loop **polls rather than watches** — see ADR 0007 for why, and for what that
costs. A watch belongs with the operator in Phase 6.

Deferred out of this phase:

- **Retries.** `max_retries` is stored and `FAILED → RETRYING → QUEUED` exists in the
  state machine, but nothing drives it yet. Retry policy belongs with the failure
  handling in Phase 5, where there is a checkpoint to resume from — retrying from step
  zero would burn a GPU to produce the same failure.
- **Placement.** `scheduled_node_id` is still null: choosing a node is Phase 3's job.
  Kubernetes currently places the Pod, and the node it chose is recorded on the job
  event rather than invented into the placement column.
- **GPU scheduling.** Jobs requesting `nvidia.com/gpu` produce a correct manifest, but
  k3d has no device plugin installed yet, so such a Pod stays Pending. That is Phase 3.

---

## Phase 3 — Scheduler + GPU *(complete, with one deferral)*

Spec milestones 3 and 4. **This is the differentiator — do not let it slip.**

- Scheduler loop: claim queued jobs, evaluate placement, bind to node
- Stage 1 FIFO → Stage 2 priority → Stage 3 resource-aware (CPU/RAM/GPU count/GPU memory)
- Resource accounting and per-project quotas, enforced before admission
- GPU discovery through `GpuProvider`; devices persisted in `gpu_devices`
- ~~NVIDIA device plugin in k3d so Pods can request `nvidia.com/gpu`~~ **blocked, see below**
- **Scheduling decisions recorded** — why each node was chosen or rejected

**Exit criteria:** submit more jobs than fit; they queue correctly, run only as many at
a time as capacity allows, and the platform explains every placement. **Met** —
`make e2e-scheduler` asserts it against a real k3d cluster, checking with `kubectl` that
each Pod actually landed on the node AshML chose.

Placement is a pure function (`domain/placement.js`), as is quota admission
(`domain/quota.js`). Both are exhaustively unit-tested, because a scheduler that refuses
a job for the *wrong* reason is worse than one that refuses it for none — it sends the
user to fix the wrong thing. Policy is best-fit: GPU jobs are packed rather than spread
(two nodes with one free GPU each cannot run a two-GPU job), and CPU-only jobs are kept
off GPU nodes.

### The GPU deferral, stated plainly

The exit criterion was written in terms of GPUs. This host has two real RTX 2080 Tis,
but Docker here has no `nvidia` container runtime, and installing the NVIDIA container
toolkit requires root, which is not available. So no GPU can be passed into a k3d node,
the cluster advertises `nvidia.com/gpu: 0`, and **no GPU job can run on this cluster
today**.

What was done instead of faking it:

- The end-to-end proof constrains on **CPU**, which is real capacity on this cluster and
  exercises the identical scheduler path — accounting, admission, requeue, decision
  record, and node binding.
- The GPU-specific arithmetic (count, per-device memory matching, health) is covered by
  unit tests and against a precisely-sized fake cluster in `scheduler.integration.test.js`.
- A GPU job on this cluster is **queued with an explanation**, and `make e2e-scheduler`
  asserts exactly that. The e2e also asserts the opposite branch, so the day a device
  plugin is installed the same check verifies the job runs.

Installing the device plugin requires no AshML change: the advertised capacity appears
and placement starts using it (ADR 0008).

### Also deferred

- **Preemption.** A high-priority job does not evict a running low-priority one; it
  waits. Eviction without checkpointing throws away work, so this belongs after Phase 4
  gives runs something to resume from.
- **Multi-node GPU attribution.** `GpuProvider` runs in the server process, so it can
  only describe the machine it runs on. Per-node discovery needs a DaemonSet — Phase 5,
  alongside DCGM.

---

## Phase 4 — ML Lifecycle *(current)*

Spec milestones 6 and 7.

- MinIO artifact storage; checkpoints and final models (metadata in Postgres, blobs in S3)
- Python SDK: training scripts report metrics/checkpoints back to the control plane
- Experiment tracking with full reproducibility capture (git SHA, dataset version,
  hyperparameters, image digest, seed, hardware)
- Model registry: models, versions, lifecycle states
- Real workload: ResNet-18 on CIFAR-10, single GPU

**Exit criteria:** train ResNet on CIFAR-10 through the platform; the run appears as an
experiment with metrics, a stored checkpoint, and a registered model version.

---

## Phase 5 — Serve, Observe, Recover *(weeks 11–12)*

Spec milestones 8, 9, 10.

- `ash model deploy` → inference Deployment + Service, health/readiness probes
- Model router (own Fastify service) with weighted version routing
- Prometheus + Grafana + DCGM-exporter; Loki for logs; OTel traces
- Dashboards: cluster/GPU, job pipeline, training curves, inference latency
- Failure recovery: retry policy, checkpoint resume, GPU-unhealthy handling
- Chaos scripts: kill training pod, kill inference pod, restart scheduler
- **Benchmarks with measured numbers** (spec §37) — never invented

**Exit criteria:** the full §50 user journey runs start to finish, including a killed
pod recovering, with real numbers in `docs/benchmarks.md`.

---

## v1 complete. Everything below is post-v1.

| Phase | Work | Why deferred |
|---|---|---|
| 6 | Kubernetes Operator + TrainingJob CRD | Big; hand-written watch loop (no Kubebuilder in JS), and Phase 2–3 logic must stabilise first |
| 7 | Distributed training (DDP across both 2080 Tis) | Needs a reliable scheduler underneath |
| 8 | AshGPU as a real `GpuProvider` | AshGPU does not exist yet (ADR 0005) |
| 9 | Ashcode integration | Weekend of work once the API is good; not the hard part |
| 10 | Auth, RBAC, rate limiting, audit, hardening | Spec milestone 14 |

---

## Known limitations to state honestly in the README

1. **Single node.** Two RTX 2080 Tis in one machine. Multi-node scheduling and node-failure
   recovery are demonstrated on simulated k3d nodes and labelled as such.
2. **11 GB per GPU.** Workloads are sized to fit. This is a platform project, not a
   frontier-model project (spec §35).
3. **AshGPU is not integrated in v1.** The provider interface exists; the implementation
   does not. Do not claim it until it runs.
