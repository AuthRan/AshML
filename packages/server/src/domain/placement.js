/**
 * Placement: choosing which node a job should run on, and explaining the choice.
 *
 * This module is pure. No database, no Kubernetes, no clock, no randomness — given the
 * same job and the same view of the cluster it always returns the same decision. That
 * matters for three reasons: the logic is the differentiating part of this platform and
 * must be exhaustively testable; a scheduling decision that cannot be reproduced cannot
 * be debugged; and every rejection here becomes a row a user reads to find out why
 * their job is still queued (spec §12).
 *
 * The scheduler in `services/scheduler.js` is what supplies the cluster view and
 * persists what this module decides.
 */

/**
 * Why a node was, or was not, chosen.
 *
 * VIABLE exists because "could have run it" and "was chosen" are different facts, and
 * an audit trail that marked every fitting node SELECTED would show several winners for
 * one job. Distinguishing them is also what makes the record useful: a job that keeps
 * landing on one node while another was viable the whole time is a ranking question,
 * not a capacity one.
 */
export const Outcome = Object.freeze({
  SELECTED: 'SELECTED',
  VIABLE: 'VIABLE',
  REJECTED: 'REJECTED',
  NO_CAPACITY: 'NO_CAPACITY',
});

/** Reasons a node is rejected, kept as codes so the CLI can render them consistently. */
export const Reject = Object.freeze({
  NOT_READY: 'NODE_NOT_READY',
  CPU: 'INSUFFICIENT_CPU',
  MEMORY: 'INSUFFICIENT_MEMORY',
  GPU_COUNT: 'INSUFFICIENT_GPUS',
  GPU_MEMORY: 'NO_GPU_LARGE_ENOUGH',
  GPU_UNHEALTHY: 'GPU_UNHEALTHY',
  GPU_NOT_SCHEDULABLE: 'GPU_NOT_SCHEDULABLE',
});

/**
 * Free capacity on a node: what it has, minus what AshML has already committed.
 *
 * Allocations come from AshML's own ledger rather than from the node's reported usage.
 * Reported usage lags — a Pod that was created a second ago has not shown up in it yet
 * — and scheduling against a lagging number is how a node gets double-booked.
 */
export function freeCapacity(node) {
  const allocated = node.allocated ?? { cpu: 0, memory_bytes: 0, gpu: 0 };
  return {
    cpu: node.cpu_cores - (node.reserved_cpu ?? 0) - (allocated.cpu ?? 0),
    memory_bytes: Number(node.memory_bytes)
      - Number(node.reserved_memory ?? 0)
      - Number(allocated.memory_bytes ?? 0),
    gpu: schedulableGpus(node) - (allocated.gpu ?? 0),
  };
}

/**
 * How many GPUs on this node can actually be scheduled onto.
 *
 * This is the **minimum** of two different facts, and conflating them is a bug that
 * hurts in both directions:
 *
 * - `gpu_capacity` is what Kubernetes advertises as `nvidia.com/gpu`. It is zero until
 *   a device plugin is installed, no matter how much silicon the machine has.
 *   Scheduling against the hardware instead would place jobs onto GPUs the cluster will
 *   never grant, and the Pod would sit Pending forever while AshML reported it placed.
 * - The GPU provider's device list is what the hardware reports, including health.
 *   Scheduling against the advertised count alone would keep placing jobs onto a device
 *   that has fallen over.
 *
 * So a node offers a GPU only when both agree there is one. When no devices have been
 * discovered at all — a cluster whose GPUs AshML cannot see directly — the advertised
 * count stands on its own, because Kubernetes granting the device is what actually
 * matters and refusing to schedule would idle a working cluster.
 */
export function schedulableGpus(node) {
  const advertised = node.gpu_capacity ?? 0;
  const devices = node.gpus ?? [];

  if (devices.length === 0) return advertised;
  return Math.min(advertised, healthyGpus(node).length);
}

/** GPUs on a node that are fit to be scheduled onto. */
function healthyGpus(node) {
  // UNKNOWN is treated as usable: it is what a device reports before it has been
  // polled, and refusing to schedule on an unpolled device would idle the cluster on
  // startup. FAILED and DEGRADED are not — a job placed on a sick GPU fails slowly and
  // confusingly, which is worse than waiting.
  return (node.gpus ?? []).filter((gpu) => gpu.health === 'OK' || gpu.health === 'UNKNOWN');
}

/**
 * Evaluates one node against one job's resource request.
 *
 * Returns `{ fits: true }` or `{ fits: false, code, reason, ... }`. Every rejection
 * carries the numbers that produced it, because "insufficient GPUs" without "1
 * requested, 0 free of 2" tells a user nothing they can act on.
 */
export function evaluateNode(node, request) {
  const free = freeCapacity(node);

  if (!node.ready) {
    return {
      fits: false,
      code: Reject.NOT_READY,
      reason: `node ${node.name} is not ready`,
    };
  }

  if (request.gpu > 0) {
    const healthy = healthyGpus(node);
    const devices = node.gpus ?? [];
    const advertised = node.gpu_capacity ?? 0;

    // The most confusing state this system can be in, and worth its own message: the
    // machine visibly has GPUs, but the cluster will not grant any. Reporting this as
    // "0 GPUs free" would send an operator to look for a busy node instead of a
    // missing device plugin.
    if (advertised === 0) {
      return {
        fits: false,
        code: Reject.GPU_NOT_SCHEDULABLE,
        reason: devices.length > 0
          ? `node ${node.name} has ${devices.length} GPU(s) but the cluster advertises `
            + 'nvidia.com/gpu=0 — no device plugin is installed, so no Pod can be granted one'
          : `node ${node.name} advertises no GPUs (nvidia.com/gpu=0); if the machine has `
            + 'GPUs, no device plugin is installed',
        advertised_gpu: 0,
      };
    }

    if (devices.length > 0 && healthy.length === 0) {
      return {
        fits: false,
        code: Reject.GPU_UNHEALTHY,
        reason: `node ${node.name} has ${devices.length} GPU(s), none reporting healthy`,
      };
    }

    if (free.gpu < request.gpu) {
      return {
        fits: false,
        code: Reject.GPU_COUNT,
        reason:
          `node ${node.name} has ${free.gpu} of ${schedulableGpus(node)} GPU(s) free; `
          + `${request.gpu} requested`,
        free_gpu: free.gpu,
        requested_gpu: request.gpu,
      };
    }

    if (request.gpu_memory_min_bytes > 0) {
      // Matched against each device's *total* memory, not its free memory. Free memory
      // moves second to second and is partly consumed by whatever is already running;
      // admitting on it would make placement depend on a number that is stale before
      // the Pod is even created. Total memory answers the question actually being
      // asked: is this device big enough to hold the job at all?
      const bigEnough = healthyGpus(node)
        .filter((gpu) => Number(gpu.memory_total_bytes) >= Number(request.gpu_memory_min_bytes));

      // Devices already committed to other jobs cannot be offered again. Which
      // physical device the plugin hands out is Kubernetes' choice, so this is a
      // count-based worst case: assume the largest devices are the busy ones.
      const availableBigEnough = Math.max(0, bigEnough.length - (node.allocated?.gpu ?? 0));

      if (availableBigEnough < request.gpu) {
        const largest = Math.max(0, ...healthyGpus(node).map((g) => Number(g.memory_total_bytes)));
        return {
          fits: false,
          code: Reject.GPU_MEMORY,
          reason:
            `node ${node.name} has ${availableBigEnough} free GPU(s) of at least `
            + `${gib(request.gpu_memory_min_bytes)} GiB; ${request.gpu} requested `
            + `(largest device is ${gib(largest)} GiB)`,
          requested_gpu_memory_min_bytes: request.gpu_memory_min_bytes,
        };
      }
    }
  }

  if (free.cpu < request.cpu) {
    return {
      fits: false,
      code: Reject.CPU,
      reason: `node ${node.name} has ${free.cpu} of ${node.cpu_cores} CPU free; ${request.cpu} requested`,
      free_cpu: free.cpu,
      requested_cpu: request.cpu,
    };
  }

  if (Number(request.memory_bytes) > 0 && free.memory_bytes < Number(request.memory_bytes)) {
    return {
      fits: false,
      code: Reject.MEMORY,
      reason:
        `node ${node.name} has ${gib(free.memory_bytes)} GiB of `
        + `${gib(node.memory_bytes)} GiB memory free; ${gib(request.memory_bytes)} GiB requested`,
      free_memory_bytes: free.memory_bytes,
      requested_memory_bytes: request.memory_bytes,
    };
  }

  return { fits: true, free };
}

/**
 * Ranks the nodes a job fits on, best first.
 *
 * The policy is **best fit**, not first fit:
 *
 * - A GPU job goes to the node that will have the fewest GPUs left over. Spreading GPU
 *   jobs across nodes fragments the cluster — two nodes each with one GPU free cannot
 *   run a two-GPU job, while one node with two free can. Packing keeps large requests
 *   schedulable.
 * - A CPU-only job goes to the node with the *fewest* GPUs. Filling a GPU node's CPU
 *   with work that does not need a GPU is how a GPU sits idle behind a CPU shortage.
 *
 * Ties break on node name, so placement is deterministic and a rerun of the same
 * situation is explainable rather than merely plausible.
 */
function rank(candidates, request) {
  return [...candidates].sort((a, b) => {
    if (request.gpu > 0) {
      const leftoverA = a.evaluation.free.gpu - request.gpu;
      const leftoverB = b.evaluation.free.gpu - request.gpu;
      if (leftoverA !== leftoverB) return leftoverA - leftoverB;
    } else {
      // Judged on schedulable GPUs: a node whose GPUs the cluster will not grant is not
      // a GPU node for scheduling purposes, and steering CPU work off it would be
      // protecting capacity that does not exist.
      const gpusA = schedulableGpus(a.node);
      const gpusB = schedulableGpus(b.node);
      if (gpusA !== gpusB) return gpusA - gpusB;
    }

    // Among equals, leave the roomiest node roomy: prefer the tighter fit on CPU too.
    const cpuA = a.evaluation.free.cpu - request.cpu;
    const cpuB = b.evaluation.free.cpu - request.cpu;
    if (cpuA !== cpuB) return cpuA - cpuB;

    return a.node.name.localeCompare(b.node.name);
  });
}

/**
 * Chooses a node for a job.
 *
 * @param {object} request `{ cpu, memory_bytes, gpu, gpu_memory_min_bytes }`
 * @param {object[]} nodes cluster view, each with `allocated` and `gpus`
 * @returns {{
 *   outcome: string,
 *   node: object|null,
 *   reason: string,
 *   decisions: Array<{node_id, node_name, outcome, reason, details}>,
 * }}
 *   `decisions` holds one entry per node considered — the audit trail, written whether
 *   the job was placed or not.
 */
export function placeJob(request, nodes) {
  if (nodes.length === 0) {
    return {
      outcome: Outcome.NO_CAPACITY,
      node: null,
      reason: 'no compute nodes are registered',
      decisions: [],
    };
  }

  const evaluated = nodes.map((node) => ({ node, evaluation: evaluateNode(node, request) }));
  const fitting = evaluated.filter((entry) => entry.evaluation.fits);

  if (fitting.length === 0) {
    return {
      outcome: Outcome.NO_CAPACITY,
      node: null,
      reason: summarise(evaluated, request),
      decisions: evaluated.map(({ node, evaluation }) => decisionRow(node, evaluation, request)),
    };
  }

  const [winner, ...runnersUp] = rank(fitting, request);

  // The rejected nodes are recorded too. "Why not the other node?" is as much a part of
  // explaining a placement as "why this one".
  const decisions = [
    {
      ...decisionRow(winner.node, winner.evaluation, request),
      outcome: Outcome.SELECTED,
      reason: selectionReason(winner, request, runnersUp.length),
    },
    ...evaluated
      .filter((entry) => entry.node.name !== winner.node.name)
      .map(({ node, evaluation }) => decisionRow(node, evaluation, request, { winner: winner.node })),
  ];

  return {
    outcome: Outcome.SELECTED,
    node: winner.node,
    reason: selectionReason(winner, request, runnersUp.length),
    decisions,
  };
}

/** What to say about a node that could have run the job but did not get it. */
function viableReason(node, winner) {
  return winner
    ? `node ${node.name} fits, but ${winner.name} was the better fit`
    : `node ${node.name} fits`;
}

function selectionReason(winner, request, alternatives) {
  const free = winner.evaluation.free;
  const parts = [`node ${winner.node.name} selected`];

  if (request.gpu > 0) {
    parts.push(`${request.gpu} of ${free.gpu} free GPU(s), leaving ${free.gpu - request.gpu}`);
  } else if (schedulableGpus(winner.node) === 0) {
    parts.push('CPU-only job kept off GPU nodes');
  }
  parts.push(`${request.cpu} of ${free.cpu} free CPU`);

  if (alternatives > 0) {
    parts.push(`best fit of ${alternatives + 1} candidates`);
  }
  return parts.join('; ');
}

/** One line explaining why nothing fit — what a queued job's owner actually reads. */
function summarise(evaluated, request) {
  const byCode = new Map();
  for (const { evaluation } of evaluated) {
    byCode.set(evaluation.code, (byCode.get(evaluation.code) ?? 0) + 1);
  }

  const asked = [`${request.cpu} CPU`];
  if (request.gpu > 0) asked.push(`${request.gpu} GPU`);
  if (Number(request.memory_bytes) > 0) asked.push(`${gib(request.memory_bytes)} GiB memory`);

  const blockers = [...byCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${count} × ${code}`)
    .join(', ');

  return `no node can currently fit ${asked.join(', ')} (${blockers})`;
}

function decisionRow(node, evaluation, request, { winner = null } = {}) {
  const { fits, reason, free, code, ...numbers } = evaluation;
  return {
    node_id: node.id,
    node_name: node.name,
    outcome: fits ? Outcome.VIABLE : Outcome.REJECTED,
    reason: reason ?? viableReason(node, winner),
    details: {
      code: code ?? null,
      requested: {
        cpu: request.cpu,
        gpu: request.gpu,
        memory_bytes: Number(request.memory_bytes),
        gpu_memory_min_bytes: Number(request.gpu_memory_min_bytes ?? 0),
      },
      free: free ?? freeCapacity(node),
      ...numbers,
    },
  };
}

/** Bytes as GiB, one decimal — for reasons a human reads, never for arithmetic. */
function gib(bytes) {
  return (Number(bytes) / 1024 ** 3).toFixed(1);
}
