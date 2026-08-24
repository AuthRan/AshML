/** SQL for projects and their resource quotas. */

/**
 * The seeded local user (migration 1755000100000).
 *
 * Since Phase 10 this is no longer the implicit author of everything — projects record
 * whoever created them. It survives as the identity the control plane runs as when
 * ASHML_AUTH_ENABLED=false, and as the owner backfilled onto projects that predate auth.
 */
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

export async function createProject(client, { name, description = '', quota = {}, ownerId = LOCAL_USER_ID }) {
  const { rows } = await client.query(
    `INSERT INTO projects (name, description, owner_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [name, description, ownerId],
  );
  const projectId = rows[0].id;

  // The creator is a member, not merely a foreign key. `projects.owner_id` records who
  // made it; `project_members` is what every authorization check reads, and a project
  // whose creator was not in it would be a project its creator could not open.
  await client.query(
    `INSERT INTO project_members (project_id, user_id, role)
     VALUES ($1, $2, 'OWNER')
     ON CONFLICT DO NOTHING`,
    [projectId, ownerId],
  );

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

/**
 * Projects visible to one caller.
 *
 * Scoping happens in SQL rather than by filtering afterwards. Fetching every project and
 * discarding the ones the caller may not see would work, and would also mean the count,
 * the ordering and any future pagination were computed over rows that are not theirs —
 * the classic way a "you have 3 projects" ends up reading 300.
 *
 * `userId: null` means a platform administrator: no filter, because they may see all.
 */
export async function listProjects(client, { userId = null } = {}) {
  const scoped = userId !== null;
  const { rows } = await client.query(
    `SELECT ${PROJECT_COLUMNS}
     FROM projects p
     LEFT JOIN resource_quotas q ON q.project_id = p.id
     ${scoped ? 'JOIN project_members m ON m.project_id = p.id AND m.user_id = $1' : ''}
     ORDER BY p.created_at DESC`,
    scoped ? [userId] : [],
  );
  return rows.map(toProject);
}
