# ADR 0005 — GPU access behind a provider interface

**Status:** Accepted · **Date:** 2026-08-17 · **Phase:** 0

## Context
AshGPU is intended to be the platform's GPU runtime layer (spec §15), but **it does not
exist yet**. AshML must not block on it, and must not pretend to integrate with it.

## Decision
All GPU knowledge enters through a single `GpuProvider` contract in
`packages/server/src/gpu/provider.js`:

```js
// name  -> string
// discover() -> Promise<Device[]>
```

Providers self-register in a registry keyed by name; selecting one is a config value.

Three implementations:
- `nvidia` — real, via `nvidia-smi`. Default on GPU hosts.
- `sim` — simulated, sets `Device.Simulated = true`. For CI and non-GPU machines.
- `ashgpu` — **not implemented.** Phase 8.

Selected at runtime by the `ASHML_GPU_PROVIDER` environment variable. The `Simulated` flag propagates to the API
response and the CLI output.

## Rationale
- Decouples the v1 timeline from AshGPU's timeline entirely.
- Adding AshGPU later is one new file plus a registry entry — no changes to the
  scheduler, API, or schema.
- Spec Rule 5 forbids faking GPU functionality. An explicit `Simulated` flag that
  survives all the way to the user is how we comply structurally rather than by
  remembering to be honest.

## Consequences
- Slight indirection cost for a single-provider v1. Worth it.
- `nvidia-smi` shell-out is adequate for discovery frequency (seconds). Node has no
  first-class NVML binding, so if this ever becomes hot the answer is a small sidecar
  (DCGM-exporter already gives us this for metrics) — but measure first.
