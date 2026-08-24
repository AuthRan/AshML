/** SQL for the authorization audit trail (`authz_denials`). */

/**
 * Appends a batch of denials in one round trip.
 *
 * One statement rather than one per row, because these are written from a buffer that
 * flushes on a timer: the whole point of buffering was to keep the cost off the request
 * that produced the denial, and a loop of INSERTs would move the cost rather than remove
 * it. `UNNEST` over parallel arrays is how PostgreSQL takes a batch without building a
 * VALUES list whose length changes the query text — which would defeat the plan cache and
 * give a different statement for every batch size.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {object[]} rows from `services/audit.js`
 * @returns {Promise<number>} rows written
 */
export async function insertDenials(client, rows) {
  if (rows.length === 0) return 0;

  const columns = [
    'occurred_at', 'principal', 'user_id', 'job_id', 'deployment_id', 'subject',
    'permission', 'project_id', 'project_name', 'method', 'route', 'status',
    'request_id', 'remote_addr',
  ];
  const values = columns.map((column) => rows.map((row) => row[column] ?? null));

  const { rowCount } = await client.query(
    `INSERT INTO authz_denials (${columns.join(', ')})
     SELECT * FROM UNNEST(
       $1::timestamptz[], $2::text[], $3::uuid[], $4::uuid[], $5::uuid[], $6::text[],
       $7::text[], $8::uuid[], $9::text[], $10::text[], $11::text[], $12::smallint[],
       $13::uuid[], $14::inet[]
     )`,
    values,
  );
  return rowCount;
}

/**
 * The newest denials, optionally narrowed.
 *
 * Filtering is done in SQL rather than after the fact for the same reason listing
 * projects is: the `LIMIT` has to apply to rows that match, or a filter silently returns
 * fewer results than it should the moment the table is busy.
 *
 * @param {object} [filter]
 * @param {string} [filter.userId] only this account's refusals
 * @param {string} [filter.permission] only refusals of this permission
 * @param {number} [filter.sinceHours] only the last N hours
 * @param {number} [filter.limit]
 */
export async function listDenials(client, {
  userId = null, permission = null, sinceHours = null, limit = 50,
} = {}) {
  const { rows } = await client.query(
    `SELECT id, occurred_at, principal, user_id, job_id, deployment_id, subject,
            permission, project_id, project_name, method, route, status,
            request_id, host(remote_addr) AS remote_addr
     FROM authz_denials
     WHERE ($1::uuid IS NULL OR user_id = $1)
       AND ($2::text IS NULL OR permission = $2)
       AND ($3::int  IS NULL OR occurred_at > now() - ($3 * INTERVAL '1 hour'))
     ORDER BY occurred_at DESC, id DESC
     LIMIT $4`,
    [userId, permission, sinceHours, limit],
  );
  return rows;
}

/** How many denials each account has collected lately. The "who is probing" query. */
export async function summariseDenials(client, { sinceHours = 24, limit = 20 } = {}) {
  const { rows } = await client.query(
    `SELECT subject, principal, count(*)::int AS denials,
            max(occurred_at) AS last_seen,
            array_agg(DISTINCT permission ORDER BY permission) AS permissions
     FROM authz_denials
     WHERE occurred_at > now() - ($1 * INTERVAL '1 hour')
     GROUP BY subject, principal
     ORDER BY denials DESC, last_seen DESC
     LIMIT $2`,
    [sinceHours, limit],
  );
  return rows;
}
