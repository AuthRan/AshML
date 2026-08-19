# ADR 0008 — Schedule against what the cluster grants, not what the hardware has

**Status:** Accepted · **Date:** 2026-08-19 · **Phase:** 3

## Context
AshML learns about GPUs from two independent sources:

- **`GpuProvider`** (ADR 0005) shells out to `nvidia-smi` and reports what the machine
  physically has: model, total memory, utilisation, temperature, health.
- **Kubernetes** advertises `nvidia.com/gpu` in a node's `allocatable`, and that figure
  is what it will actually hand to a Pod.

These can disagree, and on this development host they do. The machine has two RTX 2080
Tis. The cluster advertises `nvidia.com/gpu: 0`, because no NVIDIA device plugin is
installed — which in turn is because Docker here has no `nvidia` container runtime and
installing the container toolkit needs root.

The first implementation attached the discovered devices to a node regardless, on the
reasoning that the inventory should at least be visible. The end-to-end test caught what
that produces: the scheduler believed the node had two GPUs, placed a GPU job on it, and
the Pod would have sat `Pending` forever while AshML reported the job placed.

## Decision
Placement uses `min(nvidia.com/gpu advertised, healthy devices discovered)`.

Where no devices have been discovered at all, the advertised count stands alone. Where
no node advertises GPU capacity, discovered devices are attached to no node — they
remain visible through `/api/v1/gpus`, which is the endpoint that answers "what does this
machine have", while `compute_nodes` answers the different question of what the cluster
will schedule.

The same principle applies to CPU and memory: a node's usable capacity is `allocatable`
minus the requests of Pods AshML did not create. Reading `allocatable` alone means
believing the whole node is AshML's own, admitting jobs summing to all of it, and having
Kubernetes refuse the last one because kube-system got there first.

## Rationale
- **A Pod that cannot be granted its resources is an unobservable failure**, which is
  exactly what the architecture document says AshML's queue exists to prevent. Placing a
  job onto capacity the cluster will not grant reintroduces the problem the scheduler was
  built to solve.
- **Taking the minimum is safe in both directions.** The advertised count alone would
  keep scheduling onto a device that has failed; the hardware count alone schedules onto
  devices the cluster will not grant. Only the intersection is genuinely runnable.
- **A wrong reason is worse than no reason.** "0 GPUs free" sends an operator to look for
  a busy node. The rejection reason for this case names it explicitly: the node has
  devices, the cluster advertises none, no device plugin is installed.
- **The two sources answer different questions and are both worth keeping.** Kubernetes
  cannot tell you a GPU is running hot or has fallen over. `nvidia-smi` cannot tell you
  the cluster will refuse to schedule onto it. Averaging them away would lose both.

## Consequences
- On this host, GPU jobs queue rather than run, and say why. That is the honest outcome,
  and `make e2e-scheduler` asserts it rather than skipping the case.
- Installing the NVIDIA device plugin (which needs the container toolkit, which needs
  root) is what turns GPU scheduling on. No AshML change is required — the advertised
  capacity appears and placement starts using it.
- `compute_nodes` carries `gpu_capacity`, `reserved_cpu` and `reserved_memory` alongside
  the raw `cpu_cores` / `memory_bytes`, so what was believed at placement time stays
  auditable rather than being recomputed later from figures that have since moved.
- AshML still does not model every Kubernetes predicate — taints, affinities, topology.
  A Pod it places can still be refused. That is why placement is expressed as a
  `nodeSelector` rather than `spec.nodeName`: Kubernetes remains the enforcer, so a gap
  in AshML's model shows up as a visible Pending Pod rather than an over-committed node.
