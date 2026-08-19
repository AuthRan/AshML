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
