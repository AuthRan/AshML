/**
 * The single seam through which all Kubernetes knowledge enters AshML.
 *
 * Nothing above this module imports `@kubernetes/client-node`. The executor talks to
 * a backend object and never to a cluster directly, which is what lets the executor's
 * logic be tested without one — the same argument as the GPU provider seam
 * (docs/adr/0005-gpu-provider-interface.md), applied to compute.
 *
 * A backend is any object shaped like:
 *
 *   {
 *     name: string,
 *     ensureNamespace(): Promise<void>,
 *     listNodes(): Promise<NodeInfo[]>,
 *     createJob(manifest): Promise<void>,
 *     observeJob(namespace, name): Promise<Observation|null>,
 *     deleteJob(namespace, name): Promise<void>,
 *     readLogs(namespace, name, options): Promise<string>,
 *     applyDeployment(manifest): Promise<void>,
 *     applyService(manifest): Promise<void>,
 *     applySecret(manifest): Promise<void>,
 *     deleteSecret(namespace, name): Promise<void>,
 *     observeDeployment(namespace, name): Promise<DeploymentObservation|null>,
 *     deleteDeployment(namespace, name): Promise<void>,
 *     callService(namespace, name, options): Promise<ServiceResponse>,
 *     describeTarget(): { context, cluster, server, pinned },
 *     close(): Promise<void>,
 *   }
 *
 * An `Observation` is the backend's report of what the cluster currently shows, in
 * AshML's own vocabulary rather than Kubernetes':
 *
 *   {
 *     phase: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED',
 *     reason: string,     // human-readable, safe to store in failure_reason
 *     active: number, succeeded: number, failed: number,
 *   }
 *
 * `observeJob` returns null when the Job is not in the cluster at all, which the
 * executor must treat as a distinct case from "not finished yet".
 *
 * A `DeploymentObservation` is the serving equivalent, and keeps desired and ready
 * apart rather than reducing them to a single health flag:
 *
 *   { desired: number, ready: number, available: number, updated: number,
 *     reason: string|null }
 *
 * `ready` counts pods that passed their readiness probe — which for a model server
 * means the weights are loaded — not pods that merely exist. A deployment with three
 * desired and one ready is neither healthy nor failed, and that middle state is the
 * one an operator most needs to see. `observeDeployment` returns null when the
 * Deployment is absent, with the same meaning as for Jobs.
 *
 * A `ServiceResponse` is one HTTP answer from a Service inside the cluster:
 *
 *   { status: number, body: object|null, text: string }
 *
 * `callService` exists so a *human* can ask a deployment a question — `ash predict`, a
 * smoke test, a demo — from outside the cluster, where a ClusterIP is not an address.
 * It is not the serving path and must not become one: real traffic goes to
 * `endpoint_url` from inside the cluster. `body` is null when the answer was not JSON,
 * which a proxy error page will not be, and `text` is kept either way because that is
 * what explains it.
 *
 * `describeTarget` says which cluster the backend is actually talking to, so that the
 * server can log it at startup. It exists because `current-context` in a kubeconfig is a
 * global setting owned by whoever last ran `kubectl config use-context`: a control plane
 * that is restarted can come back pointed at a different cluster, and every symptom of
 * that reads as something else.
 *
 * A `NodeInfo` is what the scheduler needs to know about a machine, already converted
 * out of Kubernetes' quantity strings into plain numbers:
 *
 *   { name: string, ready: boolean, cpu_cores: number, memory_bytes: number,
 *     gpu_capacity: number }
 *
 * `gpu_capacity` is what Kubernetes advertises as `nvidia.com/gpu` — which is zero
 * until a device plugin is installed, regardless of how much silicon the machine has.
 * That difference is the point: AshML must schedule against what the cluster will
 * actually grant, not against what `nvidia-smi` can see.
 */

export const Phase = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
});

/** name -> factory. Populated by each backend module at import time. */
const factories = new Map();

/**
 * Makes a backend available to createBackend.
 * @param {string} name
 * @param {(options?: object) => object} factory
 */
export function registerBackend(name, factory) {
  if (factories.has(name)) {
    throw new Error(`k8s: backend registered twice: ${name}`);
  }
  factories.set(name, factory);
}

/** @returns {string[]} registered backend names, sorted. */
export function availableBackends() {
  return [...factories.keys()].sort();
}

/**
 * Constructs the named backend.
 *
 * Options come from config, never from the environment directly, so backends stay
 * testable without mutating process.env.
 */
export function createBackend(name, options = {}) {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(
      `k8s: unknown backend "${name}" (available: ${availableBackends().join(', ') || 'none'})`,
    );
  }
  return factory(options);
}

/** Test seam: drops all registrations. Not used by production code. */
export function _resetBackendsForTest() {
  factories.clear();
}

/**
 * Normalises a Kubernetes Job status into an Observation.
 *
 * Exported separately from the client so it can be unit-tested against recorded
 * status payloads without a cluster. The ordering of the checks matters: a Job that
 * has both a succeeded and a failed pod is reported as failed, because AshML must
 * never report success for a run that also produced a failure.
 */
export function observationFromJobStatus(status = {}, { podReason = '' } = {}) {
  const active = status.active ?? 0;
  const succeeded = status.succeeded ?? 0;
  const failed = status.failed ?? 0;

  // Kubernetes records the authoritative outcome as a condition; prefer it over
  // counting pods, which can lag.
  const conditions = status.conditions ?? [];
  const failedCondition = conditions.find((c) => c.type === 'Failed' && c.status === 'True');
  const completeCondition = conditions.find((c) => c.type === 'Complete' && c.status === 'True');

  if (failedCondition) {
    return {
      phase: Phase.FAILED,
      reason: failedCondition.message || failedCondition.reason || 'job failed',
      active, succeeded, failed,
    };
  }
  if (failed > 0) {
    return {
      phase: Phase.FAILED,
      reason: podReason || `${failed} pod(s) failed`,
      active, succeeded, failed,
    };
  }
  if (completeCondition || succeeded > 0) {
    return { phase: Phase.SUCCEEDED, reason: 'completed', active, succeeded, failed };
  }
  if (active > 0) {
    // `active` counts pods that exist, including ones still pulling their image.
    // The caller refines this with the pod's own phase where it needs the difference.
    return { phase: Phase.RUNNING, reason: podReason || 'pod active', active, succeeded, failed };
  }
  return { phase: Phase.PENDING, reason: podReason || 'no pods yet', active, succeeded, failed };
}
