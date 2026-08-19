/**
 * SQL for training metrics.
 *
 * Metrics are written from inside the training container, many times a run, and read
 * back as series — "loss over the course of this job", "accuracy across the jobs of
 * this experiment". Both reads are ordered by `step`, which is what the indexes on
 * (job_id, name, step) and (experiment_id, name, step) exist for.
 *
 * Rows are stored long (one per name/value) and grouped into series here rather than in
 * SQL: the grouping is presentation, and doing it in JavaScript keeps the query a plain
 * indexed range scan.
 */

function iso(value) {
  return value ? value.toISOString() : null;
}

/**
 * Inserts a batch of metrics in one statement.
 *
 * A training loop that logs four metrics every step would otherwise open a round trip
 * per value; `unnest` makes the batch one insert regardless of size. `job_id` and
 * `experiment_id` are scalars because a batch always belongs to a single run.
 *
 * `recorded_at` falls back to now() per row rather than relying on the column default,
 * which `unnest` would bypass by supplying an explicit NULL.
 *
 * @param {Array<{name: string, value: number, step: number, epoch: number|null, recordedAt: string|null}>} metrics
 * @returns {Promise<number>} how many rows were written
 */
export async function insertMetrics(client, { jobId, experimentId = null, metrics }) {
  if (metrics.length === 0) return 0;

  const { rowCount } = await client.query(
    `INSERT INTO training_metrics (job_id, experiment_id, step, epoch, name, value, recorded_at)
     SELECT $1, $2, m.step, m.epoch, m.name, m.value, COALESCE(m.recorded_at, now())
     FROM unnest($3::int[], $4::int[], $5::text[], $6::double precision[], $7::timestamptz[])
       AS m(step, epoch, name, value, recorded_at)`,
    [
      jobId,
      experimentId,
      metrics.map((m) => m.step),
      metrics.map((m) => m.epoch),
      metrics.map((m) => m.name),
      metrics.map((m) => m.value),
      metrics.map((m) => m.recordedAt),
    ],
  );
  return rowCount;
}

/**
 * Metric rows for one job, oldest step first.
 *
 * `limit` is a row cap, not a series cap: a long run can hold millions of points and
 * neither this process nor the caller should try to hold all of them at once.
 */
export async function listJobMetrics(client, jobId, { name = null, sinceStep = null, limit = 2000 } = {}) {
  const { rows } = await client.query(
    `SELECT name, step, epoch, value, recorded_at
     FROM training_metrics
     WHERE job_id = $1
       AND ($2::text IS NULL OR name = $2)
       AND ($3::int IS NULL OR step > $3)
     ORDER BY name, step, id
     LIMIT $4`,
    [jobId, name, sinceStep, limit],
  );
  return rows;
}

/** As listJobMetrics, but across every job recorded against one experiment. */
export async function listExperimentMetrics(client, experimentId, { name = null, limit = 2000 } = {}) {
  const { rows } = await client.query(
    `SELECT job_id, name, step, epoch, value, recorded_at
     FROM training_metrics
     WHERE experiment_id = $1
       AND ($2::text IS NULL OR name = $2)
     ORDER BY name, job_id, step, id
     LIMIT $3`,
    [experimentId, name, limit],
  );
  return rows;
}

/**
 * One row per metric name: how many points, the step range, and the most recent value.
 *
 * This is what "how is this run doing" needs, and it answers it without transferring
 * the whole series. DISTINCT ON takes the last point per name in one pass.
 */
export async function summariseJobMetrics(client, jobId) {
  const { rows } = await client.query(
    `SELECT s.name, s.count, s.first_step, s.last_step, l.value AS last_value, l.recorded_at
     FROM (
       SELECT name, COUNT(*)::int AS count, MIN(step) AS first_step, MAX(step) AS last_step
       FROM training_metrics WHERE job_id = $1 GROUP BY name
     ) s
     JOIN LATERAL (
       SELECT value, recorded_at FROM training_metrics
       WHERE job_id = $1 AND name = s.name
       ORDER BY step DESC, id DESC LIMIT 1
     ) l ON TRUE
     ORDER BY s.name`,
    [jobId],
  );
  return rows.map((row) => ({
    name: row.name,
    count: row.count,
    first_step: row.first_step,
    last_step: row.last_step,
    last_value: row.last_value,
    last_recorded_at: iso(row.recorded_at),
  }));
}

/**
 * Groups flat metric rows into series.
 *
 * `keyOf` decides what makes a series: name alone for one job, name plus job for an
 * experiment, where the point of the read is comparing runs against each other.
 */
export function toSeries(rows, { keyOf = (row) => row.name, extra = () => ({}) } = {}) {
  const series = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!series.has(key)) {
      series.set(key, { name: row.name, ...extra(row), points: [] });
    }
    series.get(key).points.push({
      step: row.step,
      epoch: row.epoch,
      value: row.value,
      recorded_at: iso(row.recorded_at),
    });
  }
  return [...series.values()];
}
