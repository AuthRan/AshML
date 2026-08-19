/**
 * Node and GPU inventory.
 *
 * Two different sources describe the same machines, and keeping them straight is the
 * whole job of this module:
 *
 * - **Kubernetes** knows which nodes exist, whether they are Ready, and how much CPU,
 *   memory and `nvidia.com/gpu` it will actually grant to a Pod.
 * - **`GpuProvider`** knows what the silicon is: model, total memory, utilisation,
 *   temperature, health (ADR 0005).
 *
 * Neither is sufficient alone. Kubernetes cannot tell you a GPU is running hot or has
 * fallen over; `nvidia-smi` cannot tell you the cluster will refuse to schedule onto it
 * because no device plugin is installed. The scheduler needs both, so both are recorded
 * — and where they disagree, the disagreement is preserved rather than averaged away.
 */

import { withTransaction } from '../db/pool.js';
import * as nodesRepo from '../repos/nodes.js';

/**
 * Discovers the cluster and writes it to the database.
 *
 * Runs on a slower cadence than the executor: node inventory changes on the order of
 * minutes, GPU telemetry on the order of seconds, and neither is worth a query per
 * job pass.
 *
 * @returns {Promise<{nodes: number, gpus: number, retired: number, warnings: string[]}>}
 */
export async function discoverCluster(pool, backend, gpuProvider, { logger = null } = {}) {
  const warnings = [];

  const clusterNodes = await backend.listNodes();
  const devices = await gpuProvider.discover().catch((err) => {
    // A GPU provider that cannot see its hardware must not take node discovery down
    // with it: a cluster with unreadable GPUs can still run CPU work, and reporting
    // no nodes at all would stop that too.
    warnings.push(`gpu discovery failed (${err.message}); GPU inventory left unchanged`);
    logger?.warn({ err }, 'gpu discovery failed during node reconciliation');
    return null;
  });

  return withTransaction(pool, async (client) => {
    let gpuCount = 0;

    for (const node of clusterNodes) {
      const nodeId = await nodesRepo.upsertNode(client, {
        name: node.name,
        cpuCores: node.cpu_cores,
        memoryBytes: node.memory_bytes,
        ready: node.ready,
        gpuCapacity: node.gpu_capacity ?? 0,
        reservedCpu: node.reserved_cpu ?? 0,
        reservedMemory: node.reserved_memory ?? 0,
      });

      if (devices !== null && attachesGpusTo(node, clusterNodes)) {
        for (const device of devices) {
          await nodesRepo.upsertGpuDevice(client, nodeId, device);
          gpuCount += 1;
        }
      }
    }

    // Said once for the cluster rather than per node: the machine plainly has GPUs but
    // nothing can be scheduled onto them. Raised before a user spends an afternoon on a
    // Pod that will never leave Pending.
    if (devices !== null && devices.length > 0 && clusterNodes.every((n) => n.gpu_capacity === 0)) {
      warnings.push(
        `the GPU provider found ${devices.length} device(s), but no node advertises `
        + 'nvidia.com/gpu — no device plugin is installed, so GPU jobs cannot be scheduled. '
        + 'The devices are still reported by /api/v1/gpus.',
      );
    }

    const retired = await nodesRepo.markNodesMissing(
      client,
      clusterNodes.map((node) => node.name),
    );

    if (retired > 0) {
      logger?.warn({ retired }, 'nodes disappeared from the cluster and were marked not ready');
    }

    return { nodes: clusterNodes.length, gpus: gpuCount, retired, warnings };
  });
}

/**
 * Whether the locally-discovered GPUs belong to this node.
 *
 * Attached only to a node that actually advertises GPU capacity, and only when exactly
 * one node does. Anything looser guesses, and a wrong guess here is not cosmetic: the
 * devices become the node's GPU inventory, and placement will then send GPU jobs to a
 * machine that cannot run them.
 *
 * When no node advertises GPUs — the missing-device-plugin case — the devices are
 * attached to nothing. The hardware is still reported through `/api/v1/gpus`, which is
 * where "what does this machine have" belongs; `compute_nodes` answers the different
 * question of what the cluster will schedule, and the honest answer there is none.
 *
 * v1 runs on a single machine (README, known limitations). Attributing devices to
 * nodes on a real multi-machine cluster needs the provider to run per node, which is
 * what a DaemonSet is for — Phase 5, alongside DCGM.
 */
function attachesGpusTo(node, allNodes) {
  const gpuCapable = allNodes.filter((n) => n.gpu_capacity > 0);
  return gpuCapable.length === 1 && gpuCapable[0].name === node.name;
}

/** The cluster as the scheduler sees it, for the API and the CLI. */
export async function listNodes(pool) {
  return nodesRepo.clusterView(pool);
}

/**
 * Starts the discovery loop.
 *
 * Separate from the executor loop because the cadences are genuinely different, and
 * running node discovery every two seconds would add a `LIST nodes` and an `nvidia-smi`
 * fork to every job pass for information that changes far more slowly.
 */
export function startDiscovery(pool, backend, gpuProvider, { logger = null, intervalMs = 15_000 } = {}) {
  let stopped = false;
  let timer = null;
  let settled = Promise.resolve();

  async function tick() {
    if (stopped) return;
    try {
      const summary = await discoverCluster(pool, backend, gpuProvider, { logger });
      for (const warning of summary.warnings) {
        logger?.warn({ warning }, 'cluster inventory');
      }
      logger?.debug(summary, 'cluster discovery pass');
    } catch (err) {
      logger?.error({ err }, 'cluster discovery failed');
    }
    if (!stopped) {
      timer = setTimeout(() => { settled = tick(); }, intervalMs);
      timer.unref?.();
    }
  }

  settled = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await settled.catch(() => {});
    },
  };
}
