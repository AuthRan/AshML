# ADR 0002 — Kubernetes as the compute orchestrator

**Status:** Accepted · **Date:** 2026-08-17 · **Phase:** 2

## Context
Training and inference workloads need container lifecycle management, restart semantics,
health checking, networking, and resource isolation.

## Decision
Kubernetes is the compute plane. AshML creates Kubernetes `Job` objects for training and
`Deployment` + `Service` for inference, via `@kubernetes/client-node`. Local development uses k3d.

AshML does **not** wrap Kubernetes as a passthrough. It owns admission, queueing, and
placement; Kubernetes owns execution and supervision (see ADR 0003).

## Rationale
Rebuilding container supervision, restart backoff, and health checking would be
reimplementing Kubernetes badly. Spec §43: do not reinvent infrastructure.

k3d over kind: lighter, and GPU passthrough is better supported for the single-node
2×RTX 2080 Ti host.

## Consequences
- Kubernetes is a hard dependency for Phase 2 onward. Phase 1 runs without it.
- Local development requires a cluster; `make cluster` must stay reproducible.
- Multi-node behaviour cannot be tested honestly on one physical machine. Simulated
  k3d nodes are used and labelled as such.
