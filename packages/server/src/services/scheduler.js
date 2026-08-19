/**
 * The scheduler: deciding whether a claimed job may run, and where.
 *
 * It sits between the queue and the executor. `claimNextJob` takes a job QUEUED ->
 * SCHEDULING; this module then either binds it to a node (so the executor can launch it)
 * or returns it to the queue with a recorded reason.
 *
 * Two gates, in this order, and the order matters:
 *
 *   1. **Quota** — may this project afford another job at all? Checked first because it
 *      is a property of the request, not of the cluster. A project over quota should be
 *      told so even when the cluster is empty; evaluating nodes first would report
 *      "no capacity" for what is actually a limit the user set themselves.
 *   2. **Placement** — is there a node that fits? (`domain/placement.js`)
 *
 * Both gates are pure functions living in `domain/`. This module's job is to gather
 * what they need, apply what they decide, and write down why — nothing more. Keeping
 * the decision logic out of here is what makes it testable without a database.
 */

import { randomUUID } from 'node:crypto';

import { withTransaction } from '../db/pool.js';
import { placeJob, Outcome } from '../domain/placement.js';
import { checkQuota } from '../domain/quota.js';
import * as nodesRepo from '../repos/nodes.js';
import * as schedulingRepo from '../repos/scheduling.js';
import * as jobsRepo from '../repos/jobs.js';
import * as projectsRepo from '../repos/projects.js';
import * as jobService from './jobs.js';

/** What a scheduling pass concluded. */
export const Placement = Object.freeze({
  BOUND: 'BOUND',
  REQUEUED: 'REQUEUED',
});

/**
 * Schedules one claimed job.
 *
 * The whole pass runs in a single transaction. That is what makes concurrent schedulers
 * safe: the job row is locked while capacity is read and the binding is written, so two
 * passes cannot both read the same free GPU and both promise it away. (`clusterView`
 * derives allocations from job rows, so the lock covers the capacity read as well.)
 *
 * @returns {Promise<{placement: string, node: object|null, reason: string}>}
 */
export async function scheduleJob(pool, jobId, { logger = null } = {}) {
  const passId = randomUUID();

  return withTransaction(pool, async (client) => {
    const job = await jobsRepo.getJobForUpdate(client, jobId);
    if (!job) {
      throw new Error(`scheduler: job ${jobId} vanished mid-pass`);
    }

    const request = {
      cpu: job.resources.cpu,
      memory_bytes: job.resources.memory_bytes,
      gpu: job.resources.gpu,
      gpu_memory_min_bytes: job.resources.gpu_memory_min_bytes,
    };

    // ---- gate 1: quota -------------------------------------------------------
    const project = await projectsRepo.getProjectByName(client, job.project);
    const quota = await nodesRepo.projectQuota(client, project.id);
    const usage = await nodesRepo.projectUsage(client, project.id);

    // This job is already SCHEDULING, so it is counted in `usage` — it must not be
    // charged twice for its own request.
    const usageExcludingThis = {
      gpu: usage.gpu - request.gpu,
      cpu: usage.cpu - request.cpu,
      memory_bytes: usage.memory_bytes - Number(request.memory_bytes),
      jobs: usage.jobs - 1,
    };

    const affordable = checkQuota(request, quota, usageExcludingThis);
    if (!affordable.allowed) {
      await schedulingRepo.recordDecisions(client, {
        jobId, attempt: job.attempt, passId,
        decisions: [{
          node_id: null,
          node_name: '',
          outcome: 'QUOTA_EXCEEDED',
          reason: affordable.reason,
          details: { code: affordable.code, ...affordable.details },
        }],
      });

      return requeue(client, job, affordable.reason, {
        code: affordable.code,
        gate: 'quota',
      });
    }

    // ---- gate 2: placement ---------------------------------------------------
    const nodes = await nodesRepo.clusterView(client);

    // The job is SCHEDULING, so `clusterView` already counts its request against the
    // node it was last bound to. On a first pass it is bound to nothing, so nothing is
    // double-counted; on a requeue its binding was cleared for exactly this reason.
    const decision = placeJob(request, nodes);

    await schedulingRepo.recordDecisions(client, {
      jobId, attempt: job.attempt, passId, decisions: decision.decisions,
    });

    if (decision.outcome !== Outcome.SELECTED) {
      return requeue(client, job, decision.reason, { gate: 'placement' });
    }

    await nodesRepo.bindJobToNode(client, jobId, decision.node.id, decision.reason);
    logger?.info(
      { job_id: jobId, node: decision.node.name, reason: decision.reason },
      'job placed',
    );

    return { placement: Placement.BOUND, node: decision.node, reason: decision.reason };
  });
}

/**
 * Returns a job to the queue, SCHEDULING -> QUEUED.
 *
 * The binding is cleared first. A job that goes back to the queue still holding a node
 * would keep that node's capacity reserved for work that is not going to run there,
 * and the next pass would then place against capacity its own previous pass consumed.
 */
async function requeue(client, job, reason, details) {
  await nodesRepo.unbindJob(client, job.id, reason);

  await jobService.applyTransitionForScheduler(client, job.id, 'QUEUED', {
    message: reason,
    details,
  });

  return { placement: Placement.REQUEUED, node: null, reason };
}

/** A job's recorded scheduling history, newest pass first. */
export async function getSchedulingHistory(pool, jobId, options) {
  return schedulingRepo.listDecisions(pool, jobId, options);
}
