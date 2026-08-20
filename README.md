# AshML

A Kubernetes-native GPU machine learning infrastructure platform — a miniature internal
ML cloud. Register datasets, submit training jobs, schedule them onto GPU resources,
track experiments, version models, deploy inference, and observe all of it.

**Status: Phases 0–4 complete; Phase 5 (serve, observe, recover) in progress — model
serving is done.** Projects, datasets, experiments and training jobs are persisted in
PostgreSQL with an append-only event log and a `SKIP LOCKED` queue. Submitted jobs
**actually run**: AshML's own scheduler decides whether a job may run and on which node,
the executor creates the Kubernetes Job there, and job state is driven from observed Pod
status through to `SUCCEEDED`, `FAILED` or `CANCELLED`.

Overfill the cluster and jobs queue rather than over-committing it; `ash job why <id>`
prints every node the scheduler considered and what was wrong with it.

Running jobs now **report on themselves**: metrics as they train, checkpoints as they
write them, and what the run actually observed itself running on. `ash job metrics <id>`
shows the curve, `ash job artifacts <id>` shows what it produced.

Checkpoints go straight from the training pod to MinIO over a presigned upload, and
AshML **asks the bucket** whether they arrived before marking one usable: an upload that
never landed is refused, and one stored somewhere AshML cannot check is labelled `NO` in
the CHECKED column rather than passing for a verified checkpoint.

A training script reports through the **Python SDK** (`sdk/python`, no dependencies):

```python
import ashml

with ashml.init() as run:                      # identity comes from the container's env
    for step, batch in enumerate(loader):
        run.log_metrics({"loss": train_step(batch)}, step=step)
    run.log_artifact("checkpoints/final.pt", kind="model")
```

`examples/training/sdk_smoke.py` exercises that whole path in the cluster — it trains
nothing and says so, which is the point: it proves the reporting, not a model.

What a run produces can then be registered and promoted, and the registry holds one
promise: **at most one version of a model is in PRODUCTION**, with promotion displacing
the incumbent in the same transaction. A version can only be registered from a `READY`
artifact — the payoff of everything above, since a registry entry pointing at
unconfirmed bytes just moves the discovery from "the upload failed" to "production
cannot load the model".

```bash
ash model create fraud-detector
ash model register fraud-detector --artifact <artifact-id>   # inherits the run's metrics
ash model promote fraud-detector 1
ash model production fraud-detector                          # what is serving, and is it verified
```

### The workload this was built for

ResNet-18 on CIFAR-10 has now run through all of it — scheduled by AshML, executed in
k3d, reporting its own metrics and checkpoints:

```bash
make resnet-image                                        # fetch + verify CIFAR-10, build, import
ash experiment create resnet18-cifar10-1epoch --project vision \
    --dataset cifar10 --dataset-version v1 --seed 1337
ash job submit examples/training/resnet-cifar.yaml --experiment <id>
```

One full epoch — 390 steps over all 50 000 training images, no `MAX_STEPS` truncation —
in 691 seconds, then **65.59% top-1 on the complete 10 000-image test set**.

That run has been executed twice from the same seed and the same image digest. Both
produced 0.6559 accuracy and 0.9687 loss, matching step by step from the first logged
loss to the last. Recording a seed is only worth doing if it buys
something, and this is the evidence that it does.

**That number is undertrained and is not a CIFAR-10 result.** This architecture reaches
~95% when trained the 100–200 epochs the literature uses; this is one epoch, on a CPU.
It is here to show the platform carried a real workload end to end, and the run says so
itself — in its logs at start and finish, and in the metadata attached to every artifact
it produced, because a checkpoint outlives the log that explained it (spec Rule 5).

The claim was checked rather than trusted: the model artifact was pulled back out of
object storage, loaded into a freshly built architecture, and re-evaluated over the full
test set, reproducing 0.6559 accuracy and 0.9687 loss exactly. `kubectl` confirms the pod
ran on the node the scheduler chose. The dataset is verified against its published
sha256 before it is extracted, and that digest is what `cifar10:v1` pins.

### Serving what was trained

A registered version becomes something that answers requests:

```bash
ash model deploy resnet18-cifar10 --replicas 2   # serves the PRODUCTION version
ash deployment get resnet18-cifar10              # what the cluster reports back
```

Proven end to end on k3d: the ResNet-18 version above served **1 000 real CIFAR-10 test
images at 66.0% top-1**, 8.7 ms per image on CPU — consistent with the 65.59% recorded
for that artifact over the full test set, which is what shows the served model is the
model that was evaluated.

The inference image is generic. It is handed an **artifact id**, not a URL and not a
baked-in model, and exchanges it for a time-limited download at startup through the same
endpoint the training SDK uses — a presigned URL in the manifest would expire, and a pod
restarting hours later would crash-loop on a dead signature.

`/healthz` answers as soon as the process binds; `/readyz` answers only once the weights
are loaded and a forward pass has run. They are wired to different probes deliberately:
readiness on `/healthz` would route traffic to a pod with no model in it, and liveness on
`/readyz` would kill a pod that is still downloading one — restarting it, and starting
the download over.

Status is observed, never assumed. Creating the objects reports `PROGRESSING`; only the
sync loop reading `readyReplicas` back from the cluster may say `READY`. `DEGRADED` —
was serving, now short of replicas — is kept distinct from `PROGRESSING`, because one
word for both hides an outage inside something that sounds like startup.

### Surviving a killed pod

A job with `max_retries` above zero, whose failure a retry could plausibly survive, comes
back as a second attempt that starts where the first one stopped:

```bash
make chaos-resume          # kills a training pod; asserts the retry resumes from step N
make chaos-resume-resnet   # the same, against ResNet-18: weights, optimizer, schedule
```

Killed at step 13 of 40, resumed from the checkpoint confirmed at step 10, finished, and
registered a verified model. The script does not drive the executor — it breaks something
with `kubectl` and then only watches, because what needs proving is that the platform
recovers on its own loop.

Two things have to hold for that to be worth anything. **A retry has to be able to change
the outcome**, so failures are classified rather than counted: an image that will not pull
does not begin to exist because a second pod asked for it, and a container killed for
exceeding its memory request will exceed the same request again. And **resuming has to be
offered rather than imposed** — the retry is handed the newest confirmed checkpoint as an
artifact id in `ASHML_RESUME_FROM`, and a workload that does not implement resuming
ignores it and starts over. Taking it up is one call:

```python
with ashml.init() as run:
    resume = run.fetch_resume()      # None on a first attempt
    if resume:
        state = torch.load(resume, weights_only=True)
```

What a resumed ResNet restores is the model, the optimizer's moments *and* the
learning-rate schedule. The third is the one that hides: without it the run trains,
converges and looks healthy while following a different curve from the one its experiment
record claims — so the proof is the learning rate across the kill, `.0059 → .0588 →
.1000 → .0923 → … → .0028`, one OneCycle rather than two. What is **not** restored is the
position in the shuffled training set, and the run says so in its logs and in the caveat
metadata on every artifact it produces.

**Not yet:** GPU jobs cannot run on this host — the machine has two RTX 2080 Tis, but
installing the NVIDIA container toolkit needs root, so no GPU reaches a k3d node and the
cluster advertises `nvidia.com/gpu: 0`. AshML handles this the honest way: such a job is
**queued with an explanation**, never placed onto a GPU the cluster will not grant
(ADR 0008). Preemption is stored but not driven (Phase 5).

See [`docs/roadmap.md`](docs/roadmap.md) for the phase plan and
[`docs/architecture/architecture.md`](docs/architecture/architecture.md) for the design.

## Quick start

Requires Node.js 22+, Docker, and [k3d](https://k3d.io) + kubectl for execution.

```bash
npm install
make db-up           # PostgreSQL + MinIO
make migrate         # apply schema
make cluster         # create the local k3d cluster
make image           # build the smoke workload image and load it into the cluster
make db-test         # a separate database for the tests, which truncate everything
make test

npm start            # start the control plane (API + executor)
```

`make e2e` runs the whole path against the real cluster — submit, run, log, fail,
cancel — and cross-checks every assertion with `kubectl`. `make e2e-scheduler` overfills
the cluster and asserts that jobs queue, run only as capacity allows, and land on the
node AshML actually chose.

Then, in another shell:

```bash
alias ash='node packages/cli/src/index.js'

ash project create vision --gpu-quota 2
export ASHML_PROJECT=vision          # saves repeating --project

# Register the data a run will consume. Versions are immutable.
ash dataset create cifar10
ash dataset add-version cifar10 v1 --uri s3://ashml/cifar10/v1 --digest sha256:aa11
ash dataset versions cifar10

# Capture what makes a run reproducible, then submit a job against it.
ash experiment create resnet18-baseline \
  --git-commit "$(git rev-parse --short HEAD)" \
  --dataset cifar10 --dataset-version v1 \
  --seed 1337 --param lr=0.001 --param batch_size=128
ash experiment list

ash job submit examples/training/resnet-cifar.yaml --experiment <experiment-id>
ash job list
ash job get <id>
ash job events <id>      # full audit trail
ash job why <id>         # every node considered, and why it was chosen or rejected
ash job logs <id> -f     # the container's own output, followed until it finishes

# What the run reported about itself while training.
ash job metrics <id>              # latest value and point count per metric
ash job metrics <id> --name loss  # the full series, step by step
ash job artifacts <id>            # checkpoints and models, and whether their bytes exist
ash artifact get <artifact-id>            # including whether AshML verified them itself
ash artifact download <artifact-id> -o model.pt   # straight from object storage

# And rolled up across every run of an experiment, for comparing them.
ash experiment metrics <experiment-id>
ash experiment artifacts <experiment-id> --ready
ash experiment get <experiment-id>   # what was asked for, and what the run observed
ash job cancel <id>      # stops at CANCELLING until the Pod is really gone

ash node list            # cluster capacity: what is free, what is committed
ash project quota vision --gpu 2 --jobs 4
ash gpu list
```

Every command takes `--json` for scripting.

On a machine without GPUs, or without a cluster, use the simulated backends:

```bash
ASHML_GPU_PROVIDER=sim ASHML_K8S_BACKEND=sim npm start
```

Simulated devices are flagged as such in the API response and the CLI prints a warning;
a job run by the `sim` execution backend records `simulated: true` on its events and its
"logs" say plainly that no container ran. That is deliberate — see "Honesty" below.

## Layout

```
packages/server/src/
  domain/     pure rules — the job state machine, no I/O
  repos/      hand-written SQL, one module per aggregate
  services/   transactions; the only place job state changes
  routes/     HTTP surface and JSON Schema
  gpu/        provider seam: nvidia (real), sim (flagged)
  k8s/        execution seam: kubernetes (real), sim (flagged); manifest translation
  domain/     also placement and quota — pure, and the differentiating logic
  db/         connection pool and transaction helper
packages/cli/      `ash` command-line client
db/migrations/     PostgreSQL schema
api/openapi.yaml   generated from route schemas — do not hand-edit
deploy/local/      docker-compose for Postgres + MinIO
examples/training/ job manifests
docs/              architecture, roadmap, ADRs
```

Dependencies flow one way: `routes -> services -> repos -> db`, with `domain` importable
from anywhere and importing nothing.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ASHML_PORT` | `8080` | Listen port |
| `ASHML_HOST` | `0.0.0.0` | Listen address |
| `ASHML_LOG_LEVEL` | `info` | pino log level |
| `ASHML_GPU_PROVIDER` | `nvidia` | `nvidia` or `sim` |
| `ASHML_SIM_GPUS` | `2` | Device count for the `sim` provider |
| `ASHML_DATABASE_URL` | `postgresql://ashml:ashml@127.0.0.1:5432/ashml` | PostgreSQL connection |
| `ASHML_DB_POOL_MAX` | `10` | Maximum pooled connections |
| `ASHML_K8S_BACKEND` | `kubernetes` | `kubernetes` or `sim` |
| `ASHML_K8S_NAMESPACE` | `ashml-jobs` | Namespace training Jobs are created in |
| `ASHML_KUBECONFIG` | — | Kubeconfig path; unset uses `$KUBECONFIG`, `~/.kube/config`, then in-cluster credentials |
| `ASHML_EXECUTOR_ENABLED` | `true` | Set false for a read-only API replica that runs nothing |
| `ASHML_EXECUTOR_INTERVAL_MS` | `2000` | Status-sync interval; sets the floor on scheduling latency (ADR 0007) |
| `ASHML_DISCOVERY_INTERVAL_MS` | `15000` | How often node and GPU inventory is refreshed |
| `ASHML_ARTIFACT_STORE` | `s3` | `s3` (MinIO or AWS) or `none` — no bucket; artifacts may still be registered against a caller-supplied URI, and complete as unverified |
| `ASHML_S3_BUCKET` | `ashml` | Bucket checkpoints and models are written to |
| `ASHML_S3_ENDPOINT` | `http://127.0.0.1:9000` | The dev MinIO. **Unset it for real AWS**, where the SDK resolves the host itself. Must be reachable *from a training pod* — see below |
| `ASHML_DEPLOYMENT_SYNC_INTERVAL_MS` | `10000` | How often deployment status is read back from the cluster. Slower than the executor: a deployment sits READY for days |
| `ASHML_API_ADVERTISE_URL` | `http://host.k3d.internal:8080` | What training pods are told to report to, injected as `ASHML_ENDPOINT`. In a cluster, the Service URL |
| `ASHML_S3_REGION` | `us-east-1` | |
| `ASHML_S3_ACCESS_KEY` / `ASHML_S3_SECRET_KEY` | dev MinIO credentials | Unset both to use the SDK credential chain (an IAM role in a cluster) |
| `ASHML_S3_FORCE_PATH_STYLE` | `true` | MinIO serves buckets as a path; set false for AWS |
| `ASHML_S3_PRESIGN_TTL` | `3600` | Seconds an upload or download URL stays valid |
| `ASHML_ENDPOINT` | `http://127.0.0.1:8080` | API endpoint the CLI targets |
| `ASHML_PROJECT` | — | Default project for project-scoped `ash` commands |

`config.js` is the only module that reads the environment.

### Two addresses that are not the control plane's own

A training pod has to reach two things, and neither is at an address the control plane
can infer from its own bind address (`0.0.0.0` is not somewhere else's route to you):

- **The API**, to report metrics. Set `ASHML_API_ADVERTISE_URL`; it is injected into
  every container as `ASHML_ENDPOINT`. Left unset, the SDK says it was never told where
  to report, which is a much better failure than a connection error from inside a pod.
- **Object storage**, to upload checkpoints. Presigned URLs are fetched **by the
  container**, so `ASHML_S3_ENDPOINT` must resolve there — `127.0.0.1:9000` resolves to
  the pod itself and the upload will hang or refuse.

Running the control plane on the workstation against k3d, both want the host's LAN
address rather than loopback:

```bash
HOST_IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')
ASHML_API_ADVERTISE_URL=http://$HOST_IP:8080 ASHML_S3_ENDPOINT=http://$HOST_IP:9000 npm start
```

Deployed inside the cluster, both are ordinary Service URLs and this note stops applying.

## Development

```bash
make db-test          # once: create and migrate the dedicated test database
npm test              # unit tests always; integration tests when that database is up
npm run dev           # server with --watch
npm run migrate up    # apply migrations
npm run migrate down  # roll back one migration
npm run openapi       # regenerate api/openapi.yaml after changing routes
```

Integration tests skip with a visible message when PostgreSQL is unreachable, rather
than passing silently. They run against real Postgres, not a fake — the behaviour that
matters (`SKIP LOCKED`, transaction isolation, unique violations) is exactly what a fake
would get wrong.

**They also delete every row, so they get their own database.** `ASHML_TEST_DATABASE_URL`
(default `…/ashml_test`) is the only thing they will touch; they do not fall back to
`ASHML_DATABASE_URL`, and `truncateAll` refuses outright to wipe a database whose name
does not end in `test`. This is not hypothetical caution — the fallback used to exist,
and a `npm test` run against a configured development database truncated a finished
training run's experiment, metrics, artifacts and registered model version. The artifact
*bytes* survived only because the store half of the same helper already defaulted to a
separate `ashml-test` bucket; the asymmetry between the two is what hid the problem.

The separation has a second benefit: because the suites no longer share a database with
a running control plane, `npm test` no longer needs the server stopped. A live scheduler
polling the same queue used to claim the queue tests' jobs out from under them through
the same `SKIP LOCKED` path, which failed as `Cannot read properties of null`.

## Reproducibility

An experiment is the record of what produced a result: the commit, the image digest,
the dataset **version**, the hyperparameters and the seed (spec §34). Two rules keep
that record trustworthy:

- **Dataset versions are immutable.** Re-registering a version is a `409`, not an
  update, so an experiment pinned to `cifar10:v1` means the same bytes forever.
- **A dataset reference is all-or-nothing.** Naming a dataset without a version is
  rejected rather than stored as null, because a half-pinned run looks reproducible
  without being reproducible. `ash experiment create` warns when a commit or dataset
  is missing.

## Honesty

This project follows a hard rule from its specification: **never fake GPU
functionality, scheduling, distributed training, or performance numbers.**

- Simulated devices carry `simulated: true` through the API and the CLI warns on them.
- `nvidia` is the default provider; `sim` must be opted into explicitly.
- Unimplemented work is marked `[planned: Phase N]` in the docs, not described as done.
- Benchmarks report measured numbers only.

## Known limitations

1. **Single node.** Development runs on one machine with 2× RTX 2080 Ti. Multi-node
   scheduling and node-failure recovery will be demonstrated on simulated k3d nodes and
   labelled as such.
2. **11 GB per GPU.** Workloads are sized to fit. This is a platform project, not a
   frontier-model project.
3. **AshGPU is not integrated.** The provider seam exists; the implementation does not.

## License

Apache-2.0
