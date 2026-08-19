# AshML

A Kubernetes-native GPU machine learning infrastructure platform — a miniature internal
ML cloud. Register datasets, submit training jobs, schedule them onto GPU resources,
track experiments, version models, deploy inference, and observe all of it.

**Status: Phase 2 (Kubernetes execution) complete.** Projects, datasets, experiments and
training jobs are persisted in PostgreSQL with an append-only event log and a
`SKIP LOCKED` queue. Submitted jobs now **actually run**: the executor claims them from
the queue, creates a Kubernetes Job, and drives AshML state from observed Pod status
through to `SUCCEEDED`, `FAILED` or `CANCELLED`. Logs stream back with `ash job logs`.

**Not yet:** AshML does not choose the node — Kubernetes still places the Pod, and
GPU-requesting jobs stay Pending because k3d has no device plugin installed. That is
Phase 3, which is where the scheduler this project exists to demonstrate lives. Retries
are stored but not driven (Phase 5).

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
cancel — and cross-checks every assertion with `kubectl`.

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
ash job logs <id> -f     # the container's own output, followed until it finishes
ash job cancel <id>      # stops at CANCELLING until the Pod is really gone
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
