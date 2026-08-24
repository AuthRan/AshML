# ADR 0009 — Runs push their own metrics; nothing scrapes them

**Status:** Accepted · **Date:** 2026-08-20 · **Phase:** 4

## Context

Phase 4 needs a training run's numbers — loss, accuracy, learning rate — to reach the
control plane, along with the checkpoints it writes. The run happens inside a container
AshML launched but does not otherwise participate in.

There are three ways the numbers could get here.

- **Push.** The training script calls the AshML API as it trains.
- **Scrape.** The container exposes a Prometheus endpoint and something polls it.
- **Parse the logs.** The status loop already streams logs; metrics could be pulled out
  of them.

The existing architecture leans towards scraping: Phase 5 brings Prometheus, DCGM and
Grafana, the status loop already polls Kubernetes (ADR 0007), and adding one more thing
to poll is the smaller change.

## Decision

Training runs **push** metrics and artifact records to the control-plane API:
`POST /api/v1/jobs/{id}/metrics`, `POST /api/v1/jobs/{id}/artifacts`, and
`POST /api/v1/experiments/{id}/report`.

Prometheus is still coming in Phase 5, and it will still scrape. The split is by what
the number describes:

| | Source | Example |
|---|---|---|
| **Training metrics** — what the model is doing | pushed by the run | loss, accuracy, LR |
| **Infrastructure metrics** — what the machine is doing | scraped in Phase 5 | GPU utilisation, memory, temperature |

## Rationale

- **Only the run knows what step it is on.** A metric is meaningless without the step it
  belongs to, and the step exists nowhere outside the training loop. A scraper samples on
  a timer, so it records "loss was 1.84 at 14:03:22" — the wrong axis, and it silently
  drops every step that fell between two scrapes. Sampling a curve is not the same as
  recording it.
- **A run is not a service.** Prometheus is built for processes that stay up and get
  sampled repeatedly. A training job runs to completion and exits, and the last scrape
  before it exits is the one that matters most — exactly the one most likely to be
  missed. Push means the run reports before it stops.
- **Checkpoints have no scrape shape at all.** "This file now exists at this URI with
  this digest" is an event, not a gauge. It would have needed a push path regardless, so
  scraping metrics would have meant building both.
- **Parsing logs was rejected outright.** It makes the log format an API, breaks when
  someone adds a print statement, and cannot carry a digest reliably.

## Consequences

**A training script cannot be unmodified.** This is the real cost: running someone
else's script under AshML means adding reporting calls to it. The Python SDK exists to
make that small — the target is that a loop needs `run.log_metrics({...}, step=i)` and
nothing else — but it is not zero, and the honest limitation is that AshML sees nothing
from a job that does not opt in.

**The API takes writes from inside the cluster**, which is a new direction of traffic.
~~It is unauthenticated in v1, like the rest of the API — auth is Phase 10 — so a job can
currently report metrics for another job by id.~~ **Closed in Phase 10** (ADR 0013): a
training attempt carries a token scoped to that job and that attempt, so
`POST /api/v1/jobs/:id/metrics` is refused for any job but its own — and no *person* can
write it at all, not an owner and not a platform administrator, because the value of the
record is that the pod reported what it measured rather than what somebody expected.

The two properties below were the mitigations in the meantime. Both are still true and
still enforced, and both are worth having independently of authentication:

- The experiment id is copied from the job server-side, never taken from the request, so
  a run cannot attach its numbers to an experiment it does not belong to.
- Metrics are refused for a job that has not been launched, so ids cannot be probed by
  writing to them.

Neither was a substitute for authentication, which is why this paragraph said so plainly
while there was none.

**Late reports are accepted.** A run that buffers metrics and flushes at the end reports
after its pod is gone, and an upload confirmed after the job succeeded is the normal case
for a final model. The rule is therefore "the job must have been launched", not "the job
must be running".

**`recorded_at` is the run's timestamp, not the API's.** A batch flushed in one request
would otherwise collapse the whole history onto the moment of the flush. This is why the
column exists and why it is not `created_at`.

## Alternatives considered

**A sidecar that scrapes the training container and pushes on its behalf.** Keeps the
training script unmodified, which is the main cost above. Rejected for v1: it needs the
script to expose a metrics endpoint anyway (so it is not actually unmodified), it doubles
the containers per job, and the step-axis problem is unchanged — the sidecar samples on a
timer just as Prometheus would.

**Writing metrics to the checkpoint directory and ingesting them when the job ends.** No
live curve during a run, which is most of what a training dashboard is for.

Related: ADR 0007 (why the status loop polls), ADR 0001 (Postgres for control-plane
state).
