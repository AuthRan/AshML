/**
 * Job service — the only place state changes happen.
 *
 * Every transition goes through `applyTransition`, which validates against the domain
 * state machine and writes both the new state and its event row inside one
 * transaction. Nothing else in the codebase may write `training_jobs.state`.
 */

import { JobState, transition, IllegalTransitionError } from '../domain/job-state.js';
import { decideRetry, RetryDecision } from '../domain/retry-policy.js';
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
 * Applies a transition inside a transaction the caller already owns.
 *
 * `applyTransition` is deliberately private — this module is the only place
 * `training_jobs.state` is written, and that rule is what keeps two writers from
 * corrupting a job. The scheduler is the one caller that genuinely cannot use the
 * public helpers: it must read cluster capacity, decide, and change state inside *one*
 * transaction, or two concurrent passes will both see the same free GPU. Handing it the
 * same validated primitive keeps the rule intact rather than letting it write state
 * directly.
 *
 * @param {import('pg').PoolClient} client must already be in a transaction
 */
export async function applyTransitionForScheduler(client, jobId, toState, options) {
  return applyTransition(client, jobId, toState, options);
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
          // Does not name the other project: a 400 is relayed to the caller, and the
          // name of a project they cannot see is not theirs to learn.
          `experiment ${experimentId} does not belong to project "${projectName}"`,
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
export async function claimNextJob(pool, { claimedBy = 'scheduler', excludeIds = [] } = {}) {
  return withTransaction(pool, async (client) => {
    const locked = await jobsRepo.lockNextQueuedJob(client, { excludeIds });
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
    await jobsRepo.setK8sJobName(client, jobId, k8sJobName, namespace ?? null);
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
      case 'PENDING': {
        // Still pulling the image, or waiting for a node that may never take it. The
        // state does not change — STARTING is correct — but the *reason* is recorded,
        // because "STARTING, indefinitely, no explanation" is the same experience as a
        // hang. An unschedulable Pod and a slow image pull look identical from outside
        // until something says which it is.
        const reason = observation.reason || '';
        if (reason && reason !== job.pending_reason) {
          await jobsRepo.setPendingReason(client, jobId, reason);
          // Written to the event log as well, so the sequence of things a job waited on
          // survives after the fact. Only on change: the executor observes every couple
          // of seconds and an unchanged reason is not news.
          await jobsRepo.insertJobEvent(client, {
            jobId,
            eventType: 'JOB_WAITING',
            // Deliberately no from_state/to_state: nothing transitioned. Recording the
            // current state in both would make the event log read as a STARTING ->
            // STARTING move, and the sequence of `to_state` values would stop being the
            // job's actual path through the state machine — which is the one thing that
            // log is relied on for.
            message: reason,
            details: { ...details, state: job.state },
          });
        }
        return null;
      }

      case 'RUNNING':
        if (job.state === JobState.RUNNING) return null;
        // Whatever it was waiting on has happened; the explanation must not outlive it.
        await jobsRepo.setPendingReason(client, jobId, '');
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
        await jobsRepo.setPendingReason(client, jobId, '');
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

/**
 * Decides what happens to one failed job, and does it.
 *
 * The whole decision and its consequences run in a single transaction, holding the job
 * row locked. That is not incidental: without it two executor passes could both read a
 * FAILED job with one retry left and both issue it, producing two attempts against a
 * budget of one — and `max_retries` would mean nothing, which is the same class of bug
 * as the queue handing the same job to two schedulers.
 *
 * Every outcome writes a decision, including "no". An unrecorded refusal would be
 * reconsidered on the next pass, and the next, writing an identical event every couple
 * of seconds for as long as the platform runs.
 *
 * @returns {Promise<object>} the decision, with `applied` saying whether a retry was issued
 */
export async function considerRetry(pool, jobId, { logger = null } = {}) {
  return withTransaction(pool, async (client) => {
    const job = await jobsRepo.getJobForUpdate(client, jobId);
    if (!job) throw new NotFoundError(`job ${jobId} not found`);

    // Another pass may have decided while this one waited for the lock.
    if (job.retry?.decided_at) {
      return { decision: job.retry.decision, applied: false, alreadyDecided: true };
    }

    const checkpoint = await jobsRepo.latestResumableCheckpoint(client, jobId);
    const verdict = decideRetry(job, { canResume: checkpoint !== null });

    if (verdict.decision !== RetryDecision.RETRY) {
      await jobsRepo.recordRetryDecision(client, jobId, { decision: verdict.decision });
      // A JOB_RETRY_DECLINED event rather than silence: "this job failed and stayed
      // failed" is a decision the platform made, and the reason it made it is the thing
      // an operator needs when asking why their job did not come back.
      await jobsRepo.insertJobEvent(client, {
        jobId,
        eventType: 'JOB_RETRY_DECLINED',
        message: verdict.message,
        details: {
          decision: verdict.decision,
          category: verdict.category,
          attempt: verdict.attempt,
          max_retries: job.max_retries,
        },
      });
      logger?.info(
        { job_id: jobId, decision: verdict.decision, category: verdict.category },
        'job will not be retried',
      );
      return { ...verdict, applied: false };
    }

    // FAILED -> RETRYING -> QUEUED. Both edges are walked rather than jumping straight
    // to QUEUED: RETRYING is in the state machine precisely so the event log shows that
    // a requeue was a retry and not a fresh submission, and a reader of `to_state`
    // values can see the loop.
    await applyTransition(client, jobId, JobState.RETRYING, {
      message: verdict.message,
      details: {
        decision: verdict.decision,
        category: verdict.category,
        attempt: verdict.attempt,
        resume_artifact_id: checkpoint?.id ?? null,
        resume_step: checkpoint?.step ?? null,
      },
    });

    const attempt = await jobsRepo.prepareRetry(client, jobId);
    // Only the checkpoint is carried forward. No `retry_decided_at` is written: a retry
    // is not a final decision, and marking one would exclude this job from the driver's
    // next sweep — so if the new attempt also failed, its remaining budget would never
    // be spent. The guard against deciding twice on the *same* failure is the state
    // check above, since a requeued job is QUEUED rather than FAILED.
    await jobsRepo.setResumeArtifact(client, jobId, checkpoint?.id ?? null);

    await applyTransition(client, jobId, JobState.QUEUED, {
      message: checkpoint
        ? `requeued as attempt ${attempt}, resuming from ${checkpoint.name} at step ${checkpoint.step}`
        : `requeued as attempt ${attempt}, starting from the beginning`,
      details: { attempt, resume_artifact_id: checkpoint?.id ?? null },
    });

    logger?.info(
      {
        job_id: jobId,
        attempt,
        category: verdict.category,
        resume_artifact_id: checkpoint?.id ?? null,
        resume_step: checkpoint?.step ?? null,
      },
      'job requeued for retry',
    );

    return { ...verdict, applied: true, attempt, resume: checkpoint ?? null };
  });
}

/** Failed jobs the retry driver has not ruled on yet. */
export async function listJobsAwaitingRetryDecision(pool, options) {
  return jobsRepo.listJobsAwaitingRetryDecision(pool, options);
}

/** The checkpoint a job would resume from, or null. */
export async function getResumeCheckpoint(pool, jobId) {
  return jobsRepo.latestResumableCheckpoint(pool, jobId);
}
