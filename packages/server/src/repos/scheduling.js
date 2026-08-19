/**
 * SQL for the scheduler's audit trail.
 *
 * Every pass writes one row per node it considered. That is more rows than a summary
 * would need, and deliberately so: "why is my job still queued" is the question a
 * cluster user asks most, and it cannot be answered from a single summary field once
 * the situation that produced it has passed (spec §12, §47).
 */

function iso(value) {
  return value ? value.toISOString() : null;
}

/**
 * Writes all decisions from one scheduling pass.
 *
 * They share a `pass_id` so the rows of one pass are read together — without it, two
 * passes a second apart are indistinguishable from one pass that considered twice as
 * many nodes.
 */
export async function recordDecisions(client, { jobId, attempt, passId, decisions }) {
  if (decisions.length === 0) return;

  // A pass identical to the one before it is folded into that one rather than written
  // again. The executor re-evaluates every queued job every couple of seconds, so a job
  // that cannot be placed would otherwise produce the same rows forever — see migration
  // 1755400000000.
  const previous = await newestPass(client, jobId);
  if (previous && sameVerdict(previous.decisions, decisions)) {
    await client.query(
      `UPDATE scheduling_decisions
       SET repeat_count = repeat_count + 1, last_seen_at = now()
       WHERE job_id = $1 AND pass_id = $2`,
      [jobId, previous.passId],
    );
    return;
  }

  // One multi-row INSERT rather than a statement per node: the rows of a pass are
  // written together or not at all, and a partial audit trail is worse than none
  // because it reads as complete.
  const COLUMNS = 8;
  const placeholders = decisions.map((_, i) => {
    const base = i * COLUMNS;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
  });

  const params = decisions.flatMap((decision) => [
    jobId,
    attempt,
    passId,
    decision.node_id ?? null,
    decision.node_name ?? '',
    decision.outcome,
    decision.reason ?? '',
    JSON.stringify(decision.details ?? {}),
  ]);

  await client.query(
    `INSERT INTO scheduling_decisions
       (job_id, attempt, pass_id, node_id, node_name, outcome, reason, details)
     VALUES ${placeholders.join(', ')}`,
    params,
  );
}

/** The most recent pass for a job, as `{ passId, decisions }`, or null. */
async function newestPass(client, jobId) {
  const { rows } = await client.query(
    `SELECT pass_id, node_name, outcome, reason
     FROM scheduling_decisions
     WHERE job_id = $1
       AND pass_id = (
         SELECT pass_id FROM scheduling_decisions
         WHERE job_id = $1
         ORDER BY id DESC
         LIMIT 1
       )
     ORDER BY id`,
    [jobId],
  );

  if (rows.length === 0) return null;
  return { passId: rows[0].pass_id, decisions: rows };
}

/**
 * Whether two passes reached the same verdict.
 *
 * Compared on node, outcome and reason — not on `details`, which carries the free
 * capacity at the time and so changes whenever anything else in the cluster moves. A
 * job refused for "0 of 2 GPUs free" every two seconds is one fact, and folding it is
 * the entire point; keying on details would defeat that for no gain, since the reason
 * string already carries the numbers a reader needs.
 */
function sameVerdict(previous, current) {
  if (previous.length !== current.length) return false;

  const key = (d) => `${d.node_name ?? ''}|${d.outcome}|${d.reason ?? ''}`;
  const before = previous.map(key).sort();
  const after = current.map((d) => key({ ...d, node_name: d.node_name ?? '' })).sort();

  return before.every((value, i) => value === after[i]);
}

/**
 * Reads a job's scheduling history, newest pass first.
 *
 * Grouped into passes because that is the unit a human reasons about: "on this attempt,
 * here is every node and what was wrong with it".
 */
export async function listDecisions(client, jobId, { passes = 5 } = {}) {
  const { rows } = await client.query(
    `SELECT id, attempt, pass_id, node_id, node_name, outcome, reason, details,
            created_at, last_seen_at, repeat_count
     FROM scheduling_decisions
     WHERE job_id = $1
       AND pass_id IN (
         SELECT pass_id FROM (
           SELECT pass_id, MAX(id) AS newest
           FROM scheduling_decisions
           WHERE job_id = $1
           GROUP BY pass_id
           ORDER BY newest DESC
           LIMIT $2
         ) recent
       )
     ORDER BY id DESC`,
    [jobId, passes],
  );

  const byPass = new Map();
  for (const row of rows) {
    if (!byPass.has(row.pass_id)) {
      byPass.set(row.pass_id, {
        pass_id: row.pass_id,
        attempt: row.attempt,
        at: iso(row.created_at),
        last_seen_at: iso(row.last_seen_at),
        // How many consecutive passes reached this same verdict. One means it happened
        // once; a large number means the job has been stuck on it.
        repeat_count: row.repeat_count,
        decisions: [],
      });
    }
    byPass.get(row.pass_id).decisions.push({
      node_id: row.node_id,
      node_name: row.node_name || null,
      outcome: row.outcome,
      reason: row.reason,
      details: row.details,
    });
  }

  return [...byPass.values()];
}
