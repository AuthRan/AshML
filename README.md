# AshML

A Kubernetes-native GPU machine learning infrastructure platform — a miniature internal
ML cloud. Register datasets, submit training jobs, schedule them onto GPU resources,
track experiments, version models, deploy inference, and observe all of it.

**Status: Phase 1 (control plane).** Projects and training jobs are persisted in
PostgreSQL with an append-only event log and a `SKIP LOCKED` queue. Jobs reach `QUEUED`
and can be cancelled — **nothing executes yet**; Kubernetes arrives in Phase 2. See
[`docs/roadmap.md`](docs/roadmap.md) for the phase plan and
[`docs/architecture/architecture.md`](docs/architecture/architecture.md) for the design.

## Quick start

Requires Node.js 22+ and Docker.

```bash
npm install
npm run db:up        # PostgreSQL + MinIO
npm run migrate up   # apply schema
npm test

npm start            # start the control plane
```

Then, in another shell:

```bash
alias ash='node packages/cli/src/index.js'

ash project create vision --gpu-quota 2
ash job submit examples/training/resnet-cifar.yaml
ash job list
ash job get <id>
ash job events <id>      # full audit trail
ash job cancel <id>
ash gpu list
```

On a machine without GPUs, use the simulated provider:

```bash
ASHML_GPU_PROVIDER=sim npm start
```

Simulated devices are flagged as such in the API response and the CLI prints a warning.
That is deliberate — see "Honesty" below.

## Layout

```
packages/server/src/
  domain/     pure rules — the job state machine, no I/O
  repos/      hand-written SQL, one module per aggregate
  services/   transactions; the only place job state changes
  routes/     HTTP surface and JSON Schema
  gpu/        provider seam: nvidia (real), sim (flagged)
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
| `ASHML_ENDPOINT` | `http://127.0.0.1:8080` | API endpoint the CLI targets |

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
