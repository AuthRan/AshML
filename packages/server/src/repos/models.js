/**
 * SQL for the model registry.
 *
 * A model is a name within a project; a model *version* is the thing that actually gets
 * served, and it points at an artifact — which is to say at bytes AshML has confirmed
 * exist. That link is the whole reason the artifact lifecycle was built first: a
 * registry whose entries may or may not resolve to a file is a list of intentions.
 *
 * Version numbers are per model and allocated under a lock on the model row (see
 * `lockModel`), not by a sequence: two concurrent registrations must not both compute
 * MAX(version) + 1 and get the same answer.
 */

function iso(value) {
  return value ? value.toISOString() : null;
}

const MODEL_COLUMNS = `
  m.id, m.name, m.created_at,
  p.name AS project_name,
  (SELECT COUNT(*)::int FROM model_versions v WHERE v.model_id = m.id) AS version_count,
  (SELECT MAX(v.version) FROM model_versions v WHERE v.model_id = m.id) AS latest_version,
  (SELECT v.version FROM model_versions v
    WHERE v.model_id = m.id AND v.status = 'PRODUCTION' LIMIT 1) AS production_version
`;

function toModel(row) {
  return {
    id: row.id,
    name: row.name,
    project: row.project_name,
    version_count: row.version_count,
    latest_version: row.latest_version,
    // The question the registry exists to answer, on the model itself so nobody has to
    // scan the versions to ask it.
    production_version: row.production_version,
    created_at: iso(row.created_at),
  };
}

const VERSION_COLUMNS = `
  v.id, v.version, v.status, v.metrics, v.description,
  v.promoted_at, v.created_at, v.experiment_id, v.job_id, v.artifact_id,
  m.name AS model_name,
  p.name AS project_name,
  a.uri  AS artifact_uri,
  a.name AS artifact_name,
  a.digest AS artifact_digest,
  a.size_bytes AS artifact_size,
  a.status AS artifact_status,
  a.metadata AS artifact_metadata
`;

const VERSION_FROM = `
  FROM model_versions v
  JOIN models m ON m.id = v.model_id
  JOIN projects p ON p.id = m.project_id
  LEFT JOIN artifacts a ON a.id = v.artifact_id
`;

function toVersion(row) {
  return {
    id: row.id,
    model: row.model_name,
    project: row.project_name,
    version: row.version,
    status: row.status,
    description: row.description || null,
    metrics: row.metrics,
    experiment_id: row.experiment_id,
    job_id: row.job_id,
    artifact: row.artifact_id
      ? {
        id: row.artifact_id,
        name: row.artifact_name,
        uri: row.artifact_uri,
        digest: row.artifact_digest || null,
        size_bytes: row.artifact_size,
        status: row.artifact_status,
        // Carried onto the version because "is this model's file verified" is asked
        // about the model, and nobody should have to fetch the artifact to find out.
        verified: typeof row.artifact_metadata?.verified === 'boolean'
          ? row.artifact_metadata.verified
          : null,
      }
      : null,
    promoted_at: iso(row.promoted_at),
    created_at: iso(row.created_at),
  };
}

// ------------------------------------------------------------------- models

export async function insertModel(client, { projectId, name }) {
  const { rows } = await client.query(
    'INSERT INTO models (project_id, name) VALUES ($1, $2) RETURNING id',
    [projectId, name],
  );
  return rows[0].id;
}

export async function getModelById(client, id) {
  const { rows } = await client.query(
    `SELECT ${MODEL_COLUMNS} FROM models m JOIN projects p ON p.id = m.project_id WHERE m.id = $1`,
    [id],
  );
  return rows.length ? toModel(rows[0]) : null;
}

export async function getModelByName(client, projectName, name) {
  const { rows } = await client.query(
    `SELECT ${MODEL_COLUMNS} FROM models m JOIN projects p ON p.id = m.project_id
     WHERE p.name = $1 AND m.name = $2`,
    [projectName, name],
  );
  return rows.length ? toModel(rows[0]) : null;
}

export async function listModels(client, projectName) {
  const { rows } = await client.query(
    `SELECT ${MODEL_COLUMNS} FROM models m JOIN projects p ON p.id = m.project_id
     WHERE p.name = $1 ORDER BY m.name`,
    [projectName],
  );
  return rows.map(toModel);
}

/**
 * Locks the model row.
 *
 * Held for two things that must not race: allocating the next version number, and
 * changing which version is in PRODUCTION. Both are per model, so the model row is the
 * natural thing to serialise on — and using one lock for both means a promotion cannot
 * interleave with a registration.
 */
export async function lockModel(client, id) {
  const { rows } = await client.query('SELECT id FROM models WHERE id = $1 FOR UPDATE', [id]);
  return rows.length ? rows[0] : null;
}

// ----------------------------------------------------------------- versions

/**
 * The next free version number for a model.
 *
 * Correct only while the model row is locked. A sequence would be simpler but would
 * number versions globally, so a project's second model would start at version 47.
 */
export async function nextVersionNumber(client, modelId) {
  const { rows } = await client.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM model_versions WHERE model_id = $1',
    [modelId],
  );
  return rows[0].next;
}

export async function insertVersion(client, version) {
  const { rows } = await client.query(
    `INSERT INTO model_versions
       (model_id, version, experiment_id, artifact_id, job_id, status, metrics, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      version.modelId,
      version.version,
      version.experimentId,
      version.artifactId,
      version.jobId,
      version.status,
      JSON.stringify(version.metrics),
      version.description,
    ],
  );
  return rows[0].id;
}

export async function getVersionById(client, id) {
  const { rows } = await client.query(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM} WHERE v.id = $1`,
    [id],
  );
  return rows.length ? toVersion(rows[0]) : null;
}

export async function getVersion(client, projectName, modelName, version) {
  const { rows } = await client.query(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM}
     WHERE p.name = $1 AND m.name = $2 AND v.version = $3`,
    [projectName, modelName, version],
  );
  return rows.length ? toVersion(rows[0]) : null;
}

export async function listVersions(client, modelId, { status = null } = {}) {
  const { rows } = await client.query(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM}
     WHERE v.model_id = $1 AND ($2::text IS NULL OR v.status = $2)
     ORDER BY v.version DESC`,
    [modelId, status],
  );
  return rows.map(toVersion);
}

/**
 * The versions of a model currently holding `status`, locked.
 *
 * Used to find the incumbent PRODUCTION version before a promotion displaces it.
 * Returns a list rather than one row deliberately: the invariant is that there is at
 * most one, and a query shaped to return only the first would hide a violation instead
 * of letting the service notice and fix it.
 */
export async function lockVersionsWithStatus(client, modelId, status) {
  const { rows } = await client.query(
    'SELECT id, version, status FROM model_versions WHERE model_id = $1 AND status = $2 FOR UPDATE',
    [modelId, status],
  );
  return rows;
}

export async function getVersionForUpdate(client, id) {
  const { rows } = await client.query(
    'SELECT id, model_id, version, status FROM model_versions WHERE id = $1 FOR UPDATE',
    [id],
  );
  return rows.length ? rows[0] : null;
}

/** Sets a version's status. `promoted_at` is stamped only on the way into PRODUCTION. */
export async function setVersionStatus(client, id, status, { stampPromotion = false } = {}) {
  await client.query(
    `UPDATE model_versions
     SET status = $2,
         promoted_at = CASE WHEN $3 THEN now() ELSE promoted_at END
     WHERE id = $1`,
    [id, status, stampPromotion],
  );
}
