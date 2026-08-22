/**
 * SQL for deployments.
 *
 * A deployment is a named serving endpoint within a project. It serves one or more model
 * versions through `deployment_targets`, each carrying the share of traffic it should
 * take — and each running its own pods behind its own Service, because a share of
 * traffic can only be given to something that has an address.
 *
 * Targets are read as an aggregate rather than as a join that multiplies the deployment
 * row. A deployment with three versions is one deployment, and a query that returns it
 * three times makes every caller responsible for collapsing it again — which is where the
 * "first row wins" bug lives that quietly reports one version's readiness as the whole
 * deployment's.
 *
 * Each target resolves all the way through to the artifact, because that is what the
 * serving container is actually handed: a version whose artifact is not READY is not
 * deployable, and catching that here rather than at pod startup is the difference
 * between an error message and a crash loop.
 */

function iso(value) {
  return value ? value.toISOString() : null;
}

/**
 * Every target of a deployment, as a JSON array on the deployment's own row.
 *
 * Ordered by version number, ascending and always — as a number, so v10 sorts after v9
 * rather than after v1. Two reads of an unchanged table must not disagree about which
 * target is first: `chooseTarget` walks the list to find where a random point or a sticky
 * hash falls, so reordering the array silently reassigns every sticky key to a different
 * version.
 */
const TARGETS_JSON = `
  COALESCE((
    SELECT json_agg(target ORDER BY sort_key)
    FROM (
      SELECT v.version AS sort_key, json_build_object(
        'model_version_id', t.model_version_id,
        'version',          v.version,
        'version_status',   v.status,
        'traffic_weight',   t.traffic_weight,
        'replicas',         t.replicas,
        'status',           t.status,
        'ready_replicas',   t.ready_replicas,
        'last_error',       t.last_error,
        'k8s_name',         t.k8s_name,
        'endpoint_url',     t.endpoint_url,
        'artifact_id',      v.artifact_id,
        'artifact_status',  a.status,
        -- The architecture the run recorded on the artifact it produced. Serving reads
        -- it from there rather than asking the operator to retype it, because the
        -- training script is the only thing that actually knows.
        'arch',             a.metadata->>'architecture'
      ) AS target
      FROM deployment_targets t
      JOIN model_versions v ON v.id = t.model_version_id
      LEFT JOIN artifacts a ON a.id = v.artifact_id
      WHERE t.deployment_id = d.id
    ) AS ordered
  ), '[]'::json) AS targets
`;

const DEPLOYMENT_COLUMNS = `
  d.id, d.name, d.status, d.image, d.replicas, d.ready_replicas,
  d.cpu, d.memory_bytes, d.gpu, d.k8s_name, d.namespace, d.endpoint_url,
  d.last_error, d.created_at, d.updated_at,
  d.serving_version, d.router_image, d.router_k8s_name,
  d.router_status, d.router_ready_replicas,
  p.name AS project_name,
  m.name AS model_name,
  ${TARGETS_JSON}
`;

const DEPLOYMENT_FROM = `
  FROM deployments d
  JOIN projects p ON p.id = d.project_id
  JOIN models m ON m.id = d.model_id
`;

function toTarget(row) {
  return {
    model_version_id: row.model_version_id,
    version: row.version,
    version_status: row.version_status,
    traffic_weight: row.traffic_weight,
    replicas: row.replicas,
    status: row.status,
    ready_replicas: row.ready_replicas,
    last_error: row.last_error,
    k8s_name: row.k8s_name,
    endpoint_url: row.endpoint_url,
    artifact_id: row.artifact_id,
    artifact_status: row.artifact_status,
    arch: row.arch ?? null,
  };
}

function toDeployment(row) {
  const targets = (row.targets ?? []).map(toTarget);
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
    serving_version: row.serving_version,
    router_image: row.router_image,
    router_k8s_name: row.router_k8s_name,
    router_status: row.router_status,
    router_ready_replicas: row.router_ready_replicas,
    targets,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export async function createDeployment(client, {
  projectId, modelId, name, image, replicas, cpu, memoryBytes, gpu, routerImage,
}) {
  const { rows } = await client.query(
    `INSERT INTO deployments
       (project_id, model_id, name, image, replicas, cpu, memory_bytes, gpu, router_image, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'ashml/model-router:v1'), 'PENDING')
     RETURNING id`,
    [projectId, modelId, name, image, replicas, cpu, memoryBytes, gpu, routerImage ?? null],
  );
  return rows[0].id;
}

/**
 * Adds a version to what a deployment serves, or updates the target already there.
 *
 * An upsert on (deployment_id, model_version_id), so deploying the same version again is
 * not an error. It does not remove the other targets: that is `setWeights`' job, and
 * separating them is what makes "also serve v7" and "here is the whole split" different
 * operations rather than one operation with a flag.
 */
export async function upsertTarget(client, deploymentId, modelVersionId, { weight, replicas }) {
  await client.query(
    `INSERT INTO deployment_targets (deployment_id, model_version_id, traffic_weight, replicas)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (deployment_id, model_version_id)
     DO UPDATE SET traffic_weight = EXCLUDED.traffic_weight,
                   replicas       = EXCLUDED.replicas,
                   updated_at     = now()`,
    [deploymentId, modelVersionId, weight, replicas],
  );
}

/**
 * Writes a complete split.
 *
 * Takes every weight at once because that is what a split is: `domain/routing.js` refuses
 * a set that does not sum to 100, and a per-target update would have to pass through
 * states that do not — leaving a window in which the router, which reads this table,
 * would see and act on arithmetic nobody asked for.
 *
 * @param {Array<{model_version_id: string, weight: number}>} weights
 */
export async function setWeights(client, deploymentId, weights) {
  for (const { model_version_id: versionId, weight } of weights) {
    await client.query(
      `UPDATE deployment_targets
       SET traffic_weight = $3, updated_at = now()
       WHERE deployment_id = $1 AND model_version_id = $2`,
      [deploymentId, versionId, weight],
    );
  }
}

/** Stops serving a version entirely. Its Kubernetes objects are the caller's to remove. */
export async function removeTarget(client, deploymentId, modelVersionId) {
  await client.query(
    'DELETE FROM deployment_targets WHERE deployment_id = $1 AND model_version_id = $2',
    [deploymentId, modelVersionId],
  );
}

/** Records the Kubernetes objects created for one version, and the address they answer on. */
export async function recordTargetLaunch(client, deploymentId, modelVersionId, { k8sName, endpointUrl }) {
  await client.query(
    `UPDATE deployment_targets
     SET k8s_name = $3, endpoint_url = $4, updated_at = now()
     WHERE deployment_id = $1 AND model_version_id = $2`,
    [deploymentId, modelVersionId, k8sName, endpointUrl],
  );
}

/** Writes back what the cluster reported about one version's pods. */
export async function recordTargetObservation(client, deploymentId, modelVersionId, {
  status, readyReplicas, lastError = null,
}) {
  await client.query(
    `UPDATE deployment_targets
     SET status = $3, ready_replicas = $4, last_error = $5, updated_at = now()
     WHERE deployment_id = $1 AND model_version_id = $2`,
    [deploymentId, modelVersionId, status, readyReplicas, lastError],
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
 * Records which version the deployment's front Service currently selects.
 *
 * NULL means it selects the router. This is written *after* the Service has been moved,
 * never before: it is a note of what was done, and a row that claims a front door has
 * moved before it has is worse than no row at all.
 */
export async function recordServingVersion(client, id, version) {
  await client.query(
    'UPDATE deployments SET serving_version = $2, updated_at = now() WHERE id = $1',
    [id, version],
  );
}

/**
 * Records the router's Kubernetes Deployment, or that there is no longer one.
 *
 * Clearing it also clears the observation, because a status left behind by an object that
 * no longer exists is the most misleading thing this table could hold: it would read as a
 * healthy router in front of a deployment that has none.
 */
export async function recordRouter(client, id, k8sName) {
  await client.query(
    `UPDATE deployments
     SET router_k8s_name = $2,
         router_status = CASE WHEN $2::text IS NULL THEN NULL ELSE router_status END,
         router_ready_replicas = CASE WHEN $2::text IS NULL THEN 0 ELSE router_ready_replicas END,
         updated_at = now()
     WHERE id = $1`,
    [id, k8sName],
  );
}

/** Writes back what the cluster reported about the router's pods. */
export async function recordRouterObservation(client, id, { status, readyReplicas }) {
  await client.query(
    `UPDATE deployments
     SET router_status = $2, router_ready_replicas = $3, updated_at = now()
     WHERE id = $1`,
    [id, status, readyReplicas],
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
