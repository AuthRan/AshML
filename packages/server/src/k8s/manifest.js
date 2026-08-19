/**
 * Translation from an AshML training job into a Kubernetes Job manifest.
 *
 * This module is pure: it takes a job row and returns a plain object. No API client,
 * no network, no clock. That is deliberate — the translation is the part most likely
 * to be wrong in a way tests can catch, so it is kept separate from the code that
 * talks to the cluster (mirroring the split between `domain/job-state.js` and
 * `services/jobs.js`).
 */

/** Everything AshML creates carries these, so a stray `kubectl delete` can find it all. */
export const MANAGED_BY = 'ashml';

/** Kubernetes caps a resource name at 63 characters (DNS-1123 label). */
const MAX_NAME = 63;

/**
 * Builds the Kubernetes Job name for an attempt.
 *
 * The job UUID is what makes the name unique; the human name is a prefix so
 * `kubectl get jobs` is readable, and the attempt suffix keeps a retry from colliding
 * with the attempt it replaces. The human part is truncated rather than hashed
 * because a truncated name still tells an operator which job they are looking at.
 */
export function kubeJobName(job) {
  const attempt = job.attempt ?? 0;
  const id8 = String(job.id).replaceAll('-', '').slice(0, 8);
  const suffix = `-${id8}-${attempt}`;
  const budget = MAX_NAME - MANAGED_BY.length - 1 - suffix.length;

  // Trailing dashes are illegal in a DNS-1123 label, and truncation can leave one.
  const stem = String(job.name).slice(0, Math.max(1, budget)).replace(/-+$/, '');
  return `${MANAGED_BY}-${stem}${suffix}`;
}

/**
 * Converts a byte count into a Kubernetes quantity.
 *
 * Kubernetes accepts a plain integer as bytes, which is exactly what the database
 * stores, so no unit juggling is needed — and none is invented.
 */
function bytesToQuantity(bytes) {
  return String(bytes);
}

/**
 * Builds the container resource requirements.
 *
 * CPU and memory are set as *requests* (what the scheduler reserves) without limits:
 * a training job that briefly exceeds its memory request should be allowed to, and a
 * CPU limit would throttle a data loader for no benefit. GPUs are different —
 * `nvidia.com/gpu` is an extended resource, which Kubernetes requires to appear in
 * `limits` and to match the request exactly. It is not shareable or burstable.
 *
 * `gpu_memory_min_bytes` deliberately does not appear here. Kubernetes has no way to
 * express "a GPU with at least N bytes free"; that is an AshML placement constraint,
 * carried as an annotation and enforced by the Phase 3 scheduler.
 */
function resourceRequirements(resources) {
  const requests = {};
  const limits = {};

  if (resources.cpu > 0) requests.cpu = String(resources.cpu);
  if (resources.memory_bytes > 0) requests.memory = bytesToQuantity(resources.memory_bytes);

  if (resources.gpu > 0) {
    requests['nvidia.com/gpu'] = String(resources.gpu);
    limits['nvidia.com/gpu'] = String(resources.gpu);
  }

  const requirements = {};
  if (Object.keys(requests).length > 0) requirements.requests = requests;
  if (Object.keys(limits).length > 0) requirements.limits = limits;
  return requirements;
}

/**
 * Environment handed to the training container.
 *
 * The `ASHML_*` variables are the platform's half of the contract: they are what lets
 * a training script report metrics and checkpoints back against the right run without
 * being told twice (the Python SDK reads exactly these). User-supplied `spec.env`
 * is applied first so it can never overwrite them — a job that shadowed
 * `ASHML_JOB_ID` would report its results onto another job's record.
 */
function containerEnv(job, { apiUrl = null } = {}) {
  const env = Object.entries(job.spec.env ?? {}).map(([name, value]) => ({
    name,
    value: String(value),
  }));

  const reserved = {
    ASHML_JOB_ID: job.id,
    ASHML_JOB_NAME: job.name,
    ASHML_PROJECT: job.project,
    ASHML_ATTEMPT: String(job.attempt ?? 0),
  };
  // Omitted rather than guessed when unconfigured: a wrong endpoint makes every report
  // fail with a connection error inside the pod, which is far harder to diagnose than
  // an SDK that says plainly it was not told where to report.
  if (apiUrl) {
    reserved.ASHML_ENDPOINT = apiUrl;
  }
  if (job.experiment?.id) {
    reserved.ASHML_EXPERIMENT_ID = job.experiment.id;
  }

  const userSupplied = env.filter((entry) => !Object.hasOwn(reserved, entry.name));
  return [
    ...userSupplied,
    ...Object.entries(reserved).map(([name, value]) => ({ name, value })),
  ];
}

/**
 * Pins the Pod to the node AshML's scheduler chose.
 *
 * A `nodeSelector` on the hostname label, not `spec.nodeName`. Setting `nodeName`
 * directly would bypass the Kubernetes scheduler altogether — including its resource
 * checks and the device plugin's GPU assignment — so an error in AshML's own accounting
 * would silently over-commit the node instead of being caught.
 *
 * With a selector the division of labour is the one ADR 0003 describes: AshML decides
 * *which* node and Kubernetes verifies that the node can genuinely take the Pod. If
 * AshML is wrong the Pod stays Pending, which is visible and diagnosable, rather than
 * running somewhere it does not fit.
 */
function podPlacement(nodeName) {
  if (!nodeName) return {};
  return { nodeSelector: { 'kubernetes.io/hostname': nodeName } };
}

/**
 * Builds the complete Kubernetes Job manifest for a training job.
 *
 * @param {object} job a job as returned by the jobs repo
 * @param {object} [options]
 * @param {string} [options.namespace] namespace to create the Job in
 * @param {string} [options.nodeName] the node AshML's scheduler chose, if any
 * @returns {object} a Kubernetes batch/v1 Job
 */
export function buildJobManifest(job, { namespace = 'ashml-jobs', nodeName = null, apiUrl = null } = {}) {
  if (!job.spec?.image) {
    throw new Error(`job ${job.id}: spec.image is required to build a Kubernetes Job`);
  }

  const name = kubeJobName(job);

  // `ashml.io/job-id` is the link back to the database row. The status-sync loop
  // reads it rather than parsing the Job name, so renaming the scheme later cannot
  // silently break status reporting.
  const labels = {
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'app.kubernetes.io/component': 'training-job',
    'ashml.io/job-id': job.id,
    'ashml.io/project': job.project,
    'ashml.io/attempt': String(job.attempt ?? 0),
  };

  const annotations = {
    'ashml.io/job-name': job.name,
    'ashml.io/priority': job.priority,
  };
  if (job.resources.gpu_memory_min_bytes > 0) {
    annotations['ashml.io/gpu-memory-min-bytes'] = String(job.resources.gpu_memory_min_bytes);
  }
  if (job.experiment?.id) {
    annotations['ashml.io/experiment-id'] = job.experiment.id;
  }

  const container = {
    name: 'training',
    image: job.spec.image,
    imagePullPolicy: job.spec.image_pull_policy ?? 'IfNotPresent',
    env: containerEnv(job, { apiUrl }),
    resources: resourceRequirements(job.resources),
  };
  if (Array.isArray(job.spec.command) && job.spec.command.length > 0) {
    container.command = job.spec.command;
  }
  if (Array.isArray(job.spec.args) && job.spec.args.length > 0) {
    container.args = job.spec.args;
  }

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace, labels, annotations },
    spec: {
      // AshML owns retries (ADR 0003). If Kubernetes retried on its own, a failed
      // attempt would restart without passing through FAILED -> RETRYING -> QUEUED,
      // so the event log would not explain why the job ran twice and `max_retries`
      // would mean nothing. Zero here is what keeps the state machine authoritative.
      backoffLimit: 0,

      // Pods must not restart in place for the same reason.
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          containers: [container],
          ...podPlacement(nodeName),
        },
      },
    },
  };
}
