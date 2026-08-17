# AshML Architecture

## 1. Scope of this document

This describes the architecture as built, not as dreamed. Sections marked
**[planned: Phase N]** are not implemented yet. See `docs/roadmap.md`.

## 2. Plane separation

AshML is split into two planes, and this boundary is load-bearing.

**Control plane** decides what should happen. It is stateful, Node.js, and never runs user code.
- `ashml-server` — REST API, validation, authorization, domain state
- `ashml-scheduler` — queue draining, placement decisions, resource accounting
- PostgreSQL — durable state, job events, audit log

**Compute plane** does the work. It is stateless from AshML's perspective and runs
untrusted-ish user containers.
- Kubernetes Jobs (training), Deployments (inference)
- GPU devices, exposed through the `GpuProvider` contract
- MinIO / S3 — artifacts and checkpoints

**The rule:** infrastructure logic never leaks into training containers. A training
container's only contract with AshML is the Python SDK reporting metrics and checkpoints
over the public API.

```
                 ash CLI  /  Ashcode [planned: Phase 9]
                              │
                        REST /api/v1
                              │
                    ┌─────────▼─────────┐
                    │   ashml-server    │  ── validation, authz, domain state
                    └─────────┬─────────┘
                              │  Postgres (jobs, queue, events)
                    ┌─────────▼─────────┐
                    │ ashml-scheduler   │  ── placement, quotas, GPU accounting
                    └─────────┬─────────┘
                              │  @kubernetes/client-node
                    ┌─────────▼─────────┐
                    │    Kubernetes     │
                    └─────────┬─────────┘
              ┌───────────────┼───────────────┐
         Training Job    Inference Deploy   GPU devices
              │               │               │
              └──── MinIO ────┴──── Prometheus / Loki / Tempo
```

## 3. Component boundaries

| Component | Owns | Must not |
|---|---|---|
| `ashml-server` | API surface, domain validation, state transitions, events | Talk to Kubernetes directly |
| `ashml-scheduler` | Placement decisions, resource accounting, quota enforcement | Own the API or mutate domain objects outside job state |
| `GpuProvider` | Device discovery and telemetry | Know about Kubernetes or jobs |
| Python SDK | Reporting metrics, checkpoints, artifacts | Read the database or call Kubernetes |
| CLI | Rendering, auth token handling | Contain business logic |

Only `ashml-scheduler` writes placement fields. Only `ashml-server` accepts user input.
Every state change appends to `job_events` — no silent mutations.

## 4. Why the scheduler is separate from Kubernetes' scheduler

Kubernetes schedules *pods that already exist*. AshML needs to decide whether a pod
should exist at all: queueing under quota exhaustion, priority ordering across projects,
and GPU-shape matching (count **and** per-device free memory) before admission.

Creating a Pod and letting it sit `Pending` forever is not queueing — it is an
unobservable failure. So AshML holds jobs in its own queue and only creates Kubernetes
objects once placement is decided. Kubernetes then does what it is good at: running and
supervising the container.

## 5. GPU abstraction (AshGPU pluggability)

`packages/server/src/gpu/provider.js` is the single seam through which all GPU knowledge enters the
platform:

```js
// Every provider exposes exactly this:
//   get name()   -> string
//   discover()   -> Promise<Device[]>
```

Implementations:

| Provider | Status | Use |
|---|---|---|
| `nvidia` | **Real.** Shells out to `nvidia-smi`. | Default on GPU hosts |
| `sim` | **Simulated.** Clearly labelled; every device carries `simulated: true`. | CI, laptops, multi-node testing |
| `ashgpu` | **Does not exist.** [planned: Phase 8] | Future |

Nothing above this seam knows which provider is active. Adding AshGPU later means writing
one module and registering it — no scheduler, API, or schema changes. That is the entire
point of introducing the seam now, before it is needed.

Simulated devices are flagged all the way to the API response so a demo can never
silently pass off fake telemetry as real (spec Rule 5).

## 6. State model

Job state lives in Postgres, never only in memory (spec §9). `packages/server/src/domain` owns the
legal transition table; any transition not in that table is rejected and returns an
error. Terminal states (`SUCCEEDED`, `CANCELLED`) accept no outgoing edges. `FAILED` is
deliberately *not* terminal — the retry path `FAILED → RETRYING → QUEUED` depends on it.

The scheduler and the Kubernetes status-sync loop both drive transitions, so the
transition table is the only thing preventing two writers from corrupting state. It is
unit-tested exhaustively.

## 7. Storage split

- **PostgreSQL** — metadata, state, events, audit. Small rows.
- **MinIO / S3** — checkpoints, model binaries, evaluation outputs. Large blobs.

Blobs never go in Postgres (spec §19). The `artifacts` table stores a URI and a digest.

## 8. Observability contract

Every component emits structured JSON logs via `pino`, carrying whichever of
`request_id`, `job_id`, `experiment_id`, `deployment_id`, `node_id` are in scope.
Metrics are Prometheus; traces are OpenTelemetry. **[planned: Phase 5]**

The specific question the observability stack must answer: *why is this job slow, and
what is the bottleneck?* If a dashboard cannot contribute to that answer, it is decoration.
