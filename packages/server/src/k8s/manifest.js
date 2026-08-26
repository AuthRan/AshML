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
 * Builds the name of the namespace one project's workloads run in.
 *
 * Phase 10 closed three of the four things that kept a project's pods from being
 * isolated by the *cluster* rather than by AshML's own admission checks: Pod Security
 * Admission labels, no mounted API credential, and a NetworkPolicy that stops one
 * project's pods reaching another's. The sentence it could not close was the structural
 * one — every project's pods shared a namespace and a service account, so the isolation
 * was between projects and not between a project and the platform. This is that
 * sentence. A namespace is the unit Kubernetes actually scopes things to, and giving
 * each project its own is what makes the rest of the boundary follow rather than be
 * asserted: its own `default` ServiceAccount, its own quota if one is ever wanted, and
 * a blast radius for a compromised training image that stops at the project.
 *
 * Named from the id *and* the name, like `kubeDeploymentName`, and both halves earn
 * their place. The name is there so `kubectl get ns` tells an operator whose namespace
 * they are looking at. The id is there because the name alone is not safe to truncate:
 * project names may be the full 63 characters a DNS-1123 label allows, so a prefix plus
 * a long name overflows, and two projects whose names agree for the first 43 characters
 * would otherwise be handed the same namespace — which is the one failure this whole
 * change exists to prevent, reintroduced by the naming of it.
 *
 * The base is the namespace AshML was already configured with (`ASHML_K8S_NAMESPACE`)
 * rather than a fixed string, so an operator who put AshML's workloads under a prefix of
 * their own keeps it, and the per-project namespaces sort next to the shared one they
 * replace.
 *
 * @param {{id: string, name: string}} project
 * @param {object} [options]
 * @param {string} [options.base] the namespace AshML is configured with
 */
export function projectNamespace(project, { base = 'ashml-jobs' } = {}) {
  const id8 = String(project.id).replaceAll('-', '').slice(0, 8);
  const suffix = `-${id8}`;
  const prefix = `${base}-`;
  const budget = MAX_NAME - prefix.length - suffix.length;

  // Trailing dashes are illegal in a DNS-1123 label, and truncation can leave one.
  const stem = String(project.name).slice(0, Math.max(1, budget)).replace(/-+$/, '');
  return `${prefix}${stem}${suffix}`;
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
function containerEnv(job, { apiUrl = null, runSecret = null } = {}) {
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
  // Present only on a retry that has something to resume from, and it is an artifact
  // *id* rather than a URL for the same reason the model server is handed one: the
  // download has to be signed when the container asks, not when the manifest was
  // written. A workload that does not implement resuming simply ignores it and starts
  // over, which is why this is an addition to the environment rather than a change to
  // the command — the platform offers a checkpoint, it does not impose one.
  if (job.retry?.resume_artifact_id) {
    reserved.ASHML_RESUME_FROM = job.retry.resume_artifact_id;
  }
  // `ASHML_RUN_TOKEN` is reserved whether or not this attempt has one, and it is listed
  // here rather than in `reserved` above because its value does not live in the manifest.
  // Kubernetes takes the last entry when a name appears twice, so leaving a user-supplied
  // one in place would work by accident; a job that set it would still be handed the real
  // credential, and would also ship its own guess about a credential in the same pod spec.
  const userSupplied = env.filter((entry) => (
    !Object.hasOwn(reserved, entry.name) && entry.name !== 'ASHML_RUN_TOKEN'
  ));
  const resolved = [
    ...userSupplied,
    ...Object.entries(reserved).map(([name, value]) => ({ name, value })),
  ];

  // The credential this attempt reports with (Phase 10), by reference rather than by
  // value. Both forms hand the container the same string; what differs is who else can
  // read it. An inline value is part of the Job's spec, so it is returned by
  // `kubectl get job -o yaml` to anyone who can list Jobs in this namespace — a
  // permission an operator hands out to let somebody watch their runs. Behind a
  // `secretKeyRef` it takes `get secrets`, which is a separate grant and the one people
  // actually think about before giving away.
  //
  // The earlier decision to inline it (ADR 0013) traded that for not having a second
  // object to create and clean up. The cleanup is the part that turned out to be cheap:
  // the Secret is named for the attempt, so a retry writes its own rather than mutating
  // one a pod is still reading, and every attempt's Secret is deleted by label when the
  // job reaches a terminal state.
  if (runSecret) {
    resolved.push({
      name: 'ASHML_RUN_TOKEN',
      valueFrom: { secretKeyRef: { name: runSecret, key: 'token' } },
    });
  }
  return resolved;
}

/**
 * The Secret holding one *attempt's* run credential.
 *
 * Per attempt and not per job, because a retry mints a new token and revokes the old one
 * while the pod that holds it may still be shutting down. One object per job would mean
 * the replacement overwriting a value the previous pod's container had already read —
 * harmless in itself, since an env var is materialised at container start — but it would
 * also mean a single name whose contents no longer say which attempt they belong to,
 * which is the kind of ambiguity this platform keeps out of its records.
 *
 * Budgeted from scratch rather than appended to `kubeJobName`, which is itself allowed to
 * reach the full 63 characters: `${jobName}-token` would then be rejected as a DNS-1123
 * label for exactly the jobs with the longest names.
 */
export function runSecretName(job) {
  const attempt = job.attempt ?? 0;
  const id8 = String(job.id).replaceAll('-', '').slice(0, 8);
  const suffix = `-${id8}-${attempt}-token`;
  const prefix = `${MANAGED_BY}-run-`;
  const budget = MAX_NAME - prefix.length - suffix.length;

  const stem = String(job.name).slice(0, Math.max(1, budget)).replace(/-+$/, '');
  return `${prefix}${stem}${suffix}`;
}

/**
 * The Secret a training pod reads its credential from.
 *
 * `ashml.io/job-id` is what makes the cleanup a single call: every attempt of a job
 * carries it, so one delete-by-label removes the lot without the caller having to know
 * how many attempts there were.
 */
export function buildRunSecretManifest(job, token, { namespace = 'ashml-jobs' } = {}) {
  if (!token) {
    throw new Error(`job ${job.id}: a run secret needs a token to hold`);
  }

  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: runSecretName(job),
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': MANAGED_BY,
        'app.kubernetes.io/component': 'run-token',
        'ashml.io/job-id': job.id,
        'ashml.io/attempt': String(job.attempt ?? 0),
      },
    },
    stringData: { token },
  };
}

/**
 * What every AshML-created Pod is allowed to be.
 *
 * A user submits an image. That image runs on the platform's cluster, so the question of
 * what it may do once it is running is the platform's to answer, not the image's — spec
 * §31's "do not allow arbitrary users to submit unrestricted Kubernetes resources".
 *
 * Most of that answer is already in the shape of this module: the container is assembled
 * field by field from an allowlist — image, pull policy, command, args, env, resources —
 * so there is no path by which a job spec can reach `hostNetwork`, `hostPath`, or
 * `privileged` at all. What was missing is everything a Pod gets *by default*, which is
 * where the interesting one lives:
 *
 * **`automountServiceAccountToken: false`.** Kubernetes mounts a credential for its own
 * API into every Pod unless told not to. AshML's training pods had one at
 * `/var/run/secrets/kubernetes.io/serviceaccount` — checked on the development cluster,
 * not assumed — and no line of the training path has ever used it. In a default k3s
 * install the `default` service account is granted nothing, so what that credential could
 * do was small; what makes it worth removing is the second half of that sentence, because
 * "granted nothing" is a property of the cluster today and a single future RoleBinding to
 * `default` silently hands it to every training pod in the namespace.
 *
 * The rest are the standard three, and none of them can break a workload that was not
 * already doing something a training job has no reason to do:
 *
 *   - `allowPrivilegeEscalation: false` — a setuid binary in the image cannot gain more
 *     than the container started with.
 *   - `capabilities: { drop: ['ALL'] }` — training needs none of them.
 *   - `seccompProfile: RuntimeDefault` — the syscall filter the container runtime already
 *     ships, applied rather than left at `Unconfined`.
 *
 * **`runAsNonRoot` is deliberately not here**, and that is the one gap this leaves. It
 * would refuse any image that does not declare a `USER`, which includes `busybox` — the
 * image the platform's own end-to-end test runs — so switching it on would turn a
 * security default into "your job does not start", for images their authors have every
 * right to have built that way. Everything else `restricted` asks for is satisfied above,
 * so it is a one-line change the day every image in use declares a user, and the
 * namespace is labelled to say so (`ensureNamespace`).
 */
export function podHardening() {
  return {
    // Nothing AshML runs talks to the Kubernetes API. A credential nothing uses is a
    // credential that can only ever be taken.
    automountServiceAccountToken: false,
    securityContext: {
      seccompProfile: { type: 'RuntimeDefault' },
    },
  };
}

/** The container half of the same answer. See `podHardening`. */
export function containerHardening() {
  return {
    securityContext: {
      allowPrivilegeEscalation: false,
      privileged: false,
      capabilities: { drop: ['ALL'] },
    },
  };
}

// -------------------------------------------------------------- log collection

/** The Role, and the RoleBinding that uses it, are named the same in every namespace. */
export const LOG_READER_NAME = `${MANAGED_BY}-log-reader`;

/**
 * The grant that lets a log collector read a project's pod logs.
 *
 * A Role and not a ClusterRole, which is the whole point. ADR 0018 wrote the collector's
 * grant out by hand rather than copying the upstream example, because `pods/log`
 * cluster-wide is a standing credential that can read every line every container in the
 * cluster has printed, and a monitoring identity is never rotated by anything. That was a
 * Role in one namespace while there was one namespace. Now there is one per project, so
 * the same grant has to be created per project — and it is created by the thing that
 * creates the namespace, which is the only component that knows a new one exists.
 *
 * Only `pods/log`. Discovering *which* pods exist is a separate, cluster-wide grant in
 * `deploy/observability/`, and the split is deliberate: listing pods reveals names and
 * labels, reading `pods/log` reveals what the code printed — secrets in a stack trace, a
 * dataset row, a token somebody echoed. The half worth scoping tightly is this one, and
 * this is the half that stays inside AshML's namespaces.
 */
export function buildLogReaderRoleManifest({ namespace }) {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: {
      name: LOG_READER_NAME,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': MANAGED_BY },
    },
    rules: [
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
    ],
  };
}

/**
 * The binding, in the namespace being read, for a subject in the namespace doing the
 * reading.
 *
 * That asymmetry is copied from `deploy/observability/31-alloy.yaml` on purpose: it keeps
 * the grant with the thing being granted, so deleting a project's namespace takes its
 * collector access with it rather than leaving a binding pointing at nothing.
 */
export function buildLogReaderRoleBindingManifest({ namespace, serviceAccount }) {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: {
      name: LOG_READER_NAME,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': MANAGED_BY },
    },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Role',
      name: LOG_READER_NAME,
    },
    subjects: [{
      kind: 'ServiceAccount',
      name: serviceAccount.name,
      namespace: serviceAccount.namespace,
    }],
  };
}

// ------------------------------------------------------------------- isolation

/** The default pod network for k3s, which is what `make cluster` brings up. */
export const DEFAULT_CLUSTER_POD_CIDR = '10.42.0.0/16';

/** The NetworkPolicy that isolates one project's pods. One per project, per namespace. */
export function projectNetworkPolicyName(project) {
  return `${MANAGED_BY}-project-${project}`;
}

/**
 * The per-project network boundary: a project's pods may talk to their own project, to
 * DNS, and to everything outside the cluster — and to no other project.
 *
 * This is the gap Phase 10 left open and named: every project's workloads share one
 * namespace and one service account, so a training pod in one project could open a
 * connection to a model server in another and the cluster had no opinion about it.
 * Pod Security Admission does not help here — it governs what a Pod *is*, not who it may
 * reach — and neither does AshML's own authorization, because this traffic never goes
 * near the control plane. It is pod to pod, inside one namespace, and only the cluster
 * can refuse it.
 *
 * **Egress, and not ingress**, which is the decision worth recording because ingress is
 * the obvious way to write it. "A project's pods accept connections only from their own
 * project" reads as the same rule from the other end, and on a single-node cluster it
 * even behaves like it. It breaks on the second node. An ingress policy denies every
 * source it does not name, and the sources it cannot name are the ones that are not pods:
 * the kubelet's readiness probes, and the API server's `/proxy` endpoint — which is how
 * `callService` reaches a model server for `ash predict`. On a cluster running k3s with
 * flannel, traffic from the API server to a pod on *another* node arrives from that
 * node's flannel address, which sits inside the pod CIDR and is therefore excluded by
 * the same `except` that keeps other projects out. Measured, not reasoned about: with an
 * ingress policy in place, a proxy call to a pod on the second node returns
 *
 *     Error from server (ServiceUnavailable): error trying to reach service:
 *     proxy error from 127.0.0.1:6443 while dialing 10.42.1.78:8080, code 502
 *
 * while the identical call to a pod on the API server's own node succeeds — a policy that
 * would have looked correct on the development cluster and broken serving in production,
 * intermittently, depending on where a pod landed.
 *
 * Egress has none of that problem: it constrains the pod AshML is least sure about — the
 * user-submitted image — at the point where it *initiates*, and leaves every inbound
 * platform path untouched. And because every AshML pod carries `ashml.io/project` and
 * every project gets this policy, denying each project's egress to the others denies the
 * traffic in both directions: there is no pod left that is allowed to start the
 * conversation.
 *
 * The three rules, and what each one is for:
 *
 *   1. **Its own project**, on any port. A router reaching its model servers, a model
 *      server reaching a sidecar, one training pod reaching another.
 *   2. **DNS**, port 53 in `kube-system`, TCP as well as UDP because a large answer
 *      falls back to TCP. Selected by namespace rather than by the `k8s-app: kube-dns`
 *      label, so a cluster that runs something other than CoreDNS still resolves.
 *   3. **Everything that is not a pod in this cluster** — the control plane on the host,
 *      the artifact store, a dataset on the public internet, a package index. Training
 *      jobs are user code and are meant to be able to fetch things; this is a boundary
 *      between projects, not a firewall.
 *
 * Rule 3 is where `clusterPodCidr` matters, and a wrong value fails in the direction that
 * does not announce itself: too narrow and cross-project traffic is quietly permitted,
 * because the addresses it excludes are not the addresses the pods actually have. It is
 * checked against what the cluster reports rather than trusted — see
 * `verifyClusterPodCidr` in `kubernetes.js`, which compares it with every node's
 * `spec.podCIDR` at startup and says so if they disagree.
 *
 * A ClusterIP is deliberately not in the list. Traffic to a Service is translated to a
 * pod address before the policy is evaluated, so `beta-svc.ashml-jobs.svc` from another
 * project is refused by rule 1 exactly as the pod address is — verified on the cluster,
 * because it depends on the CNI evaluating after DNAT and it would be a hole if it did
 * not.
 *
 * **What this cannot do is enforce itself.** A NetworkPolicy is an object any cluster
 * accepts and only some clusters implement; k3s ships kube-router's policy controller and
 * enforces it, but a cluster whose CNI ignores policies will store this one, report it,
 * and route the traffic anyway. That is why the control plane logs what it applied at
 * startup rather than leaving it to be assumed, and why `make e2e-isolation` asks the
 * cluster the question directly instead of asserting on the manifest.
 *
 * @param {string} project the project name, already a DNS-1123 label (routes/projects.js)
 * @param {object} [options]
 * @param {string} [options.namespace]
 * @param {string} [options.clusterPodCidr] the addresses this cluster gives to pods
 * @returns {object} a networking.k8s.io/v1 NetworkPolicy
 */
export function buildProjectNetworkPolicyManifest(project, {
  namespace = 'ashml-jobs', clusterPodCidr = DEFAULT_CLUSTER_POD_CIDR,
} = {}) {
  if (!project) {
    throw new Error('a network policy needs a project to isolate');
  }

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: projectNetworkPolicyName(project),
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': MANAGED_BY,
        'app.kubernetes.io/component': 'project-isolation',
        'ashml.io/project': project,
      },
    },
    spec: {
      podSelector: { matchLabels: { 'ashml.io/project': project } },
      // Egress only. Naming Ingress here — even with no ingress rules — would deny every
      // inbound connection to the project, including the kubelet's probes.
      policyTypes: ['Egress'],
      egress: [
        { to: [{ podSelector: { matchLabels: { 'ashml.io/project': project } } }] },
        {
          to: [{
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          }],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
        { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: [clusterPodCidr] } }] },
      ],
    },
  };
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
 * @param {string} [options.apiUrl] what the pod should report back to
 * @param {string} [options.runSecret] the Secret holding this attempt's run token
 * @returns {object} a Kubernetes batch/v1 Job
 */
export function buildJobManifest(job, {
  namespace = 'ashml-jobs', nodeName = null, apiUrl = null, runSecret = null,
} = {}) {
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
    env: containerEnv(job, { apiUrl, runSecret }),
    resources: resourceRequirements(job.resources),
    ...containerHardening(),
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
          ...podHardening(),
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
 * The name both serving containers give their port.
 *
 * One name, declared by the model server and by the router, so the deployment's front
 * Service can target a port without knowing which of the two it is pointed at today.
 * See `buildServiceManifest`.
 */
export const PORT_NAME = 'http';

/**
 * Builds the Kubernetes name a deployment's front Service answers on.
 *
 * This is the deployment's address, and it is the one thing here that must never change
 * for the life of the deployment: a deployment's name is what callers hold, so renaming
 * it would silently point them at nothing. The construction matches `kubeJobName` minus
 * the attempt suffix — a deployment is long-lived and updated in place.
 *
 * What is *behind* this name changes constantly: one version's pods, then another's,
 * then a router. That is the point of the indirection, and `serving_version` on the row
 * is what records which of those it currently is.
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
 * Builds the name of one version's Deployment and Service.
 *
 * A version gets its own objects because a traffic weight is a share of requests, and
 * requests can only be divided between things that have addresses. Putting two versions
 * in one Kubernetes Deployment is not possible at all — a Deployment has one pod
 * template — and putting them behind one Service with different replica counts is the
 * mistake `domain/routing.js` refuses: it makes the split a function of capacity.
 *
 * The version number is in the name rather than a hash of it, because the first thing an
 * operator does when a rollout misbehaves is `kubectl get pods` and read.
 */
export function kubeTargetName(deployment, version) {
  const id8 = String(deployment.id).replaceAll('-', '').slice(0, 8);
  const suffix = `-${id8}-v${version}`;
  const prefix = `${MANAGED_BY}-svc-`;
  const budget = MAX_NAME - prefix.length - suffix.length;

  const stem = String(deployment.name).slice(0, Math.max(1, budget)).replace(/-+$/, '');
  return `${prefix}${stem}${suffix}`;
}

/**
 * The labels that identify one version's pods.
 *
 * `ashml.io/model-version` is what makes the per-version Service select this version and
 * not its sibling, so it is in the Deployment's `spec.selector` — which Kubernetes makes
 * immutable, and which is safe here precisely because a target's version never changes.
 * A target *is* a version; rolling out a different one creates a different target.
 */
function targetSelector(deployment, target) {
  return {
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'ashml.io/deployment-id': deployment.id,
    'ashml.io/model-version': String(target.version),
  };
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
function servingEnv(deployment, target, { apiUrl = null, secretName = null } = {}) {
  const env = [
    { name: 'ASHML_MODEL_ARCH', value: String(target.arch) },
    { name: 'ASHML_ARTIFACT_ID', value: String(target.artifact_id) },
    { name: 'ASHML_PORT', value: String(SERVING_PORT) },
    { name: 'ASHML_DEPLOYMENT_ID', value: String(deployment.id) },
    { name: 'ASHML_MODEL_VERSION', value: String(target.version) },
  ];
  // Omitted rather than guessed when unconfigured, exactly as for training jobs: the
  // server then says it was never told where to fetch from, instead of failing with a
  // connection error to an invented address.
  if (apiUrl) env.unshift({ name: 'ASHML_ENDPOINT', value: apiUrl });
  // The model server is handed an artifact id, not a URL, and exchanges it for a signed
  // download at startup — so since Phase 10 it needs a credential to do that with. It is
  // scoped to this deployment and may do exactly two things: fetch artifacts belonging to
  // its own project, and read this deployment's routing table (domain/roles.js).
  //
  // A `secretKeyRef`, not the value. This is the difference between a stable pod template
  // and a rollout on every apply: `applyDesiredState` re-writes every target's manifest
  // whenever anything about the deployment changes, so an inlined token would make the
  // template differ each time and Kubernetes would restart every serving pod on, say, a
  // traffic-weight change — replacing a weighted rollout with an outage. The reference is
  // the same string every time; rotating what is behind it touches no running pod.
  if (secretName) {
    env.unshift({
      name: 'ASHML_RUN_TOKEN',
      valueFrom: { secretKeyRef: { name: secretName, key: 'token' } },
    });
  }
  return env;
}

/**
 * The Secret holding one deployment's workload credential.
 *
 * Budgeted from scratch rather than built by appending to `kubeDeploymentName`, which is
 * itself allowed to reach the full 63 characters — `${name}-token` would then be 69 and
 * rejected as a DNS-1123 label, for exactly the deployments with the longest names.
 */
export function servingSecretName(deployment) {
  const id8 = String(deployment.id).replaceAll('-', '').slice(0, 8);
  const suffix = `-${id8}-token`;
  const prefix = `${MANAGED_BY}-svc-`;
  const budget = MAX_NAME - prefix.length - suffix.length;

  const stem = String(deployment.name).slice(0, Math.max(1, budget)).replace(/-+$/, '');
  return `${prefix}${stem}${suffix}`;
}

/**
 * The Secret a deployment's pods read their credential from.
 *
 * `stringData` rather than `data` so the value is not base64-encoded here — Kubernetes
 * does that. Worth stating because a token that is base64'd twice fails authentication
 * with a message about the token being invalid, which sends you looking in the wrong
 * place entirely.
 */
export function buildServingSecretManifest(deployment, token, { namespace = 'ashml-jobs' } = {}) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: servingSecretName(deployment),
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': MANAGED_BY,
        'app.kubernetes.io/component': 'serving-token',
        'ashml.io/deployment-id': deployment.id,
      },
    },
    stringData: { token },
  };
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
 * Builds the Kubernetes Deployment that runs one version of a deployment's model.
 *
 * @param {object} deployment a deployment row
 * @param {object} target one of its targets, resolved through to the artifact
 * @returns {object} a Kubernetes apps/v1 Deployment
 */
export function buildTargetManifest(deployment, target, {
  namespace = 'ashml-jobs', apiUrl = null, secretName = null,
} = {}) {
  if (!deployment.image) {
    throw new Error(`deployment ${deployment.id}: image is required`);
  }
  if (!target?.artifact_id) {
    throw new Error(`deployment ${deployment.id}: target v${target?.version} has no artifact_id`);
  }

  const name = kubeTargetName(deployment, target.version);
  const selector = targetSelector(deployment, target);

  // `ashml.io/deployment-id` is the link back to the database row, read by the status
  // loop rather than parsing the name — same contract as `ashml.io/job-id`.
  const labels = {
    ...selector,
    'app.kubernetes.io/component': 'model-server',
    'ashml.io/project': deployment.project,
  };

  const annotations = {
    'ashml.io/deployment-name': deployment.name,
    'ashml.io/model': String(deployment.model ?? ''),
    'ashml.io/model-version': String(target.version),
    'ashml.io/artifact-id': String(target.artifact_id),
    // What share of the deployment's traffic this version is meant to take. An
    // annotation, not a label: it changes on every rollout step, and a label that
    // changed that often would churn every selector an operator had written by hand.
    // It is here so that `kubectl describe` explains a pod's existence.
    'ashml.io/traffic-weight': String(target.traffic_weight),
  };

  const container = {
    name: 'model-server',
    image: deployment.image,
    imagePullPolicy: deployment.image_pull_policy ?? 'IfNotPresent',
    ports: [{ name: PORT_NAME, containerPort: SERVING_PORT }],
    env: servingEnv(deployment, target, { apiUrl, secretName }),
    resources: resourceRequirements({
      cpu: deployment.cpu,
      memory_bytes: deployment.memory_bytes,
      gpu: deployment.gpu,
    }),
    ...servingProbes(),
    ...containerHardening(),
  };

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace, labels, annotations },
    spec: {
      // A version at weight 0 is one an operator has taken out of rotation, and running
      // pods for it is capacity spent on nothing. Scaled to zero rather than deleted, so
      // that putting it back is a weight change rather than a redeploy — which is what
      // makes a rollback fast at the moment it is most needed.
      //
      // With one exception, and it is the same exception the reaper makes: the version
      // the deployment's address currently resolves to keeps its pods whatever its
      // weight says. During a switch the outgoing version has already been taken out of
      // rotation and is still the only thing answering, and scaling it to zero there
      // would drop every request in flight — an outage caused by tidying up early.
      replicas: (target.traffic_weight > 0 || target.version === deployment.serving_version)
        ? (target.replicas ?? deployment.replicas)
        : 0,
      selector: { matchLabels: selector },
      template: {
        metadata: { labels, annotations },
        // A model server answers HTTP and fetches its own weights through the AshML
        // API. It has no more use for a Kubernetes credential than a training pod does.
        spec: { containers: [container], ...podHardening() },
      },
    },
  };
}

/**
 * Builds the Service that gives one version its own address.
 *
 * This is not the address callers use — that is the deployment's front Service. This one
 * exists so the router has something to forward to, and so an operator can ask a single
 * version a question without the split getting in the way.
 */
export function buildTargetServiceManifest(deployment, target, { namespace = 'ashml-jobs' } = {}) {
  const name = kubeTargetName(deployment, target.version);

  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace,
      labels: {
        ...targetSelector(deployment, target),
        'app.kubernetes.io/component': 'model-server',
        'ashml.io/project': deployment.project,
      },
    },
    spec: {
      type: 'ClusterIP',
      selector: targetSelector(deployment, target),
      ports: [{ name: PORT_NAME, port: 80, targetPort: PORT_NAME, protocol: 'TCP' }],
    },
  };
}

/**
 * The selector the deployment's front Service should carry.
 *
 * With `version` given the front door selects that version's pods directly: there is one
 * version taking traffic, nothing to decide, and a router in the path would be a hop and
 * a dependency bought for nothing. With `version` null it selects the router's pods,
 * which is what happens the moment a second version starts taking traffic and something
 * has to choose per request.
 *
 * Both branches are fully specified. A selector that came out empty — or with only
 * `managed-by` — would match every pod AshML has ever created in the namespace, which is
 * worse than matching none: a deployment would front another model's pods and answer
 * with them.
 *
 * @param {object} deployment
 * @param {number|null} version the version to select directly, or null for the router
 */
export function frontSelector(deployment, version) {
  const base = {
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'ashml.io/deployment-id': deployment.id,
  };
  if (version == null) {
    return { ...base, 'app.kubernetes.io/component': ROUTER_COMPONENT };
  }
  return {
    ...base,
    'app.kubernetes.io/component': 'model-server',
    'ashml.io/model-version': String(version),
  };
}

/**
 * Builds the Service that gives a deployment its stable address.
 *
 * ClusterIP: this is the address other things *inside* the cluster call, and it is what
 * `endpoint_url` records. Exposing it outside the cluster is a gateway's job, not a
 * per-deployment one — a NodePort per model would hand out a different port for every
 * deployment and make the address depend on which node answered.
 *
 * Its selector is the only mutable thing about it, and moving it is how a deployment
 * changes what it serves without changing where it is. A Service's `clusterIP` and DNS
 * name survive a selector change, so callers holding the address never notice; deleting
 * and recreating the Service to point somewhere else would give it a new IP and break
 * every connection and cached lookup at once.
 *
 * **The target port is the port's name, not a number**, and that is load-bearing rather
 * than stylistic. This is the one Service whose backing pods change *kind*: a model
 * server on SERVING_PORT while one version takes traffic, a router on ROUTER_PORT the
 * moment two do. Written as a number it can only be right about one of them — and it was
 * written as SERVING_PORT, so every request through a split deployment's address was
 * refused by a router that was healthy, ready, and listening one port away. Nothing
 * reported it: the pods were ready, AshML said READY, and the address answered
 * ECONNREFUSED. A name is resolved against whichever pod the selector found, so the port
 * follows the selector by construction rather than by anyone remembering to move it.
 * Both containers name their port `http` for this reason.
 */
export function buildServiceManifest(deployment, { namespace = 'ashml-jobs', version = null } = {}) {
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
      selector: frontSelector(deployment, version),
      ports: [{ name: PORT_NAME, port: 80, targetPort: PORT_NAME, protocol: 'TCP' }],
    },
  };
}

/**
 * The in-cluster URL for a deployment's front Service.
 *
 * Recorded on the row when the Service is created, so that reading a deployment does
 * not require reconstructing the naming scheme in a second place.
 */
export function serviceUrl(deployment, { namespace = 'ashml-jobs' } = {}) {
  return `http://${kubeDeploymentName(deployment)}.${namespace}.svc.cluster.local`;
}

/** The in-cluster URL for one version's own Service — what the router forwards to. */
export function targetServiceUrl(deployment, version, { namespace = 'ashml-jobs' } = {}) {
  return `http://${kubeTargetName(deployment, version)}.${namespace}.svc.cluster.local`;
}

// ----------------------------------------------------------------------- router

/** What the router's pods are labelled as, and what the front Service selects them by. */
export const ROUTER_COMPONENT = 'model-router';

/** The port the router listens on. Different from the model server's, so a pod that ended
 * up running the wrong image fails to bind rather than answering as the wrong thing. */
export const ROUTER_PORT = 8082;

/**
 * How many routers a deployment runs.
 *
 * Two, not one. The router is in front of every request the deployment answers, so a
 * single replica makes an ordinary rolling restart — a node drain, an image change — into
 * a gap in service for a deployment whose model pods were never touched. Two is the
 * smallest number that survives one of them going away, and a router is a few tens of
 * megabytes of Node forwarding HTTP, which is a cheap thing to have two of.
 */
export const ROUTER_REPLICAS = 2;

/** The router's Kubernetes name. Distinct from every version's, and from the front door's. */
export function kubeRouterName(deployment) {
  const id8 = String(deployment.id).replaceAll('-', '').slice(0, 8);
  const suffix = `-${id8}`;
  const prefix = `${MANAGED_BY}-router-`;
  const budget = MAX_NAME - prefix.length - suffix.length;

  const stem = String(deployment.name).slice(0, Math.max(1, budget)).replace(/-+$/, '');
  return `${prefix}${stem}${suffix}`;
}

/**
 * Builds the Deployment that runs a deployment's routers.
 *
 * There is no Service of its own. The deployment's front Service selects these pods
 * directly, which is what makes turning routing on a selector change rather than a new
 * address — callers keep the name they had, and the hop appears underneath them.
 *
 * The router is told an **id** and an endpoint, and nothing about the split. It reads the
 * weights from the control plane every few seconds, which is what makes
 * `ash deployment rollout` take effect without restarting anything. Weights in the
 * environment would mean every step of a canary restarted the thing measuring it.
 */
export function buildRouterManifest(deployment, {
  namespace = 'ashml-jobs', apiUrl = null, refreshMs = 5_000, secretName = null,
} = {}) {
  if (!deployment.router_image) {
    throw new Error(`deployment ${deployment.id}: router_image is required`);
  }
  if (!apiUrl) {
    // Refused rather than defaulted. A router that cannot reach the control plane never
    // gets a routing table, so it never becomes ready, so the front Service is never
    // moved onto it — the deployment goes on serving one version and nothing says why.
    throw new Error(
      `deployment ${deployment.id}: a router needs the control plane's address `
      + '(ASHML_API_ADVERTISE_URL). Without it it can never fetch a split, and a router '
      + 'with no split is a pod that starts, stays unready, and explains nothing.',
    );
  }

  const name = kubeRouterName(deployment);
  const selector = {
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'ashml.io/deployment-id': deployment.id,
    'app.kubernetes.io/component': ROUTER_COMPONENT,
  };
  const labels = { ...selector, 'ashml.io/project': deployment.project };

  const container = {
    name: 'model-router',
    image: deployment.router_image,
    imagePullPolicy: deployment.router_image_pull_policy ?? 'IfNotPresent',
    ports: [{ name: PORT_NAME, containerPort: ROUTER_PORT }],
    env: [
      { name: 'ASHML_ENDPOINT', value: apiUrl },
      // The router polls the deployment's routing table. Same Secret, same reason it is
      // a reference rather than a value: the router must not restart on a weight change,
      // because a weight change is precisely when it is carrying the traffic.
      ...(secretName ? [{
        name: 'ASHML_RUN_TOKEN',
        valueFrom: { secretKeyRef: { name: secretName, key: 'token' } },
      }] : []),
      { name: 'ASHML_DEPLOYMENT_ID', value: String(deployment.id) },
      { name: 'ASHML_DEPLOYMENT_NAME', value: String(deployment.name) },
      { name: 'ASHML_PORT', value: String(ROUTER_PORT) },
      { name: 'ASHML_ROUTING_REFRESH_MS', value: String(refreshMs) },
    ],
    // Small and explicit. A router forwards bytes; it holds no model and does no
    // arithmetic beyond picking a bucket, and sizing it like a model server would take
    // capacity away from the pods actually doing the inference.
    resources: {
      requests: { cpu: '100m', memory: '134217728' },
      limits: { memory: '268435456' },
    },
    readinessProbe: {
      // 200 only once there is a split to apply and something to apply it to. Until
      // then the pod is out of the front Service's endpoints, which is what stops the
      // front door being moved onto a router that would answer 503 to everything.
      httpGet: { path: '/readyz', port: ROUTER_PORT },
      periodSeconds: 5,
      failureThreshold: 3,
    },
    livenessProbe: {
      httpGet: { path: '/healthz', port: ROUTER_PORT },
      periodSeconds: 20,
      failureThreshold: 3,
    },
    // No startup probe, unlike the model server. There is no slow first load to protect:
    // the router's startup is one HTTP request, and a startup probe would only delay the
    // first liveness check in exchange for nothing.
    ...containerHardening(),
  };

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      namespace,
      labels,
      annotations: {
        'ashml.io/deployment-name': deployment.name,
        'ashml.io/model': String(deployment.model ?? ''),
        'ashml.io/split': (deployment.targets ?? [])
          .filter((t) => t.traffic_weight > 0)
          .map((t) => `v${t.version}=${t.traffic_weight}`)
          .join(','),
      },
    },
    spec: {
      replicas: ROUTER_REPLICAS,
      selector: { matchLabels: selector },
      template: {
        metadata: { labels },
        // A router forwards HTTP and polls one AshML endpoint. Same reasoning as the
        // model server: no Kubernetes credential, no capabilities, no escalation.
        spec: { containers: [container], ...podHardening() },
      },
    },
  };
}
