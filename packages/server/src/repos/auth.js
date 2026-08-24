/** SQL for tokens, project membership, and resolving a caller. */

/**
 * Resolves a user API token to its holder, in one query.
 *
 * The join to `project_members` is here rather than in a second round trip because it
 * runs on every authenticated request and two queries would double the per-request
 * database cost of having authentication at all.
 *
 * The `WHERE` is the whole verification. There is no comparison anywhere: the presented
 * token is hashed and that hash is the lookup key (see `auth/tokens.js`), so a token that
 * is revoked, expired, or simply not ours produces no row and is refused by the same
 * path. Distinguishing those cases in the answer would tell a caller which half to fix.
 */
export async function findUserByTokenHash(client, tokenHash) {
  const { rows } = await client.query(
    `SELECT
       t.id          AS token_id,
       u.id          AS user_id,
       u.email,
       u.display_name,
       u.is_admin,
       COALESCE(
         (SELECT json_agg(json_build_object('project_id', m.project_id, 'role', m.role))
          FROM project_members m WHERE m.user_id = u.id),
         '[]'::json
       ) AS memberships
     FROM api_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1
       AND t.revoked_at IS NULL
       AND (t.expires_at IS NULL OR t.expires_at > now())`,
    [tokenHash],
  );
  return rows.length ? rows[0] : null;
}

/**
 * Records that a token was used.
 *
 * Deliberately not awaited on the request path and deliberately not inside the caller's
 * transaction: it is evidence for a human deciding whether revoking a token will break
 * something, and it must never be the reason a request fails or waits. Truncated to the
 * minute so a busy token does not rewrite its row on every call.
 */
export async function touchToken(client, tokenId) {
  await client.query(
    `UPDATE api_tokens
     SET last_used_at = now()
     WHERE id = $1
       AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [tokenId],
  );
}

/**
 * Resolves a workload token to the workload it belongs to.
 *
 * One query for both kinds. `kind` in the row is what the caller switches on, so nothing
 * has to infer which sort of token it is holding from which column happens to be null.
 */
export async function findWorkloadByTokenHash(client, tokenHash) {
  const { rows } = await client.query(
    `SELECT
       w.id AS token_id, w.kind, w.job_id, w.attempt, w.deployment_id,
       COALESCE(j.project_id, d.project_id) AS project_id,
       -- Carried so a run token can report against its own experiment as well as its
       -- own job, without a second query per request.
       j.experiment_id
     FROM workload_tokens w
     LEFT JOIN training_jobs j ON j.id = w.job_id
     LEFT JOIN deployments   d ON d.id = w.deployment_id
     WHERE w.token_hash = $1
       AND w.revoked_at IS NULL
       AND (w.expires_at IS NULL OR w.expires_at > now())`,
    [tokenHash],
  );
  return rows.length ? rows[0] : null;
}

export async function createApiToken(client, { userId, name, tokenHash, prefix, expiresAt = null }) {
  const { rows } = await client.query(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, prefix, created_at, expires_at`,
    [userId, name, tokenHash, prefix, expiresAt],
  );
  return rows[0];
}

/** Live tokens only. A revoked token is evidence, not inventory. */
export async function listApiTokens(client, userId) {
  const { rows } = await client.query(
    `SELECT id, name, prefix, created_at, last_used_at, expires_at
     FROM api_tokens
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * Revokes one of a user's tokens by name.
 *
 * Scoped to the user in the statement itself rather than checked first: a name is not a
 * secret, and a check-then-update would let one user revoke another's token by racing
 * between the two.
 */
export async function revokeApiToken(client, userId, name) {
  const { rows } = await client.query(
    `UPDATE api_tokens
     SET revoked_at = now()
     WHERE user_id = $1 AND name = $2 AND revoked_at IS NULL
     RETURNING id, name, prefix`,
    [userId, name],
  );
  return rows.length ? rows[0] : null;
}

export async function createRunToken(client, { jobId, attempt, tokenHash, expiresAt = null }) {
  const { rows } = await client.query(
    `INSERT INTO workload_tokens (kind, job_id, attempt, token_hash, expires_at)
     VALUES ('RUN', $1, $2, $3, $4)
     RETURNING id, kind, job_id, attempt, created_at, expires_at`,
    [jobId, attempt, tokenHash, expiresAt],
  );
  return rows[0];
}

/**
 * Is there already a working credential for this deployment?
 *
 * Only the hash is stored, so this cannot return the token — only whether one exists.
 * That is enough, and it is the question that matters: if a live token exists, the
 * Secret in the cluster already holds its plaintext and the pods already have it, so
 * there is nothing to do. See `ensureServingToken` for why minting anyway is harmful.
 */
export async function hasLiveServingToken(client, deploymentId) {
  const { rows } = await client.query(
    `SELECT 1 FROM workload_tokens
     WHERE deployment_id = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [deploymentId],
  );
  return rows.length > 0;
}

export async function createServingToken(client, { deploymentId, tokenHash, expiresAt = null }) {
  const { rows } = await client.query(
    `INSERT INTO workload_tokens (kind, deployment_id, token_hash, expires_at)
     VALUES ('SERVING', $1, $2, $3)
     RETURNING id, kind, deployment_id, created_at, expires_at`,
    [deploymentId, tokenHash, expiresAt],
  );
  return rows[0];
}

/**
 * Revokes every live token for a job.
 *
 * Called when a job reaches a terminal state, and on retry *before* the next attempt is
 * minted. The second case is the one that matters: a SIGKILLed pod can still be shutting
 * down while its replacement starts, and without this it could report metrics for the run
 * that replaced it — which would not fail, it would quietly write one attempt's numbers
 * onto another's.
 */
export async function revokeRunTokens(client, jobId) {
  const { rowCount } = await client.query(
    `UPDATE workload_tokens SET revoked_at = now()
     WHERE job_id = $1 AND revoked_at IS NULL`,
    [jobId],
  );
  return rowCount;
}

/**
 * Brings forward the expiry of a job's live tokens instead of revoking them.
 *
 * The difference between this and `revokeRunTokens` is the difference between the two
 * ways a run ends, and getting it wrong breaks something in each direction.
 *
 * A **retry** must revoke, immediately: a SIGKILLed pod can still be shutting down while
 * its replacement starts, and a token that outlived the attempt would let it write one
 * run's numbers onto another's.
 *
 * A run that simply **finished** must not. The upload of the final checkpoint completes
 * after the pod is gone — `POST /artifacts/:id/complete` arrives from a process that is
 * on its way out — and cutting the credential at the terminal state would leave every
 * successful run's model stuck at PENDING. So the token is given a short grace window
 * and expires on its own.
 *
 * `LEAST` so this only ever shortens a token's life; a job that finishes twice, or one
 * whose token already expires sooner, cannot have its credential extended by this.
 */
export async function expireRunTokens(client, jobId, graceSeconds) {
  const { rowCount } = await client.query(
    `UPDATE workload_tokens
     SET expires_at = LEAST(
           COALESCE(expires_at, now() + ($2 || ' seconds')::interval),
           now() + ($2 || ' seconds')::interval
         )
     WHERE job_id = $1 AND revoked_at IS NULL`,
    [jobId, String(graceSeconds)],
  );
  return rowCount;
}

export async function revokeServingTokens(client, deploymentId) {
  const { rowCount } = await client.query(
    `UPDATE workload_tokens SET revoked_at = now()
     WHERE deployment_id = $1 AND revoked_at IS NULL`,
    [deploymentId],
  );
  return rowCount;
}

export async function getUserByEmail(client, email) {
  const { rows } = await client.query(
    'SELECT id, email, display_name, is_admin FROM users WHERE email = $1',
    [email],
  );
  return rows.length ? rows[0] : null;
}

export async function createUser(client, { email, displayName, isAdmin = false }) {
  const { rows } = await client.query(
    `INSERT INTO users (email, display_name, is_admin)
     VALUES ($1, $2, $3)
     RETURNING id, email, display_name, is_admin`,
    [email, displayName, isAdmin],
  );
  return rows[0];
}

export async function setMember(client, { projectId, userId, role }) {
  const { rows } = await client.query(
    `INSERT INTO project_members (project_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING project_id, user_id, role, created_at`,
    [projectId, userId, role],
  );
  return rows[0];
}

export async function removeMember(client, { projectId, userId }) {
  const { rowCount } = await client.query(
    'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId],
  );
  return rowCount > 0;
}

export async function listMembers(client, projectId) {
  const { rows } = await client.query(
    `SELECT u.id AS user_id, u.email, u.display_name, m.role, m.created_at
     FROM project_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.project_id = $1
     ORDER BY m.created_at`,
    [projectId],
  );
  return rows;
}

/**
 * Serialises membership changes for one project.
 *
 * A row lock on the project, not on `project_members`, because the invariant being
 * protected — "at least one owner" — is a property of the *set*, and locking the rows
 * that happen to exist cannot stop a concurrent transaction from reading the same set and
 * reaching the same conclusion. Same argument as `db/locks.js` makes for the scheduler,
 * one scope down.
 */
export async function lockProjectMembership(client, projectId) {
  await client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
}

/** How many owners a project has. Used to refuse removing the last one. */
export async function countOwners(client, projectId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM project_members
     WHERE project_id = $1 AND role = 'OWNER'`,
    [projectId],
  );
  return rows[0].n;
}

/**
 * Where an id-addressed entity sits: its project, and the run it belongs to.
 *
 * Routes addressed by an opaque id cannot be authorized from the URL — there is no
 * project in it — so the entity has to be located first. These return the *scope* rather
 * than just the project, because a run token is scoped to a job and several of these
 * entities are only transitively a job's: an artifact belongs to the run that produced
 * it, and a report belongs to the experiment the run is part of. Returning only the
 * project id here is what made an earlier version of this refuse a run's own upload
 * confirmation — the artifact id was compared against the token's job id.
 *
 * A missing row returns null, which callers turn into the same 404 as "not permitted"
 * (see `resolveProject` for why those are one answer).
 */
async function scopeBy(client, sql, id) {
  // A malformed uuid is a 404, not a 500: `:id` comes from the URL and Postgres would
  // otherwise raise invalid_text_representation (22P02) on the cast, which the error
  // handler masks as an internal error. The previous pattern was `[0-9a-f-]{36}`, which
  // let 36 dashes through to the database and rejected the valid undashed form.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const { rows } = await client.query(sql, [id]);
  if (!rows.length) return null;
  return {
    projectId: rows[0].project_id,
    jobId: rows[0].job_id ?? null,
    experimentId: rows[0].experiment_id ?? null,
    deploymentId: rows[0].deployment_id ?? null,
  };
}

export const scopeOfJob = (client, id) =>
  scopeBy(
    client,
    `SELECT project_id, id AS job_id, experiment_id
     FROM training_jobs WHERE id = $1`,
    id,
  );

export const scopeOfExperiment = (client, id) =>
  scopeBy(
    client,
    'SELECT project_id, id AS experiment_id, NULL::uuid AS job_id FROM experiments WHERE id = $1',
    id,
  );

export const scopeOfDeployment = (client, id) =>
  scopeBy(
    client,
    `SELECT project_id, id AS deployment_id, NULL::uuid AS job_id, NULL::uuid AS experiment_id
     FROM deployments WHERE id = $1`,
    id,
  );

/** An artifact belongs to a project, and to a run, through the job that produced it. */
export const scopeOfArtifact = (client, id) =>
  scopeBy(
    client,
    `SELECT j.project_id, j.id AS job_id, j.experiment_id
     FROM artifacts a JOIN training_jobs j ON j.id = a.job_id
     WHERE a.id = $1`,
    id,
  );
