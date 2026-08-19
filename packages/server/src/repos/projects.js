/** SQL for projects and their resource quotas. */

/** Fixed local user until authentication exists (see migration 1755000100000). */
export const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001';

const PROJECT_COLUMNS = `
  p.id,
  p.name,
  p.description,
  p.created_at,
  COALESCE(q.gpu_limit, 0)    AS gpu_limit,
  COALESCE(q.cpu_limit, 0)    AS cpu_limit,
  COALESCE(q.memory_bytes, 0) AS memory_limit_bytes,
  COALESCE(q.job_limit, 0)    AS job_limit
`;

function toProject(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: row.created_at.toISOString(),
    quota: {
      gpu: row.gpu_limit,
      cpu: row.cpu_limit,
      memory_bytes: row.memory_limit_bytes,
      jobs: row.job_limit,
    },
  };
}

/**
 * Updates a project's quota.
 *
 * Only the fields present in `quota` are changed, so raising the GPU limit does not
 * silently reset the CPU limit to zero — which, since zero means unlimited, would be a
 * quota change that quietly removed a quota.
 */
export async function updateQuota(client, projectId, quota) {
  const { rows } = await client.query(
    `UPDATE resource_quotas
     SET gpu_limit    = COALESCE($2, gpu_limit),
         cpu_limit    = COALESCE($3, cpu_limit),
         memory_bytes = COALESCE($4, memory_bytes),
         job_limit    = COALESCE($5, job_limit)
     WHERE project_id = $1
     RETURNING gpu_limit, cpu_limit, memory_bytes, job_limit`,
    [
      projectId,
      quota.gpu ?? null,
      quota.cpu ?? null,
      quota.memory_bytes ?? null,
      quota.jobs ?? null,
    ],
  );
  return rows.length ? rows[0] : null;
}

export async function createProject(client, { name, description = '', quota = {} }) {
  const { rows } = await client.query(
    `INSERT INTO projects (name, description, owner_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [name, description, LOCAL_USER_ID],
  );
  const projectId = rows[0].id;

  // A project always has a quota row, even if it is all zeros, so the scheduler can
  // join unconditionally rather than handling a missing row (Phase 3).
  await client.query(
    `INSERT INTO resource_quotas (project_id, gpu_limit, cpu_limit, memory_bytes, job_limit)
     VALUES ($1, $2, $3, $4, $5)`,
    [projectId, quota.gpu ?? 0, quota.cpu ?? 0, quota.memory_bytes ?? 0, quota.jobs ?? 0],
  );

  return getProjectById(client, projectId);
}

export async function getProjectById(client, id) {
  const { rows } = await client.query(
    `SELECT ${PROJECT_COLUMNS}
     FROM projects p
     LEFT JOIN resource_quotas q ON q.project_id = p.id
     WHERE p.id = $1`,
    [id],
  );
  return rows.length ? toProject(rows[0]) : null;
}

export async function getProjectByName(client, name) {
  const { rows } = await client.query(
    `SELECT ${PROJECT_COLUMNS}
     FROM projects p
     LEFT JOIN resource_quotas q ON q.project_id = p.id
     WHERE p.name = $1`,
    [name],
  );
  return rows.length ? toProject(rows[0]) : null;
}

export async function listProjects(client) {
  const { rows } = await client.query(
    `SELECT ${PROJECT_COLUMNS}
     FROM projects p
     LEFT JOIN resource_quotas q ON q.project_id = p.id
     ORDER BY p.created_at DESC`,
  );
  return rows.map(toProject);
}
