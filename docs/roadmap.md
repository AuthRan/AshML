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

## Phase 0 — Foundation *(current)*

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

## Phase 1 — Control Plane *(weeks 1–3)*

Spec milestone 1.

- PostgreSQL wired up (`pg` driver + hand-written SQL), `node-pg-migrate` runner
- Domain CRUD: Project, Dataset, Experiment, TrainingJob
- Job state transitions **persisted**, with an append-only `job_events` table
- Job queue in Postgres (`FOR UPDATE SKIP LOCKED`) — no Redis (ADR 0004)
- CLI: `ash project`, `ash job submit|list|get|cancel`
- Structured JSON logging (`pino`) with `request_id` / `job_id` correlation

**Exit criteria:** submit a job from the CLI, watch it move `CREATED → QUEUED`,
cancel it, and read the full event history back. Nothing executes yet.

---

## Phase 2 — Kubernetes Execution *(weeks 4–6)*

Spec milestone 2.

- k3d local cluster, reproducible via `make cluster`
- `@kubernetes/client-node` integration; TrainingJob → Kubernetes Job → Pod
- Status synchronisation loop: Pod phase → AshML job state
- Log streaming (`ash job logs`)
- Container images for training workloads

**Exit criteria:** `ash job submit` runs a real container in k3d and the job reaches
`SUCCEEDED` through observed Pod status, not a timer.

---

## Phase 3 — Scheduler + GPU *(weeks 7–8)*

Spec milestones 3 and 4. **This is the differentiator — do not let it slip.**

- Scheduler loop: claim queued jobs, evaluate placement, bind to node
- Stage 1 FIFO → Stage 2 priority → Stage 3 resource-aware (CPU/RAM/GPU count/GPU memory)
- Resource accounting and per-project quotas, enforced before admission
- GPU discovery through `GpuProvider`; devices persisted in `gpu_devices`
- NVIDIA device plugin in k3d so Pods can request `nvidia.com/gpu`
- **Scheduling decisions recorded** — why each node was chosen or rejected

**Exit criteria:** submit 10 jobs requesting 1–2 GPUs against a 2-GPU node; jobs
queue correctly, run two at a time, and `ash job get` explains the placement.

---

## Phase 4 — ML Lifecycle *(weeks 9–10)*

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
