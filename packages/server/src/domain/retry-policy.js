/**
 * Whether a failed job is worth running again (spec §10, milestone 10).
 *
 * Pure: no database, no cluster, no clock. The decision is separated from the code that
 * acts on it for the same reason placement is — a retry that fires for the wrong reason
 * is not a neutral cost. It occupies a GPU for the length of a training run in order to
 * reproduce a failure exactly, and it does that `max_retries` times.
 *
 * The governing idea is that **a retry has to be able to change the outcome**. Two
 * things can make it able to: the failure was caused by the infrastructure rather than
 * the workload, or the run can resume from a checkpoint instead of starting over. If
 * neither holds, running the identical container against the identical inputs produces
 * the identical failure, and the honest thing is to say so and stop.
 *
 * That is why `max_retries` defaults to 0. Retrying is opt-in per job, and even then it
 * is refused for the failures below, where trying again is arithmetic rather than hope.
 */

/** Why a job will or will not be retried. Recorded on the event, so it is auditable. */
export const RetryDecision = Object.freeze({
  RETRY: 'RETRY',
  /** Trying again cannot change the result. */
  PERMANENT: 'PERMANENT',
  /** It could have changed the result, but the budget is used up. */
  EXHAUSTED: 'EXHAUSTED',
  /** The job did not fail, or a human ended it. */
  NOT_APPLICABLE: 'NOT_APPLICABLE',
});

/**
 * Failure categories, and whether re-running the same container can change them.
 *
 * Matched against the human-readable reason the backend produced, because that is what
 * Kubernetes actually gives us — there is no machine-readable failure taxonomy on a Pod
 * that survives the trip through `reasonFromPod`. The patterns are deliberately narrow:
 * a category that matched too eagerly would suppress retries that should have happened,
 * which is the more expensive mistake of the two (a run that could have recovered on
 * its own instead needs a human).
 */
const CATEGORIES = [
  {
    name: 'image',
    retryable: false,
    // A tag that does not exist does not begin to exist because a second Pod asked for
    // it. The fix is a different image reference, which is a new job.
    pattern: /ImagePullBackOff|ErrImagePull|InvalidImageName|ImageInspectError|RegistryUnavailable/i,
    explanation: 'the image could not be pulled; a retry would ask the same registry for the same missing image',
  },
  {
    name: 'container_config',
    retryable: false,
    // A missing ConfigMap key or an unparsable command is a description of the job, and
    // the description is what the retry would copy.
    pattern: /CreateContainerConfigError|CreateContainerError|RunContainerError/i,
    explanation: 'the container could not be created from this spec; the spec is what a retry would repeat',
  },
  {
    name: 'out_of_memory',
    retryable: false,
    // Exit 137 is SIGKILL, which for a container is nearly always the OOM killer. The
    // same memory request and the same model produce the same kill, so this needs a
    // bigger request rather than another attempt.
    pattern: /OOMKilled|exited 137/i,
    explanation: 'the container was killed for exceeding its memory; the same request would be exceeded again',
  },
  {
    name: 'evicted',
    retryable: true,
    // The node ran out of something, or was drained. Somewhere else may well have room,
    // and placement is decided fresh on requeue.
    pattern: /Evicted|NodeShutdown|Preempt|DisruptionTarget|TaintManagerEviction/i,
    explanation: 'the pod was evicted by the cluster rather than failing on its own',
  },
  {
    name: 'workload_missing',
    retryable: true,
    // AshML never observed a result. That is not evidence the workload is broken — an
    // operator may have deleted the Job — so it is worth one more look.
    pattern: /disappeared before reporting a result|NodeLost/i,
    explanation: 'the workload vanished before reporting a result, so nothing was learned about the code',
  },
  {
    name: 'unschedulable',
    retryable: true,
    // Capacity is the most transient thing in the cluster. Requeueing re-runs placement
    // against what is free now, and if nothing is, the scheduler refuses it with an
    // explanation rather than burning an attempt.
    pattern: /Unschedulable|FailedScheduling/i,
    explanation: 'no node would take the pod at the time; capacity may free up',
  },
];

/**
 * The category a failure reason falls into.
 *
 * An unrecognised reason is treated as **retryable**, which is the deliberate default.
 * A generic non-zero exit may be a deterministic bug in the training script — in which
 * case the retry is wasted — or a transient fault in something the script talked to. We
 * cannot tell the two apart from here, and the operator has already expressed a view by
 * setting `max_retries` above zero. Guessing "permanent" would silently disable a
 * feature they explicitly asked for.
 */
export function classifyFailure(reason) {
  const text = String(reason ?? '');
  for (const category of CATEGORIES) {
    if (category.pattern.test(text)) {
      return {
        category: category.name,
        retryable: category.retryable,
        explanation: category.explanation,
      };
    }
  }
  return {
    category: 'unknown',
    retryable: true,
    explanation: 'the failure was not recognised as one a retry cannot fix',
  };
}

/**
 * Decides whether a failed job should run again.
 *
 * @param {object} job with `state`, `attempt`, `max_retries`, `failure_reason`
 * @param {object} [options]
 * @param {boolean} [options.canResume] whether a checkpoint exists to resume from.
 *   This does not make a permanent failure retryable — a missing image is still missing
 *   — but it is recorded, because "retried from step zero" and "retried from epoch 4"
 *   are different events and the second is the one the whole checkpoint lifecycle was
 *   built to enable.
 * @returns {{decision: string, retryable: boolean, category: string, message: string,
 *   attempt: number, remaining: number}}
 */
export function decideRetry(job, { canResume = false } = {}) {
  const attempt = job.attempt ?? 0;
  const maxRetries = job.max_retries ?? 0;
  const remaining = Math.max(0, maxRetries - attempt);

  if (job.state !== 'FAILED') {
    return {
      decision: RetryDecision.NOT_APPLICABLE,
      retryable: false,
      category: 'not_failed',
      message: `job is ${job.state}, not FAILED`,
      attempt,
      remaining,
    };
  }

  const { category, retryable, explanation } = classifyFailure(job.failure_reason);

  // Checked before the budget so that the message names the real obstacle. Telling
  // someone their retries are exhausted, when the failure would never have been retried
  // at any budget, sends them to raise `max_retries` and watch it fail again.
  if (!retryable) {
    return {
      decision: RetryDecision.PERMANENT,
      retryable: false,
      category,
      message: `not retrying: ${explanation}`,
      attempt,
      remaining,
    };
  }

  if (remaining <= 0) {
    return {
      decision: RetryDecision.EXHAUSTED,
      retryable: false,
      category,
      message: maxRetries === 0
        ? 'not retrying: this job was submitted with max_retries 0'
        : `not retrying: all ${maxRetries} retries have been used`,
      attempt,
      remaining: 0,
    };
  }

  const resumption = canResume
    ? 'resuming from the last confirmed checkpoint'
    : 'restarting from the beginning; no confirmed checkpoint to resume from';

  return {
    decision: RetryDecision.RETRY,
    retryable: true,
    category,
    message: `retrying (attempt ${attempt + 1} of ${maxRetries}): ${explanation}; ${resumption}`,
    attempt,
    remaining,
  };
}
