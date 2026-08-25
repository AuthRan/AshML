/**
 * SQL for artifacts — checkpoints, final models, and anything else a run produces.
 *
 * The row records where the bytes are and what they are; the bytes themselves live in
 * object storage. `status` tracks whether those two agree yet — see
 * `domain/artifact-status.js` for why the row is written first.
 */

function iso(value) {
  return value ? value.toISOString() : null;
}

const ARTIFACT_COLUMNS = `
  a.id, a.job_id, a.experiment_id, a.kind, a.name, a.uri, a.digest,
  a.size_bytes, a.step, a.metadata, a.status, a.created_at,
  j.name AS job_name,
  p.name AS project_name
`;

const ARTIFACT_FROM = `
  FROM artifacts a
  LEFT JOIN training_jobs j ON j.id = a.job_id
  LEFT JOIN projects p ON p.id = j.project_id
`;

function toArtifact(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    uri: row.uri,
    status: row.status,
    digest: row.digest || null,
    size_bytes: row.size_bytes,
    step: row.step,
    metadata: row.metadata,
    // Surfaced out of metadata rather than buried in it: whether AshML asked the store
    // if these bytes exist is the difference between a checkpoint and a claim. null
    // means the artifact has not been completed yet.
    verified: typeof row.metadata?.verified === 'boolean' ? row.metadata.verified : null,
    job: row.job_id ? { id: row.job_id, name: row.job_name } : null,
    project: row.project_name ?? null,
    experiment_id: row.experiment_id,
    created_at: iso(row.created_at),
  };
}

export async function insertArtifact(client, artifact) {
  const { rows } = await client.query(
    `INSERT INTO artifacts (job_id, experiment_id, kind, name, uri, step, metadata, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      artifact.jobId,
      artifact.experimentId,
      artifact.kind,
      artifact.name,
      artifact.uri,
      artifact.step,
      JSON.stringify(artifact.metadata),
      artifact.status,
    ],
  );
  return rows[0].id;
}

export async function getArtifactById(client, id) {
  const { rows } = await client.query(
    `SELECT ${ARTIFACT_COLUMNS} ${ARTIFACT_FROM} WHERE a.id = $1`,
    [id],
  );
  return rows.length ? toArtifact(rows[0]) : null;
}

/**
 * Locks the row for a status change.
 *
 * Returns only the status, because that is the whole of what the transition is decided
 * from — two concurrent confirmations must not both read PENDING.
 */
export async function getArtifactStatusForUpdate(client, id) {
  const { rows } = await client.query(
    'SELECT id, status FROM artifacts WHERE id = $1 FOR UPDATE',
    [id],
  );
  return rows.length ? rows[0] : null;
}

/**
 * Settles a PENDING artifact.
 *
 * The digest and size are written in the same statement as the status: a READY row
 * whose digest arrives separately would be trusted for the moment in between, which is
 * exactly the window the status exists to close.
 */
export async function settleArtifact(client, id, status, { digest = '', sizeBytes = 0, metadata = null } = {}) {
  await client.query(
    `UPDATE artifacts
     SET status = $2,
         digest = $3,
         size_bytes = $4,
         metadata = COALESCE($5::jsonb, metadata)
     WHERE id = $1`,
    [id, status, digest, sizeBytes, metadata === null ? null : JSON.stringify(metadata)],
  );
}

/**
 * Artifacts that were registered and never confirmed, and are not going to be.
 *
 * Two ways in, because there are two ways a confirmation goes missing and only one of
 * them involves a job that ended:
 *
 *   - **the job reached a terminal state and stayed there.** The usual case: a pod was
 *     killed between registering a checkpoint and confirming it. The window has to be
 *     wider than `ASHML_RUN_TOKEN_GRACE`, because a *successful* run's final upload is
 *     confirmed after the pod has exited — reaping inside that window would mark the one
 *     artifact anybody cares about FAILED (see `reapAbandonedArtifacts`).
 *   - **it has simply been PENDING too long.** Covers the job whose terminal state was
 *     never observed at all, which is exactly the case where nothing else will ever come
 *     along to settle the artifact, and an artifact with no job row at all.
 *
 * `FOR UPDATE ... SKIP LOCKED` narrows the window in which two control-plane replicas
 * sweeping at once pick the same rows — it does not close it, because the selecting
 * transaction commits before the store is asked about the bytes, and holding the locks
 * across that call is the thing `reapAbandonedArtifacts` explains it must not do. What
 * makes a collision harmless is the settle itself: it re-locks the row and re-checks the
 * status, so the second replica's transition is refused rather than applied twice.
 *
 * @param {object} client
 * @param {object} options
 * @param {string[]} options.terminalStates
 * @param {number} options.afterTerminalSeconds how long after the job ended to wait
 * @param {number} options.maxPendingSeconds the backstop, measured from registration
 * @param {number} [options.limit] how many to take in one pass
 */
export async function lockAbandonedArtifacts(client, {
  terminalStates, afterTerminalSeconds, maxPendingSeconds, limit = 50,
}) {
  const { rows } = await client.query(
    `SELECT a.id, a.uri, a.name, a.job_id, a.created_at, j.state AS job_state,
            COALESCE(j.finished_at, j.updated_at) AS job_finished_at
     FROM artifacts a
     LEFT JOIN training_jobs j ON j.id = a.job_id
     WHERE a.status = 'PENDING'
       AND (
         (j.state = ANY($1)
          AND COALESCE(j.finished_at, j.updated_at) < now() - ($2 * INTERVAL '1 second'))
         OR a.created_at < now() - ($3 * INTERVAL '1 second')
       )
     ORDER BY a.created_at
     LIMIT $4
     FOR UPDATE OF a SKIP LOCKED`,
    [terminalStates, afterTerminalSeconds, maxPendingSeconds, limit],
  );
  return rows;
}

/** How many artifacts are still PENDING, and how old the oldest is. For the reaper's log. */
export async function pendingArtifactAge(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS pending,
            COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::int AS oldest_seconds
     FROM artifacts WHERE status = 'PENDING'`,
  );
  return rows[0];
}

export async function listArtifactsForJob(client, jobId, { kind = null, status = null } = {}) {
  const { rows } = await client.query(
    `SELECT ${ARTIFACT_COLUMNS} ${ARTIFACT_FROM}
     WHERE a.job_id = $1
       AND ($2::text IS NULL OR a.kind = $2)
       AND ($3::text IS NULL OR a.status = $3)
     ORDER BY a.created_at, a.id`,
    [jobId, kind, status],
  );
  return rows.map(toArtifact);
}

export async function listArtifactsForExperiment(client, experimentId, { kind = null, status = null } = {}) {
  const { rows } = await client.query(
    `SELECT ${ARTIFACT_COLUMNS} ${ARTIFACT_FROM}
     WHERE a.experiment_id = $1
       AND ($2::text IS NULL OR a.kind = $2)
       AND ($3::text IS NULL OR a.status = $3)
     ORDER BY a.created_at, a.id`,
    [experimentId, kind, status],
  );
  return rows.map(toArtifact);
}
