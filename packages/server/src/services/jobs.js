/**
 * Job service — the only place state changes happen.
 *
 * Every transition goes through `applyTransition`, which validates against the domain
 * state machine and writes both the new state and its event row inside one
 * transaction. Nothing else in the codebase may write `training_jobs.state`.
 */

import { JobState, transition, IllegalTransitionError } from '../domain/job-state.js';
import { withTransaction } from '../db/pool.js';
import * as jobsRepo from '../repos/jobs.js';
import * as projectsRepo from '../repos/projects.js';

/** Maps a target state onto the event name recorded for it (spec §47). */
const EVENT_FOR_STATE = Object.freeze({
  [JobState.QUEUED]: 'JOB_QUEUED',
  [JobState.SCHEDULING]: 'JOB_SCHEDULING',
  [JobState.STARTING]: 'JOB_STARTING',
  [JobState.RUNNING]: 'JOB_STARTED',
  [JobState.SUCCEEDED]: 'JOB_COMPLETED',
  [JobState.FAILED]: 'JOB_FAILED',
  [JobState.RETRYING]: 'JOB_RETRYING',
  [JobState.CANCELLING]: 'JOB_CANCELLING',
  [JobState.CANCELLED]: 'JOB_CANCELLED',
});

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
    this.statusCode = 404;
  }
}

export class ConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConflictError';
    this.code = code;
    this.statusCode = 409;
  }
}

/**
 * Moves a job to `toState`, writing the state and its event atomically.
 *
 * The row is locked with FOR UPDATE before the transition is evaluated, so a
 * concurrent writer cannot observe the same starting state and race us.
 *
 * @param {import('pg').PoolClient} client must already be in a transaction
 */
async function applyTransition(client, jobId, toState, { message = '', details = {}, failureReason = null } = {}) {
  const job = await jobsRepo.getJobForUpdate(client, jobId);
  if (!job) {
    throw new NotFoundError(`job ${jobId} not found`);
  }

  // Throws IllegalTransitionError, which the route layer maps to 409.
  transition(job.state, toState);

  await jobsRepo.updateJobState(client, jobId, toState, { failureReason });
  await jobsRepo.insertJobEvent(client, {
    jobId,
    eventType: EVENT_FOR_STATE[toState] ?? 'JOB_STATE_CHANGED',
    fromState: job.state,
    toState,
    message,
    details,
  });

  return job.state;
}

/**
 * Submits a job: creates it, then immediately queues it.
 *
 * Both steps happen in one transaction so a job can never be left in CREATED with no
 * one responsible for advancing it.
 */
export async function submitJob(pool, { projectName, name, spec, resources, priority, maxRetries }) {
  return withTransaction(pool, async (client) => {
    const project = await projectsRepo.getProjectByName(client, projectName);
    if (!project) {
      throw new NotFoundError(`project "${projectName}" not found`);
    }

    const jobId = await jobsRepo.insertJob(client, {
      projectId: project.id,
      name,
      state: JobState.CREATED,
      priority,
      spec,
      resources,
      maxRetries,
    });

    await jobsRepo.insertJobEvent(client, {
      jobId,
      eventType: 'JOB_CREATED',
      toState: JobState.CREATED,
      message: `submitted to project ${projectName}`,
    });

    await applyTransition(client, jobId, JobState.QUEUED, {
      message: 'admitted to queue',
      details: { priority },
    });

    return jobsRepo.getJobById(client, jobId);
  });
}

/**
 * Cancels a job.
 *
 * A queued job passes through CANCELLING to CANCELLED in a single call, because in
 * Phase 1 there is no running workload to wait for. From Phase 2 the Kubernetes
 * status-sync loop owns the second step, and this will stop at CANCELLING.
 */
export async function cancelJob(pool, jobId, { reason = 'cancelled by user' } = {}) {
  return withTransaction(pool, async (client) => {
    const job = await jobsRepo.getJobForUpdate(client, jobId);
    if (!job) {
      throw new NotFoundError(`job ${jobId} not found`);
    }

    if (job.state === JobState.CANCELLED || job.state === JobState.CANCELLING) {
      throw new ConflictError('ALREADY_CANCELLED', `job ${jobId} is already ${job.state}`);
    }

    // Terminal states have no outgoing edges; say so plainly rather than letting the
    // state machine produce a less helpful message.
    if (job.state === JobState.SUCCEEDED) {
      throw new ConflictError('JOB_ALREADY_FINISHED', `job ${jobId} already SUCCEEDED`);
    }

    if (job.state === JobState.CREATED) {
      await applyTransition(client, jobId, JobState.CANCELLED, { message: reason });
    } else {
      await applyTransition(client, jobId, JobState.CANCELLING, { message: reason });
      await applyTransition(client, jobId, JobState.CANCELLED, {
        message: 'no workload running; cancelled immediately',
        details: { phase: 1 },
      });
    }

    return jobsRepo.getJobById(client, jobId);
  });
}

/**
 * Claims the next queued job for execution, moving it QUEUED -> SCHEDULING.
 *
 * Locking and transitioning happen in one transaction, which is what makes the claim
 * exclusive: a second scheduler skips the locked row (ADR 0004), and by the time the
 * lock is released the job is no longer QUEUED, so it cannot be handed out twice.
 * Locking alone is not a claim — without the transition the same job is returned on
 * every call.
 *
 * Returns null on an empty queue rather than blocking; the Phase 3 scheduler loop polls.
 *
 * @returns {Promise<object|null>} the claimed job, now in SCHEDULING
 */
export async function claimNextJob(pool, { claimedBy = 'scheduler' } = {}) {
  return withTransaction(pool, async (client) => {
    const locked = await jobsRepo.lockNextQueuedJob(client);
    if (!locked) {
      return null;
    }

    await applyTransition(client, locked.id, JobState.SCHEDULING, {
      message: `claimed by ${claimedBy}`,
      details: { priority: locked.priority },
    });

    return jobsRepo.getJobById(client, locked.id);
  });
}

export async function getJob(pool, jobId) {
  const job = await jobsRepo.getJobById(pool, jobId);
  if (!job) {
    throw new NotFoundError(`job ${jobId} not found`);
  }
  return job;
}

export async function getJobEvents(pool, jobId) {
  const job = await jobsRepo.getJobById(pool, jobId);
  if (!job) {
    throw new NotFoundError(`job ${jobId} not found`);
  }
  return jobsRepo.listJobEvents(pool, jobId);
}

export async function listJobs(pool, filters) {
  return jobsRepo.listJobs(pool, filters);
}

export { IllegalTransitionError };
