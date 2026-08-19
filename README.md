# AshML

A Kubernetes-native GPU machine learning infrastructure platform — a miniature internal
ML cloud. Register datasets, submit training jobs, schedule them onto GPU resources,
track experiments, version models, deploy inference, and observe all of it.

**Status: Phase 3 (scheduler) complete; Phase 4 (ML lifecycle) in progress.** Projects,
datasets, experiments and training jobs are persisted in PostgreSQL with an append-only
event log and a `SKIP LOCKED` queue. Submitted jobs **actually run**: AshML's own
scheduler decides whether a job may run and on which node, the executor creates the
Kubernetes Job there, and job state is driven from observed Pod status through to
`SUCCEEDED`, `FAILED` or `CANCELLED`.

Overfill the cluster and jobs queue rather than over-committing it; `ash job why <id>`
prints every node the scheduler considered and what was wrong with it.

Running jobs now **report on themselves**: metrics as they train, checkpoints as they
write them, and what the run actually observed itself running on. `ash job metrics <id>`
shows the curve, `ash job artifacts <id>` shows what it produced.

Checkpoints go straight from the training pod to MinIO over a presigned upload, and
AshML **asks the bucket** whether they arrived before marking one usable: an upload that
never landed is refused, and one stored somewhere AshML cannot check is labelled `NO` in
the CHECKED column rather than passing for a verified checkpoint.

**Not yet in Phase 4:** the Python SDK and the model registry, so reporting today means
calling the API directly.

**Not yet:** GPU jobs cannot run on this host — the machine has two RTX 2080 Tis, but
installing the NVIDIA container toolkit needs root, so no GPU reaches a k3d node and the
cluster advertises `nvidia.com/gpu: 0`. AshML handles this the honest way: such a job is
**queued with an explanation**, never placed onto a GPU the cluster will not grant
(ADR 0008). Retries and preemption are stored but not driven (Phase 5).

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
| `ASHML_S3_ENDPOINT` | `http://127.0.0.1:9000` | The dev MinIO. **Unset it for real AWS**, where the SDK resolves the host itself |
| `ASHML_S3_REGION` | `us-east-1` | |
| `ASHML_S3_ACCESS_KEY` / `ASHML_S3_SECRET_KEY` | dev MinIO credentials | Unset both to use the SDK credential chain (an IAM role in a cluster) |
| `ASHML_S3_FORCE_PATH_STYLE` | `true` | MinIO serves buckets as a path; set false for AWS |
| `ASHML_S3_PRESIGN_TTL` | `3600` | Seconds an upload or download URL stays valid |
| `ASHML_ENDPOINT` | `http://127.0.0.1:8080` | API endpoint the CLI targets |
| `ASHML_PROJECT` | — | Default project for project-scoped `ash` commands |

`config.js` is the only module that reads the environment.

## Development

```bash
npm test              # unit tests always; integration tests when Postgres is up
npm run dev           # server with --watch
npm run migrate up    # apply migrations
npm run migrate down  # roll back one migration
npm run openapi       # regenerate api/openapi.yaml after changing routes
```

Integration tests skip with a visible message when PostgreSQL is unreachable, rather
than passing silently. They run against real Postgres, not a fake — the behaviour that
matters (`SKIP LOCKED`, transaction isolation, unique violations) is exactly what a fake
would get wrong.

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
