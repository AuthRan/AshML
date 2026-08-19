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
import * as experimentsRepo from '../repos/experiments.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

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
export async function submitJob(pool, { projectName, name, spec, resources, priority, maxRetries, experimentId = null }) {
  return withTransaction(pool, async (client) => {
    const project = await projectsRepo.getProjectByName(client, projectName);
    if (!project) {
      throw new NotFoundError(`project "${projectName}" not found`);
    }

    if (experimentId !== null) {
      const experiment = await experimentsRepo.getExperimentById(client, experimentId);
      if (!experiment) {
        throw new NotFoundError(`experiment ${experimentId} not found`);
      }
      // Quotas, and later scheduling, are per project. A job attributed to another
      // project's experiment would make both sides' accounting wrong.
      if (experiment.project !== projectName) {
        throw new ValidationError(
          'EXPERIMENT_PROJECT_MISMATCH',
          `experiment ${experimentId} belongs to project "${experiment.project}", not "${projectName}"`,
        );
      }
    }

    const jobId = await jobsRepo.insertJob(client, {
      projectId: project.id,
      experimentId,
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
 * States in which a Kubernetes workload may exist for this job.
 *
 * SCHEDULING is included even though the Job is usually not created yet: the executor
 * creates it outside a transaction, so a cancel arriving mid-launch could otherwise
 * mark the job CANCELLED while a Pod is still being created — an orphan holding a GPU
 * that nothing points at. Handing these to the executor instead is what closes that
 * race, and it can do so safely because the Kubernetes Job name is derived from the
 * job id and attempt, so it is known even before the Job exists.
 */
const CANCEL_NEEDS_EXECUTOR = new Set([
  JobState.SCHEDULING,
  JobState.STARTING,
  JobState.RUNNING,
]);

/**
 * Cancels a job.
 *
 * A job with no workload behind it (CREATED, or still QUEUED and therefore unclaimed)
 * reaches CANCELLED in this one call. Once the executor may have created a Kubernetes
 * Job, cancellation stops at CANCELLING and the executor completes it after tearing
 * the workload down — the job is not cancelled until the Pod is actually gone.
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
    } else if (CANCEL_NEEDS_EXECUTOR.has(job.state)) {
      await applyTransition(client, jobId, JobState.CANCELLING, {
        message: reason,
        details: { awaiting: 'workload teardown' },
      });
    } else {
      await applyTransition(client, jobId, JobState.CANCELLING, { message: reason });
      await applyTransition(client, jobId, JobState.CANCELLED, {
        message: 'no workload had been launched; cancelled immediately',
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

/**
 * Records that a Kubernetes Job has been created for this attempt: SCHEDULING -> STARTING.
 *
 * The Job name and the state change are written in one transaction. Writing them
 * separately would allow a crash to leave a job STARTING with no recorded name, and
 * therefore a Pod that nothing can observe, cancel, or read logs from.
 */
export async function markLaunched(pool, jobId, k8sJobName, { namespace, simulated = false } = {}) {
  return withTransaction(pool, async (client) => {
    await jobsRepo.setK8sJobName(client, jobId, k8sJobName);
    await applyTransition(client, jobId, JobState.STARTING, {
      message: `kubernetes Job ${k8sJobName} created`,
      details: { k8s_job_name: k8sJobName, namespace, simulated },
    });
    return jobsRepo.getJobById(client, jobId);
  });
}

/**
 * Applies what the cluster reports onto the job's state.
 *
 * This is the only path by which observed reality changes a job's state, and it is
 * deliberately one transaction per job: the row is locked, the transition validated
 * against the state machine, and the event written, so a status-sync tick that
 * overlaps a user's cancel cannot produce a state neither of them asked for.
 *
 * Returns the resulting state, or null if the observation implied no change.
 *
 * @param {object} observation from a k8s backend: { phase, reason, node, simulated }
 */
export async function recordObservation(pool, jobId, observation) {
  return withTransaction(pool, async (client) => {
    const job = await jobsRepo.getJobForUpdate(client, jobId);
    if (!job) {
      throw new NotFoundError(`job ${jobId} not found`);
    }

    // A cancel may have landed between listing this job and observing it. The user's
    // intent wins: cancellation is finished by the executor's teardown path, not here.
    if (job.state === JobState.CANCELLING || isJobFinished(job.state)) {
      return null;
    }

    const details = {
      k8s_phase: observation.phase,
      node: observation.node ?? null,
      ...(observation.simulated ? { simulated: true } : {}),
    };

    switch (observation.phase) {
      case 'PENDING':
        // Still pulling the image or waiting for a node. STARTING already says that.
        return null;

      case 'RUNNING':
        if (job.state === JobState.RUNNING) return null;
        await applyTransition(client, jobId, JobState.RUNNING, {
          message: observation.reason || 'pod running',
          details,
        });
        return JobState.RUNNING;

      case 'SUCCEEDED':
        // A short container can finish between two ticks, so the first observation of
        // it may be SUCCEEDED while AshML still has the job in STARTING. The state
        // machine has no STARTING -> SUCCEEDED edge, and it should not: the container
        // did run, so the run is recorded through RUNNING rather than skipping it.
        if (job.state === JobState.STARTING) {
          await applyTransition(client, jobId, JobState.RUNNING, {
            message: 'pod ran to completion between status checks',
            details,
          });
        }
        await applyTransition(client, jobId, JobState.SUCCEEDED, {
          message: observation.reason || 'completed',
          details,
        });
        return JobState.SUCCEEDED;

      case 'FAILED':
        await applyTransition(client, jobId, JobState.FAILED, {
          message: observation.reason || 'pod failed',
          details,
          failureReason: observation.reason || 'pod failed',
        });
        return JobState.FAILED;

      default:
        throw new ValidationError(
          'UNKNOWN_K8S_PHASE',
          `k8s backend reported unknown phase "${observation.phase}" for job ${jobId}`,
        );
    }
  });
}

/**
 * Fails a job whose workload vanished from the cluster.
 *
 * Distinct from an observed pod failure because the cause is different and an
 * operator needs to be able to tell them apart: the container may never have run at
 * all. Never treated as success — AshML must not report a result it did not observe.
 */
export async function markWorkloadMissing(pool, jobId, reason) {
  return withTransaction(pool, async (client) => {
    const job = await jobsRepo.getJobForUpdate(client, jobId);
    if (!job) throw new NotFoundError(`job ${jobId} not found`);
    if (job.state === JobState.CANCELLING || isJobFinished(job.state)) return null;

    await applyTransition(client, jobId, JobState.FAILED, {
      message: reason,
      details: { cause: 'workload_missing' },
      failureReason: reason,
    });
    return JobState.FAILED;
  });
}

/** Completes a cancellation once the workload is gone: CANCELLING -> CANCELLED. */
export async function finishCancellation(pool, jobId, { message = 'workload torn down' } = {}) {
  return withTransaction(pool, async (client) => {
    await applyTransition(client, jobId, JobState.CANCELLED, { message });
    return jobsRepo.getJobById(client, jobId);
  });
}

/** @returns {boolean} whether the job has reached a state the executor no longer drives. */
function isJobFinished(state) {
  return state === JobState.SUCCEEDED
    || state === JobState.FAILED
    || state === JobState.CANCELLED;
}

/** Jobs the executor is responsible for reconciling against the cluster. */
export async function listJobsToReconcile(pool, options) {
  return jobsRepo.listJobsToReconcile(pool, options);
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
