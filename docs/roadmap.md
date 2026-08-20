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

## Phase 4 — ML Lifecycle *(complete)*

Spec milestones 6 and 7.

- ~~Metric ingest: runs report their own numbers; series read back per job and per experiment~~ **done**
- ~~Artifact lifecycle: register before writing, confirm after, so `READY` means the bytes exist~~ **done**
- ~~Experiment tracking with full reproducibility capture (git SHA, dataset version,
  hyperparameters, image digest, seed, hardware)~~ **done** — intent was already captured
  in Phase 1; the observed half (framework, hardware, SDK, run window) lands here
- ~~MinIO artifact storage: presigned uploads, so the run writes bytes AshML can serve back~~ **done**
- ~~Python SDK: the thin client that makes a training script report without ceremony~~ **done** —
  `sdk/python`, zero dependencies, proven end to end from a real pod in k3d
- ~~Model registry: models, versions, lifecycle states~~ **done**
- ~~Real workload: ResNet-18 on CIFAR-10~~ **done** — on CPU, not a GPU; see below

**Exit criteria:** train ResNet on CIFAR-10 through the platform; the run appears as an
experiment with metrics, a stored checkpoint, and a registered model version. **Met** —
job `085cade3`, one full epoch, **65.59% top-1 on the full 10 000-image test set**.

### The run, and what its number is worth

One complete pass over the 50 000 training images — 390 steps at batch 128 — in 790
seconds, evaluated on the entire test set. Not a truncated demo: the workload supports
a `MAX_STEPS` bound and it was not used, so nothing here is an extrapolation from a
partial epoch.

**65.59% is undertrained and should never be quoted as a CIFAR-10 result.** The
literature reaches ~95% with this architecture by training 100–200 epochs; this is one.
The number is here to prove the platform carried a real workload end to end, not to say
anything about ResNet-18. The run states that caveat in its own logs, and
`caveat_metadata` attaches it to every artifact, because a checkpoint outlives the log
that explained it (spec Rule 5).

It trained on **CPU**. The GPU deferral from Phase 3 still holds — no `nvidia` container
runtime, so no device reaches a k3d node (ADR 0008) — and the run reported the hardware
it actually got rather than the hardware the manifest wished for: `pytorch 2.13.0+cpu`,
`gpus: 0`, `cuda: null`, all captured on the experiment.

What was checked rather than believed, in the spirit of the earlier phases:

- **The dataset** is the published CIFAR-10 archive, verified against its sha256 before
  extraction; that same digest is what `cifar10:v1` pins, so the experiment's dataset
  reference is a hash of bytes that were checked.
- **The placement** was AshML's: `kubectl` confirms the pod ran on `k3d-ashml-server-0`,
  the node the scheduler chose and recorded a reason for.
- **The artifacts** were confirmed against object storage — both `READY` and `CHECKED`,
  85.3 MiB resumable checkpoint and 42.7 MiB weights-only model.
- **The accuracy** was reproduced independently. The model artifact was pulled back out
  of MinIO, loaded with `strict=True` into a freshly built architecture, and evaluated
  over all 10 000 test images: 0.6559 accuracy and 0.9687 loss, matching what the run
  reported to the metric API exactly. The registered version is bytes that demonstrably
  produce the accuracy attached to them.

`resnet18-cifar10` **v1** is registered from that verified artifact and promoted to
`PRODUCTION`, carrying the run's metrics with it.

### How a run reports (ADR 0009)

Training metrics are **pushed** by the run, not scraped. Only the training loop knows
what step a value belongs to, and a scraper sampling on a timer records "loss was 1.84 at
14:03:22" — the wrong axis, silently dropping every step between two scrapes. Prometheus
still arrives in Phase 5 and still scrapes; the split is by what the number describes.
Infrastructure metrics (GPU utilisation, memory, temperature) are scraped. Training
metrics are pushed.

The cost is stated plainly in the ADR: a training script cannot be unmodified. AshML sees
nothing from a job that does not opt in.

### What "READY" is worth

Artifact bytes go straight from the training pod to object storage over a presigned PUT;
they never pass through the control plane, because a 2 GB checkpoint proxied through a
Fastify handler would occupy an event loop that has a scheduler to run.

On completion AshML **asks the store** whether the object is there and how big it is. An
upload that never landed is refused, and so is a size that disagrees with what is stored.
A run cannot talk its checkpoint into existence.

Where the store cannot be asked — no bucket configured, or a URI the run brought from
storage AshML knows nothing about — the artifact still completes, but is recorded and
displayed as `verified: false`. The two cases must never look alike, so `ash job
artifacts` prints a CHECKED column and says plainly which is which (spec Rule 5).

### The registry's one promise

A model has **at most one version in PRODUCTION**, and promotion displaces the incumbent
inside the same transaction — never an instant with two, never one with none. That is
what makes "the production model" a question with an answer instead of a tie-break every
consumer has to invent for itself.

Two supporting decisions:

- **A version can only be registered from a READY artifact.** This is what the artifact
  lifecycle was built for. A registry entry pointing at unconfirmed bytes only moves the
  moment of discovery from "the upload failed" to "production cannot load the model".
- **A displaced version goes to STAGING, not ARCHIVED.** It is the most likely rollback
  target, and the person promoting at 3am has not decided to retire it forever. A
  rollback is then just promoting the previous version again.

Registering is deliberately **not** something the SDK does. A training script that could
promote itself to production is the anti-pattern the lifecycle exists to prevent; the run
produces a verified artifact, and a human or CI decides whether it becomes a version and
whether that version serves traffic.

### Deferred within this phase

- **Digest verification.** The size is checked against the store; the digest is the run's
  own and is stored unchecked. Verifying it means reading the object back, which for a
  30 GB checkpoint costs more than it proves — S3's ETag is kept alongside as the store's
  own answer. A `--verify-digest` path belongs with the checkpoint-resume work in Phase 5,
  where something actually loads the bytes.
- **Garbage collection.** A PENDING artifact whose run died leaves a row and possibly a
  partial object. Nothing sweeps them yet.
- **Authentication on the ingest path.** The API takes writes from inside the cluster and
  is unauthenticated, like the rest of v1 (auth is Phase 10). Two things limit the damage
  and both are deliberate: the experiment id is copied from the job server-side rather
  than taken from the request, and metrics are refused for a job that has not launched.
  Neither substitutes for auth.

---

## Phase 5 — Serve, Observe, Recover *(current — weeks 11–12)*

Spec milestones 8, 9, 10.

- ~~`ash model deploy` → inference Deployment + Service, health/readiness probes~~ **done**
- Model router (own Fastify service) with weighted version routing
- Prometheus + Grafana + DCGM-exporter; Loki for logs; OTel traces
- Dashboards: cluster/GPU, job pipeline, training curves, inference latency
- ~~Failure recovery: retry policy, checkpoint resume~~ **done**; GPU-unhealthy handling
- Chaos scripts: ~~kill training pod~~ **done**; kill inference pod, restart scheduler
- **Benchmarks with measured numbers** (spec §37) — never invented

**Exit criteria:** the full §50 user journey runs start to finish, including a killed
pod recovering, with real numbers in `docs/benchmarks.md`.

### Serving, as built

`ash model deploy` turns a registered version into a Kubernetes Deployment and a
ClusterIP Service. Proven end to end: the ResNet-18 version trained in Phase 4 was
deployed to k3d and answered **1 000 real CIFAR-10 test images at 66.0% top-1**, 8.7 ms
per image on CPU — consistent with the 65.59% recorded for that artifact over the full
test set, which is what confirms the served model is the model that was evaluated.

The inference image is generic. It is handed an **artifact id**, not a URL or a baked-in
model, and exchanges it for a time-limited download at startup through the same endpoint
the training SDK uses. A presigned URL in the manifest would expire, and a pod that
restarted six hours later would crash-loop on a dead signature long after anyone
connected the two.

**Readiness is the part that matters.** `/healthz` answers as soon as the process binds;
`/readyz` answers only once the weights are loaded *and* a forward pass has run. The two
are wired to different probes on purpose, and getting it backwards breaks something
specific in each direction:

- readiness on `/healthz` puts a pod with no model into the Service's endpoints, and
  callers get 503s that look like the model's fault;
- liveness on `/readyz` kills a pod that is slowly but successfully downloading a large
  checkpoint — and the restart begins the download again, a crash loop caused entirely
  by the probe.

A startup probe covers the first load so a slow cold start is never mistaken for a hang.

Deployment status is **observed, not assumed**, exactly as job state is. Creating the
objects reports `PROGRESSING`; only the sync loop, reading `readyReplicas` back from the
cluster, may say `READY`. `DEGRADED` is kept distinct from `PROGRESSING` because "was
serving and is now short of replicas" and "has not started serving yet" are different
events, and one word for both hides an outage inside something that sounds like startup.

Four things are refused at deploy time rather than inside a container: a version whose
artifact is not `READY`, an `ARCHIVED` version, an architecture the server has no builder
for, and a deployment name already serving a different model. The architecture is read
from what the **training run recorded** on the artifact, not retyped by the operator —
the run is the only thing that actually knows.

Deploying with no version named serves whatever is in `PRODUCTION`, and fails plainly if
nothing is promoted rather than falling back to the newest. "Latest" and "the one we
chose" are different things, and quietly substituting one for the other is how the wrong
model ends up serving.

### Recovery, as built

A job that dies partway through comes back as a second attempt that starts where the
first one stopped. `make chaos-resume` kills a training pod with `kubectl` and asserts
the whole of it, and `make chaos-resume-resnet` does the same to ResNet-18: killed at
step 13 of 40, resumed from the checkpoint confirmed at step 10, finished, registered a
verified model.

Two decisions shape the rest of it.

**A retry has to be able to change the outcome.** `domain/retry-policy.js` is a pure
classifier of failures that a second attempt could plausibly survive, and it refuses the
ones where trying again is arithmetic rather than hope — an image that will not pull does
not begin to exist because a second pod asked for it, and a container killed for exceeding
its memory request will exceed the same request again. Eviction, a lost node and a
vanished Job are retried, because none of them taught us anything about the code. An
unrecognised reason is retried on purpose: a deterministic bug and a transient fault are
indistinguishable from here, and the operator already expressed a view by setting
`max_retries` above zero. It still defaults to 0, so nothing retries unless asked.
Permanence is checked before the budget, so the message names the real obstacle rather
than sending someone to raise a limit and watch the identical failure.

**The platform offers a checkpoint; it does not impose one.** The retry is handed the
newest `READY` checkpoint as `ASHML_RESUME_FROM` — an artifact *id*, so the download is
signed when the container asks rather than when the manifest was written. Unconfirmed
bytes are never offered. A workload that does not implement resuming ignores the variable
and starts over, which is why this is an addition to the environment rather than a change
to the command.

Taking up the offer is one call, `run.fetch_resume()`, returning a path or `None`. What it
will not do is return `None` when a checkpoint *was* offered and could not be fetched: that
restarts the run from step zero while its logs, its metric steps and its next checkpoint
all say otherwise, and the failure surfaces days later as a curve with a discontinuity
nobody can explain.

The download is where Phase 4's **digest deferral** is closed, in the place that phase
said it belonged. Verifying on upload means reading a 30 GB object back to prove something
about bytes just sent; verifying here costs one hash of a stream already being read, and
this is the moment it matters, because something is about to load it. Size is checked
first so a truncated download blames the right thing, and the bytes are renamed into place
only once verified — a truncated checkpoint that torch is willing to load is worse than no
checkpoint at all.

What a resumed ResNet restores is the model, the optimizer's moments and the
learning-rate schedule. The schedule is the one that hides: restore the first two and not
the third and the run trains, converges and looks entirely healthy while following a
different curve from the one its experiment record claims. So the proof is the learning
rate itself, across the kill —

| step | 0 | 5 | 10 | 15 | 20 | 25 | 30 | 35 |
|---|---|---|---|---|---|---|---|---|
| lr | .0059 | .0588 | .1000 | .0923 | .0717 | .0444 | .0188 | .0028 |

— steps 0 and 5 from the killed attempt, 10 onwards from the resumed one, and one
OneCycle rather than two. A restarted schedule would repeat `.0059` at step 10.

What is **not** restored is the position in the shuffled training set. The resumed epoch
runs the batches it had left, drawn fresh, rather than the exact images the killed attempt
had not reached; replaying those needs the sampler and RNG state checkpointed alongside
the weights. So the run says so, in its own logs and in the caveat metadata attached to
every artifact the resumed attempt produces.

One defect the first chaos run exposed, because it is the kind only a real kill finds. The
first attempt's metrics for steps 0–14 existed nowhere: the SDK batches points, the pod
was SIGKILLed, and the buffer went with it. The checkpoint had preserved the work and
nothing had preserved the record of it — and since the resumed attempt starts *after* the
checkpoint, those points would never be reported by anyone. `log_artifact` now flushes
buffered metrics before uploading, which bounds what an interruption costs the record to
what it costs the training: the work since the last checkpoint. Steps after the checkpoint
may legitimately be reported twice, because they are genuinely trained twice and metrics
are append-only; steps before it must never be.

### Deferred within this phase, so far

- **Weighted routing.** `deployment_targets` carries the weight column and a deployment
  holds exactly one target at 100. Two targets are meaningless until the router exists,
  because nothing would decide which one answers.
- **External exposure.** The Service is a ClusterIP. A NodePort per model would hand out
  a different port for every deployment and make the address depend on which node
  answered; that belongs to a gateway.
- **Autoscaling.** Replicas are what was asked for. Scaling on load needs the metrics
  that arrive later in this phase.
- **Resuming the data order.** Covered above: a resumed epoch redraws its remaining
  batches rather than replaying them. Fixing it means checkpointing the sampler and RNG
  state, which is worth doing when a run is long enough for the difference to matter.
- **GPU-unhealthy handling.** The retry classifier has no category for it, because this
  cluster cannot produce one: no device reaches a k3d node (ADR 0008), so a job never
  fails for a reason a GPU could cause. Writing the pattern blind would be a guess about
  a string we have never seen.

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
