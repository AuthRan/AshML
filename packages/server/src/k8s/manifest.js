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

// --------------------------------------------------------------------- inference

/** The port the model server listens on inside the container. */
export const SERVING_PORT = 8081;

/**
 * Builds the Kubernetes name shared by a deployment's Deployment and Service.
 *
 * Same construction as `kubeJobName` and for the same reasons, minus the attempt
 * suffix: a deployment is long-lived and updated in place, so there is no attempt to
 * disambiguate. Deployment and Service share the name because they are one thing to an
 * operator, and `kubectl get all -l ashml.io/deployment-id=<id>` is how you find both.
 */
export function kubeDeploymentName(deployment) {
  const id8 = String(deployment.id).replaceAll('-', '').slice(0, 8);
  const suffix = `-${id8}`;
  const prefix = `${MANAGED_BY}-svc-`;
  const budget = MAX_NAME - prefix.length - suffix.length;

  const stem = String(deployment.name).slice(0, Math.max(1, budget)).replace(/-+$/, '');
  return `${prefix}${stem}${suffix}`;
}

/**
 * The environment that tells a model server which model it is.
 *
 * The server is handed an artifact *id*, not a URL. It exchanges that for a
 * time-limited download URL at startup, which is what lets a pod that restarts hours
 * later still fetch its own weights — a presigned URL baked into the manifest would
 * expire and the pod would crash-loop on a dead signature long after anyone had stopped
 * associating the two.
 */
function servingEnv(deployment, { apiUrl = null } = {}) {
  const env = [
    { name: 'ASHML_MODEL_ARCH', value: String(deployment.target.arch) },
    { name: 'ASHML_ARTIFACT_ID', value: String(deployment.target.artifact_id) },
    { name: 'ASHML_PORT', value: String(SERVING_PORT) },
    { name: 'ASHML_DEPLOYMENT_ID', value: String(deployment.id) },
    { name: 'ASHML_MODEL_VERSION', value: String(deployment.target.version) },
  ];
  // Omitted rather than guessed when unconfigured, exactly as for training jobs: the
  // server then says it was never told where to fetch from, instead of failing with a
  // connection error to an invented address.
  if (apiUrl) env.unshift({ name: 'ASHML_ENDPOINT', value: apiUrl });
  return env;
}

/**
 * Liveness, readiness and startup probes for a model server.
 *
 * The three are genuinely different questions and conflating any two of them breaks
 * something specific:
 *
 * - **readiness** hits `/readyz`, which is 200 only once the weights are loaded and a
 *   forward pass has run. Pointing this at `/healthz` would put a pod with no model in
 *   it into the Service's endpoints, and callers would get 503s that look like the
 *   model's fault.
 * - **liveness** hits `/healthz`, which answers as soon as the process binds. Pointing
 *   this at `/readyz` would kill a pod that is slowly but successfully downloading a
 *   large checkpoint, and restarting it makes the download start over — a crash loop
 *   caused entirely by the probe.
 * - **startup** guards the first load. Until it passes, liveness is not evaluated at
 *   all, so a cold start that takes longer than the liveness threshold is not mistaken
 *   for a hang. `failureThreshold * periodSeconds` is the budget for pulling weights
 *   over the network; it is generous because being wrong in the other direction costs a
 *   restart loop that never converges.
 */
function servingProbes() {
  const port = SERVING_PORT;
  return {
    startupProbe: {
      httpGet: { path: '/readyz', port },
      periodSeconds: 5,
      failureThreshold: 60,
    },
    readinessProbe: {
      httpGet: { path: '/readyz', port },
      periodSeconds: 10,
      failureThreshold: 3,
    },
    livenessProbe: {
      httpGet: { path: '/healthz', port },
      periodSeconds: 20,
      failureThreshold: 3,
    },
  };
}

/**
 * Builds the Kubernetes Deployment for a model deployment.
 *
 * @param {object} deployment a deployment row joined with its single target
 * @param {object} [options]
 * @returns {object} a Kubernetes apps/v1 Deployment
 */
export function buildDeploymentManifest(deployment, { namespace = 'ashml-jobs', apiUrl = null } = {}) {
  if (!deployment.image) {
    throw new Error(`deployment ${deployment.id}: image is required`);
  }
  if (!deployment.target?.artifact_id) {
    throw new Error(`deployment ${deployment.id}: target.artifact_id is required`);
  }

  const name = kubeDeploymentName(deployment);

  // `ashml.io/deployment-id` is the link back to the database row, read by the status
  // loop rather than parsing the name — same contract as `ashml.io/job-id`.
  const labels = {
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'app.kubernetes.io/component': 'model-server',
    'ashml.io/deployment-id': deployment.id,
    'ashml.io/project': deployment.project,
  };

  // The selector must be stable for the life of the Deployment: `spec.selector` is
  // immutable in Kubernetes, so anything that can change on an update — the version,
  // the artifact — must not appear in it.
  const selector = {
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'ashml.io/deployment-id': deployment.id,
  };

  const annotations = {
    'ashml.io/deployment-name': deployment.name,
    'ashml.io/model': String(deployment.model ?? ''),
    'ashml.io/model-version': String(deployment.target.version),
    'ashml.io/artifact-id': String(deployment.target.artifact_id),
  };

  const container = {
    name: 'model-server',
    image: deployment.image,
    imagePullPolicy: deployment.image_pull_policy ?? 'IfNotPresent',
    ports: [{ name: 'http', containerPort: SERVING_PORT }],
    env: servingEnv(deployment, { apiUrl }),
    resources: resourceRequirements({
      cpu: deployment.cpu,
      memory_bytes: deployment.memory_bytes,
      gpu: deployment.gpu,
    }),
    ...servingProbes(),
  };

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace, labels, annotations },
    spec: {
      replicas: deployment.replicas,
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: { ...labels, ...selector }, annotations },
        spec: { containers: [container] },
      },
    },
  };
}

/**
 * Builds the Service that gives a deployment a stable address.
 *
 * ClusterIP: this is the address other things *inside* the cluster call, and it is what
 * `endpoint_url` records. Exposing it outside the cluster is a gateway's job, not a
 * per-deployment one — a NodePort per model would hand out a different port for every
 * deployment and make the address depend on which node answered.
 */
export function buildServiceManifest(deployment, { namespace = 'ashml-jobs' } = {}) {
  const name = kubeDeploymentName(deployment);

  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': MANAGED_BY,
        'app.kubernetes.io/component': 'model-server',
        'ashml.io/deployment-id': deployment.id,
        'ashml.io/project': deployment.project,
      },
    },
    spec: {
      type: 'ClusterIP',
      selector: {
        'app.kubernetes.io/managed-by': MANAGED_BY,
        'ashml.io/deployment-id': deployment.id,
      },
      ports: [{ name: 'http', port: 80, targetPort: SERVING_PORT, protocol: 'TCP' }],
    },
  };
}

/**
 * The in-cluster URL for a deployment's Service.
 *
 * Recorded on the row when the Service is created, so that reading a deployment does
 * not require reconstructing the naming scheme in a second place.
 */
export function serviceUrl(deployment, { namespace = 'ashml-jobs' } = {}) {
  return `http://${kubeDeploymentName(deployment)}.${namespace}.svc.cluster.local`;
}
