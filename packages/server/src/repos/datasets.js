/**
 * SQL for datasets and their versions.
 *
 * A dataset is a name; a dataset *version* is the thing training actually consumes,
 * and it is immutable — once a version carries a URI and a digest, neither changes.
 * That immutability is what makes an experiment reproducible: `experiments`
 * references a version id, so "which data did this run see" has exactly one answer
 * forever (spec §34).
 *
 * Blobs never live in Postgres. A version stores a URI and a digest; the bytes sit in
 * object storage (ADR 0001).
 */

function iso(value) {
  return value ? value.toISOString() : null;
}

const DATASET_COLUMNS = `
  d.id,
  d.name,
  d.created_at,
  p.name AS project_name,
  (SELECT COUNT(*)::int FROM dataset_versions v WHERE v.dataset_id = d.id) AS version_count,
  (SELECT v.version FROM dataset_versions v WHERE v.dataset_id = d.id
    ORDER BY v.created_at DESC, v.version DESC LIMIT 1) AS latest_version
`;

function toDataset(row) {
  return {
    id: row.id,
    name: row.name,
    project: row.project_name,
    version_count: row.version_count,
    latest_version: row.latest_version,
    created_at: iso(row.created_at),
  };
}

function toVersion(row) {
  return {
    id: row.id,
    dataset: row.dataset_name,
    project: row.project_name,
    version: row.version,
    uri: row.uri,
    digest: row.digest || null,
    size_bytes: row.size_bytes,
    created_at: iso(row.created_at),
  };
}

const VERSION_COLUMNS = `
  v.id, v.version, v.uri, v.digest, v.size_bytes, v.created_at,
  d.name AS dataset_name,
  p.name AS project_name
`;

const VERSION_FROM = `
  FROM dataset_versions v
  JOIN datasets d ON d.id = v.dataset_id
  JOIN projects p ON p.id = d.project_id
`;

export async function insertDataset(client, { projectId, name }) {
  const { rows } = await client.query(
    `INSERT INTO datasets (project_id, name) VALUES ($1, $2) RETURNING id`,
    [projectId, name],
  );
  return rows[0].id;
}

export async function getDatasetById(client, id) {
  const { rows } = await client.query(
    `SELECT ${DATASET_COLUMNS}
     FROM datasets d
     JOIN projects p ON p.id = d.project_id
     WHERE d.id = $1`,
    [id],
  );
  return rows.length ? toDataset(rows[0]) : null;
}

/** Names are unique per project, not globally, so both halves are required. */
export async function getDatasetByName(client, projectName, name) {
  const { rows } = await client.query(
    `SELECT ${DATASET_COLUMNS}
     FROM datasets d
     JOIN projects p ON p.id = d.project_id
     WHERE p.name = $1 AND d.name = $2`,
    [projectName, name],
  );
  return rows.length ? toDataset(rows[0]) : null;
}

export async function listDatasets(client, projectName) {
  const { rows } = await client.query(
    `SELECT ${DATASET_COLUMNS}
     FROM datasets d
     JOIN projects p ON p.id = d.project_id
     WHERE p.name = $1
     ORDER BY d.name`,
    [projectName],
  );
  return rows.map(toDataset);
}

export async function insertDatasetVersion(client, { datasetId, version, uri, digest = '', sizeBytes = 0 }) {
  const { rows } = await client.query(
    `INSERT INTO dataset_versions (dataset_id, version, uri, digest, size_bytes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [datasetId, version, uri, digest, sizeBytes],
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

export async function getVersion(client, datasetId, version) {
  const { rows } = await client.query(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM} WHERE v.dataset_id = $1 AND v.version = $2`,
    [datasetId, version],
  );
  return rows.length ? toVersion(rows[0]) : null;
}

/**
 * Newest first — the common question is "what is the latest version of this data".
 *
 * Ties break on the version label rather than the id: ids are random UUIDs, so
 * `id DESC` would look like insertion order without being it.
 */
export async function listVersions(client, datasetId) {
  const { rows } = await client.query(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM}
     WHERE v.dataset_id = $1
     ORDER BY v.created_at DESC, v.version DESC`,
    [datasetId],
  );
  return rows.map(toVersion);
}
