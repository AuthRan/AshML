/**
 * Per-project resource quotas, evaluated at admission.
 *
 * Pure, for the same reasons as `placement.js`: a quota refusal is something a user
 * argues with, so it has to be reproducible and it has to show its arithmetic.
 *
 * Quotas are checked *before* a node is chosen and before any Kubernetes object exists
 * (ADR 0003). Checking after placement would mean a job could hold a node while being
 * refused, and refusing at the Kubernetes layer would produce a Pod that sits Pending
 * forever — which the architecture document calls an unobservable failure rather than
 * queueing.
 */

/** A limit of zero means unlimited, matching the schema default for a new project. */
const UNLIMITED = 0;

export const QuotaBreach = Object.freeze({
  GPU: 'GPU_QUOTA_EXCEEDED',
  CPU: 'CPU_QUOTA_EXCEEDED',
  MEMORY: 'MEMORY_QUOTA_EXCEEDED',
  JOBS: 'JOB_QUOTA_EXCEEDED',
});

/**
 * Checks whether a project can afford to start one more job.
 *
 * @param {object} request the job's resources
 * @param {object} quota `{ gpu_limit, cpu_limit, memory_bytes, job_limit }`
 * @param {object} usage what the project's already-running jobs hold
 * @returns {{ allowed: boolean, code?: string, reason?: string, details: object }}
 */
export function checkQuota(request, quota, usage) {
  const checks = [
    {
      code: QuotaBreach.JOBS,
      limit: quota.job_limit,
      used: usage.jobs,
      wanted: 1,
      unit: 'concurrent job',
    },
    {
      code: QuotaBreach.GPU,
      limit: quota.gpu_limit,
      used: usage.gpu,
      wanted: request.gpu,
      unit: 'GPU',
    },
    {
      code: QuotaBreach.CPU,
      limit: quota.cpu_limit,
      used: usage.cpu,
      wanted: request.cpu,
      unit: 'CPU',
    },
    {
      code: QuotaBreach.MEMORY,
      limit: Number(quota.memory_bytes),
      used: Number(usage.memory_bytes),
      wanted: Number(request.memory_bytes),
      unit: 'byte',
    },
  ];

  for (const check of checks) {
    if (check.limit === UNLIMITED) continue;
    // A request of zero is always affordable; it consumes nothing.
    if (check.wanted === 0) continue;

    if (check.used + check.wanted > check.limit) {
      return {
        allowed: false,
        code: check.code,
        reason:
          `project quota: ${check.used} of ${check.limit} ${check.unit}(s) in use, `
          + `${check.wanted} more requested`,
        details: {
          limit: check.limit,
          in_use: check.used,
          requested: check.wanted,
        },
      };
    }
  }

  return {
    allowed: true,
    details: {
      // Recorded on the admission decision so a later "why did this run?" is
      // answerable with what was true at the time, not with today's usage.
      gpu: { limit: quota.gpu_limit, in_use: usage.gpu },
      cpu: { limit: quota.cpu_limit, in_use: usage.cpu },
      jobs: { limit: quota.job_limit, in_use: usage.jobs },
    },
  };
}
