/**
 * Prometheus metrics for the control plane.
 *
 * The split this module lives on is ADR 0009's, and it is the reason there are no
 * training metrics here: **infrastructure is scraped, training is pushed.** Only the
 * training loop knows what step a loss belongs to, so a scraper sampling on a timer
 * records "loss was 1.84 at 14:03:22" — the wrong axis, silently dropping every step
 * between two scrapes. Losses and accuracies live in `training_metrics` and reach a
 * dashboard through Grafana's PostgreSQL datasource, on the step axis they were reported
 * against. What is here is queue depth, replica counts, pass durations, GPU telemetry:
 * things whose value at a moment is the whole truth about them.
 *
 * Two kinds of metric, gathered two different ways:
 *
 * - **Instruments**, updated by the code as it runs — an HTTP request finished, an
 *   executor pass took this long. These are counters and histograms, and they only move
 *   forward.
 * - **Snapshots**, collected at scrape time from PostgreSQL and the GPU provider. These
 *   are gauges of state AshML does not own the transitions of. Deriving them from
 *   counters incremented in code would mean the numbers drift from the database
 *   whenever anything else writes to it — another replica, a migration, a human with
 *   psql — and a metric that disagrees with `ash job list` is worse than no metric.
 *
 * `prom-client` rather than hand-rolled exposition. The format looks trivial and is not:
 * label escaping, histogram bucket cumulativity, `_sum`/`_count` naming, and the special
 * cases around `+Inf` and NaN are all places where output is silently *dropped* by
 * Prometheus rather than rejected, which is the worst failure mode available for a
 * monitoring system.
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

import { JobState, OUTCOME_STATES } from '../domain/job-state.js';
import { ArtifactStatus } from '../domain/artifact-status.js';
import { ModelStatus } from '../domain/model-status.js';
import { OCCUPYING_STATES } from '../repos/nodes.js';
import * as observabilityRepo from '../repos/observability.js';

const PREFIX = 'ashml_';

/**
 * Buckets for durations that are dominated by a poll interval rather than by work.
 *
 * Scheduling latency is bounded below by nothing and above by the executor's interval
 * (ADR 0007), so the interesting resolution is around one and two seconds. Default
 * buckets top out at 10 s and would put every normal value in the same two buckets.
 */
const SCHEDULING_BUCKETS = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10, 30, 60];

/** Buckets for an HTTP request, which on this API is milliseconds, not seconds. */
const REQUEST_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Builds a registry and every metric on it.
 *
 * A factory rather than module-level singletons, because prom-client throws on a
 * duplicate metric name in a registry and tests build several apps in one process. It
 * also keeps the metrics injectable, which is what lets the collector be tested against
 * a fixture instead of a cluster.
 */
export function createMetrics({ collectDefaults = true } = {}) {
  const registry = new Registry();
  registry.setDefaultLabels({ component: 'control-plane' });

  if (collectDefaults) {
    // Event-loop lag, heap, handles, GC. Worth having precisely because this process
    // runs a scheduler on the same event loop it serves the API from: "the platform is
    // slow" and "the event loop is blocked" are the same graph.
    collectDefaultMetrics({ register: registry, prefix: PREFIX });
  }

  const instruments = {
    httpRequestDuration: new Histogram({
      name: `${PREFIX}http_request_duration_seconds`,
      help: 'Control-plane HTTP request duration',
      // The *route*, never the URL. `/api/v1/jobs/:id` is one series; the URL is one
      // series per job, which is how a metrics endpoint becomes the largest thing in a
      // Prometheus instance.
      labelNames: ['method', 'route', 'status'],
      buckets: REQUEST_BUCKETS,
      registers: [registry],
    }),

    schedulingLatency: new Histogram({
      name: `${PREFIX}job_scheduling_latency_seconds`,
      help: 'Time from a job being queued to its Kubernetes Job existing',
      buckets: SCHEDULING_BUCKETS,
      registers: [registry],
    }),

    executorPassDuration: new Histogram({
      name: `${PREFIX}executor_pass_duration_seconds`,
      help: 'Duration of one executor pass',
      buckets: SCHEDULING_BUCKETS,
      registers: [registry],
    }),

    executorPasses: new Counter({
      name: `${PREFIX}executor_passes_total`,
      help: 'Executor passes, by outcome',
      labelNames: ['outcome'],
      registers: [registry],
    }),

    deploymentSyncDuration: new Histogram({
      name: `${PREFIX}deployment_sync_duration_seconds`,
      help: 'Duration of one deployment status sync pass',
      buckets: SCHEDULING_BUCKETS,
      registers: [registry],
    }),

    jobLaunches: new Counter({
      name: `${PREFIX}job_launches_total`,
      help: 'Kubernetes Jobs created by the executor, by outcome',
      labelNames: ['outcome'],
      registers: [registry],
    }),

    jobTerminations: new Counter({
      name: `${PREFIX}job_terminations_total`,
      help: 'Attempts that ended, by the state they ended in. FAILED counts even when a retry follows: the attempt did fail',
      labelNames: ['state'],
      registers: [registry],
    }),

    predictionDuration: new Histogram({
      name: `${PREFIX}prediction_duration_seconds`,
      help: 'Round trip of a prediction made through the control plane, including the API server proxy',
      labelNames: ['project', 'deployment', 'outcome'],
      buckets: REQUEST_BUCKETS,
      registers: [registry],
    }),

    predictionUpstreamDuration: new Histogram({
      name: `${PREFIX}prediction_upstream_duration_seconds`,
      help: 'The forward pass itself, as the model server measured it',
      labelNames: ['project', 'deployment'],
      buckets: REQUEST_BUCKETS,
      registers: [registry],
    }),

    predictionInstances: new Counter({
      name: `${PREFIX}prediction_instances_total`,
      help: 'Instances predicted on, which is what per-image cost is derived from',
      labelNames: ['project', 'deployment'],
      registers: [registry],
    }),

    rateLimited: new Counter({
      name: `${PREFIX}rate_limited_total`,
      help: 'Requests refused by the rate limiter, by which limiter refused them',
      labelNames: ['scope'],
      registers: [registry],
    }),

    scrapeErrors: new Counter({
      name: `${PREFIX}scrape_errors_total`,
      help: 'Scrapes where a snapshot could not be collected, by source',
      labelNames: ['source'],
      registers: [registry],
    }),
  };

  const snapshots = {
    // The one snapshot `collectSnapshot` does not fill: the limiter is in this process,
    // so `auth/rate-limit.js` attaches a `collect` callback and the number is read off
    // the live maps at scrape time rather than copied there on a timer.
    rateLimitKeys: new Gauge({
      name: `${PREFIX}rate_limit_keys`,
      help: 'Callers the rate limiter is currently tracking, by scope. Bounded by ASHML_RATE_LIMIT_MAX_KEYS; at the bound, the oldest is evicted',
      labelNames: ['scope'],
      registers: [registry],
    }),
    jobs: new Gauge({
      name: `${PREFIX}jobs`,
      help: 'Jobs in each state',
      labelNames: ['state'],
      registers: [registry],
    }),
    queueDepth: new Gauge({
      name: `${PREFIX}queue_depth`,
      help: 'Jobs waiting in QUEUED',
      registers: [registry],
    }),
    queueOldestSeconds: new Gauge({
      name: `${PREFIX}queue_oldest_seconds`,
      help: 'Age of the oldest queued job. Depth alone cannot tell ten new jobs from one stuck one',
      registers: [registry],
    }),
    deployments: new Gauge({
      name: `${PREFIX}deployments`,
      help: 'Deployments in each status',
      labelNames: ['status'],
      registers: [registry],
    }),
    deploymentReplicasDesired: new Gauge({
      name: `${PREFIX}deployment_replicas_desired`,
      help: 'Replicas asked for',
      labelNames: ['project', 'deployment'],
      registers: [registry],
    }),
    deploymentReplicasReady: new Gauge({
      name: `${PREFIX}deployment_replicas_ready`,
      help: 'Replicas that passed their readiness probe — for a model server, that the weights are loaded',
      labelNames: ['project', 'deployment'],
      registers: [registry],
    }),
    nodeReady: new Gauge({
      name: `${PREFIX}node_ready`,
      help: '1 when the node is Ready',
      labelNames: ['node'],
      registers: [registry],
    }),
    nodeCpuCores: new Gauge({
      name: `${PREFIX}node_cpu_cores`,
      help: 'Allocatable CPU cores',
      labelNames: ['node'],
      registers: [registry],
    }),
    nodeCpuAllocated: new Gauge({
      name: `${PREFIX}node_cpu_allocated`,
      help: 'CPU cores committed to jobs AshML placed',
      labelNames: ['node'],
      registers: [registry],
    }),
    nodeMemoryBytes: new Gauge({
      name: `${PREFIX}node_memory_bytes`,
      help: 'Allocatable memory',
      labelNames: ['node'],
      registers: [registry],
    }),
    nodeMemoryAllocated: new Gauge({
      name: `${PREFIX}node_memory_allocated_bytes`,
      help: 'Memory committed to jobs AshML placed',
      labelNames: ['node'],
      registers: [registry],
    }),
    nodeGpuCapacity: new Gauge({
      name: `${PREFIX}node_gpu_capacity`,
      help: 'GPUs the cluster advertises on this node, which is what may actually be requested (ADR 0008)',
      labelNames: ['node'],
      registers: [registry],
    }),
    nodeGpuAllocated: new Gauge({
      name: `${PREFIX}node_gpu_allocated`,
      help: 'GPUs committed to jobs AshML placed',
      labelNames: ['node'],
      registers: [registry],
    }),
    nodeJobs: new Gauge({
      name: `${PREFIX}node_jobs`,
      help: 'Jobs currently occupying capacity on this node',
      labelNames: ['node'],
      registers: [registry],
    }),
    artifacts: new Gauge({
      name: `${PREFIX}artifacts`,
      help: 'Artifacts in each status. A growing PENDING count is runs dying before confirming their bytes',
      labelNames: ['status'],
      registers: [registry],
    }),
    modelVersions: new Gauge({
      name: `${PREFIX}model_versions`,
      help: 'Registered model versions in each lifecycle state',
      labelNames: ['status'],
      registers: [registry],
    }),

    // ------------------------------------------------------------ GPU
    //
    // Real telemetry from the provider, which on this host can see two RTX 2080 Tis that
    // no container can be given (ADR 0008). Both facts are exported, deliberately:
    // `gpu_utilization_ratio` says what the silicon is doing and `node_gpu_capacity`
    // says what the cluster will grant. On this machine they read 0.99 and 0, and a
    // dashboard showing only one of them would mislead whichever one it chose.
    gpuUtilization: new Gauge({
      name: `${PREFIX}gpu_utilization_ratio`,
      help: 'GPU utilisation, 0..1, as the driver reports it',
      labelNames: ['uuid', 'index', 'model', 'simulated'],
      registers: [registry],
    }),
    gpuMemoryUsed: new Gauge({
      name: `${PREFIX}gpu_memory_used_bytes`,
      help: 'GPU memory in use, as the driver reports it',
      labelNames: ['uuid', 'index', 'model', 'simulated'],
      registers: [registry],
    }),
    gpuMemoryTotal: new Gauge({
      name: `${PREFIX}gpu_memory_total_bytes`,
      help: 'GPU memory installed',
      labelNames: ['uuid', 'index', 'model', 'simulated'],
      registers: [registry],
    }),
    gpuTemperature: new Gauge({
      name: `${PREFIX}gpu_temperature_celsius`,
      help: 'GPU temperature',
      labelNames: ['uuid', 'index', 'model', 'simulated'],
      registers: [registry],
    }),
    gpuPower: new Gauge({
      name: `${PREFIX}gpu_power_watts`,
      help: 'GPU power draw',
      labelNames: ['uuid', 'index', 'model', 'simulated'],
      registers: [registry],
    }),
    gpuHealthy: new Gauge({
      name: `${PREFIX}gpu_healthy`,
      help: '1 when the provider reports the device healthy',
      labelNames: ['uuid', 'index', 'model', 'simulated'],
      registers: [registry],
    }),
    gpuSchedulable: new Gauge({
      name: `${PREFIX}gpu_schedulable`,
      help:
        'GPUs the cluster will actually grant a Pod, summed over nodes. Zero with '
        + 'ashml_gpu_visible above zero means the devices exist and no container can '
        + 'have them (ADR 0008)',
      registers: [registry],
    }),
    gpuVisible: new Gauge({
      name: `${PREFIX}gpu_visible`,
      help: 'GPUs the provider can see on the machine this process runs on',
      registers: [registry],
    }),

    scrapeDuration: new Gauge({
      name: `${PREFIX}scrape_collect_duration_seconds`,
      help: 'How long gathering the snapshot gauges took. A scrape that costs more than it reports is a bug',
      registers: [registry],
    }),
  };

  // Counters whose label vocabulary is known up front are created at zero, for the same
  // reason every state gets a zero gauge: a panel reading "No data" and a panel reading
  // "0 failures" say different things, and only one of them is what an empty
  // `rate(ashml_job_terminations_total{state="FAILED"}[5m])` actually means. Where the
  // vocabulary is not known up front — a deployment's name — nothing is invented.
  for (const state of OUTCOME_STATES) instruments.jobTerminations.inc({ state }, 0);
  for (const outcome of ['launched', 'requeued', 'error']) instruments.jobLaunches.inc({ outcome }, 0);
  for (const outcome of ['ok', 'partial', 'failed']) instruments.executorPasses.inc({ outcome }, 0);
  for (const source of ['database', 'gpu']) instruments.scrapeErrors.inc({ source }, 0);

  return { registry, ...instruments, ...snapshots, _instruments: instruments, _snapshots: snapshots };
}

/**
 * Fills the snapshot gauges from PostgreSQL and the GPU provider.
 *
 * Called on every scrape. Failure of one source must not lose the others: a database
 * that has gone away is exactly when the GPU telemetry and the process metrics are worth
 * having, so each source is isolated and a failure increments `ashml_scrape_errors_total`
 * rather than failing the scrape. The alternative — a 500 — makes Prometheus record the
 * target as down and drop *everything*, including the metrics that were still available
 * and would have said what was wrong.
 */
export async function collectSnapshot(metrics, { pool, gpuProvider, logger = null } = {}) {
  const startedAt = process.hrtime.bigint();

  if (pool) {
    await collectFromDatabase(metrics, pool, logger);
  }
  if (gpuProvider) {
    await collectFromGpuProvider(metrics, gpuProvider, logger);
  }

  metrics.scrapeDuration.set(Number(process.hrtime.bigint() - startedAt) / 1e9);
}

async function collectFromDatabase(metrics, pool, logger) {
  try {
    const [jobs, queue, deployments, replicas, nodes, artifacts, versions] = await Promise.all([
      observabilityRepo.jobsByState(pool, Object.values(JobState)),
      observabilityRepo.queueDepth(pool),
      observabilityRepo.deploymentsByStatus(pool, DEPLOYMENT_STATUSES),
      observabilityRepo.deploymentReplicas(pool),
      observabilityRepo.nodeCapacity(pool, OCCUPYING_STATES),
      observabilityRepo.artifactsByStatus(pool, Object.values(ArtifactStatus)),
      observabilityRepo.modelVersionsByStatus(pool, Object.values(ModelStatus)),
    ]);

    for (const row of jobs) metrics.jobs.set({ state: row.state }, row.count);
    metrics.queueDepth.set(queue.depth);
    metrics.queueOldestSeconds.set(queue.oldest_seconds);

    for (const row of deployments) metrics.deployments.set({ status: row.status }, row.count);

    // Reset first: a deleted deployment must stop reporting, and a gauge nothing sets
    // again keeps its last value for ever. This is the one place where "absent" is the
    // right answer rather than zero — the deployment does not exist, so neither should
    // a series claiming it has zero ready replicas.
    metrics.deploymentReplicasDesired.reset();
    metrics.deploymentReplicasReady.reset();
    for (const row of replicas) {
      const labels = { project: row.project, deployment: row.name };
      metrics.deploymentReplicasDesired.set(labels, row.desired);
      metrics.deploymentReplicasReady.set(labels, row.ready);
    }

    for (const gauge of [
      metrics.nodeReady, metrics.nodeCpuCores, metrics.nodeCpuAllocated,
      metrics.nodeMemoryBytes, metrics.nodeMemoryAllocated,
      metrics.nodeGpuCapacity, metrics.nodeGpuAllocated, metrics.nodeJobs,
    ]) gauge.reset();

    let schedulable = 0;
    for (const node of nodes) {
      const labels = { node: node.name };
      metrics.nodeReady.set(labels, node.ready ? 1 : 0);
      metrics.nodeCpuCores.set(labels, node.cpu_cores);
      metrics.nodeCpuAllocated.set(labels, node.allocated_cpu);
      metrics.nodeMemoryBytes.set(labels, node.memory_bytes);
      metrics.nodeMemoryAllocated.set(labels, node.allocated_memory_bytes);
      metrics.nodeGpuCapacity.set(labels, node.gpu_capacity);
      metrics.nodeGpuAllocated.set(labels, node.allocated_gpu);
      metrics.nodeJobs.set(labels, node.running_jobs);
      // Only ready nodes: capacity on a NotReady node is capacity nothing can be
      // placed onto, and counting it would overstate what the cluster can grant.
      if (node.ready) schedulable += node.gpu_capacity;
    }
    metrics.gpuSchedulable.set(schedulable);

    for (const row of artifacts) metrics.artifacts.set({ status: row.status }, row.count);
    for (const row of versions) metrics.modelVersions.set({ status: row.status }, row.count);
  } catch (err) {
    metrics.scrapeErrors.inc({ source: 'database' });
    logger?.warn?.({ err: err.message }, 'metrics: could not read the database');
  }
}

async function collectFromGpuProvider(metrics, gpuProvider, logger) {
  try {
    const devices = await gpuProvider.discover();

    for (const gauge of [
      metrics.gpuUtilization, metrics.gpuMemoryUsed, metrics.gpuMemoryTotal,
      metrics.gpuTemperature, metrics.gpuPower, metrics.gpuHealthy,
    ]) gauge.reset();

    for (const device of devices) {
      const labels = {
        uuid: device.uuid,
        index: String(device.index),
        model: device.model,
        // Carried as a label rather than dropped, so a panel can filter it out and a
        // panel that forgets to is at least visibly wrong (spec Rule 5).
        simulated: String(Boolean(device.simulated)),
      };
      metrics.gpuUtilization.set(labels, (device.utilization_pct ?? 0) / 100);
      metrics.gpuMemoryUsed.set(labels, device.memory_used_bytes ?? 0);
      metrics.gpuMemoryTotal.set(labels, device.memory_total_bytes ?? 0);
      metrics.gpuHealthy.set(labels, device.health === 'OK' ? 1 : 0);
      // Temperature and power are absent on some devices and from some providers.
      // Reporting a missing reading as 0 would put a cold GPU on the same graph as a
      // GPU that did not answer.
      if (device.temperature_c != null) metrics.gpuTemperature.set(labels, device.temperature_c);
      if (device.power_watts != null) metrics.gpuPower.set(labels, device.power_watts);
    }
    metrics.gpuVisible.set(devices.length);
  } catch (err) {
    metrics.scrapeErrors.inc({ source: 'gpu' });
    logger?.warn?.({ err: err.message }, 'metrics: could not read GPU telemetry');
  }
}

/**
 * Deployment statuses, restated here rather than imported.
 *
 * `services/deployments.js` owns the vocabulary, but importing a service from a metrics
 * module inverts the dependency direction the architecture depends on (routes ->
 * services -> repos). The list is short and its purpose here is only to force a zero
 * series to exist for every status.
 */
const DEPLOYMENT_STATUSES = Object.freeze([
  'PENDING', 'PROGRESSING', 'READY', 'DEGRADED', 'FAILED', 'STOPPED',
]);
