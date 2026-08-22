/**
 * The aggregate queries a Prometheus scrape needs.
 *
 * Separate from the other repos because these read across aggregates rather than about
 * one — "how many jobs are in each state" is not a jobs question, it is a platform
 * question — and because a scrape has a constraint the API does not: it happens on a
 * timer, forever, whether anyone is looking or not. So each of these is one round trip
 * that groups in PostgreSQL rather than a list the process then counts. A `/metrics`
 * endpoint that pulls every job row every fifteen seconds is a slow leak of exactly the
 * capacity the scheduler needs.
 */

/**
 * How many jobs are in each state.
 *
 * Every state is a row here even at zero, which the caller depends on: a gauge that
 * disappears when its value reaches zero leaves the last non-zero sample as the newest
 * one Prometheus has, and a graph of "running jobs" then shows the count it had when the
 * last job finished, for ever. `ashml_jobs{state="RUNNING"} 0` is the answer; absence is
 * not.
 */
export async function jobsByState(client, states) {
  const { rows } = await client.query(
    `SELECT s.state, COALESCE(count(j.id), 0)::int AS count
       FROM unnest($1::text[]) AS s(state)
       LEFT JOIN training_jobs j ON j.state = s.state
      GROUP BY s.state`,
    [states],
  );
  return rows;
}

/**
 * The queue, and how long its oldest entry has been waiting.
 *
 * Depth alone cannot distinguish a queue of ten jobs that arrived a second ago from one
 * job that has been stuck for an hour, and those are opposite problems: the first is
 * throughput, the second is a job nothing will ever place. The age is what makes an
 * alert on this meaningful.
 */
export async function queueDepth(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS depth,
            COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))), 0)::float AS oldest_seconds
       FROM training_jobs
      WHERE state = 'QUEUED'`,
  );
  return rows[0];
}

/** How many deployments are in each status, zeros included, for the reason above. */
export async function deploymentsByStatus(client, statuses) {
  const { rows } = await client.query(
    `SELECT s.status, COALESCE(count(d.id), 0)::int AS count
       FROM unnest($1::text[]) AS s(status)
       LEFT JOIN deployments d ON d.status = s.status
      GROUP BY s.status`,
    [statuses],
  );
  return rows;
}

/**
 * Desired and ready replicas per deployment, kept apart.
 *
 * One series with a health flag would answer "is it up"; two answer "how far short is
 * it", which is the question during a rollout and during an outage alike. The alerting
 * expression that matters — ready < desired for longer than a rollout takes — needs
 * both.
 */
export async function deploymentReplicas(client) {
  const { rows } = await client.query(
    `SELECT p.name AS project, d.name, d.status,
            -- Summed over the versions taking traffic, not read off the deployment:
            -- \`deployments.replicas\` is the count each version runs, so a deployment
            -- splitting between two versions at one replica each wants two pods.
            -- Reporting 1 would make a split with half of it failed look complete, and
            -- the alert that matters here is exactly ready < desired.
            COALESCE((
              SELECT SUM(t.replicas)::int
                FROM deployment_targets t
               WHERE t.deployment_id = d.id AND t.traffic_weight > 0
            ), 0) AS desired,
            d.ready_replicas::int AS ready
       FROM deployments d
       JOIN projects p ON p.id = d.project_id
      ORDER BY p.name, d.name`,
  );
  return rows;
}

/**
 * Node capacity and what is committed on it.
 *
 * `gpu_capacity` is what Kubernetes advertises, which on this cluster is zero however
 * much silicon the machine has (ADR 0008). Exporting it next to the GPU telemetry from
 * the provider is deliberate: the two numbers disagreeing is the honest description of
 * this host, and a dashboard that showed only one of them would be misleading whichever
 * one it picked.
 */
export async function nodeCapacity(client, occupyingStates) {
  const { rows } = await client.query(
    `SELECT n.name, n.ready, n.cpu_cores::float AS cpu_cores,
            n.memory_bytes::float AS memory_bytes, n.gpu_capacity::int AS gpu_capacity,
            COALESCE(alloc.cpu, 0)::float          AS allocated_cpu,
            COALESCE(alloc.memory_bytes, 0)::float AS allocated_memory_bytes,
            COALESCE(alloc.gpu, 0)::int            AS allocated_gpu,
            COALESCE(alloc.jobs, 0)::int           AS running_jobs
       FROM compute_nodes n
       LEFT JOIN LATERAL (
         SELECT SUM(j.cpu_request)          AS cpu,
                SUM(j.memory_request)      AS memory_bytes,
                SUM(j.gpu_request)          AS gpu,
                count(*)                    AS jobs
           FROM training_jobs j
          WHERE j.scheduled_node_id = n.id
            AND j.state = ANY($1::text[])
       ) alloc ON TRUE
      ORDER BY n.name`,
    [occupyingStates],
  );
  return rows;
}

/**
 * Artifacts by status, which is how "did the bytes arrive" becomes a graph.
 *
 * PENDING artifacts accumulating is the visible form of runs dying between registering
 * an artifact and confirming it — the garbage-collection gap Phase 4 deferred. Nothing
 * sweeps them yet, so the least that can be done is to make the pile countable.
 */
export async function artifactsByStatus(client, statuses) {
  const { rows } = await client.query(
    `SELECT s.status, COALESCE(count(a.id), 0)::int AS count
       FROM unnest($1::text[]) AS s(status)
       LEFT JOIN artifacts a ON a.status = s.status
      GROUP BY s.status`,
    [statuses],
  );
  return rows;
}

/** Registered model versions by lifecycle state — one line for "what is in production". */
export async function modelVersionsByStatus(client, statuses) {
  const { rows } = await client.query(
    `SELECT s.status, COALESCE(count(v.id), 0)::int AS count
       FROM unnest($1::text[]) AS s(status)
       LEFT JOIN model_versions v ON v.status = s.status
      GROUP BY s.status`,
    [statuses],
  );
  return rows;
}
