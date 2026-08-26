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
- Repository, npm workspaces, ~~CI skeleton, lint config~~ — **these two were listed here
  and never existed.** Found while auditing what was left at the end of v1; there was no
  `.github/` at all and no lint config of any kind, so for five phases `npm test` was run
  by whoever remembered to. Both are in now — `.github/workflows/ci.yml` and
  `eslint.config.js` — and they are recorded here as arriving late rather than quietly
  ticked off, because a plan that marks undone work as done is worse than one that leaves
  it open. CI later grew a second job that stands up a real k3d cluster and runs
  `make e2e` on it, so the Phase 2 exit criterion below is machine-verified rather than
  verified when somebody remembers
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
- ~~**Garbage collection.** A PENDING artifact whose run died leaves a row and possibly a
  partial object. Nothing sweeps them yet.~~ **Half-closed.** A reaper now settles the
  *record*: an artifact still PENDING once its job has been terminal for longer than the
  reap window, or PENDING past a hard maximum, becomes FAILED with a reason naming which
  rule fired. It asks the store first and says which of the two things happened, because
  they are not the same fact — "nothing was ever stored" is a run that failed to write,
  and "bytes are stored that no run ever confirmed" is a file that might be a perfectly
  good checkpoint whose confirming call was lost.

  The window is the part worth stating. It has to be **longer than
  `ASHML_RUN_TOKEN_GRACE`**, because a successful run confirms its final checkpoint after
  the pod has exited — that grace window exists for exactly that — so a reaper that swept
  first would mark the final model of every run that worked FAILED. The two settings look
  unrelated; the server refuses to start with them the wrong way round rather than leaving
  it to be discovered days later.

  **The object is still not deleted**, which is the half that stays open. Reaping a record
  is safe and inspectable; deleting bytes on a timer is neither, and the bytes it would
  delete are the ones nobody has been able to look at yet.
  `ashml_artifacts_reaped_total{outcome="orphaned_bytes"}` counts them so a person can
  decide.
- **Authentication on the ingest path.** ~~The API takes writes from inside the cluster
  and is unauthenticated, like the rest of v1 (auth is Phase 10).~~ **Closed in Phase 10.**
  A training attempt now carries a run token scoped to that job and that attempt, so the
  metric and artifact endpoints accept writes only from the run that produced them — and
  not from a person at all. The two mitigations recorded here were real and are still in
  place: the experiment id is copied from the job server-side rather than taken from the
  request, and metrics are refused for a job that has not launched. Neither substituted
  for auth, which is why it was written down rather than left implied.

---

## Phase 5 — Serve, Observe, Recover *(complete)*

Spec milestones 8, 9, 10.

- ~~`ash model deploy` → inference Deployment + Service, health/readiness probes~~ **done**
- ~~`ash predict` → the §50 journey's step 7, answered by a real pod~~ **done**
- ~~Model router (own Fastify service) with weighted version routing~~ **done** —
  `packages/router/`, [ADR 0011](adr/0011-a-router-only-when-there-is-a-choice.md), and
  `make e2e-rollout`, which measures the split against real pods
- ~~Prometheus + Grafana~~ **done** — `deploy/observability/`; DCGM-exporter, Loki and
  OTel traces are deferred, see below
- ~~Dashboards: cluster/GPU, job pipeline, training curves, inference latency~~ **done** —
  four dashboards, provisioned from JSON in git
- ~~Failure recovery: retry policy, checkpoint resume~~ **done**; GPU-unhealthy handling
- ~~Chaos scripts: kill training pod, kill inference pod, restart scheduler~~ **done**
- ~~**Benchmarks with measured numbers** (spec §37) — never invented~~ **done** —
  [`docs/benchmarks.md`](benchmarks.md), produced by `scripts/bench.mjs`

**Exit criteria:** the full §50 user journey runs start to finish, including a killed
pod recovering, with real numbers in `docs/benchmarks.md`. **Met** — `make journey`,
below.

### §49's dashboard, and what it is

The spec asks for a web dashboard (§49) and immediately says not to spend months on a
frontend, because "the backend and infrastructure are the project". No phase of this plan
ever scheduled one, which left the question open rather than answered. It is answered in
two halves: **the control plane serves its own dashboard at `/`**, and **Grafana holds the
time series**. Neither duplicates the other — one is what the platform *is*, the other is
what it has been doing.

Checked against §49's own list rather than asserted:

| §49 asks for | where it is |
|---|---|
| Cluster — nodes, GPUs, CPU, RAM | *Cluster & GPU*, including `ashml_gpu_visible` next to `ashml_gpu_schedulable` |
| Jobs — queued, running, completed, failed | *Job pipeline*, by state, plus scheduling latency and the queue's oldest entry |
| Experiments — loss, accuracy, duration | *Training curves*, read from PostgreSQL against the step the run reported (ADR 0010) |
| Models — versions, status | *Models & deployments* — added for this, because the rest were counts |
| Deployments | *Models & deployments*, and status counts on *Inference* |
| Inference — requests, latency, errors | *Inference*, with the forward pass separated from the round trip |

The Models row is the one that was genuinely missing, and it is worth saying why a count
was not enough. Prometheus can export `ashml_model_versions{status="PRODUCTION"}` and does;
what nobody actually asks is *how many* versions are in production, it is **which one, and
were the bytes behind it ever confirmed**. That is a row, not a number, so it comes from
PostgreSQL through the second datasource the training curves already use. The same table
shows `address_resolves_to` beside the traffic split, because during a rollout those two
disagree and the disagreement *is* the switch in progress.

`routes/ui.js` serves one HTML file — no build step, no framework, no new dependency, and
no endpoints of its own. That last part is the rule the CLI already follows (spec §28) and
it is asserted rather than trusted: a test extracts every path the page fetches and injects
a request at each one, failing if any is not a route this API serves. An `/overview`
endpoint built for one page would be a second, quietly different account of the same state,
and this is how it stays impossible to add one by accident.

What is not built, and is not pretended: it is **read-only**. There is no click-through
from a job to its logs and no way to operate anything from a browser — every write stays in
`ash` and the API, where it is logged, attributable and scriptable. A button that promotes a
model version is a thing to design carefully, not to add because a page happened to exist.
The reading half was the half worth having at this size.

### The journey, as run

`make journey` runs §50's nine steps in order, against one project, on the real cluster:
create the project, submit a manifest, watch the scheduler place it, see metrics arrive
from the running pod, register and promote what it produced, deploy it, ask it for
predictions, check that everything the dashboards read is being exported, then kill the
serving pod and a training worker and require both back.

**It drives the CLI rather than the API**, which is the one place in this repo where that
is the right choice. Every other script talks HTTP so that what is under test is the
platform rather than the client; §50 is written entirely in `ash` commands, so here the
question genuinely is whether a person can type them. The commit that fixed
`ash deployment rollout --version 2` printing the client version and exiting 0 is the
argument: every HTTP-level test in this repo was structurally unable to see it.

What one run looks like, and every line of it is measured rather than asserted-into-being:

| step | what it showed |
|---|---|
| 3 | `QUEUED -> STARTING -> RUNNING`, placed on `k3d-ashml-server-0`, and the Pod was on the node AshML chose — asked of the cluster, not of AshML |
| 4 | four series arriving *while the job was still RUNNING*, loss 5.44 at step 10 |
| 5 | 4 checkpoints, a verified model artifact, v1 promoted to PRODUCTION carrying the run's own metrics |
| 7 | 3 of 8 real CIFAR-10 test images correct |
| 8 | 41 series across 4 dashboards, all exported; GPUs visible 2, schedulable 0 |
| 9 | `DEGRADED 0/1` with a reason, then the same artifact back on a new pod; a killed training pod resumed at step 15 from the checkpoint it was offered |

Four decisions in it are worth naming, because each one is a place the script could have
claimed more than it knows.

**Step 3 says "GPU NODE SELECTED" in the spec and the journey says otherwise.** No GPU
reaches a node here (ADR 0008), so the placement was made on CPU and the journey prints
the scheduler's actual reason next to the spec's wording rather than reading the step as
satisfied. It also prints only the states it *observed* — `SCHEDULING` usually falls
between two polls — and asserts that what it saw advanced in the state machine's order,
not that it caught every transition.

**Step 7 prints the score and does not assert it.** The manifest bounds training to
`MAX_STEPS`, so the model is undertrained by construction; a threshold here would be a
threshold tuned until it passed. What is asserted is that the answers are well-formed,
attributed to the deployed version, and came from the artifact the registry names — and
that the pod's own account of what it loaded agrees with AshML's. 3/8 is what this model
is, and the line says so.

**Step 8 reads its list out of the dashboards.** `deploy/observability/dashboards/*.json`
is scanned for every `ashml_*` series it queries, and each one must be exported. A
hand-kept list drifts in the direction that hides the problem: rename a metric, update the
exporter and the list, and the panel still asking for the old name renders "No data"
forever with nobody's test failing. Four instruments that must have *moved* during the
journey are checked separately, because a permanent zero reads as answered rather than as
missing.

**Step 10 is not run and the journey ends by saying so.** Ashcode is post-v1 (Phase 9).
Both operations it would perform exist and are reachable by hand; nothing translates a
sentence into them, and a scripted transcript pretending otherwise is what Rule 5 forbids.

One defect in the journey itself is worth recording, because it is a trap anyone writing
this kind of script walks into. The first version deleted the serving pod without
`--force`, so the pod drained gracefully — staying Ready, and in the Service's endpoints,
for its full termination grace period — while its replacement started. `readyReplicas`
never reached zero, the outage being demonstrated never happened, and the script waited
two minutes for a `DEGRADED` that had been true for no observable instant. A graceful
delete is a rolling replacement; only `--grace-period=0 --force` is a kill.

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

### Asking a deployment a question

Step 7 of the §50 journey is `ash predict`, and until now there was no way to run it: a
deployment's Service is a ClusterIP, which is right for serving and useless from a
laptop. Proving the deployment served correctly meant holding a `kubectl port-forward`
open, which is not a thing to ask of a demo.

`POST /api/v1/projects/:p/deployments/:d/predict` forwards a body to the Service through
the **Kubernetes API server's proxy subresource** — which already proxies to Services and
which this process already holds credentials for, so nothing new is exposed and nothing
new is installed. A NodePort per model would have handed out a different port for every
deployment and made the address depend on which node answered; that still belongs to a
gateway.

**It is not the serving path and must not become one.** Real traffic goes to
`endpoint_url` from inside the cluster: every request routed through here occupies the
event loop that also runs the scheduler, and a control plane being restarted must not
take inference down with it. This is for a human asking a deployment a question.

Three things it does beyond proxying, each because the alternative fails quietly:

- **Every answer says which version produced it.** `served_by` carries the deployment,
  model, version and artifact id. A prediction nobody can attribute to a version is how
  the wrong model serves for a week.
- **`GET …/metadata` asks the pod what it actually loaded**, and compares it against what
  AshML recorded. They agree in every normal case; the point is the case where they do
  not, which otherwise surfaces only as predictions nobody can reproduce.
- **Failures name the right thing.** A malformed batch comes back as the caller's 400
  carrying the model server's own message, a pod with no weights as a 503 carrying what
  AshML last observed *and how long ago* — deployment status is polled, so "READY" means
  "was READY when last asked" — and an unreachable Service as a 502 about the path rather
  than about the pod. The error handler had to learn to stop masking 5xx messages for
  errors constructed to be read; it still masks everything else.

Refusing early on `ready_replicas == 0` was written and then removed. That readiness is
up to a sync interval old, so refusing on it denies a prediction because of a ten-second
old observation — confidently wrong, about a pod that is answering perfectly well. The
cluster is asked instead, and what AshML knows is attached to the failure rather than used
to pre-empt it.

The PNG decoding is in the CLI, not the server. The model server takes pixels because it
owns the normalisation its weights were trained with, and a second implementation of that
transform on the client's side of the wire is a silent accuracy loss no error message
points at. `packages/cli/src/png.js` is a hand-written decoder — `ash` is a tool people
install, and an image library is a lot of native code to carry for one command — which
centre-crops, area-averages to 32x32, and **prints what it did**. Interlaced and sub-8-bit
PNGs are refused by name rather than half-decoded.

Proven against the live k3d deployment: `make cifar-png` writes CIFAR-10 **test** images
with their true labels in the filename, and the ResNet-18 version above gets six of the
first eight right — which is what a 65.59% model looks like, and what a demo scoring 8/8
would be hiding. Measured: ~270 ms in the pod for one image, ~350 ms for eight, and the
API server proxy adds 15-25 ms of that. The per-request floor dominates at this batch
size; the 8.7 ms per image recorded earlier was over a much larger run.

### Routing, as built

`ash deployment rollout resnet-cifar --version 7 --traffic 10` is the spec's worked
sequence, and it does what §21 asks: 10, then 50, then `promote`. What it changes is one
row. The router reads the split from the control plane every few seconds, so a canary step
does not restart the thing measuring the canary.

**A version is a thing with an address.** Each gets its own Deployment and Service, because
a share of traffic can only be given to something that can be reached. The alternative —
one Service and replica counts — makes a 99/1 canary cost a hundred pods and makes
resizing a version silently change the split.

**The deployment's own address never moves.** It is a Service whose *selector* moves: onto
one version's pods when one version is taking traffic, onto the router's when more than one
is. It keeps its `clusterIP` and its DNS name throughout, so nothing holding the address
notices. The one trap is that a merge patch merges maps, which would leave a stale
`ashml.io/model-version` key behind and produce a selector matching nothing — a routine
rollout becoming an outage with no error anywhere. `$patch: replace` is in the request for
that reason alone.

**The address only moves onto something that is ready**, which is what makes a version
change a blue/green rather than a rolling update: v2's pods start alongside v1's, the
address moves when v2 answers, then v1 scales to zero. It costs both versions' capacity for
the length of the switch and it removes the window in which some requests are answered by
one version and some by the other with nothing recording which. For a model, that window is
predictions nobody can attribute.

Two consequences that look like special cases and are the same sentence — *nothing that is
answering is taken away*: the outgoing version keeps its pods while the address still points
at it, and the reaper spares whatever the address currently selects.

**A router exists only while there is something to decide.** `needsRouter` counts the
versions taking traffic, not the targets — written the other way first, which would have
left a router permanently in front of every promoted deployment, because promoting keeps
the previous version at weight 0 as the rollback.

**The router itself** is 300 lines of Fastify that forwards and attributes. Three things
it does beyond forwarding:

- **Every answer says which version produced it**, in `X-AshML-Served-By` and never in the
  body. A client parsing a field the router injected would break the moment the deployment
  dropped back to one version and the router left the path.
- **A version that did not answer is failed over; a version that answered badly is not.**
  One line apart, and the whole value of a canary: a 500 from v7 is the single most
  important thing a canary produces, and serving that request from v6 instead would hide
  exactly the failure the canary was deployed to find.
- **It keeps serving on a stale split when the control plane is gone**, rather than
  emptying its table or failing readiness — which would make a control-plane restart an
  outage for every deployment behind a router. It reports the age of what it is applying
  instead: `age_seconds` on `/-/routing`, `ashml_router_config_age_seconds` in Prometheus.

A version at weight 0 keeps its objects at zero replicas, so a rollback is a weight change
and a scale-up rather than an image pull. `ash deployment retire` removes one for good, and
is refused while it takes traffic or while the address still resolves to it.

### Routing, as run — and the two things a simulated cluster could not have found

All of the above shipped with 68 tests behind it, and none of them had sent a request to a
real address. `make e2e-rollout` does: it trains two versions, deploys one, canaries the
other at 10% and then 50%, promotes, rolls back and retires, sampling the split from live
traffic through the deployment's own Service. In the recorded run a 10% canary took 13.0%
of 400 requests and a 50% split took 52.0%, and the address kept one ClusterIP from the
first deploy to the last retire.

The tolerance is four binomial sigmas computed from the sample size rather than a number
chosen to fit, so raising `ROLLOUT_SAMPLES` tightens the test instead of leaving a band
that passes whatever happens. Each sample asks `/metadata`, so every response carries two
independent accounts of where it went — the router's `X-AshML-Served-By` and the pod's own
statement of which artifact it loaded — and the check is that they agree. A router
attributing requests to the wrong version satisfies either one alone.

Running it found two defects, and the shape of both is the same: everything AshML could
see said `READY`.

**The front Service targeted a port by number, and it has two kinds of backend.** It
selects a model server on `SERVING_PORT` while one version takes traffic and the router on
`ROUTER_PORT` the moment two do — and it named the model server's port in both branches.
So the instant the address moved onto the router, every request through it was refused, by
a router that was running, ready, and listening one port away. Both pods were ready, both
router replicas were passing their probes on the port they were actually serving, the
deployment was `READY` — and the address answered `ECONNREFUSED`. The fix is to target the port by
*name*: both containers declare `http`, a name resolves against whichever pod the selector
found, and the port now follows the selector by construction rather than by anyone
remembering to move it.

**`ash deployment rollout --version 2` printed `0.1.0` and exited 0.** Commander recognises
the program's own options after a subcommand too, so the program's `--version` matched
before the subcommand's. The rollout never happened and the shell saw success — which is
the worst possible failure for a command that scripts wrap. It hit `rollout`, `promote` and
`retire`: every version-shifting command the CLI has, and the exact form written in §21, in
this document and in the README. `enablePositionalOptions()` makes an option belong to the
command it follows; the cost is that `--endpoint` must now precede the subcommand, where
after one it is an error rather than a silent misparse.

That is the argument for this script in one line. The rollout logic was tested from both
ends and was correct; what was broken was the request it made of Kubernetes and the
arguments it accepted from a person, and only running it touches either.

A third, smaller thing came out of the same session: the e2e and chaos scripts all called
bare `kubectl`, which follows `current-context` — a global setting owned by whoever last
ran `kubectl config use-context`. On the development host that was a different cluster
entirely. An e2e run would have asserted against one cluster while driving another, and
`chaos-resume` and `chaos-serving` would have deleted a pod in it. They now share
`scripts/lib/kubectl.mjs`, which reads the same `ASHML_KUBECONFIG_CONTEXT` the control
plane takes, so a script that starts a control plane cannot point the two halves of its own
test at different clusters.

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

The position in the training set is restored too, and it was not always. A resumed epoch
used to run the number of batches it had left, *drawn fresh* — training twice on some
images and never on others. Nothing shows that: the loss curve is smooth, the accuracy is
plausible, and the only consequence is that the run stops being the run its experiment
record describes. It was a caveat on every artifact a resumed attempt produced, which was
honest and was not a fix.

The fix is not to checkpoint the sampler. Each epoch's permutation is **derived** from
`(seed, epoch)` rather than drawn, so epoch 3 has one order on every attempt and on every
machine, and resuming is a matter of slicing that order at the batch the last attempt
reached. Nothing version-specific goes into the checkpoint, there is no separate resume
branch — a fresh epoch is the same code path with an offset of zero — and the property
holds for a run interrupted five times as readily as for one interrupted once.

What makes it checkable rather than asserted is `batch_digest`, a position-weighted
fingerprint of each logged step's batch. Two runs from one seed report the same digest at
the same step whether or not one of them was killed, which is a thing a script can compare
and `make chaos-resume-resnet` now does.

One defect the first chaos run exposed, because it is the kind only a real kill finds. The
first attempt's metrics for steps 0–14 existed nowhere: the SDK batches points, the pod
was SIGKILLed, and the buffer went with it. The checkpoint had preserved the work and
nothing had preserved the record of it — and since the resumed attempt starts *after* the
checkpoint, those points would never be reported by anyone. `log_artifact` now flushes
buffered metrics before uploading, which bounds what an interruption costs the record to
what it costs the training: the work since the last checkpoint. Steps after the checkpoint
may legitimately be reported twice, because they are genuinely trained twice and metrics
are append-only; steps before it must never be.

### What the chaos scripts break, and what has to survive it

Four of them. None drives the code it is testing: each breaks something and then watches,
because a script that calls the recovery path proves the recovery path can be called.

| `make …` | breaks | must survive |
|---|---|---|
| `chaos-resume` | the training pod, mid-run | the retry resumes from the last confirmed checkpoint (10/10) |
| `chaos-resume-resnet` | the same, on ResNet-18 | weights, optimizer, schedule *and* data order restored (11/11) |
| `chaos-serving` | the pod behind a live deployment | DEGRADED reported, then the same model back, to the digit (6/6) |
| `chaos-restart` | the control plane itself, SIGKILL | the pod keeps training; the record comes back identical (6/6) |

`chaos-restart` is the one that checks the claim underneath all the others: **AshML keeps
no state that exists only in its own process** (ADR 0001). Across a 12-second outage the
training pod did not notice, the job came back with the same attempt, the same Kubernetes
Job and the same placement, and the event log gained nothing — no second `STARTING`
written by a control plane re-deriving state from the cluster, which is what would turn
the event log from a history of what happened into a log of what was noticed. The run
finished, having lost 63 metric points to the outage and reported exactly 63, because a
curve with a hole in it looks like a training problem until you know it was a network one.

### Benchmarks, and one that was wrong first

[`docs/benchmarks.md`](benchmarks.md) records API latency, scheduling latency, an
inference batch-size sweep and the ResNet run's own throughput. Every figure names the
command that produces it, and the document leads with the fact that the cluster runs on
the machine being measured — so every hop in it is loopback, and the numbers are a floor
rather than a forecast. There is no GPU figure anywhere in it, because no GPU reaches a
node here and a projected one is precisely what Rule 5 forbids.

Two results are worth pulling out. Inference at batch 64 costs 9.4 ms per image, which
corroborates the 8.7 ms recorded for the 1 000-image serving run above by a different
method — and 120-160 ms of every `ash predict` request is *not* the model, it is the API
server proxy and this control plane, which is the measured form of "this is not the
serving path".

The scheduling benchmark reported a p50 of 178 ms in its first version, and that number
was an artefact: submitting each job the moment the previous one started running
phase-locks every submission to the same point in the poll cycle, so the benchmark
sampled one phase and called it a distribution. Spacing submissions randomly across one
interval gives 1083 ms — half of the 2000 ms poll, which is the number that can be
derived from first principles. The flattering one could not be, and that is the tell.

### The outage nobody scheduled

Docker was reinstalled on this host mid-phase while a model was serving. Everything came
back except MinIO, and a serving pod happened to restart into that window. Most of what
followed was the design working:

- liveness on `/healthz` meant nothing killed the pod — correct, since restarting would
  have reproduced the same failure while the store was down;
- readiness on `/readyz` stayed 503, so the Service kept traffic off it;
- AshML reported `DEGRADED` with 0/1 rather than claiming health.

The outage was contained. It was also **permanent**: the model server loaded once, and
once was all it ever tried, so MinIO returning changed nothing and the pod stayed
not-ready until a human deleted it. Containment without recovery is half the job.

The loader now retries on the same distinction the job retry policy makes — a refused
connection may be accepted in ten seconds, while a 404, an artifact that is not `READY`,
an unknown architecture or a state dict that does not fit are the same answer however
often you ask. Reproduced deliberately with the store stopped: five attempts over 60
seconds, MinIO started, pod ready by itself.

The second finding was AshML's own. It said `DEGRADED` and `last_error: null`, because a
Deployment carries no reason of its own until its progress deadline expires ten minutes
later — so for ten minutes the platform reported an outage with no explanation and sent
the operator to `kubectl`, which is the thing `reasonFromPod` was written to prevent for
jobs and had never been applied to deployments. It now asks the pods when replicas are
short. The reason is carried on `DEGRADED` and withheld on `PROGRESSING`: "has not become
ready yet" is what every cold start looks like, and recording that as an error teaches an
operator to ignore the field on the day it matters.

### Observing it, as built

`/metrics` on the control plane and a Prometheus + Grafana stack in
[`deploy/observability/`](../deploy/observability/) that reads it. `make observability`
applies it; `make grafana` opens it.

**The important decision is that Grafana has two datasources** ([ADR 0010](adr/0010-two-datasources-one-story.md)).
Prometheus scrapes what is infrastructure. The training curves are read from
`training_metrics` in PostgreSQL and plotted against the `step` column the run reported.
That is ADR 0009 made visible rather than a redundancy: a loss belongs to a step, and the
obvious unification — a Prometheus Pushgateway — destroys exactly what the push was
protecting, because it keeps only the most recent value per label set and stamps it with
the scraper's clock. Two steps four milliseconds apart become one sample at the wrong
time. Making the step a label instead is one series per step, forty thousand for one
ResNet epoch, and Prometheus' own documentation names it as the thing not to do.

The stack is plain YAML and the dashboards are `.json` files in git, provisioned with
`allowUiUpdates: false`. No operator: `kube-prometheus-stack` would bring a controller and
about forty pods to run one Prometheus scraping four targets, and would hide the scrape
config — the part worth reading — inside a CRD. A panel that exists only in someone's
browser is a panel nobody else has.

What the dashboards refuse to pretend, in the same spirit as the rest of this phase:

- **`ashml_gpu_visible` (2) sits next to `ashml_gpu_schedulable` (0)** on the cluster
  dashboard. Both are true on this host and either alone is a lie about it (ADR 0008).
- **cAdvisor is scraped and DCGM-exporter is not.** cAdvisor answers something the
  control plane cannot — what a container *used*, against the request the scheduler
  admitted it on. DCGM would export zeroes here, because no device plugin means no GPU
  reaches a node, and an exporter that reports nothing is decoration.
- **Alert rules ship and Alertmanager does not**, which the rules file says in its first
  line. A rule that looks like an alert and reaches nobody is worse than no rule, because
  it gets trusted.

Two defects were found by deploying it rather than by writing it. Four instruments —
`ashml_prediction_*` and `ashml_job_terminations_total` — had been declared in the
exporter and never updated, so they scraped as permanent zeros, which reads as *answered*
rather than as missing. And `host.k3d.internal` had silently stopped resolving inside the
cluster: k3d installs that name in CoreDNS' `NodeHosts`, k3s owns and rewrites that entry
from the node list, and it was dropped when the cluster came back after Docker was
reinstalled. Nothing could scrape the control plane — and, far worse, **no training pod
could reach the endpoint it is handed as `ASHML_ENDPOINT`**: it would run, train, and
report nothing. `make cluster-dns-check` asks a Pod; `make cluster-dns` restores it.

### Deferred within this phase, so far

- **Weighted routing.** `deployment_targets` carries the weight column and a deployment
  holds exactly one target at 100. Two targets are meaningless until the router exists,
  because nothing would decide which one answers.
- **External exposure.** The Service is still a ClusterIP, and `ash predict` reaches it
  through the API server's proxy rather than by exposing anything. That is right for a
  human with a kubeconfig and is not an ingress: callers who are not AshML operators, and
  traffic at any volume, need a gateway.
- **Autoscaling.** Replicas are what was asked for. Scaling on load needs the metrics
  that arrive later in this phase.
- **GPU-unhealthy handling.** The retry classifier has no category for it, because this
  cluster cannot produce one: no device reaches a k3d node (ADR 0008), so a job never
  fails for a reason a GPU could cause. Writing the pattern blind would be a guess about
  a string we have never seen.
- **DCGM-exporter, ~~Loki~~ and OTel traces.** DCGM is covered above: it would export
  zeroes. **Loki is now deployed** — see below. A trace crossing the API, the executor and
  a Pod is still a `traceparent` that has to be threaded through the manifest, and is
  still not claimed.
- **Alertmanager.** Rules exist and page nobody. Where an alert goes and who is on call
  are decisions this cluster cannot answer. Loki's ruler is off for the same reason.

### The logs, which used to last exactly as long as the pod

Closed after v1, and worth stating as a gap that had no symptom until you needed it.

`ash job logs` reads a Pod through the Kubernetes API, which is right for a running job and
carries a property nobody had written down: it answers for exactly as long as the Pod
object exists. A cancellation deletes it, an eviction replaces it, a node reclaim takes it.
So the platform kept a job's *state* forever — every transition with its reason, in
`job_events` — and its *output* for as long as Kubernetes happened to feel like it. For the
runs worth explaining afterwards that is backwards: the failed attempt whose last twenty
lines would say why is the one most likely to have had its pod removed.

Loki and Grafana Alloy now sit beside Prometheus in `deploy/observability`, applied by the
same `make observability`. Every AshML pod has carried `ashml.io/job-id` since Phase 2, so
the archive is queried by the identifier that already reaches the database rows and the
metrics:

    {job_id="6993051b-a577-47cf-ad92-3eaf083b68a6"}

**`ash job logs` is unchanged**, deliberately. It still asks the cluster and still says
plainly when the cluster no longer knows — a fallback to querying Loki would give the
control plane a required dependency on a log store, a client to configure and a new way for
a log request to be slow, in exchange for a fallback path. Grafana is where history is read
(ADR 0010); the API reports what it observed.

Three decisions in it that could each have gone quietly wrong:

- **Alloy rather than Promtail**, because Promtail reached end of life in March 2026.
  Choosing it would have been choosing an unmaintained agent in order to match the
  tutorials.
- **Read through the Kubernetes API rather than off the node's disk.** The usual DaemonSet
  wants a hostPath mount on every node, in a cluster whose whole Phase 10 argument is that
  a workload must not reach the host. The cost is stated rather than hidden: a pod that
  starts and finishes while Alloy is down leaves nothing behind. What it does *not* cost is
  duplication — the source has no positions file and re-reads every pod from the start on
  each restart, and that was measured rather than assumed: three lines before a restart,
  the same pod re-tailed, three lines after, because Loki discards entries identical in
  stream, timestamp and content.
- **Alloy's grant is a Role in `ashml-jobs`, not a ClusterRole.** Reading `pods/log`
  cluster-wide is a standing credential over every line every container has ever printed,
  and a monitoring identity is never rotated by anything.

Demonstrated end to end rather than asserted: a job that exits 3, its output read through
`ash job logs`, the Kubernetes Job deleted, `ash job logs` then answering *"the Pod for this
job no longer exists in the cluster"* — and Loki returning all six lines under the job's own
id. Reasoning in [ADR 0018](adr/0018-logs-that-outlive-the-pod.md).

---

## v1 complete. Everything below is post-v1.

| Phase | Work | Why deferred |
|---|---|---|
| 6 | Kubernetes Operator + TrainingJob CRD | Big; hand-written watch loop (no Kubebuilder in JS), and Phase 2–3 logic must stabilise first |
| 7 | Distributed training (DDP across both 2080 Tis) | Needs a reliable scheduler underneath |
| 8 | AshGPU as a real `GpuProvider` | AshGPU does not exist yet (ADR 0005) |
| 9 | Ashcode integration | Weekend of work once the API is good; not the hard part |
| 10 | Kubernetes RBAC, an identity provider | Auth, project RBAC, rate limiting, the audit trail and per-project network isolation are **done** — see below |

---

## Phase 10 — Authentication and authorization *(partly complete)*

Spec §31 and §32. The API was unauthenticated through v1 and the roadmap said so in three
places; this is the part of Phase 10 that is now built, and the part that is not.

### Built

- **Bearer tokens**, stored as SHA-256 hashes and looked up by hash, never compared. The
  plaintext is returned once, at creation, and nothing can retrieve it again.
- **Default deny.** Every `/api/v1` route must declare the permission it needs, and the
  declaration is checked *when the route is registered* — a route that says nothing makes
  the server fail to start rather than answering to anybody.
- **Three project roles** — VIEWER, EDITOR, OWNER — and a platform-administrator flag.
  The mapping from role to permission is a pure function in `domain/roles.js` with the
  whole cross-product enumerated in its test, because an authorization bug produces no
  symptom in a working system.
- **Project isolation.** Listing is filtered in SQL rather than after the fact, so the
  `LIMIT` applies to rows the caller may see. A project you are not in answers 404, not
  403, so names cannot be enumerated.
- **Workload identity.** A training attempt gets a run token, scoped to that job and that
  attempt and revoked when either ends; a deployment gets a serving token, scoped to
  fetching its own weights and following its own routing table. This closes the ingest
  hole Phase 4 recorded: metrics and artifacts could previously be written for any job by
  anything that could reach the control plane.
- **Quotas moved to platform administration.** A quota a project owner can raise is not a
  quota.
- **Rate limiting**, in two budgets. See below; the short version is that the interesting
  one is the budget for callers who have *not* authenticated.
- **An audit trail of refusals**, written at the decision rather than at the response —
  because the API answers 404 to "you may not see this project" on purpose, so its own
  status codes are an unreliable narrator about authorization. Readable through
  `ash audit denials` and `ash audit summary`.
- **A network boundary per project**, because authorization cannot reach pod-to-pod
  traffic: it never touches the control plane. One NetworkPolicy per project, applied
  before the workload it protects, allowing a project's pods to reach their own project,
  DNS, and everything that is not a pod in this cluster. See below for why it is written
  as egress, which is the half that was not obvious.
- `ash login`, `ash whoami`, `ash token create|list|revoke`, `ash member add|remove|list`.

### Upgrading an existing cluster

Rebuild every image — `make image && make resnet-image && make model-server-image &&
make router-image`. All four talk to the control plane and all four now have to prove who
they are. An older image calls the API anonymously and fails in a way that does not name
the cause: a model server with `HTTP 401 fetching the model`, which looks like a
control-plane fault; a training pod with `ApiError: authentication required` at its first
artifact upload, minutes into an otherwise healthy run.

**The move to a namespace per project needs nothing beyond `npm run migrate up`**, and
that is a property it was designed for rather than one it happened to have. Jobs launched
before the migration have no namespace recorded, which the executor reads as the shared
one — so they are still observed where they actually are, finish there, and are cleaned up
there. Jobs launched after it go to their project's namespace. Nothing has to be drained,
moved or coordinated, and the two coexist for as long as it takes the old runs to end.

What an operator will notice is `kubectl get ns`: one namespace per project that has ever
launched anything, alongside `ashml-jobs`, which stays because it is where the pre-upgrade
workloads live. Nothing reclaims them — there is no delete-project endpoint — so they
accumulate. A cluster that had one namespace will have as many as it has projects.

If the observability stack is deployed, re-apply it — `make observability`. Alloy's grant
was a Role in `ashml-jobs`, which after this change would have covered no new job's pods at
all, and the symptom of missing it is an empty Grafana panel rather than an error. The new
shape is a ClusterRole for pod discovery plus an `ashml-log-reader` Role that AshML creates
in each namespace it creates; the old `ashml-alloy-logs` pair is left behind, inert, and
removed by `make observability-down`.

Do not change `ASHML_K8S_NAMESPACE` during an upgrade. It is now the prefix every
per-project namespace is built from *and* the home of everything launched before the
migration, so changing it makes the old workloads unfindable and renames every future
namespace at the same time.

### The one asymmetry worth stating

**A person cannot report a run's results — not even a platform administrator.** The value
of the record is that the pod reported what it observed (ADR 0009, spec Rule 5), and an
endpoint a human can post to is an endpoint where the number might have been chosen. It
is the only permission nobody can grant themselves.

### Rate limiting, and the half of it that matters

Two token buckets, both per minute, and the split is not between endpoints but between
kinds of caller.

The **identified** budget — 1200 a minute, keyed by *who* is calling rather than by which
credential they used — is a backstop against a runaway loop. Nothing in this repository
should ever meet it: `make bench` makes about six hundred calls in a few seconds and fits
inside it, and it is a bucket rather than a fixed window, so a client that has been quiet
may spend the whole minute at once instead of being throttled to a trickle it never asked
for.

The **anonymous** budget — 600 a minute, per source address — is the one worth building.
Verifying a bearer token means hashing it and asking PostgreSQL, so an API that
authenticates but does not rate limit has *created* a way to make it run a query per
packet, using no credential at all. Every one of those requests was going to be refused;
the database load is the entire payload. So the anonymous budget is peeked at in a hook
installed **before** the authentication hook, and charged in an `onSend` hook after a 401
has actually happened. Both halves are necessary: charging early would count legitimate
traffic, and checking late would pay for the lookup before deciding not to want it.

Its *number* was the part that took thinking about, and the first one chosen was wrong.
Sixty a minute reads as generous for a caller with no credential — one 401 is a typo, a
hundred is somebody working through a list — and it would have been a bug, because every
pod in a k3d cluster reaches the control plane from a single address. That budget is
shared by everything behind a NAT or an ingress, so a limit tuned to "a few failures is
suspicious" hands one misconfigured workload the ability to starve every healthy pod
beside it: precisely the pre-Phase-10 image failure this roadmap already documents, turned
contagious by the thing meant to protect the platform. Ten a second is above any real
failure loop — a crash-looping pod restarts on backoff, the router polls every five
seconds — and three orders of magnitude below a flood. The ceiling is what matters here,
not the number.

Three smaller decisions, each one a place this could have gone quietly wrong:

- **Refusals are not charged.** A blocked caller that keeps knocking would otherwise never
  refill, and a rate limit that a retry loop converts into a permanent ban is not the
  thing anybody configured.
- **`/healthz`, `/readyz` and `/metrics` are exempt.** A throttled liveness probe is a pod
  Kubernetes restarts; throttled metrics blind the monitoring at the moment it is
  describing the overload. In both cases the limiter would turn a load problem into an
  outage — the failure it exists to prevent, arriving by its own hand.
- **A limit of `0` is an error, not "unlimited".** Zero means unlimited for a quota
  (`domain/quota.js`), which is exactly why it cannot mean it here; the message names
  `ASHML_RATE_LIMIT_ENABLED=false` as the way to say what was meant.

What it is not: **the counters live in this process.** Two API replicas are two budgets,
and a caller who can vary their key faster than the bucket map can hold — a botnet, or a
`X-Forwarded-For` header this server was told to trust — evicts their own throttled
entries and escapes with one burst per eviction. The honest fix is a shared counter in
PostgreSQL, which v1 does not have, and `ASHML_TRUST_PROXY` defaults to off so that the
second problem stays a deliberate choice rather than a default.

### The audit trail, and the reason it is not a hook on 403

Job state changes have been audited since Phase 1 (`job_events`) — what the platform
*did*. What it *declined to do* left no trace at all: `api_tokens.last_used_at` recorded
that a credential had been presented, never what it was refused.

The obvious implementation is a hook that records every 403, and it would miss the
refusals that matter most. A caller who asks about a project they are not a member of is
answered **404**, deliberately, so that project names cannot be enumerated
(`resolveProject`). The same is true of a job, an artifact, a deployment — anything
addressed by an opaque id. So the API's own status codes are a deliberately unreliable
narrator about authorization, and an audit built on them would file the probing it exists
to surface under "not found", where nobody would look. The services that refuse therefore
attach a `denial` descriptor to the error at the point of decision, and each row carries
both the refusal and the status the caller was actually given. The two are allowed to
disagree, and `ash audit denials` prints the disagreement in a column headed TOLD.

**Only refusals of a caller the platform could identify.** A 401 has no principal — what
it has is an address and a token prefix, and no ceiling on how many a stranger can
produce. A row per 401 would be an INSERT-per-packet amplifier, which is the failure the
rate limiter in this same phase exists to prevent, handed straight back through its own
audit trail. Unauthenticated refusals are counted in `ashml_auth_failures_total` and
logged instead. An audit row should be worth reading; "somebody unknown presented an
invalid token" is a rate, not a record.

**Buffered, and dropped rather than queued when it cannot keep up.** Writing inline would
put an INSERT on the path of every refusal — a path whose rate the caller chooses — so
denials go into a bounded buffer that flushes in batches and never blocks a response. The
buffer is bounded and overflow is *dropped*: an audit that grows without limit under load
is a memory leak that fires exactly when the platform is already in trouble, and the
honest failure is a gap in the record with `ashml_audit_dropped_total` saying how large it
is. A failed write loses its batch for the same reason — re-queueing would turn a database
that is down into a buffer that never drains.

**No foreign keys**, which is the one thing in the schema that looks like an oversight and
is not. Every other id in this database cascades or nulls when its subject is deleted; an
audit row that a DELETE can erase or anonymise is not an audit row. The subject is copied
in as text at the time, so the record still reads after the account it names has gone.

### What a pod may do in the cluster

A user submits an image. That image then runs on the platform's cluster, so what it may
do once it is running is the platform's question to answer — spec §31's "do not allow
arbitrary users to submit unrestricted Kubernetes resources".

Most of that answer turned out to be already true, by construction rather than by a
filter. `k8s/manifest.js` assembles a container field by field from an allowlist — image,
pull policy, command, args, env, resources — so a job spec has no path to `privileged`,
`hostNetwork` or a `hostPath` mount at all. There is nothing to strip, because nothing is
copied. There is now a test asserting that, so changing the builder to a merge fails
loudly rather than quietly opening it.

What was missing was everything a Pod gets *by default*, and one of those was worth
finding. **Kubernetes mounts a credential for its own API into every Pod unless told not
to**, and every AshML training pod had one at
`/var/run/secrets/kubernetes.io/serviceaccount` — checked on the development cluster, not
assumed — which no line of the training path has ever read. In a default k3s install the
`default` service account is granted nothing, so what that credential could do was small.
What makes it worth removing is the other half of that sentence: "granted nothing" is a
property of the cluster *today*, and one future RoleBinding to `default` hands whatever it
gains to every training pod in the namespace at once. Training pods, model servers and
routers now all set `automountServiceAccountToken: false`, along with
`allowPrivilegeEscalation: false`, `capabilities: drop: [ALL]` and the runtime's own
seccomp profile.

The half that AshML cannot provide itself is the namespace label. `ensureNamespace` now
applies `pod-security.kubernetes.io/enforce=baseline`, so the cluster refuses a privileged
or host-networked pod in that namespace whoever submits it — verified by asking the
cluster to admit one:

    Error from server (Forbidden): pods "psa-probe" is forbidden: violates PodSecurity
    "baseline:latest": host namespaces (hostNetwork=true), privileged (container
    "psa-probe" must not set securityContext.privileged=true)

`enforce=baseline` and not `restricted`, and the gap between them is exactly one
requirement: `restricted` demands `runAsNonRoot`, which refuses any image that does not
declare a `USER` — including `busybox`, the image this platform's own end-to-end test
runs. Turning it on would convert a security default into "your job does not start", for
images their authors had every right to build that way. Everything *else* `restricted`
asks for is already satisfied by the manifests above, so this is a one-word change the day
every image in use declares a user; the namespace carries `audit=restricted` in the
meantime so a cluster with audit logging records what it would have refused.

Reasoning in [ADR 0016](adr/0016-the-clusters-own-admission-not-only-ashmls.md).

`ensureNamespace` also had to start patching rather than returning early when the
namespace exists. Applying admission labels only on *creation* would mean every cluster
that had already run AshML — which is every cluster that matters — was the one cluster
that never got them.

### One project cannot reach another's

Everything above governs what a pod *is*. It says nothing about who a pod may reach, and
the answer used to be everyone. Projects share a namespace, so a training pod in one
project could open a socket to a model server in another — measured on the development
cluster before it was fixed, first try, no obstacle. Authorization cannot close that,
because none of the traffic touches the control plane: it is one pod dialling another pod's
address, and the cluster is the only thing in the system able to refuse it.

Each project now gets one NetworkPolicy, applied before the first workload that needs it
and re-applied on every launch and every deployment apply. A project's pods may reach
their own project on any port, DNS, and everything that is not a pod in this cluster —
the control plane on the host, the artifact store, a dataset on the internet. A training
job is user code that is *meant* to be able to fetch things; this is a boundary between
projects, not a firewall around user code.

**It is written as egress, and the reason is the most useful thing in this section.**
"Accept connections only from my own project" is the same rule read from the other end,
and it is what comes to mind first. It also refuses every source that is not a pod — the
kubelet's readiness probes, and the API server's `/proxy`, which is how `callService`
reaches a model server for `ash predict`. Allowing "everything outside the pod network"
back in looks like the fix, and on a one-node cluster it behaves like it. On two nodes it
does not: with k3s and flannel, the API server's traffic to a pod on the *other* node
arrives from that node's flannel address, which is inside the pod CIDR and therefore
inside the very exception that keeps other projects out. Asked of the cluster:

    Error from server (ServiceUnavailable): error trying to reach service:
    proxy error from 127.0.0.1:6443 while dialing 10.42.1.78:8080, code 502

with the identical call to a pod on the API server's own node returning its page. That is
a policy which passes on the development cluster and breaks serving in production
depending on where a pod landed. Egress has none of it: it constrains the pod the platform
is least sure about at the point where it *initiates*, and leaves every inbound platform
path alone. Because every AshML pod carries `ashml.io/project` and every project gets a
policy, denying each project's egress to the others denies the traffic in both directions
— there is no pod left that is allowed to start the conversation.

Three smaller things, each a place this could have been quietly wrong:

- **A ClusterIP is not in the allow list, and does not need to be.** Traffic to a Service
  is translated to a pod address before the policy is evaluated, so another project's
  Service is refused exactly as its pod address is. Verified rather than assumed, because
  it depends on the CNI evaluating after DNAT and would be a hole if it did not.
- **The pod CIDR is the one setting that can be wrong in silence.** Too narrow a value
  does not fail; the pods it misses are read as "outside the cluster", which is the branch
  that *permits*, so isolation is simply absent for those nodes and nothing says so. The
  control plane compares `ASHML_CLUSTER_POD_CIDR` with every node's `spec.podCIDR` at
  startup and names the node when they disagree — a warning and not a refusal to start,
  since the policy still binds every node that is covered.
- **A failure to apply the policy fails the launch.** The alternative is a pod that runs
  for a few seconds with no boundary, and nothing observes that window or reports it
  afterwards. The quieter outcome is the wrong one.

What this cannot do is enforce itself. A NetworkPolicy is an object every cluster accepts
and only some clusters implement; k3s ships kube-router's controller and enforces it, and
a cluster whose CNI ignores policies will store this one, list it back, and route the
traffic anyway. So `make e2e-isolation` asserts nothing about the manifest: it stands up
two projects' pods on the real cluster and runs `wget` inside them, and every refusal is
paired with the same address answering a pod in the project that owns it — "alpha cannot
reach beta" proves nothing without "beta can, right now". It needs only `busybox`, so it
runs in CI beside `make e2e`.

Reasoning in [ADR 0017](adr/0017-egress-is-the-side-that-can-be-enforced.md).

### Not built

- **No identity provider.** No OIDC, no SSO, no passwords. Tokens are issued out of band
  and `ash login` stores one. Fine for a handful of users; the first thing to replace
  beyond that.
- ~~**No Kubernetes RBAC, and no per-project service accounts.**~~ — **closed, in four
  parts, and the entry is kept rather than deleted because the order it closed in is the
  useful part.** As written it said: Spec §31 lists both; AshML's own service account
  creates every workload, so a project's pods are isolated by AshML's admission checks and
  not by the cluster's, and a compromised training image is contained by the namespace,
  not by the project.

  **Two parts of this closed first; the per-project part did not.** See *What a pod may do in
  the cluster*, below. The workload namespace now carries Kubernetes' own Pod Security
  Admission labels, so `privileged`, `hostNetwork`, `hostPath` and the rest are refused by
  the *cluster* rather than merely never emitted by AshML — which is the difference
  between "AshML checks AshML" and a rule that also binds anything else with write access
  to that namespace. And no AshML pod mounts a Kubernetes API credential any more; they
  all did, and none of them ever read it.

  **The third part closed too, and by the cheaper of the two routes.** A training pod in
  one project could open a socket to a model server in another; it now cannot, and the
  cluster is what refuses it (*One project cannot reach another's*, below).

  ~~What is still true is the narrower sentence: every project's pods share one namespace
  and one service account, so the isolation is between projects and not between a project
  and the platform.~~ **That closed too, and it was the last of the four.** Each project's
  workloads now run in a namespace of its own — `ashml-jobs-<name>-<id8>` — carrying the
  same Pod Security Admission labels the shared one does, and Kubernetes puts a `default`
  ServiceAccount in each, so the per-project service account needed no building. A run's
  Secret is no longer readable by another project's pods, which one namespace and one
  `get secrets` had made it. ADR 0019.

  No RBAC Role came with it, deliberately. Nothing AshML runs reads the Kubernetes API and
  nothing mounts a credential to do it with, so the right permission set is the empty one
  it already has; an empty Role added to be able to write the word "RBAC" would describe
  the platform less accurately than its absence does.

  The NetworkPolicy is kept rather than retired. A namespace scopes *names*, not routes —
  nothing about being in one namespace stops a pod dialling a pod IP in another — so the
  policy is still the half that refuses the packet, and `make e2e-isolation` checks the
  two halves separately, because either alone would leave a false claim in the README.

  **What replaces the sentence is smaller.** Namespaces are never reclaimed: there is no
  delete-project endpoint, so empty namespaces accumulate one per project, forever. And
  the control plane still holds credentials that can write to every one of them — this
  separates projects from each other and from the platform's namespace, not from the
  platform's reach.
- ~~**The training run token is visible in the Job's pod spec**~~ — **closed.** It reaches
  the container through a `secretKeyRef` now, like the serving token, so reading it takes
  `get secrets` rather than `get jobs`. Those are not the same grant: `get jobs` is what an
  operator hands out so a colleague can watch their runs. The Secret is named for the
  attempt, so a retry writes its own rather than overwriting one a pod is still shutting
  down around, and every attempt's is deleted by label when the job reaches a terminal
  state — the object stops existing at about the moment its contents stop working.

  What remains is that anyone who can `exec` into the pod reads it out of the environment,
  which no arrangement of Kubernetes objects prevents. The correction to ADR 0013 is
  recorded there rather than quietly applied.
- ~~**No token rotation policy.**~~ **Half closed, and the half that was missing.** Tokens
  could be given an expiry and nothing required one, so the default token — every token a
  script mints — lived forever. `ASHML_TOKEN_MAX_TTL_DAYS` is now both a ceiling *and* the
  default, so there is no way to mint a personal token with no end; ninety days, and
  `none` is how to say there should be no limit. A request over the ceiling is refused
  rather than quietly shortened, because a caller given ninety days when they asked for a
  year plans around a year and learns otherwise from a 401 in a pipeline that has worked
  for three months. `scripts/issue-token.mjs` obeys the same ceiling — it writes straight
  to the table and issues the *first* token on every cluster, so exempting it would have
  left the platform's longest-lived credential outside the platform's own policy.

  Tokens that already exist are untouched: this governs minting, and revoking working
  credentials as a side effect of editing a config file is how a security setting gets
  turned off.

  **What is still not built is rotation itself.** Nothing replaces a token before it dies.
  That is `ash token create` followed by `ash token revoke`, and it stays a decision a
  person makes; what the policy guarantees is that the decision cannot be postponed
  indefinitely.

### The scheduler race this phase also fixed

Not authentication, but found while reading the same code. `ADR 0004` said the queue's
`SKIP LOCKED` "safely supports multiple scheduler replicas". That was true of claiming a
job and not of scheduling it: two passes on *different* jobs both read an unlocked
aggregate of cluster capacity, and under READ COMMITTED neither sees the other's
uncommitted binding, so both could promise the same GPU. Reproducible, and reproduced in
`scheduler.integration.test.js`. Fixed with a transaction-scoped advisory lock — ADR 0012.

---

## Known limitations to state honestly in the README

1. **Single node.** Two RTX 2080 Tis in one machine. Multi-node scheduling and node-failure
   recovery are demonstrated on simulated k3d nodes and labelled as such.
2. **11 GB per GPU.** Workloads are sized to fit. This is a platform project, not a
   frontier-model project (spec §35).
3. **AshGPU is not integrated in v1.** The provider interface exists; the implementation
   does not. Do not claim it until it runs.
