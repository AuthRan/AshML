# ADR 0007 — The executor polls Kubernetes; it does not watch

**Status:** Accepted · **Date:** 2026-08-19 · **Phase:** 2

## Context
AshML job state has to track what the cluster is actually doing. Kubernetes offers two
ways to learn that: a **watch** (a long-lived streaming connection that pushes changes)
or a **poll** (ask for current state on an interval).

A watch is the idiomatic choice, and it is what an operator built on the
controller-runtime pattern would use. It is also lower latency and cheaper per update.

## Decision
Phase 2's executor polls, on a configurable interval (`ASHML_EXECUTOR_INTERVAL_MS`,
default 2000ms). Each pass reconciles every job that has, or may have, a workload, then
admits new jobs from the queue.

## Rationale
- **A stalled watch is indistinguishable from a quiet cluster.** Watch connections drop
  — through idle timeouts, load balancers, API server restarts, expired resource
  versions. When one silently stops delivering events, every running job appears frozen
  and nothing reports an error. That failure mode is *wrong*, not merely slow, and it is
  exactly the class of bug this platform exists to demonstrate handling.
- **Polling degrades honestly.** A slow or unreachable API server makes the loop slower
  and logs errors; it does not make job state quietly untrue.
- **Reconciliation is required either way.** A correct watch-based controller still needs
  a periodic resync to recover from missed events, so the polling path has to exist and
  be correct regardless. Building only that path first means one code path rather than
  two, and the one that determines correctness.
- **The scale does not justify it.** Tens of concurrent jobs on one cluster. The cost of
  a `LIST` per interval is irrelevant here, and optimising it first would be optimising
  before measuring (spec §59).

## Revisit when
Phase 6 introduces the TrainingJob CRD and a real operator. That is where a watch belongs
— with the informer cache and resync interval that make it safe. Also revisit if measured
scheduling latency (the interval sets its floor, as in ADR 0004) becomes a real
complaint rather than a theoretical one.

## Consequences
- Job state can lag reality by up to one interval. `started_at` and `finished_at` are
  therefore observation times, not exact container times — the event log says which.
- A job whose container starts and exits inside a single interval is never observed
  RUNNING. It is still recorded as having passed through RUNNING, because it did run;
  synthesising that transition is what keeps `started_at` from being null for a job
  that plainly executed.
- The loop is a plain function (`runOnce`) that can be called once from a test, which is
  what makes the executor's logic testable without a cluster or a clock.
