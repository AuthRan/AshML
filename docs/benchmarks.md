# Benchmarks

Spec §37: **benchmarks report measured numbers only.** So every figure below was produced
by `scripts/bench.mjs` or read out of the database on the date given, and the command that
produces each one is printed next to it. Re-run them and they will move.

Nothing here is a claim about hardware AshML has not run on. In particular there is no
GPU number anywhere in this document, because no GPU reaches a node on this cluster
(ADR 0008) — a "projected" GPU figure would be the exact thing Rule 5 forbids.

```bash
make bench                                  # everything
node scripts/bench.mjs --inference --json   # one section, machine-readable
```

## The machine, and why that matters more than usual

| | |
|---|---|
| Host | 8× Intel Xeon Gold 5222 @ 3.80 GHz, 125 GiB RAM |
| Kernel | Linux 7.0.0-28-generic |
| Node | v24.19.0 |
| Cluster | k3d, k3s v1.35.5+k3s1, 1 server + 1 agent |
| Database | PostgreSQL 16, same host |
| GPUs available to the cluster | **0** — two RTX 2080 Tis in the machine, none reachable by a container (ADR 0008) |
| Measured | 2026-08-21 |

**The cluster runs on the machine being measured.** Every network hop below is loopback:
the control plane to PostgreSQL, the control plane to the Kubernetes API server, and the
API server to a pod. A real cluster on a real network does not look like this, and the
numbers should be read as a floor rather than as a forecast.

---

## Control-plane API latency

`node scripts/bench.mjs --api` — 100 sequential requests each, after 5 warm-up requests,
against a control plane with nothing else contending for it.

| endpoint | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| `GET /healthz` | 100 | 1.7 ms | 2.4 ms | 2.8 ms | 2.8 ms |
| `GET /api/v1/version` | 100 | 1.6 ms | 1.9 ms | 2.1 ms | 2.9 ms |
| `GET /api/v1/nodes` | 100 | 2.4 ms | 3.1 ms | 3.9 ms | 4.0 ms |
| `GET /api/v1/projects` | 100 | 2.0 ms | 2.8 ms | 3.8 ms | 4.7 ms |
| `GET /api/v1/jobs?limit=20` | 100 | 3.0 ms | 4.3 ms | 8.5 ms | 8.5 ms |
| `GET /api/v1/projects/vision/deployments` | 100 | 2.6 ms | 2.9 ms | 3.1 ms | 3.2 ms |

Read endpoints that hit PostgreSQL sit around 2–3 ms; `/healthz`, which touches nothing,
sits at 1.7 ms, so roughly half of a read is the HTTP round trip and half is the query.
Percentiles are nearest-rank, so every value printed is a request that actually happened —
at n = 100 an interpolated p99 would be arithmetic on two samples.

This is latency under no load. It is not a throughput figure and must not be quoted as
one: nothing here saturates anything.

---

## Scheduling latency

`node scripts/bench.mjs --scheduling` — 16 real jobs submitted to the real cluster, each
running a real container.

| interval | n | min | p50 | max |
|---|---|---|---|---|
| submitted → Kubernetes Job created | 16 | 476 ms | 1083 ms | 2463 ms |
| submitted → container running | 16 | 2551 ms | 5275 ms | 7678 ms |

**The first row is the executor's poll, not a queue.** AshML polls rather than watches
(ADR 0007) at `ASHML_EXECUTOR_INTERVAL_MS`, 2000 ms here, so a job waits for the next pass:
uniformly distributed submissions give an expected median of half the interval, and 1083 ms
is that. The maximum exceeds the interval by the duration of a pass that had other work to
do. Lowering the interval lowers this number directly, and ADR 0007 says what it costs.

**The second row is mostly not AshML.** It adds the kubelet pulling and starting the
container. The two are reported separately for exactly that reason — as one number, a slow
scheduler could hide behind containerd.

### A measurement that was wrong first

The first version of this benchmark submitted each job the moment the previous one started
running, and reported a p50 of **178 ms**. That number was an artefact: submitting on the
previous job's transition phase-locks every submission to the same point in the poll cycle,
so the benchmark sampled one phase and called it a distribution. `bench.mjs` now spaces
submissions by a uniform random offset across one interval, which is where 1083 ms comes
from — and 1083 ms, being half the interval, is the number that can be derived from first
principles. The flattering one could not.

---

## Inference latency and throughput

`node scripts/bench.mjs --inference` — against the live deployment of `resnet18-cifar10`
v1 (artifact `7228968a`), one replica, 2 CPU, no GPU. 20 sequential requests per batch
size after 3 warm-up requests.

| batch | n | p50 | p95 | ms/image | images/s | forward pass, in the pod |
|---|---|---|---|---|---|---|
| 1 | 20 | 323.0 ms | 388.1 ms | 323.0 | 3 | 160.4 ms |
| 2 | 20 | 345.0 ms | 360.1 ms | 172.5 | 6 | 289.4 ms |
| 4 | 20 | 386.8 ms | 408.1 ms | 96.7 | 10 | 326.9 ms |
| 8 | 20 | 410.0 ms | 435.8 ms | 51.3 | 20 | 362.4 ms |
| 16 | 20 | 458.4 ms | 497.6 ms | 28.6 | 35 | 377.1 ms |
| 32 | 20 | 474.8 ms | 497.7 ms | 14.8 | 67 | 413.2 ms |
| 64 | 20 | 601.4 ms | 627.6 ms | 9.4 | 106 | 480.3 ms |

Two things this says.

**Per-image cost is a batch-size question, and a single image answers it wrongly.** One
image costs 323 ms; sixty-four cost 601 ms, which is 9.4 ms each. Quoting either number
alone is misleading in a different direction, so both are here. The 9.4 ms at batch 64
corroborates the 8.7 ms per image recorded for the 1 000-image serving run in the roadmap —
a figure produced months apart by a different method against the same artifact.

**About 120–160 ms of every request is not the model.** At batch 1 the pod measures 160 ms
for a forward pass while the caller waits 323 ms; at batch 64, 480 ms against 601 ms. That
difference is the Kubernetes API server proxy plus this control plane, and it is the
measured form of the warning attached to `ash predict` in the code: **this is not the
serving path.** Traffic that matters goes to `endpoint_url` from inside the cluster and
pays none of it.

These are sequential, one request in flight at a time. They are latency figures. Nothing
here measures what one replica can sustain under concurrent load, and the deployment's
`ASHML_MAX_CONCURRENCY` of 4 is untested by any of it.

---

## Training throughput

Not from `bench.mjs`: these are read out of the records of an actual training run, which is
the only place a training number can honestly come from.

ResNet-18 on CIFAR-10, job `9cea7d96`, one full epoch on **CPU**:

| | |
|---|---|
| Steps | 390, batch 128, all 50 000 training images |
| Run window (the SDK's own `started_at`/`ended_at`) | 691.4 s |
| Job wall clock (`started_at` → `finished_at`) | 700.1 s |
| Throughput, as the run reported it | 0.562 steps/s mean (0.509 min, 0.606 max) |
| Which is | ~72 images/s at batch 128 |
| Framework and hardware, as observed | `pytorch 2.13.0+cpu`, `gpus: 0`, `cuda: null` |
| Final | `val_accuracy` 0.6559, `val_loss` 0.9687 over the full 10 000-image test set |

The two durations differ by 8.7 s and both are correct: the run window is what the training
process measured for itself, and the wall clock adds container start and stop. Reporting
one as the other is a small lie that gets repeated.

`steps_per_second` is a metric the run pushed about itself (ADR 0009), sampled every ten
steps — so this is 39 measurements taken during training rather than one division at the
end, which is why a range can be given at all.

**0.6559 is undertrained and is not a CIFAR-10 result.** This architecture reaches ~95% at
the 100–200 epochs the literature uses. One epoch on a CPU is here to show the platform
carried a real workload, and this table is about the platform's throughput, not the model's
quality.

The sibling run `085cade3`, quoted elsewhere in the docs, cannot be checked today: its rows
were destroyed by the test-database incident described in the README, which is why the
numbers above come from the run that survived it rather than from the one that was cited
first.

---

## What is deliberately not measured

- **Anything with a GPU.** No device reaches a k3d node on this host (ADR 0008). There is
  no GPU training figure, no GPU inference figure, and no scaled estimate of either.
- **Sustained throughput under concurrency.** Every number above is sequential. Load
  testing needs the Prometheus work later in Phase 5 to be worth interpreting — without
  server-side metrics, a saturation curve measured only from the client cannot say what
  saturated.
- **Multi-node scheduling at scale.** Two nodes, one of them the k3d server. Placement
  arithmetic across a larger cluster is unit-tested against fake inventories and is not a
  benchmark.
- **The database under load.** `SKIP LOCKED` queue behaviour is tested for correctness
  against real PostgreSQL; how many jobs a second it will claim is untested.
