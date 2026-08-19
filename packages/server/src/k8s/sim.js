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

  const key = (ns, name) => `${ns}/${name}`;

  return {
    name: 'sim',
    namespace,
    simulated: true,

    async ensureNamespace() {},

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

    async readLogs(ns, name) {
      const record = jobs.get(key(ns, name));
      return record ? record.logs : null;
    },

    async close() {
      jobs.clear();
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
    },
  };
}

registerBackend('sim', createSimBackend);
