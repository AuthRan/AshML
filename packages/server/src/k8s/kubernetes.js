/**
 * The real Kubernetes backend, built on `@kubernetes/client-node`.
 *
 * This is the only module in AshML that imports the Kubernetes client. Everything it
 * exposes is in AshML's vocabulary (see `backend.js`) so that swapping the cluster
 * for a fake — or later for an operator — touches nothing above it.
 */

import https from 'node:https';

import * as k8s from '@kubernetes/client-node';

import { Phase, registerBackend, observationFromJobStatus } from './backend.js';
import {
  MANAGED_BY,
  DEFAULT_CLUSTER_POD_CIDR,
  buildProjectNetworkPolicyManifest,
} from './manifest.js';
import { cidrContains, isIpv4Cidr, podCidrsOf } from './cidr.js';

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
 * @param {string} [options.kubeconfigContext] which context in that file to use;
 *   defaults to whatever `current-context` says
 * @param {boolean} [options.networkPolicyEnabled] apply the per-project NetworkPolicy
 * @param {string} [options.clusterPodCidr] the addresses this cluster gives to pods;
 *   the policy's "everything that is not a pod here" rule is written against it
 */
export function createKubernetesBackend({
  namespace = 'ashml-jobs', kubeconfig = null, kubeconfigContext = null,
  networkPolicyEnabled = true, clusterPodCidr = DEFAULT_CLUSTER_POD_CIDR,
} = {}) {
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

    if (kubeconfigContext) {
      // Checked rather than set blindly. `setCurrentContext` accepts any string, and a
      // typo would surface much later as a null cluster inside an unrelated call.
      const known = kc.getContexts().map((context) => context.name);
      if (!known.includes(kubeconfigContext)) {
        throw new Error(
          `ASHML_KUBECONFIG_CONTEXT="${kubeconfigContext}" is not in this kubeconfig `
          + `(it has: ${known.join(', ') || 'no contexts'})`,
        );
      }
      kc.setCurrentContext(kubeconfigContext);
    }

    clients = {
      core: kc.makeApiClient(k8s.CoreV1Api),
      batch: kc.makeApiClient(k8s.BatchV1Api),
      apps: kc.makeApiClient(k8s.AppsV1Api),
      networking: kc.makeApiClient(k8s.NetworkingV1Api),
      // Kept alongside the generated clients because `callService` needs the config
      // itself, not an API client: the generated proxy method cannot carry a request
      // body, so that one request is built by hand against the same credentials.
      config: kc,
    };
    return clients;
  }

  /**
 * The labels on the namespace AshML runs workloads in.
 *
 * The interesting ones are Kubernetes' built-in **Pod Security Admission**, and they are
 * here because they are the half of spec §31 that AshML cannot provide itself. The
 * manifest builder already refuses to put anything dangerous in a Pod — the container is
 * assembled from an allowlist, so a job spec has no path to `privileged`, `hostNetwork`
 * or a `hostPath` mount. But that is *AshML* checking AshML. Anything else with write
 * access to this namespace is unconstrained, and the roadmap has said since Phase 10 that
 * a project's pods are isolated by AshML's admission checks and not by the cluster's.
 * A namespace label moves one of those checks to the cluster, where it applies to
 * everything, including AshML.
 *
 * **`enforce: baseline`** and not `restricted`, and the difference is one requirement:
 * `restricted` demands `runAsNonRoot`, which refuses any image that does not declare a
 * `USER` — including `busybox`, the image this platform's own end-to-end test runs. Every
 * *other* thing `restricted` asks for is already satisfied by `podHardening` and
 * `containerHardening`, so this is a one-word change the day every image in use declares
 * a user, rather than a distant ambition.
 *
 * `warn` is deliberately unset. It would attach a warning to every Job this server
 * creates, saying the same sentence each time; a warning that appears on every successful
 * operation is one an operator stops reading, which costs more than the two lines of
 * documentation it replaces.
 */
function namespaceLabels() {
  return {
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'pod-security.kubernetes.io/enforce': 'baseline',
    // Pinned to `latest` rather than a version: the point is to track what the cluster
    // currently considers baseline, not to freeze a 2026 definition of it.
    'pod-security.kubernetes.io/enforce-version': 'latest',
    'pod-security.kubernetes.io/audit': 'restricted',
    'pod-security.kubernetes.io/audit-version': 'latest',
  };
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

  /**
   * Why a deployment is short of ready replicas, in words an operator can act on.
   *
   * The Deployment's own status says "0 of 1 ready" and nothing else until its progress
   * deadline expires ten minutes later — so for those ten minutes an operator looking at
   * AshML would see DEGRADED with no explanation and have to reach for kubectl, which is
   * the thing this platform exists to make unnecessary. The Pod knows more, exactly as it
   * does for a Job (`reasonFromPod`).
   *
   * A pod that is Running but not Ready is the interesting case and the one this was
   * written for: nothing is wrong from Kubernetes' point of view, the container simply
   * has not passed its readiness probe. For a model server that means the weights are not
   * loaded, and the pod's own `/readyz` says why — so the reason points there rather than
   * guessing at it.
   */
  async function reasonFromDeploymentPods(ns, deployment) {
    const selector = deployment.spec?.selector?.matchLabels ?? {};
    const labelSelector = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',');
    if (!labelSelector) return null;

    let pods;
    try {
      const listed = await core().listNamespacedPod({ namespace: ns, labelSelector });
      pods = listed.items ?? [];
    } catch {
      // Diagnosis must never be the reason the status loop fails. Without the reason the
      // status is still correct, just less useful.
      return null;
    }

    if (pods.length === 0) return 'no pods exist for this deployment yet';

    for (const pod of pods) {
      const reason = reasonFromPod(pod);
      if (reason) return reason;
    }

    const notReady = pods.find((pod) => !(pod.status?.containerStatuses ?? []).every((c) => c.ready));
    if (notReady) {
      return `pod ${notReady.metadata?.name} is ${pod0Phase(notReady)} but has not become ready; `
        + 'ask the pod itself (/readyz) or read its logs';
    }
    return null;
  }

  const pod0Phase = (pod) => (pod.status?.phase ?? 'present').toLowerCase();
  const core = () => connect().core;

  return {
    name: 'kubernetes',
    namespace,

    /**
     * Which cluster this backend is actually talking to.
     *
     * Logged at startup, and that is the entire point. `current-context` is a global
     * setting owned by whoever last ran `kubectl config use-context`, so a control plane
     * started without ASHML_KUBECONFIG_CONTEXT can come back from a restart pointed at a
     * different cluster than the one it was creating Jobs in — and every symptom of that
     * is misleading. Nodes vanish, running jobs report their Kubernetes Job as gone, and
     * nothing anywhere says "different cluster". One line in the startup log turns that
     * into something an operator sees before it costs them an afternoon.
     */
    describeTarget() {
      const { config } = connect();
      const context = config.getCurrentContext();
      return {
        context,
        cluster: config.getCurrentCluster()?.name ?? null,
        server: config.getCurrentCluster()?.server ?? null,
        pinned: kubeconfigContext !== null,
      };
    },

    /**
     * Creates the namespace if it is absent, and keeps its labels current either way.
     *
     * Safe to call on every startup, and it has to be: the labels below are Kubernetes'
     * own admission control, and a namespace created by an older version of this server —
     * or by hand — would otherwise never acquire them. An earlier version returned as soon
     * as the namespace existed, which meant every cluster that had ever run AshML was the
     * one cluster that would not get them.
     */
    async ensureNamespace() {
      const { core } = connect();
      let exists = true;
      try {
        await core.readNamespace({ name: namespace });
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
        exists = false;
      }

      if (exists) {
        // Merge-patch: it sets the labels below and leaves anything else on the
        // namespace alone, so a label somebody else put there is not collateral.
        await core.patchNamespace(
          { name: namespace, body: { metadata: { labels: namespaceLabels() } } },
          k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
        );
        return;
      }

      try {
        await core.createNamespace({
          body: { metadata: { name: namespace, labels: namespaceLabels() } },
        });
      } catch (err) {
        // Another server replica won the race; that is the outcome we wanted.
        if (statusOf(err) !== 409) throw err;
      }
    },

    /**
     * Puts the project's network boundary in place, before anything of that project's
     * runs.
     *
     * Called on every launch and every deployment apply rather than once, and it is one
     * API call either way: a policy created at startup and deleted by hand at noon would
     * otherwise stay deleted until the next restart, which is a security control whose
     * absence nothing reports. Applying it on the path that needs it means the boundary
     * is re-asserted by the same action that creates the thing it protects.
     *
     * **Before** the workload, not after. The gap between a pod starting and its policy
     * arriving is a real window, small and entirely avoidable by ordering. A failure here
     * therefore fails the launch: a training pod that runs without its boundary is a
     * quieter outcome than one that does not run, and the quieter outcome is the wrong
     * one.
     *
     * Replaced rather than left alone when it already exists, like a Secret and unlike a
     * Service — the whole point of the object is its contents, and this server's idea of
     * what the rules should be is newer than a policy written by an older version of it.
     */
    async ensureProjectIsolation(project) {
      if (!networkPolicyEnabled) return;

      const manifest = buildProjectNetworkPolicyManifest(project, {
        namespace, clusterPodCidr,
      });
      const { networking } = connect();
      try {
        await networking.createNamespacedNetworkPolicy({ namespace, body: manifest });
      } catch (err) {
        if (statusOf(err) !== 409) throw err;
        await networking.replaceNamespacedNetworkPolicy({
          namespace,
          name: manifest.metadata.name,
          body: manifest,
        });
      }
    },

    /**
     * Checks the configured pod CIDR against what the cluster's nodes actually report.
     *
     * The one setting in the isolation policy that can be wrong without anything
     * failing. `ASHML_CLUSTER_POD_CIDR` decides which addresses the policy treats as
     * "outside this cluster and therefore allowed"; set too narrow, the pods it misses
     * are exactly the pods it was meant to exclude, and a project's egress to another
     * project's model server is permitted by the rule written to forbid it. Nothing
     * errors. Nothing logs. The boundary is simply not there for those nodes.
     *
     * So it is compared with `spec.podCIDR` on every node, at startup, and the answer is
     * a list of sentences for the log rather than a thrown error: a cluster whose node
     * ranges do not match is a cluster that needs the operator to look, not one this
     * server should refuse to run against — the policy is still enforced for every node
     * that *is* covered, and exiting would take that away too.
     *
     * @returns {Promise<string[]>} what an operator needs to be told; empty when it agrees
     */
    async verifyClusterPodCidr() {
      if (!networkPolicyEnabled) return [];

      const warnings = [];
      if (!isIpv4Cidr(clusterPodCidr)) {
        return [
          `ASHML_CLUSTER_POD_CIDR="${clusterPodCidr}" is not an IPv4 CIDR block; `
          + 'per-project network isolation cannot be trusted until it is one',
        ];
      }

      const { core } = connect();
      const nodes = (await core.listNode()).items ?? [];
      for (const node of nodes) {
        const name = node.metadata?.name ?? '(unnamed node)';
        for (const cidr of podCidrsOf(node)) {
          if (!isIpv4Cidr(cidr)) {
            warnings.push(
              `node ${name} gives pods ${cidr}, which is not IPv4: the per-project `
              + 'network policy excludes IPv4 pod addresses only, so traffic between '
              + 'projects over IPv6 is not refused',
            );
            continue;
          }
          if (!cidrContains(clusterPodCidr, cidr)) {
            warnings.push(
              `node ${name} gives pods ${cidr}, which is outside `
              + `ASHML_CLUSTER_POD_CIDR=${clusterPodCidr}: pods on that node are treated `
              + 'as outside the cluster, so other projects may reach them. Widen the '
              + 'setting to cover every node.',
            );
          }
        }
      }
      return warnings;
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

    /**
     * Creates a Deployment, or updates the one already there.
     *
     * Unlike a training Job, a deployment is a long-lived object that legitimately
     * changes: rolling out a new model version is an update to the same Deployment, and
     * Kubernetes' rolling update is what keeps the old pods serving until the new ones
     * pass their readiness probe. Deleting and recreating would drop traffic on every
     * version change for no benefit.
     *
     * 409 therefore means "already exists, update it", where for `createJob` it meant
     * "leave it alone" — the difference is that a Job's identity includes its attempt
     * number, so a colliding Job is the same attempt, while a colliding Deployment is
     * the previous state of a thing that is meant to be mutated.
     */
    async applyDeployment(manifest) {
      const { apps } = connect();
      const ns = manifest.metadata.namespace ?? namespace;
      try {
        await apps.createNamespacedDeployment({ namespace: ns, body: manifest });
      } catch (err) {
        if (statusOf(err) !== 409) throw err;
        await apps.replaceNamespacedDeployment({
          namespace: ns,
          name: manifest.metadata.name,
          body: manifest,
        });
      }
    },

    /**
     * Creates or replaces a Secret.
     *
     * Replaced rather than left alone, unlike a Service: the whole point of this object
     * is that its contents change when a credential is rotated, and a Secret has no
     * cluster-assigned immutable fields to collide with.
     *
     * Rotating it does not restart anything. That is deliberate and is the reason the
     * serving token lives here rather than inline in the pod template: a Pod reads a
     * Secret-backed environment variable once, at start, so the running pods keep the
     * value they were given and only pods created after the rotation see the new one.
     */
    async applySecret(manifest) {
      const { core } = connect();
      const ns = manifest.metadata.namespace ?? namespace;
      try {
        await core.createNamespacedSecret({ namespace: ns, body: manifest });
      } catch (err) {
        if (statusOf(err) !== 409) throw err;
        await core.replaceNamespacedSecret({
          namespace: ns,
          name: manifest.metadata.name,
          body: manifest,
        });
      }
    },

    /** Deletes a Secret. Absent is success: this is called to make it not exist. */
    async deleteSecret(ns, name) {
      const { core } = connect();
      try {
        await core.deleteNamespacedSecret({ namespace: ns ?? namespace, name });
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
      }
    },

    /**
     * Deletes every Secret in a namespace carrying the given labels.
     *
     * One call rather than one per name, because the caller that needs it — a job that
     * has finished — does not know how many attempts it had, and a per-attempt Secret is
     * exactly the thing there can be an unknown number of.
     *
     * Absent is success, like `deleteSecret`: this is called to make them not exist.
     *
     * @param {object} labels e.g. `{ 'ashml.io/job-id': id }`
     */
    async deleteSecrets(ns, labels) {
      const { core } = connect();
      const labelSelector = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
      if (!labelSelector) {
        // An empty selector matches everything. Refused rather than obeyed: this is a
        // delete, and the difference between "no labels given" and "delete every Secret
        // in the namespace" is not one to resolve by guessing.
        throw new Error('deleteSecrets: at least one label is required');
      }
      try {
        await core.deleteCollectionNamespacedSecret({ namespace: ns ?? namespace, labelSelector });
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
      }
    },

    /**
     * Creates the Service if it is absent.
     *
     * Not replaced when it already exists: a Service's `spec.clusterIP` is assigned by
     * the cluster and immutable, so sending back a manifest without it is rejected. The
     * fields AshML sets — selector, ports — do not change for the life of a deployment,
     * so there is nothing to update anyway.
     */
    async applyService(manifest) {
      const { core } = connect();
      const ns = manifest.metadata.namespace ?? namespace;
      try {
        await core.createNamespacedService({ namespace: ns, body: manifest });
      } catch (err) {
        if (statusOf(err) !== 409) throw err;
      }
    },

    /**
     * Reports what the cluster currently shows for a Deployment.
     *
     * `ready` is the number that decides whether AshML calls a deployment READY, and it
     * is deliberately `readyReplicas` rather than `replicas` or `availableReplicas`:
     * `replicas` counts pods that exist, including ones still downloading a model and
     * failing their readiness probe. Reporting those as ready is exactly the overclaim
     * the probe split exists to prevent.
     *
     * @returns {Promise<object|null>} null when the Deployment does not exist
     */
    async observeDeployment(ns, name) {
      const { apps } = connect();
      let deployment;
      try {
        deployment = await apps.readNamespacedDeployment({ namespace: ns, name });
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }

      const status = deployment.status ?? {};
      const conditions = status.conditions ?? [];

      // Kubernetes reports a stalled rollout as Progressing=False with reason
      // ProgressDeadlineExceeded. Surfacing its own message is more use than
      // paraphrasing it: it names the ReplicaSet that could not come up.
      const progressing = conditions.find((c) => c.type === 'Progressing');
      const failure = progressing?.status === 'False' ? (progressing.message ?? progressing.reason) : null;

      const desired = deployment.spec?.replicas ?? 0;
      const ready = status.readyReplicas ?? 0;

      return {
        desired,
        ready,
        available: status.availableReplicas ?? 0,
        updated: status.updatedReplicas ?? 0,
        reason: failure,
        // Only asked for when it is needed. A healthy deployment does not need its pods
        // listed on every sync, and this loop runs for as long as the deployment exists.
        pendingReason: ready >= desired ? null : await reasonFromDeploymentPods(ns, deployment),
      };
    },

    /**
     * Makes one HTTP request to a Service inside the cluster, through the API server.
     *
     * A deployment's Service is a ClusterIP, which is right for serving and useless from
     * here: the control plane usually runs outside the cluster, and `127.0.0.1` in a
     * kubeconfig is not a route to a pod network. The alternatives are a port-forward
     * (needs kubectl, and a process to hold it open) or making every Service reachable
     * from outside (a NodePort per model, addresses that depend on which node answered).
     * The API server already proxies to Services and this process already holds
     * credentials for it, so nothing new has to be exposed or installed.
     *
     * **This is not the serving path, and must not become one.** It exists so a human can
     * ask a deployment a question — `ash predict`, a smoke test, a demo — from a laptop.
     * Real traffic goes to `endpoint_url` from inside the cluster, because every request
     * routed through here occupies the event loop that also runs the scheduler, and
     * because a control plane that is down should not take inference down with it.
     */
    async callService(ns, name, { path = '/', method = 'GET', body = null, timeoutMs = 15_000, port = 80 } = {}) {
      const { config } = connect();
      const cluster = config.getCurrentCluster();
      if (!cluster) throw new Error('no current cluster in the kubeconfig');

      const options = {};
      await config.applyToHTTPSOptions(options);

      const url = new URL(
        `${cluster.server}/api/v1/namespaces/${ns}/services/${name}:${port}/proxy${path}`,
      );
      const payload = body === null ? null : Buffer.from(JSON.stringify(body));

      return new Promise((resolve, reject) => {
        const request = https.request(url, {
          ...options,
          method,
          headers: {
            ...(options.headers ?? {}),
            ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          },
          timeout: timeoutMs,
        }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            let parsed = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              // A proxy error page, or a service that does not speak JSON. The status
              // and the raw text are still what the caller needs to explain it.
            }
            // Headers are carried through because the model router puts its
            // attribution in them: `x-ashml-served-by` is which version actually
            // answered, which with a split in place is something only the router knows
            // and the control plane must not guess at.
            resolve({
              status: response.statusCode,
              headers: response.headers ?? {},
              body: parsed,
              text,
            });
          });
        });

        request.on('timeout', () => {
          // `destroy` does not itself reject; the error handler below does, and this
          // message names the timeout rather than surfacing a bare socket hang up.
          request.destroy(new Error(`no answer from ${name} within ${timeoutMs}ms`));
        });
        request.on('error', reject);
        if (payload) request.write(payload);
        request.end();
      });
    },

    /**
     * Moves a Service's selector to point at different pods.
     *
     * This is how a deployment changes what it serves without changing where it is. A
     * Service's `clusterIP` and DNS name survive a selector change, so every caller
     * holding the address keeps working; deleting and recreating the Service to point
     * somewhere else would issue a new IP and break every open connection and cached
     * lookup at once.
     *
     * A patch rather than a replace, for the reason `applyService` gives for not
     * replacing: the manifest AshML holds has no `clusterIP`, and sending it back would
     * be rejected. Patching sends only the field that is actually changing, which is also
     * what makes this safe against a Service an operator has since annotated.
     *
     * `$patch: replace` is the whole point of the call. A selector is a map, and both
     * merge-patch flavours *merge* maps: patching `{a, b}` over `{a, b, c}` leaves `c`
     * in place. That is exactly the failure this operation must not have — moving the
     * front door from a version's pods to the router's drops the `ashml.io/model-version`
     * key, and a merge that kept it would leave a selector matching nothing at all,
     * turning a routine rollout into an outage with no error anywhere. The directive
     * replaces the map wholesale, so the selector afterwards is what was asked for.
     */
    async patchServiceSelector(ns, name, selector) {
      const { core } = connect();
      await core.patchNamespacedService(
        { namespace: ns, name, body: { spec: { selector: { $patch: 'replace', ...selector } } } },
        k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.StrategicMergePatch),
      );
    },

    /**
     * Names every Deployment in a namespace carrying the given labels.
     *
     * Used to find Kubernetes objects AshML created and no longer has a row for — a
     * version removed from a split, or objects left behind by a process that died
     * between creating them and recording them. Asking the cluster what exists is the
     * only way to find the second kind: anything derived from the database can only
     * report what the database already knows about.
     *
     * @param {object} labels e.g. `{ 'ashml.io/deployment-id': id }`
     */
    async listDeploymentNames(ns, labels) {
      const { apps } = connect();
      const labelSelector = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
      const listed = await apps.listNamespacedDeployment({ namespace: ns, labelSelector });
      return (listed.items ?? []).map((item) => ({
        name: item.metadata.name,
        labels: item.metadata.labels ?? {},
      }));
    },

    /**
     * Removes a deployment's Deployment and its Service.
     *
     * Both, because they are one thing to the operator who asked for it, and a Service
     * left behind resolves to no endpoints — which fails as a connection timeout rather
     * than as anything that mentions a deleted deployment.
     */
    async deleteDeployment(ns, name) {
      const { apps, core } = connect();
      for (const remove of [
        () => apps.deleteNamespacedDeployment({ namespace: ns, name, propagationPolicy: 'Background' }),
        () => core.deleteNamespacedService({ namespace: ns, name }),
      ]) {
        try {
          await remove();
        } catch (err) {
          // Already gone is the state we were asking for.
          if (statusOf(err) !== 404) throw err;
        }
      }
    },

    async close() {
      // The client holds no pooled connections that need draining; this exists so the
      // backend interface is uniform and callers need not special-case it.
    },
  };
}

registerBackend('kubernetes', createKubernetesBackend);
