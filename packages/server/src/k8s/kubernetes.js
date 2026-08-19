/**
 * The real Kubernetes backend, built on `@kubernetes/client-node`.
 *
 * This is the only module in AshML that imports the Kubernetes client. Everything it
 * exposes is in AshML's vocabulary (see `backend.js`) so that swapping the cluster
 * for a fake — or later for an operator — touches nothing above it.
 */

import * as k8s from '@kubernetes/client-node';

import { Phase, registerBackend, observationFromJobStatus } from './backend.js';
import { MANAGED_BY } from './manifest.js';

/** @returns {number|null} the HTTP status of a client error, or null if it is not one. */
function statusOf(err) {
  return typeof err?.code === 'number' ? err.code : null;
}

/**
 * Pulls a human-readable reason out of a Pod.
 *
 * A Job's own status says "0 succeeded, 1 active" and nothing more, so when a run is
 * stuck the useful information — `ImagePullBackOff`, `CreateContainerConfigError`,
 * an OOM kill, a non-zero exit code — is only on the Pod. Surfacing it is what makes
 * `ash job get` able to explain a failure instead of just reporting one.
 */
function reasonFromPod(pod) {
  if (!pod) return '';

  const statuses = [
    ...(pod.status?.containerStatuses ?? []),
    ...(pod.status?.initContainerStatuses ?? []),
  ];

  for (const status of statuses) {
    const waiting = status.state?.waiting;
    if (waiting?.reason) {
      return waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason;
    }
    const terminated = status.state?.terminated;
    if (terminated && terminated.exitCode !== 0) {
      const detail = terminated.reason || 'error';
      return `container exited ${terminated.exitCode} (${detail})`;
    }
  }

  // A Pod that cannot be scheduled at all reports it here, not on any container.
  const unschedulable = (pod.status?.conditions ?? [])
    .find((c) => c.type === 'PodScheduled' && c.status === 'False');
  if (unschedulable) {
    return unschedulable.message
      ? `${unschedulable.reason}: ${unschedulable.message}`
      : (unschedulable.reason || 'pod not scheduled');
  }

  return pod.status?.reason || '';
}

/**
 * Sums the resource requests of Pods that AshML did not create, per node.
 *
 * Kubernetes reserves against *requests*, not usage, and it counts every Pod on the
 * node — kube-system daemons, the CNI, metrics-server, anything else sharing the
 * cluster. AshML reading `allocatable` alone would believe the whole node is its own,
 * admit jobs summing to all of it, and then have Kubernetes refuse the last one because
 * the system Pods were already there. The job would sit Pending while AshML insisted it
 * had been placed.
 *
 * Only running and pending Pods count: a Succeeded or Failed Pod holds nothing.
 */
async function reservedByForeignPods(core) {
  const pods = await core.listPodForAllNamespaces({
    fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed',
  });

  const byNode = new Map();
  for (const pod of pods.items) {
    const nodeName = pod.spec?.nodeName;
    if (!nodeName) continue; // Not yet bound, so holding nothing.

    // AshML's own jobs are already accounted for in its database; counting them here
    // as well would charge every running job to the node twice.
    if (pod.metadata?.labels?.['app.kubernetes.io/managed-by'] === MANAGED_BY) continue;

    const entry = byNode.get(nodeName) ?? { cpu: 0, memory_bytes: 0 };
    for (const container of [...(pod.spec.containers ?? []), ...(pod.spec.initContainers ?? [])]) {
      const requests = container.resources?.requests ?? {};
      entry.cpu += parseCpuMillis(requests.cpu);
      entry.memory_bytes += parseMemory(requests.memory);
    }
    byNode.set(nodeName, entry);
  }

  // Summed in milli-cores and rounded *up* to whole cores at the end. Rounding each
  // container down would let a hundred 100m system Pods reserve nothing at all.
  for (const entry of byNode.values()) {
    entry.cpu = Math.ceil(entry.cpu / 1000);
  }
  return byNode;
}

/** Parses a CPU quantity into milli-cores, keeping the precision `parseCpu` discards. */
function parseCpuMillis(quantity) {
  if (!quantity) return 0;
  const text = String(quantity);
  if (text.endsWith('m')) return Number.parseInt(text.slice(0, -1), 10) || 0;
  return Math.round(Number.parseFloat(text) * 1000) || 0;
}

/**
 * Parses a Kubernetes CPU quantity into whole cores, rounding down.
 *
 * Kubernetes expresses CPU in cores or in milli-cores ("8" or "7800m"). AshML schedules
 * in whole cores, and rounding *down* is the only safe direction: rounding 7800m up to
 * 8 would let the scheduler promise a core the node cannot grant.
 */
function parseCpu(quantity) {
  if (!quantity) return 0;
  const text = String(quantity);
  if (text.endsWith('m')) {
    return Math.floor(Number.parseInt(text.slice(0, -1), 10) / 1000);
  }
  return Math.floor(Number.parseFloat(text));
}

/** Parses a Kubernetes memory quantity ("64Gi", "1024Mi", "8000000") into bytes. */
function parseMemory(quantity) {
  if (!quantity) return 0;
  const text = String(quantity).trim();

  const suffixes = [
    ['Ki', 1024], ['Mi', 1024 ** 2], ['Gi', 1024 ** 3], ['Ti', 1024 ** 4],
    ['k', 1000], ['M', 1000 ** 2], ['G', 1000 ** 3], ['T', 1000 ** 4],
  ];
  for (const [suffix, multiplier] of suffixes) {
    if (text.endsWith(suffix)) {
      return Math.floor(Number.parseFloat(text.slice(0, -suffix.length)) * multiplier);
    }
  }
  return Math.floor(Number.parseFloat(text)) || 0;
}

/**
 * @param {object} [options]
 * @param {string} [options.namespace] namespace training Jobs are created in
 * @param {string} [options.kubeconfig] path to a kubeconfig; defaults to the standard
 *   resolution order, which also picks up in-cluster credentials
 */
export function createKubernetesBackend({ namespace = 'ashml-jobs', kubeconfig = null } = {}) {
  // Credentials are resolved on first use, not here. Constructing a backend is
  // therefore pure, which is what lets `buildApp` decorate one unconditionally —
  // including in tests and on machines with no kubeconfig at all. A genuinely missing
  // or broken config still fails loudly, at the point something tries to use it, and
  // the server calls `ensureNamespace()` on startup precisely so that point is startup.
  let clients = null;

  function connect() {
    if (clients) return clients;

    const kc = new k8s.KubeConfig();
    if (kubeconfig) {
      kc.loadFromFile(kubeconfig);
    } else {
      // Handles both a developer's ~/.kube/config and the service-account credentials
      // mounted into a Pod, so the server runs unchanged in either place.
      kc.loadFromDefault();
    }

    clients = {
      core: kc.makeApiClient(k8s.CoreV1Api),
      batch: kc.makeApiClient(k8s.BatchV1Api),
    };
    return clients;
  }

  /** Finds the Pod belonging to a Job, or null. */
  async function podFor(ns, jobName) {
    const { core } = connect();
    const pods = await core.listNamespacedPod({
      namespace: ns,
      labelSelector: `job-name=${jobName}`,
    });
    if (pods.items.length === 0) return null;

    // A Job with backoffLimit 0 has at most one Pod, but a Pod being replaced can
    // briefly make two visible. The newest is the one that reflects current state.
    return pods.items.reduce((newest, pod) => (
      Date.parse(pod.metadata?.creationTimestamp ?? 0) > Date.parse(newest.metadata?.creationTimestamp ?? 0)
        ? pod
        : newest
    ));
  }

  return {
    name: 'kubernetes',
    namespace,

    /** Creates the namespace if it is absent. Safe to call on every startup. */
    async ensureNamespace() {
      const { core } = connect();
      try {
        await core.readNamespace({ name: namespace });
        return;
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
      }

      try {
        await core.createNamespace({
          body: {
            metadata: {
              name: namespace,
              labels: { 'app.kubernetes.io/managed-by': MANAGED_BY },
            },
          },
        });
      } catch (err) {
        // Another server replica won the race; that is the outcome we wanted.
        if (statusOf(err) !== 409) throw err;
      }
    },

    /**
     * Lists the cluster's nodes as the scheduler needs to see them.
     *
     * `status.allocatable` is used rather than `status.capacity`: capacity is the
     * machine's total, while allocatable is what Kubernetes will actually hand to Pods
     * after reserving for the kubelet and system daemons. Scheduling against capacity
     * would promise resources the cluster has already spoken for.
     */
    async listNodes() {
      const { core } = connect();
      const nodes = await core.listNode();

      // What Pods AshML did not create have already claimed. Read once for the whole
      // cluster rather than per node, because it is one API call either way.
      const reserved = await reservedByForeignPods(core);

      return nodes.items.map((node) => {
        const allocatable = node.status?.allocatable ?? {};
        const ready = (node.status?.conditions ?? [])
          .some((c) => c.type === 'Ready' && c.status === 'True');
        const claimed = reserved.get(node.metadata.name) ?? { cpu: 0, memory_bytes: 0 };

        return {
          name: node.metadata.name,
          ready,
          cpu_cores: parseCpu(allocatable.cpu),
          memory_bytes: parseMemory(allocatable.memory),
          // The advertised figure, not the hardware. Zero here with GPUs physically
          // present means no device plugin — see migration 1755300000000.
          gpu_capacity: Number.parseInt(allocatable['nvidia.com/gpu'] ?? '0', 10) || 0,
          reserved_cpu: claimed.cpu,
          reserved_memory: claimed.memory_bytes,
          labels: node.metadata.labels ?? {},
        };
      });
    },

    /**
     * Creates the Job.
     *
     * An existing Job with the same name is treated as success, not as an error: the
     * name is derived deterministically from the job id and attempt, so a 409 means
     * this exact attempt was already launched — most likely the server restarted
     * between creating the Job and recording that it had. Re-launching would be the
     * bug; accepting the existing Job is what makes the launch idempotent.
     */
    async createJob(manifest) {
      const { batch } = connect();
      try {
        await batch.createNamespacedJob({
          namespace: manifest.metadata.namespace ?? namespace,
          body: manifest,
        });
      } catch (err) {
        if (statusOf(err) !== 409) throw err;
      }
    },

    /**
     * Reports what the cluster currently shows for a Job.
     *
     * @returns {Promise<object|null>} null when the Job does not exist
     */
    async observeJob(ns, name) {
      const { batch } = connect();
      let job;
      try {
        job = await batch.readNamespacedJob({ namespace: ns, name });
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }

      const pod = await podFor(ns, name).catch(() => null);
      const podReason = reasonFromPod(pod);
      const observation = observationFromJobStatus(job.status ?? {}, { podReason });

      // The Job counts a Pod as `active` from the moment it exists, including while
      // it is still pulling its image. AshML distinguishes STARTING from RUNNING, so
      // the Pod's own phase is what decides which one this is.
      if (observation.phase === Phase.RUNNING && pod?.status?.phase === 'Pending') {
        return { ...observation, phase: Phase.PENDING, reason: podReason || 'pod pending' };
      }

      return { ...observation, node: pod?.spec?.nodeName ?? null };
    },

    /**
     * Deletes a Job and the Pods it owns.
     *
     * `Background` propagation means the call returns as soon as the Job is marked for
     * deletion and the garbage collector removes the Pods after — without it the Pods
     * are orphaned and keep holding their GPU.
     */
    async deleteJob(ns, name) {
      const { batch } = connect();
      try {
        await batch.deleteNamespacedJob({
          namespace: ns,
          name,
          propagationPolicy: 'Background',
        });
      } catch (err) {
        // Already gone is the state we were asking for.
        if (statusOf(err) !== 404) throw err;
      }
    },

    /**
     * Reads the training container's logs.
     *
     * @param {object} [options]
     * @param {number} [options.tailLines] most recent N lines; omit for everything
     * @param {boolean} [options.previous] read the previous container instance, which
     *   is where the useful output lives after a crash
     */
    async readLogs(ns, name, { tailLines = null, previous = false } = {}) {
      const { core } = connect();
      const pod = await podFor(ns, name);
      if (!pod) return null;

      // Read the whole body in one call rather than through the streaming `Log`
      // helper. Streaming is the right tool for `follow`, which this is not: for a
      // finished run the caller wants the complete output, and collecting a stream to
      // get it means resolving when the *stream* ends rather than when the request
      // does — a distinction that silently truncates the last lines when it is wrong.
      try {
        return await core.readNamespacedPodLog({
          namespace: ns,
          name: pod.metadata.name,
          container: 'training',
          previous,
          ...(tailLines ? { tailLines } : {}),
        });
      } catch (err) {
        // The Pod exists but its container has not started, or its logs were rotated
        // away. Neither is an error worth failing the request over.
        if (statusOf(err) === 400 || statusOf(err) === 404) return null;
        throw err;
      }
    },

    async close() {
      // The client holds no pooled connections that need draining; this exists so the
      // backend interface is uniform and callers need not special-case it.
    },
  };
}

registerBackend('kubernetes', createKubernetesBackend);
