/**
 * SQL for training jobs, their events, and the queue.
 *
 * Nothing here decides whether a state change is legal — that is `domain/job-state.js`,
 * and `services/jobs.js` is what puts the two together inside a transaction.
 */

const JOB_COLUMNS = `
  j.id, j.name, j.state, j.priority,
  j.cpu_request, j.memory_request, j.gpu_request, j.gpu_memory_min,
  j.spec, j.attempt, j.max_retries, j.failure_reason,
  j.scheduled_node_id, j.placement_reason,
  j.queued_at, j.started_at, j.finished_at, j.created_at, j.updated_at,
  p.name AS project_name
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
    attempt: row.attempt,
    max_retries: row.max_retries,
    failure_reason: row.failure_reason || null,
    placement: {
      node_id: row.scheduled_node_id,
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
       (project_id, name, state, priority, spec,
        cpu_request, memory_request, gpu_request, gpu_memory_min, max_retries)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      job.projectId,
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
     FROM training_jobs j
     JOIN projects p ON p.id = j.project_id
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
     FROM training_jobs j
     JOIN projects p ON p.id = j.project_id
     WHERE j.id = $1
     FOR UPDATE OF j`,
    [id],
  );
  return rows.length ? toJob(rows[0]) : null;
}

export async function listJobs(client, { projectName = null, state = null, limit = 50 } = {}) {
  const { rows } = await client.query(
    `SELECT ${JOB_COLUMNS}
     FROM training_jobs j
     JOIN projects p ON p.id = j.project_id
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
 */
export async function lockNextQueuedJob(client) {
  const { rows } = await client.query(
    `SELECT ${JOB_COLUMNS}
     FROM training_jobs j
     JOIN projects p ON p.id = j.project_id
     WHERE j.state = 'QUEUED'
     ORDER BY
       CASE j.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END,
       j.queued_at
     LIMIT 1
     FOR UPDATE OF j SKIP LOCKED`,
  );
  return rows.length ? toJob(rows[0]) : null;
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
