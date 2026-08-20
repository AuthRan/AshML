/**
 * SQL for deployments.
 *
 * A deployment is a named serving endpoint within a project. It points at a model
 * version through `deployment_targets`, which carries the traffic weight that weighted
 * routing will need — for now there is exactly one target at weight 100, and the join
 * is written so that adding a second is a routing change rather than a schema change.
 *
 * The target resolves all the way through to the artifact, because that is what the
 * serving container is actually handed: a version whose artifact is not READY is not
 * deployable, and catching that here rather than at pod startup is the difference
 * between an error message and a crash loop.
 */

function iso(value) {
  return value ? value.toISOString() : null;
}

const DEPLOYMENT_COLUMNS = `
  d.id, d.name, d.status, d.image, d.replicas, d.ready_replicas,
  d.cpu, d.memory_bytes, d.gpu, d.k8s_name, d.namespace, d.endpoint_url,
  d.last_error, d.created_at, d.updated_at,
  p.name AS project_name,
  m.name AS model_name,
  t.model_version_id, t.traffic_weight,
  v.version AS version_number,
  v.status  AS version_status,
  v.artifact_id,
  a.status  AS artifact_status,
  a.metadata AS artifact_metadata
`;

const DEPLOYMENT_FROM = `
  FROM deployments d
  JOIN projects p ON p.id = d.project_id
  JOIN models m ON m.id = d.model_id
  LEFT JOIN deployment_targets t ON t.deployment_id = d.id
  LEFT JOIN model_versions v ON v.id = t.model_version_id
  LEFT JOIN artifacts a ON a.id = v.artifact_id
`;

function toDeployment(row) {
  return {
    id: row.id,
    name: row.name,
    project: row.project_name,
    model: row.model_name,
    status: row.status,
    image: row.image,
    replicas: row.replicas,
    ready_replicas: row.ready_replicas,
    // NUMERIC comes back from pg as a string; every consumer wants a number, and the
    // conversion belongs here rather than in each of them.
    cpu: row.cpu === null ? 0 : Number(row.cpu),
    memory_bytes: row.memory_bytes === null ? 0 : Number(row.memory_bytes),
    gpu: row.gpu,
    k8s_name: row.k8s_name,
    namespace: row.namespace,
    endpoint_url: row.endpoint_url,
    last_error: row.last_error,
    target: row.model_version_id
      ? {
        model_version_id: row.model_version_id,
        version: row.version_number,
        version_status: row.version_status,
        traffic_weight: row.traffic_weight,
        artifact_id: row.artifact_id,
        artifact_status: row.artifact_status,
        // The architecture the run recorded on the artifact it produced. Serving reads
        // it from there rather than asking the operator to retype it, because the
        // training script is the only thing that actually knows.
        arch: row.artifact_metadata?.architecture ?? null,
      }
      : null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export async function createDeployment(client, {
  projectId, modelId, name, image, replicas, cpu, memoryBytes, gpu,
}) {
  const { rows } = await client.query(
    `INSERT INTO deployments (project_id, model_id, name, image, replicas, cpu, memory_bytes, gpu, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')
     RETURNING id`,
    [projectId, modelId, name, image, replicas, cpu, memoryBytes, gpu],
  );
  return rows[0].id;
}

/**
 * Points a deployment at a model version.
 *
 * Written as an upsert on (deployment_id, model_version_id) so that redeploying the
 * same version is not an error, and switching versions replaces the single target
 * rather than accumulating them — until there is a router, two targets would mean two
 * ReplicaSets and no rule about which one answers.
 */
export async function setSingleTarget(client, deploymentId, modelVersionId, { replicas = 1 } = {}) {
  await client.query(
    'DELETE FROM deployment_targets WHERE deployment_id = $1 AND model_version_id <> $2',
    [deploymentId, modelVersionId],
  );
  await client.query(
    `INSERT INTO deployment_targets (deployment_id, model_version_id, traffic_weight, replicas)
     VALUES ($1, $2, 100, $3)
     ON CONFLICT (deployment_id, model_version_id)
     DO UPDATE SET traffic_weight = 100, replicas = EXCLUDED.replicas`,
    [deploymentId, modelVersionId, replicas],
  );
}

export async function getDeploymentById(client, id) {
  const { rows } = await client.query(
    `SELECT ${DEPLOYMENT_COLUMNS} ${DEPLOYMENT_FROM} WHERE d.id = $1`,
    [id],
  );
  return rows[0] ? toDeployment(rows[0]) : null;
}

export async function getDeploymentByName(client, projectName, name) {
  const { rows } = await client.query(
    `SELECT ${DEPLOYMENT_COLUMNS} ${DEPLOYMENT_FROM} WHERE p.name = $1 AND d.name = $2`,
    [projectName, name],
  );
  return rows[0] ? toDeployment(rows[0]) : null;
}

export async function listDeployments(client, { projectName = null } = {}) {
  const { rows } = await client.query(
    `SELECT ${DEPLOYMENT_COLUMNS} ${DEPLOYMENT_FROM}
     WHERE ($1::text IS NULL OR p.name = $1)
     ORDER BY d.created_at DESC`,
    [projectName],
  );
  return rows.map(toDeployment);
}

/**
 * Every deployment the status loop should still be asking the cluster about.
 *
 * STOPPED is excluded because nothing of it exists in the cluster to observe; the row
 * is kept only so that its history and its name survive.
 */
export async function listActiveDeployments(client) {
  const { rows } = await client.query(
    `SELECT ${DEPLOYMENT_COLUMNS} ${DEPLOYMENT_FROM}
     WHERE d.status <> 'STOPPED' AND d.k8s_name IS NOT NULL
     ORDER BY d.created_at`,
  );
  return rows.map(toDeployment);
}

/** Records the Kubernetes objects AshML created, and the address they answer on. */
export async function recordLaunch(client, id, { k8sName, namespace, endpointUrl }) {
  await client.query(
    `UPDATE deployments
     SET k8s_name = $2, namespace = $3, endpoint_url = $4, updated_at = now()
     WHERE id = $1`,
    [id, k8sName, namespace, endpointUrl],
  );
}

/**
 * Writes back what the cluster reported.
 *
 * `last_error` is set to the reason or cleared, never left alone: a stale explanation
 * that outlives the problem it described sends the next reader to fix something that is
 * already fixed.
 */
export async function recordObservation(client, id, { status, readyReplicas, lastError = null }) {
  await client.query(
    `UPDATE deployments
     SET status = $2, ready_replicas = $3, last_error = $4, updated_at = now()
     WHERE id = $1`,
    [id, status, readyReplicas, lastError],
  );
}

export async function updateSpec(client, id, { image, replicas, cpu, memoryBytes, gpu }) {
  await client.query(
    `UPDATE deployments
     SET image = $2, replicas = $3, cpu = $4, memory_bytes = $5, gpu = $6, updated_at = now()
     WHERE id = $1`,
    [id, image, replicas, cpu, memoryBytes, gpu],
  );
}

export async function deleteDeployment(client, id) {
  await client.query('DELETE FROM deployments WHERE id = $1', [id]);
}
