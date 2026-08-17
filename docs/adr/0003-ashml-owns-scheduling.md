# ADR 0003 — AshML owns scheduling, not kube-scheduler

**Status:** Accepted · **Date:** 2026-08-17 · **Phase:** 3

## Context
Spec §11 requires an ML-aware scheduling layer that is not a thin wrapper around
Kubernetes. We need to justify why kube-scheduler is insufficient.

## Decision
AshML maintains its own queue and placement logic. Kubernetes objects are created only
*after* AshML has decided placement. Scheduling decisions — including rejected candidate
nodes and the reason for rejection — are persisted.

The scheduler evolves in stages: FIFO → priority → resource-aware → GPU-aware. Advanced
features (gang scheduling, preemption, topology, fair-share) are out of scope for v1.

## Rationale
kube-scheduler schedules Pods that already exist. It cannot:
- Hold work behind a **project quota** before any object is created.
- Order across projects by priority with a durable, inspectable queue.
- Match GPU *shape* — count plus per-device free memory plus device type.
- Explain, after the fact, why a job waited.

Creating a Pod that sits `Pending` indefinitely is an unobservable failure. Queueing in
the control plane makes waiting a first-class, explainable state.

## Consequences
- Two schedulers exist. AshML picks the node; kube-scheduler must honour it (nodeSelector
  or nodeName). This overlap must be documented, not hidden.
- Scheduler correctness becomes our problem, so it needs heavy unit tests.
