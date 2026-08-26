/**
 * An in-memory stand-in for a Kubernetes cluster.
 *
 * This exists for two callers: the executor's tests, which need to drive a job
 * through every phase deterministically and cannot depend on a cluster being
 * present; and a developer without k3d running who wants the control plane to be
 * exercisable end to end.
 *
 * Per spec Rule 5 it is behind the backend interface, named `sim`, and never the
 * default — `ASHML_K8S_BACKEND=sim` has to be set deliberately. Nothing it reports is
 * ever presented as a real run: every observation it produces is marked `simulated`,
 * and the executor records that flag on the job event, so the event log shows plainly
 * that no container ran.
 */

import { Phase, registerBackend } from './backend.js';
import { projectNamespace } from './manifest.js';

/**
 * @param {object} [options]
 * @param {string} [options.namespace]
 * @param {boolean} [options.autoAdvance] when true (the default) a job progresses on
 *   its own each time it is observed, which is what makes a no-cluster demo work.
 *   Tests set it false and call `_setPhase` so timing is never a source of flakiness.
 * @param {number} [options.observationsToRunning] observations spent PENDING
 * @param {number} [options.observationsToFinish] further observations spent RUNNING
 * @param {string} [options.finalPhase] SUCCEEDED or FAILED
 * @param {object[]} [options.nodes] the fake cluster's nodes. Defaults to a single
 *   2-GPU node, which is the shape of the real development host and therefore the
 *   shape the scheduler tests care about.
 */
export function createSimBackend({
  namespace = 'ashml-jobs',
  autoAdvance = true,
  observationsToRunning = 1,
  observationsToFinish = 2,
  finalPhase = Phase.SUCCEEDED,
  nodes = null,
} = {}) {
  /** `${namespace}/${name}` -> record */
  const jobs = new Map();

  /** `${namespace}/${name}` -> record. Deployments outlive jobs, so they are separate. */
  const deployments = new Map();
  // Secrets are stored so a test can assert what a workload was actually handed.
  const secrets = new Map();

  /** Projects `ensureProjectIsolation` was called for, in the order they were asked. */
  const isolatedProjects = new Set();

  /** Project name -> the namespace its boundary was drawn in. */
  const isolatedIn = new Map();

  /** Namespaces `ensureNamespace`/`ensureProjectNamespace` were asked to create. */
  const ensuredNamespaces = new Set();

  /** Namespaces a log collector was granted `pods/log` in. */
  const logReaderGrants = new Set();

  /**
   * `${namespace}/${name}` -> `{ selector }`.
   *
   * Services are modelled as their own objects rather than as a flag on a Deployment,
   * because with weighted routing they stop being one-to-one: a deployment's front
   * Service selects a version's pods and then the router's, and the versions have
   * Services of their own. A flag cannot express "this address currently resolves to
   * those pods", which is the only interesting thing a Service does — and it is exactly
   * what a rollout moves.
   */
  const services = new Map();

  const simNodes = nodes ?? [{
    name: 'sim-node-0',
    ready: true,
    cpu_cores: 16,
    memory_bytes: 64 * 1024 ** 3,
    gpu_capacity: 2,
    reserved_cpu: 0,
    reserved_memory: 0,
    labels: {},
  }];

  /** Set by `_setServiceResponder`; null means `callService` refuses. */
  let responder = null;

  const key = (ns, name) => `${ns}/${name}`;

  /**
   * The Deployments whose pods a selector would match, and which have a ready pod.
   *
   * This is kube-proxy's half of the job, and modelling it is what makes a moved front
   * door observable: after `patchServiceSelector` the same Service name resolves to
   * different pods, exactly as it would in a cluster.
   */
  function endpointsFor(ns, selector) {
    const wanted = Object.entries(selector ?? {});
    if (wanted.length === 0) return [];
    return [...deployments.values()].filter((record) => (
      record.namespace === ns
      && record.ready > 0
      && wanted.every(([k, v]) => record.podLabels[k] === v)
    ));
  }

  return {
    name: 'sim',
    namespace,
    simulated: true,

    /** There is no cluster. Saying so is the honest answer, and it is what gets logged. */
    describeTarget() {
      return {
        context: null,
        cluster: 'sim (no cluster: nothing here runs)',
        server: null,
        pinned: true,
        simulated: true,
      };
    },

    async ensureNamespace(name = namespace) {
      ensuredNamespaces.add(name);
      return name;
    },

    namespaceFor(project, { base = namespace } = {}) {
      return projectNamespace(project, { base });
    },

    /**
     * There is no cluster, so nothing is created — but the *name* is real, and it is what
     * every object this launch goes on to build is placed in. Returning the same string
     * the Kubernetes backend would return is the whole point: it is what lets a test
     * assert that two projects' jobs landed in different namespaces without a cluster.
     */
    async ensureProjectNamespace(project, { base = namespace } = {}) {
      const name = projectNamespace(project, { base });
      ensuredNamespaces.add(name);
      // No cluster, so no RBAC — but the *fact* of the grant is recorded, because a
      // namespace that ships no logs is the kind of regression that shows up as an empty
      // panel weeks later rather than as a failure here.
      logReaderGrants.add(name);
      return name;
    },

    /** The namespaces a log collector was granted read access in. */
    logReaderGrants,

    /** The namespaces this backend was asked to create, in insertion order. */
    ensuredNamespaces,

    /**
     * Nothing here is on a network, so there is no boundary to draw.
     *
     * Recorded rather than ignored: a test can assert the executor asked for a project's
     * isolation before launching its job, which is the ordering that matters and the one
     * a no-op would let regress unnoticed.
     */
    async ensureProjectIsolation(project, { namespace: ns = namespace } = {}) {
      isolatedProjects.add(project);
      isolatedIn.set(project, ns);
    },

    /** Which namespace each project's boundary was last drawn in. */
    isolatedIn,

    /** The projects this backend was asked to isolate, in insertion order. */
    isolatedProjects,

    /** No cluster, so no node ranges to disagree with. */
    async verifyClusterPodCidr() {
      return [];
    },

    async listNodes() {
      return simNodes.map((node) => ({ ...node, simulated: true }));
    },

    async createJob(manifest) {
      const ns = manifest.metadata.namespace ?? namespace;
      const id = key(ns, manifest.metadata.name);
      if (jobs.has(id)) return; // Idempotent, matching the real backend.

      jobs.set(id, {
        manifest,
        phase: Phase.PENDING,
        reason: 'simulated pod pending',
        observations: 0,
        logs:
          `[sim] no container was executed for ${manifest.metadata.name}.\n`
          + '[sim] this output is fabricated by the sim backend '
          + '(ASHML_K8S_BACKEND=sim); set ASHML_K8S_BACKEND=kubernetes for a real run.\n',
      });
    },

    async observeJob(ns, name) {
      const record = jobs.get(key(ns, name));
      if (!record) return null;

      if (autoAdvance) {
        record.observations += 1;
        if (record.observations > observationsToRunning + observationsToFinish) {
          record.phase = finalPhase;
          record.reason = finalPhase === Phase.SUCCEEDED ? 'completed' : 'simulated failure';
        } else if (record.observations > observationsToRunning) {
          record.phase = Phase.RUNNING;
          record.reason = 'simulated pod running';
        }
      }

      return {
        phase: record.phase,
        reason: record.reason,
        active: record.phase === Phase.RUNNING ? 1 : 0,
        succeeded: record.phase === Phase.SUCCEEDED ? 1 : 0,
        failed: record.phase === Phase.FAILED ? 1 : 0,
        node: 'sim-node-0',
        simulated: true,
      };
    },

    async deleteJob(ns, name) {
      jobs.delete(key(ns, name));
    },

    async deleteSecret(ns, name) {
      secrets.delete(key(ns ?? namespace, name));
    },

    async deleteSecrets(ns, labels) {
      const wanted = Object.entries(labels);
      if (wanted.length === 0) {
        throw new Error('deleteSecrets: at least one label is required');
      }
      for (const [id, manifest] of secrets) {
        if (!id.startsWith(`${ns ?? namespace}/`)) continue;
        const has = manifest.metadata?.labels ?? {};
        if (wanted.every(([k, v]) => has[k] === v)) secrets.delete(id);
      }
    },

    async applySecret(manifest) {
      const ns = manifest.metadata.namespace ?? namespace;
      secrets.set(key(ns, manifest.metadata.name), manifest);
    },

    async applyDeployment(manifest) {
      const ns = manifest.metadata.namespace ?? namespace;
      const id = key(ns, manifest.metadata.name);

      // Replaces rather than ignores when it already exists, matching the real backend:
      // a Deployment is a mutable object, and a rollout is an update to it.
      deployments.set(id, {
        manifest,
        namespace: ns,
        desired: manifest.spec?.replicas ?? 1,
        // A rollout starts with nothing ready, even when replacing something that was.
        // Reporting the old ready count against the new manifest would make a
        // simulated rollout look instantaneous, which is the one thing about a rollout
        // worth simulating.
        ready: 0,
        observations: 0,
        // The labels its pods would carry. This is what a Service's selector matches
        // against, so it is read from the pod template rather than from the Deployment's
        // own metadata — the two are usually the same and the distinction is the whole
        // reason a selector can be wrong.
        podLabels: manifest.spec?.template?.metadata?.labels ?? {},
      });
    },

    async applyService(manifest) {
      const ns = manifest.metadata.namespace ?? namespace;
      const id = key(ns, manifest.metadata.name);
      // Created if absent, left alone if present — matching the real backend, where a
      // Service's assigned clusterIP makes a replace impossible. Moving one is
      // `patchServiceSelector`, which is a different operation on purpose.
      if (!services.has(id)) {
        services.set(id, { selector: { ...(manifest.spec?.selector ?? {}) } });
      }
    },

    async patchServiceSelector(ns, name, selector) {
      const record = services.get(key(ns, name));
      if (!record) throw new Error(`sim: no such service ${key(ns, name)}`);
      // Replaced wholesale, not merged, for the reason the real backend spells out: a
      // merged selector keeps a key the new one dropped and ends up matching nothing.
      record.selector = { ...selector };
    },

    async listDeploymentNames(ns, labels) {
      const wanted = Object.entries(labels);
      return [...deployments.values()]
        .filter((record) => record.namespace === ns)
        .filter((record) => {
          const own = record.manifest.metadata.labels ?? {};
          return wanted.every(([k, v]) => own[k] === v);
        })
        .map((record) => ({
          name: record.manifest.metadata.name,
          labels: record.manifest.metadata.labels ?? {},
        }));
    },

    async observeDeployment(ns, name) {
      const record = deployments.get(key(ns, name));
      if (!record) return null;

      if (autoAdvance) {
        record.observations += 1;
        if (record.observations > observationsToRunning) {
          record.ready = record.desired;
        }
      }

      return {
        desired: record.desired,
        ready: record.ready,
        available: record.ready,
        updated: record.desired,
        reason: null,
        // The real backend derives this from the pods; there are none here, and saying
        // so is better than a plausible sentence a test could come to depend on.
        pendingReason: record.ready >= record.desired ? null : 'simulated: no pods to ask',
        simulated: true,
      };
    },

    async deleteDeployment(ns, name) {
      deployments.delete(key(ns, name));
      services.delete(key(ns, name));
    },

    /**
     * Refuses, in words, rather than inventing an answer.
     *
     * Every other thing this backend fabricates is infrastructure: a pod phase, a ready
     * count, a node's capacity. A prediction is not infrastructure — it is model output,
     * and spec Rule 5 forbids faking that outright. A simulated deployment has no
     * weights in it, so the only honest response is to say so, and a caller reading
     * `simulated: true` off this is reading a refusal rather than a plausible number.
     *
     * A test that needs a service to answer installs `_setServiceResponder` explicitly.
     * That keeps the fabrication in the test that wanted it, where it is visible, rather
     * than in a backend a demo might be pointed at by accident.
     */
    async callService(ns, name, options = {}) {
      const service = services.get(key(ns, name));
      if (!service) {
        return {
          status: 404,
          body: { error: `sim: no such service ${key(ns, name)}` },
          headers: {},
          text: `sim: no such service ${key(ns, name)}`,
          simulated: true,
        };
      }
      // A responder is a fixture a test installed deliberately, and it stands in for the
      // pod itself — so it answers whether or not this fake cluster has endpoints, in the
      // same way a real pod answers whether or not anyone modelled kube-proxy.
      if (responder) return { headers: {}, ...(await responder(ns, name, options)), simulated: true };

      // A Service with no ready endpoints is not a 404 — the name resolves, nothing
      // answers — and the two are worth telling apart here for the same reason they are
      // in the real backend: one is a deployment that does not exist and the other is a
      // deployment that is not ready, and an operator does different things about them.
      if (endpointsFor(ns, service.selector).length === 0) {
        const message = `sim: ${key(ns, name)} resolves to no ready pods`;
        return {
          status: 503, headers: {}, body: { error: message }, text: message, simulated: true,
        };
      }

      const message = 'sim: no container is running, so there is nothing to answer this. '
        + 'The sim backend fabricates cluster state (ASHML_K8S_BACKEND=sim); it will not '
        + 'fabricate model output. Set ASHML_K8S_BACKEND=kubernetes to ask a real pod.';
      return {
        status: 501, headers: {}, body: { error: message }, text: message, simulated: true,
      };
    },

    /**
     * Test seam: make `callService` answer with whatever this returns.
     *
     * Deliberately not a default: see `callService`. A test that installs one is stating
     * that the answer is a fixture it wrote, which is a different thing from a backend
     * that hands out predictions to anyone who asks.
     */
    _setServiceResponder(fn) {
      responder = fn;
    },

    /** Test seam: drive a deployment's ready count directly, bypassing autoAdvance. */
    _setReady(ns, name, ready) {
      const record = deployments.get(key(ns, name));
      if (!record) throw new Error(`sim: no such deployment ${key(ns, name)}`);
      record.ready = ready;
    },

    async readLogs(ns, name) {
      const record = jobs.get(key(ns, name));
      return record ? record.logs : null;
    },

    async close() {
      jobs.clear();
      deployments.clear();
      services.clear();
    },

    /** Test seam: drive a job to a phase directly, bypassing autoAdvance. */
    _setPhase(ns, name, phase, reason = '') {
      const record = jobs.get(key(ns, name));
      if (!record) throw new Error(`sim: no such job ${key(ns, name)}`);
      record.phase = phase;
      record.reason = reason || record.reason;
    },

    /** Test seam: how many Jobs the fake cluster currently holds. */
    _size() {
      return jobs.size;
    },

    /**
     * Test seam: empty the fake cluster.
     *
     * A test that truncates the database must clear this too, or the next test starts
     * against workloads belonging to jobs that no longer exist.
     */
    _reset() {
      jobs.clear();
      deployments.clear();
      secrets.clear();
      isolatedProjects.clear();
      responder = null;
    },

    /** What a workload was actually handed, for tests to assert against. */
    _secret(ns, name) {
      return secrets.get(key(ns, name)) ?? null;
    },

    /** The manifest a Job was created from — what a `kubectl get job -o yaml` would show. */
    _jobManifest(ns, name) {
      return jobs.get(key(ns, name))?.manifest ?? null;
    },
  };
}

registerBackend('sim', createSimBackend);
