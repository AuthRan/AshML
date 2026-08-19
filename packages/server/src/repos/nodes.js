/**
 * SQL for compute nodes, their GPUs, and the capacity view the scheduler places against.
 *
 * The scheduler's whole correctness rests on `clusterView` returning what is actually
 * committed, so the allocation arithmetic lives here in one query rather than being
 * assembled in JavaScript from several.
 */

/**
 * States in which a job occupies capacity on its node.
 *
 * SCHEDULING is included: a job that has been placed but not yet launched has already
 * had capacity promised to it, and leaving it out would let the next pass hand the same
 * GPU to a second job. CANCELLING is included because the Pod is still running until
 * the executor tears it down.
 *
 * This constant is the single definition of "occupies capacity". Anything that needs
 * the answer imports it rather than restating the list.
 */
export const OCCUPYING_STATES = Object.freeze([
  'SCHEDULING', 'STARTING', 'RUNNING', 'CANCELLING',
]);

function iso(value) {
  return value ? value.toISOString() : null;
}

/**
 * Registers or refreshes a node.
 *
 * Upsert by name because the name is what Kubernetes knows the node as; a node that is
 * deleted and recreated with the same name is the same node from AshML's point of view.
 */
export async function upsertNode(client, { name, cpuCores, memoryBytes, ready, gpuCapacity = 0, reservedCpu = 0, reservedMemory = 0 }) {
  const { rows } = await client.query(
    `INSERT INTO compute_nodes
       (name, cpu_cores, memory_bytes, ready, gpu_capacity, reserved_cpu, reserved_memory, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (name) DO UPDATE
       SET cpu_cores       = EXCLUDED.cpu_cores,
           memory_bytes    = EXCLUDED.memory_bytes,
           ready           = EXCLUDED.ready,
           gpu_capacity    = EXCLUDED.gpu_capacity,
           reserved_cpu    = EXCLUDED.reserved_cpu,
           reserved_memory = EXCLUDED.reserved_memory,
           last_seen_at    = now()
     RETURNING id`,
    [name, cpuCores, memoryBytes, ready, gpuCapacity, reservedCpu, reservedMemory],
  );
  return rows[0].id;
}

/**
 * Marks nodes that were not in the latest discovery as not ready.
 *
 * They are not deleted: a job may still reference one, and the scheduling decisions
 * that mention it must stay readable. Not-ready is enough to stop placement.
 */
export async function markNodesMissing(client, presentNames) {
  const { rowCount } = await client.query(
    `UPDATE compute_nodes
     SET ready = false
     WHERE ready = true
       AND NOT (name = ANY($1::text[]))`,
    [presentNames],
  );
  return rowCount;
}

/** Registers or refreshes one GPU device against its node. */
export async function upsertGpuDevice(client, nodeId, device) {
  await client.query(
    `INSERT INTO gpu_devices
       (node_id, provider, device_index, uuid, model, memory_total_bytes,
        memory_used_bytes, utilization_pct, temperature_c, power_watts, health,
        simulated, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (uuid) DO UPDATE
       SET node_id            = EXCLUDED.node_id,
           provider           = EXCLUDED.provider,
           device_index       = EXCLUDED.device_index,
           model              = EXCLUDED.model,
           memory_total_bytes = EXCLUDED.memory_total_bytes,
           memory_used_bytes  = EXCLUDED.memory_used_bytes,
           utilization_pct    = EXCLUDED.utilization_pct,
           temperature_c      = EXCLUDED.temperature_c,
           power_watts        = EXCLUDED.power_watts,
           health             = EXCLUDED.health,
           simulated          = EXCLUDED.simulated,
           updated_at         = now()`,
    [
      nodeId, device.provider, device.index, device.uuid, device.model,
      device.memory_total_bytes, device.memory_used_bytes, device.utilization_pct,
      device.temperature_c, device.power_watts, device.health, device.simulated,
    ],
  );
}

/**
 * The cluster as the scheduler sees it: every node, its GPUs, and what is committed.
 *
 * Allocations are derived from `training_jobs` rather than from a separate ledger, so
 * there is exactly one place the truth lives. They are also derived from AshML's own
 * records rather than from Kubernetes' reported usage, which lags by design — a Pod
 * created a moment ago has not appeared in it yet, and scheduling against a lagging
 * number double-books the node.
 */
export async function clusterView(client) {
  const { rows } = await client.query(
    `SELECT
       n.id, n.name, n.cpu_cores, n.memory_bytes, n.ready, n.last_seen_at,
       n.gpu_capacity, n.reserved_cpu, n.reserved_memory,
       COALESCE(alloc.cpu, 0)          AS allocated_cpu,
       COALESCE(alloc.memory_bytes, 0) AS allocated_memory_bytes,
       COALESCE(alloc.gpu, 0)          AS allocated_gpu,
       COALESCE(alloc.jobs, 0)         AS running_jobs,
       COALESCE(gpus.devices, '[]'::json) AS devices
     FROM compute_nodes n
     LEFT JOIN LATERAL (
       SELECT
         SUM(j.cpu_request)::int      AS cpu,
         SUM(j.memory_request)::bigint AS memory_bytes,
         SUM(j.gpu_request)::int      AS gpu,
         COUNT(*)::int                AS jobs
       FROM training_jobs j
       WHERE j.scheduled_node_id = n.id
         AND j.state = ANY($1::text[])
     ) alloc ON true
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object(
         'uuid', g.uuid,
         'index', g.device_index,
         'model', g.model,
         'memory_total_bytes', g.memory_total_bytes,
         'memory_used_bytes', g.memory_used_bytes,
         'utilization_pct', g.utilization_pct,
         'health', g.health,
         'simulated', g.simulated
       ) ORDER BY g.device_index) AS devices
       FROM gpu_devices g
       WHERE g.node_id = n.id
     ) gpus ON true
     ORDER BY n.name`,
    [OCCUPYING_STATES],
  );

  return rows.map(toNode);
}

function toNode(row) {
  return {
    id: row.id,
    name: row.name,
    ready: row.ready,
    cpu_cores: row.cpu_cores,
    memory_bytes: Number(row.memory_bytes),
    // What Kubernetes will grant, which is not the same as what the hardware has.
    gpu_capacity: row.gpu_capacity,
    reserved_cpu: row.reserved_cpu,
    reserved_memory: Number(row.reserved_memory),
    gpus: row.devices.map((device) => ({
      ...device,
      memory_total_bytes: Number(device.memory_total_bytes),
      memory_used_bytes: Number(device.memory_used_bytes),
    })),
    allocated: {
      cpu: row.allocated_cpu,
      memory_bytes: Number(row.allocated_memory_bytes),
      gpu: row.allocated_gpu,
    },
    running_jobs: row.running_jobs,
    last_seen_at: iso(row.last_seen_at),
  };
}

/**
 * What a project currently holds, for quota admission.
 *
 * Counted over the same occupying states as node capacity, so a job cannot be invisible
 * to one accounting and visible to the other.
 */
export async function projectUsage(client, projectId) {
  const { rows } = await client.query(
    `SELECT
       COALESCE(SUM(gpu_request), 0)::int       AS gpu,
       COALESCE(SUM(cpu_request), 0)::int       AS cpu,
       COALESCE(SUM(memory_request), 0)::bigint AS memory_bytes,
       COUNT(*)::int                            AS jobs
     FROM training_jobs
     WHERE project_id = $1
       AND state = ANY($2::text[])`,
    [projectId, OCCUPYING_STATES],
  );

  return {
    gpu: rows[0].gpu,
    cpu: rows[0].cpu,
    memory_bytes: Number(rows[0].memory_bytes),
    jobs: rows[0].jobs,
  };
}

/** The project's quota row, or unlimited defaults when none was ever set. */
export async function projectQuota(client, projectId) {
  const { rows } = await client.query(
    `SELECT gpu_limit, cpu_limit, memory_bytes, job_limit
     FROM resource_quotas
     WHERE project_id = $1`,
    [projectId],
  );

  if (rows.length === 0) {
    // Absent means unlimited, matching how a zero limit is read (see domain/quota.js).
    return { gpu_limit: 0, cpu_limit: 0, memory_bytes: 0, job_limit: 0 };
  }
  return { ...rows[0], memory_bytes: Number(rows[0].memory_bytes) };
}

/** Records the node a job was placed on, and the one-line summary of why. */
export async function bindJobToNode(client, jobId, nodeId, reason) {
  await client.query(
    `UPDATE training_jobs
     SET scheduled_node_id = $2, placement_reason = $3, updated_at = now()
     WHERE id = $1`,
    [jobId, nodeId, reason],
  );
}

/** Clears a placement when a job goes back to the queue, so it stops holding capacity. */
export async function unbindJob(client, jobId, reason) {
  await client.query(
    `UPDATE training_jobs
     SET scheduled_node_id = NULL, placement_reason = $2, updated_at = now()
     WHERE id = $1`,
    [jobId, reason],
  );
}
