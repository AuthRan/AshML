# ADR 0006 — Plain JavaScript (Node.js) for the control plane

**Status:** Accepted · **Date:** 2026-08-17 · **Phase:** 0

## Context

The control plane needs a language. The obvious candidate for a Kubernetes-native
platform is Go — it is the ecosystem's native language, `client-go` is the reference
implementation, and Kubebuilder makes operators tractable.

The constraint that overrides this: the author knows JavaScript (Node) and Python, and
does not know Go or TypeScript. The project's dominant risk (see `docs/roadmap.md`) is
not choosing a suboptimal language — it is abandonment partway through a 3-month plan.
Learning Go concurrently with Kubernetes, scheduler design, and operator patterns
roughly doubles the timeline.

## Decision

Build the v1 control plane in **plain JavaScript on Node.js (LTS), ESM modules**.
No TypeScript.

Type safety is recovered at runtime rather than compile time:
- **JSON Schema on every Fastify route**, validating both request and response.
- Schemas are the single source of truth and generate the OpenAPI document.

Python remains the language of the compute plane: training, evaluation, inference
servers, and the reporting SDK.

## Rationale

- A finished platform in JavaScript demonstrates far more engineering than an
  unfinished one in Go. The architecture is what this project is being judged on.
- Runtime validation at the API boundary matters more than compile-time types for a
  control plane taking untrusted input. Fastify's JSON Schema approach gives validation,
  serialization speed, and OpenAPI generation from one declaration — which is arguably a
  better fit for plain JS than TypeScript would be.
- `@kubernetes/client-node` is the official, maintained Kubernetes client.
- Node's built-in test runner and `node:sqlite`-era stdlib mean fewer dependencies
  (spec Rule 4).

## Consequences

- **No Kubebuilder/Kopf equivalent.** The Phase 6 operator must be written directly
  against the Kubernetes watch API. This is ~300 lines of reconciliation loop and is
  honestly a *stronger* demonstration than generating one — but it must be built
  carefully: resync on watch expiry, resourceVersion tracking, idempotent reconcile.
- No compile-time type checking. Mitigated by JSON Schema at boundaries and by keeping
  the domain layer small and heavily unit-tested.
- Single-threaded runtime. Irrelevant at our scale — the control plane is I/O-bound and
  the actual compute happens in Kubernetes pods.

## Revisit when

After Phase 5, the scheduler has benchmarks. If scheduling latency is a measured
bottleneck, porting *only the scheduler* to Go becomes a well-motivated Phase 6+
exercise with before/after numbers — a stronger outcome than having started in Go.
Per spec §59, that decision must be driven by a benchmark, not by intuition.
