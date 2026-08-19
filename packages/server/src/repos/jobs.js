/**
 * SQL for training jobs, their events, and the queue.
 *
 * Nothing here decides whether a state change is legal — that is `domain/job-state.js`,
 * and `services/jobs.js` is what puts the two together inside a transaction.
 */

const JOB_COLUMNS = `
  j.id, j.name, j.state, j.priority,
  j.cpu_request, j.memory_request, j.gpu_request, j.gpu_memory_min,
  j.spec, j.attempt, j.max_retries, j.failure_reason, j.pending_reason,
  j.scheduled_node_id, j.placement_reason, j.k8s_job_name,
  j.queued_at, j.started_at, j.finished_at, j.created_at, j.updated_at,
  p.name AS project_name,
  j.experiment_id,
  e.name AS experiment_name,
  cn.name AS node_name
`;

/**
 * Every job read joins its project (jobs are always shown by project name, never by
 * id) and left-joins its experiment, which is optional.
 */
const JOB_FROM = `
  FROM training_jobs j
  JOIN projects p ON p.id = j.project_id
  LEFT JOIN experiments e ON e.id = j.experiment_id
  LEFT JOIN compute_nodes cn ON cn.id = j.scheduled_node_id
`;

function iso(value) {
  return value ? value.toISOString() : null;
}

function toJob(row) {
  return {
    id: row.id,
    name: row.name,
    project: row.project_name,
    state: row.state,
    priority: row.priority,
    resources: {
      cpu: row.cpu_request,
      memory_bytes: row.memory_request,
      gpu: row.gpu_request,
      gpu_memory_min_bytes: row.gpu_memory_min,
    },
    spec: row.spec,
    experiment: row.experiment_id
      ? { id: row.experiment_id, name: row.experiment_name }
      : null,
    attempt: row.attempt,
    max_retries: row.max_retries,
    k8s_job_name: row.k8s_job_name || null,
    failure_reason: row.failure_reason || null,
    pending_reason: row.pending_reason || null,
    placement: {
      node_id: row.scheduled_node_id,
      node_name: row.node_name ?? null,
      reason: row.placement_reason || null,
    },
    queued_at: iso(row.queued_at),
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export async function insertJob(client, job) {
  const { rows } = await client.query(
    `INSERT INTO training_jobs
       (project_id, experiment_id, name, state, priority, spec,
        cpu_request, memory_request, gpu_request, gpu_memory_min, max_retries)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      job.projectId,
      job.experimentId ?? null,
      job.name,
      job.state,
      job.priority,
      JSON.stringify(job.spec),
      job.resources.cpu,
      job.resources.memory_bytes,
      job.resources.gpu,
      job.resources.gpu_memory_min_bytes,
      job.maxRetries,
    ],
  );
  return rows[0].id;
}

export async function getJobById(client, id) {
  const { rows } = await client.query(
    `SELECT ${JOB_COLUMNS}
     ${JOB_FROM}
     WHERE j.id = $1`,
    [id],
  );
  return rows.length ? toJob(rows[0]) : null;
}

/**
 * Reads a job and locks its row for the rest of the transaction, so two concurrent
 * writers cannot both read `RUNNING` and both transition away from it.
 */
export async function getJobForUpdate(client, id) {
  const { rows } = await client.query(
    `SELECT ${JOB_COLUMNS}
     ${JOB_FROM}
     WHERE j.id = $1
     FOR UPDATE OF j`,
    [id],
  );
  return rows.length ? toJob(rows[0]) : null;
}

export async function listJobs(client, { projectName = null, state = null, limit = 50 } = {}) {
  const { rows } = await client.query(
    `SELECT ${JOB_COLUMNS}
     ${JOB_FROM}
     WHERE ($1::text IS NULL OR p.name = $1)
       AND ($2::text IS NULL OR j.state = $2)
     ORDER BY j.created_at DESC
     LIMIT $3`,
    [projectName, state, limit],
  );
  return rows.map(toJob);
}

/**
 * Applies a state change. Callers must have validated the transition through the
 * domain layer first; this only writes.
 *
 * Timestamps are set from the target state so they cannot drift from it.
 */
export async function updateJobState(client, id, toState, { failureReason = null } = {}) {
  await client.query(
    `UPDATE training_jobs
     SET state       = $2,
         updated_at  = now(),
         queued_at   = CASE WHEN $2 = 'QUEUED'  AND queued_at  IS NULL THEN now() ELSE queued_at  END,
         started_at  = CASE WHEN $2 = 'RUNNING' AND started_at IS NULL THEN now() ELSE started_at END,
         finished_at = CASE WHEN $2 IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN now() ELSE finished_at END,
         failure_reason = COALESCE($3, failure_reason)
     WHERE id = $1`,
    [id, toState, failureReason],
  );
}

/**
 * Appends to the append-only event log. Every state change writes one of these in the
 * same transaction as the state itself — no silent mutations (spec §47).
 */
export async function insertJobEvent(client, { jobId, eventType, fromState = null, toState = null, message = '', details = {} }) {
  await client.query(
    `INSERT INTO job_events (job_id, event_type, from_state, to_state, message, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [jobId, eventType, fromState, toState, message, JSON.stringify(details)],
  );
}

export async function listJobEvents(client, jobId) {
  const { rows } = await client.query(
    `SELECT id, event_type, from_state, to_state, message, details, created_at
     FROM job_events
     WHERE job_id = $1
     ORDER BY id`,
    [jobId],
  );
  return rows.map((row) => ({
    id: row.id,
    event_type: row.event_type,
    from_state: row.from_state,
    to_state: row.to_state,
    message: row.message,
    details: row.details,
    created_at: iso(row.created_at),
  }));
}

/**
 * Claims the next queued job for this scheduler instance.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes the queue safe across multiple scheduler
 * replicas without Redis (ADR 0004): each caller takes a row no other transaction
 * holds, and rows already claimed are skipped rather than blocking.
 *
 * Ordering is priority first, then arrival — FIFO within a priority band, which is
 * Stage 1 and 2 of the scheduler evolution in spec §12.
 *
 * Returns null when the queue is empty. Must be called inside a transaction; the
 * claim holds only until it commits.
 */
/**
 * Locks the next queued job in priority-then-arrival order and returns it.
 *
 * This only takes the row lock — it deliberately does not change state, because every
 * transition belongs to the service layer (see services/jobs.js). A caller that locks a
 * job without transitioning it hands the same job out again on the next call, so use
 * `claimNextJob` from the service unless you specifically want the locking primitive.
 *
 * The lock is what makes two schedulers safe: the loser skips the row rather than
 * blocking on it (ADR 0004).
 *
 * `excludeIds` lets one scheduling pass walk past jobs it has already refused. Without
 * it a job that cannot currently be placed — one asking for more GPUs than any node has
 * — is claimed, refused, returned to the queue, and immediately claimed again, and no
 * job behind it in the queue is ever considered. Priority order is preserved: the pass
 * still takes the highest-priority job it has not yet refused.
 */
export async function lockNextQueuedJob(client, { excludeIds = [] } = {}) {
  const { rows } = await client.query(
    `SELECT ${JOB_COLUMNS}
     ${JOB_FROM}
     WHERE j.state = 'QUEUED'
       AND NOT (j.id = ANY($1::uuid[]))
     ORDER BY
       CASE j.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END,
       j.queued_at
     LIMIT 1
     FOR UPDATE OF j SKIP LOCKED`,
    [excludeIds],
  );
  return rows.length ? toJob(rows[0]) : null;
}

/**
 * Records the name of the Kubernetes Job launched for this attempt.
 *
 * Written by the executor immediately after the Job is created, in the same
 * transaction as the SCHEDULING -> STARTING transition. If the two could be written
 * separately, a crash between them would leave a running Pod that no database row
 * points at — a workload nothing can observe or cancel.
 */
export async function setK8sJobName(client, id, k8sJobName) {
  await client.query(
    `UPDATE training_jobs SET k8s_job_name = $2, updated_at = now() WHERE id = $1`,
    [id, k8sJobName],
  );
}

/**
 * Lists jobs the executor is responsible for watching: everything that has, or may
 * have, a workload in the cluster.
 *
 * SCHEDULING is included so a launch interrupted by a crash is finished rather than
 * abandoned — the job has been claimed off the queue, so nothing else will ever pick
 * it up again.
 *
 * Ordered oldest-updated first so a long list of active jobs is reconciled fairly
 * rather than the most recently touched starving the rest.
 */
export async function listJobsToReconcile(client, { limit = 200 } = {}) {
  const { rows } = await client.query(
    `SELECT ${JOB_COLUMNS}
     ${JOB_FROM}
     WHERE j.state IN ('SCHEDULING', 'STARTING', 'RUNNING', 'CANCELLING')
     ORDER BY j.updated_at
     LIMIT $1`,
    [limit],
  );
  return rows.map(toJob);
}

/**
 * Records why a launched job is not yet running.
 *
 * Cleared (to '') the moment it runs, so a stale explanation cannot outlive the
 * condition that produced it — a job showing "ImagePullBackOff" while happily running
 * is worse than showing nothing.
 */
export async function setPendingReason(client, id, reason) {
  await client.query(
    `UPDATE training_jobs SET pending_reason = $2, updated_at = now() WHERE id = $1`,
    [id, reason],
  );
}

/** Queue depth by priority. Cheap enough to expose as a metric (spec §23). */
export async function queueDepth(client) {
  const { rows } = await client.query(
    `SELECT priority, COUNT(*)::int AS count
     FROM training_jobs
     WHERE state = 'QUEUED'
     GROUP BY priority`,
  );
  const depth = { HIGH: 0, MEDIUM: 0, LOW: 0, total: 0 };
  for (const row of rows) {
    depth[row.priority] = row.count;
    depth.total += row.count;
  }
  return depth;
}
