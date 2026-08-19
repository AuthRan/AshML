/**
 * The executor: the loop that turns queued AshML jobs into running Kubernetes
 * workloads, and observed cluster state back into AshML job state.
 *
 * It owns no state of its own. Every tick reads the database, asks the cluster what
 * is true, and writes the difference back through `services/jobs.js` — so a restart
 * loses nothing and two executors racing on the same job cannot corrupt it (the
 * claim is a row lock; every transition re-reads under `FOR UPDATE`).
 *
 * The loop deliberately polls rather than watching. A watch is more efficient, but it
 * is also a stream that can silently stall, and a stalled watch looks exactly like a
 * quiet cluster. Polling makes the failure mode "slower", not "wrong". Phase 6's
 * operator is where a watch belongs, with the resync interval that makes it safe.
 */

import { Phase } from '../k8s/backend.js';
import { buildJobManifest, kubeJobName } from '../k8s/manifest.js';
import { JobState } from '../domain/job-state.js';
import * as jobService from './jobs.js';

/**
 * Launches one claimed job onto the cluster.
 *
 * Order matters: the Kubernetes Job is created *before* the database records that it
 * was. The reverse order would let a crash leave the database claiming a workload
 * exists when none does — a job that would sit in STARTING forever. This way a crash
 * leaves the job in SCHEDULING, which the next tick retries; `createJob` is
 * idempotent and the Job name is derived from the job id and attempt, so the retry
 * adopts the existing Job rather than creating a second one.
 *
 * @returns {Promise<object>} the job, now STARTING
 */
export async function launchJob(pool, backend, job, { logger = null } = {}) {
  const namespace = backend.namespace;
  const manifest = buildJobManifest(job, { namespace });
  const name = manifest.metadata.name;

  await backend.createJob(manifest);
  logger?.info(
    { job_id: job.id, k8s_job_name: name, namespace, backend: backend.name },
    'kubernetes Job created',
  );

  return jobService.markLaunched(pool, job.id, name, {
    namespace,
    simulated: backend.simulated === true,
  });
}

/**
 * Tears down the workload for a job the user cancelled, then marks it CANCELLED.
 *
 * The delete is issued whether or not a Job name was recorded. A job cancelled during
 * SCHEDULING may have had its Kubernetes Job created moments before the cancel landed,
 * and because the name is deterministic it can be deleted anyway — deleting a Job that
 * does not exist is a no-op in every backend, whereas skipping the delete would leak a
 * Pod holding a GPU.
 */
export async function cancelWorkload(pool, backend, job, { logger = null } = {}) {
  const name = job.k8s_job_name ?? kubeJobName(job);

  await backend.deleteJob(backend.namespace, name);
  logger?.info({ job_id: job.id, k8s_job_name: name }, 'workload deleted for cancellation');

  return jobService.finishCancellation(pool, job.id, {
    message: `kubernetes Job ${name} deleted`,
  });
}

/**
 * Reconciles one job against the cluster.
 *
 * @returns {Promise<string|null>} the new state, or null if nothing changed
 */
export async function reconcileJob(pool, backend, job, { logger = null } = {}) {
  if (job.state === JobState.CANCELLING) {
    await cancelWorkload(pool, backend, job, { logger });
    return JobState.CANCELLED;
  }

  // Claimed but never launched — finish what a previous tick or process started.
  if (job.state === JobState.SCHEDULING) {
    await launchJob(pool, backend, job, { logger });
    return JobState.STARTING;
  }

  const observation = await backend.observeJob(backend.namespace, job.k8s_job_name);

  if (observation === null) {
    // The Job is gone but AshML never saw it finish. This is not a success: the
    // container may have been evicted, or an operator may have deleted it by hand.
    // Reporting a result that was never observed is exactly what spec Rule 5 forbids.
    const reason = `kubernetes Job ${job.k8s_job_name} disappeared before reporting a result`;
    logger?.warn({ job_id: job.id, k8s_job_name: job.k8s_job_name }, reason);
    return jobService.markWorkloadMissing(pool, job.id, reason);
  }

  const newState = await jobService.recordObservation(pool, job.id, observation);
  if (newState) {
    logger?.info(
      { job_id: job.id, state: newState, k8s_phase: observation.phase, node: observation.node },
      'job state advanced from observed cluster state',
    );
  }
  return newState;
}

/**
 * Runs one full pass: reconcile everything already launched, then launch what the
 * queue is holding.
 *
 * Reconciling first is not cosmetic — it is what frees finished jobs before new ones
 * are admitted, so a full cluster drains before it fills again.
 *
 * A failure on one job never stops the pass. One job with an unpullable image must not
 * be able to stall every other job on the platform, so errors are logged against the
 * job that caused them and the loop continues.
 *
 * @param {object} [options]
 * @param {number} [options.maxLaunches] how many queued jobs to admit this pass
 * @returns {Promise<{reconciled: number, launched: number, errors: number}>}
 */
export async function runOnce(pool, backend, { logger = null, maxLaunches = 10 } = {}) {
  const summary = { reconciled: 0, launched: 0, errors: 0 };

  const active = await jobService.listJobsToReconcile(pool);
  for (const job of active) {
    try {
      const changed = await reconcileJob(pool, backend, job, { logger });
      if (changed) summary.reconciled += 1;
    } catch (err) {
      summary.errors += 1;
      logger?.error({ err, job_id: job.id, state: job.state }, 'reconcile failed');
    }
  }

  for (let i = 0; i < maxLaunches; i += 1) {
    let job;
    try {
      job = await jobService.claimNextJob(pool, { claimedBy: `executor:${backend.name}` });
    } catch (err) {
      summary.errors += 1;
      logger?.error({ err }, 'claiming from the queue failed');
      break;
    }
    if (!job) break;

    try {
      await launchJob(pool, backend, job, { logger });
      summary.launched += 1;
    } catch (err) {
      summary.errors += 1;
      // The job stays SCHEDULING and is retried by the next pass's reconcile. It is
      // deliberately not failed here: an unreachable API server is a platform problem,
      // and failing the user's job for it would be blaming them for our outage.
      logger?.error({ err, job_id: job.id }, 'launch failed; will retry on the next pass');
    }
  }

  return summary;
}

/**
 * Starts the executor loop.
 *
 * Passes never overlap: the next tick is scheduled after the current one settles, so a
 * slow cluster produces a slower loop rather than a pile-up of concurrent passes all
 * reconciling the same jobs.
 *
 * @returns {{ stop: () => Promise<void> }}
 */
export function startExecutor(pool, backend, { logger = null, intervalMs = 2000, maxLaunches = 10 } = {}) {
  let stopped = false;
  let timer = null;
  let settled = Promise.resolve();

  async function tick() {
    if (stopped) return;
    try {
      const summary = await runOnce(pool, backend, { logger, maxLaunches });
      if (summary.launched > 0 || summary.reconciled > 0 || summary.errors > 0) {
        logger?.debug({ ...summary, backend: backend.name }, 'executor pass');
      }
    } catch (err) {
      // runOnce already isolates per-job failures; reaching here means the database
      // itself is unreachable. Keep looping — it may come back, and stopping would
      // require an operator to notice and restart the server.
      logger?.error({ err }, 'executor pass failed');
    }
    if (!stopped) {
      timer = setTimeout(() => { settled = tick(); }, intervalMs);
      // A pending tick must never hold the process open on its own.
      timer.unref?.();
    }
  }

  settled = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Wait for an in-flight pass so shutdown cannot interrupt a transaction.
      await settled.catch(() => {});
    },
  };
}

export { Phase };
