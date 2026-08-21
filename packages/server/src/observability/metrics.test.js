/**
 * Unit tests for the metric registry and the snapshot collector.
 *
 * These are the parts of `/metrics` that must hold whatever the database and the cluster
 * are doing, so they are tested against fixtures rather than against either. The point of
 * most of them is a *wrong graph* that would otherwise be drawn quietly: a gauge that kept
 * its last value after the thing it described disappeared, a temperature of 0 °C for a
 * device that did not answer, a scrape that returned 500 and took the working metrics down
 * with the broken ones.
 *
 * The behaviour that needs a real database — every state present at zero, route labelling,
 * the absence of training metrics — is in `metrics.integration.test.js`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMetrics, collectSnapshot } from './metrics.js';
import { JobState, OUTCOME_STATES } from '../domain/job-state.js';

/**
 * A pool that answers the collector's queries from canned rows.
 *
 * Matched on a fragment of each statement rather than on call order, so a change to the
 * order the collector issues them in does not silently start feeding node rows to the
 * artifact gauge.
 */
function fakePool(overrides = {}) {
  const answers = {
    'LEFT JOIN training_jobs j ON j.state': [{ state: JobState.RUNNING, count: 2 }],
    oldest_seconds: [{ depth: 0, oldest_seconds: 0 }],
    'LEFT JOIN deployments d ON d.status': [{ status: 'READY', count: 1 }],
    'd.ready_replicas::int AS ready': [],
    'FROM compute_nodes n': [],
    'LEFT JOIN artifacts a ON a.status': [{ status: 'READY', count: 3 }],
    'LEFT JOIN model_versions v ON v.status': [{ status: 'PRODUCTION', count: 1 }],
    ...overrides,
  };

  return {
    async query(sql) {
      for (const [fragment, rows] of Object.entries(answers)) {
        if (sql.includes(fragment)) {
          if (rows instanceof Error) throw rows;
          return { rows };
        }
      }
      throw new Error(`fakePool: no fixture for ${sql.slice(0, 60)}`);
    },
  };
}

function node(name, extra = {}) {
  return {
    name,
    ready: true,
    cpu_cores: 8,
    memory_bytes: 34_359_738_368,
    gpu_capacity: 0,
    allocated_cpu: 0,
    allocated_memory_bytes: 0,
    allocated_gpu: 0,
    running_jobs: 0,
    ...extra,
  };
}

function device(extra = {}) {
  return {
    uuid: 'GPU-0000',
    index: 0,
    model: 'NVIDIA GeForce RTX 2080 Ti',
    utilization_pct: 25,
    memory_used_bytes: 1024,
    memory_total_bytes: 11_811_160_064,
    temperature_c: 41,
    power_watts: 62,
    health: 'OK',
    ...extra,
  };
}

const gpuProvider = (devices) => ({ async discover() { return devices; } });

/** Every exposed line, as `{name{labels} value}` strings. */
async function scrape(metrics) {
  const text = await metrics.registry.metrics();
  return text.split('\n').filter((line) => line && !line.startsWith('#'));
}

/** The value of one series, or undefined if it is not exposed at all. */
async function valueOf(metrics, name, labels = {}) {
  const lines = await scrape(metrics);
  const wanted = Object.entries(labels);
  for (const line of lines) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    if (wanted.every(([k, v]) => line.includes(`${k}="${v}"`))) {
      return Number(line.slice(line.lastIndexOf(' ') + 1));
    }
  }
  return undefined;
}

describe('the metric registry', () => {
  test('counters with a known vocabulary exist at zero', async () => {
    // A panel reading "No data" and a panel reading "0 failures" say different things,
    // and only one of them is what an empty rate() over an absent counter means.
    const metrics = createMetrics({ collectDefaults: false });

    for (const state of OUTCOME_STATES) {
      assert.equal(await valueOf(metrics, 'ashml_job_terminations_total', { state }), 0);
    }
    for (const outcome of ['launched', 'requeued', 'error']) {
      assert.equal(await valueOf(metrics, 'ashml_job_launches_total', { outcome }), 0);
    }
    for (const source of ['database', 'gpu']) {
      assert.equal(await valueOf(metrics, 'ashml_scrape_errors_total', { source }), 0);
    }
  });

  test('nothing is invented for a vocabulary that is not known up front', async () => {
    // Deployment and project names come from users. Pre-creating series for them is not
    // possible and pretending otherwise would be worse than the gap.
    const metrics = createMetrics({ collectDefaults: false });
    const lines = await scrape(metrics);
    assert.ok(!lines.some((l) => l.startsWith('ashml_prediction_')));
  });
});

describe('collecting the snapshot', () => {
  test('a database that has gone away does not take the GPU metrics with it', async () => {
    // The whole argument for isolating sources. A 500 here makes Prometheus mark the
    // target down and drop *everything* — including the metrics that were still
    // available and would have said what was wrong.
    const metrics = createMetrics({ collectDefaults: false });
    const pool = { async query() { throw new Error('connection terminated'); } };

    await collectSnapshot(metrics, { pool, gpuProvider: gpuProvider([device()]) });

    assert.equal(await valueOf(metrics, 'ashml_scrape_errors_total', { source: 'database' }), 1);
    assert.equal(await valueOf(metrics, 'ashml_scrape_errors_total', { source: 'gpu' }), 0);
    assert.equal(await valueOf(metrics, 'ashml_gpu_visible'), 1);
  });

  test('a GPU provider that throws does not take the database metrics with it', async () => {
    const metrics = createMetrics({ collectDefaults: false });
    const provider = { async discover() { throw new Error('nvidia-smi not found'); } };

    await collectSnapshot(metrics, { pool: fakePool(), gpuProvider: provider });

    assert.equal(await valueOf(metrics, 'ashml_scrape_errors_total', { source: 'gpu' }), 1);
    assert.equal(await valueOf(metrics, 'ashml_scrape_errors_total', { source: 'database' }), 0);
    assert.equal(await valueOf(metrics, 'ashml_jobs', { state: JobState.RUNNING }), 2);
  });

  test('a failing source is reported rather than thrown', async () => {
    // The route depends on this: `collectSnapshot` rejecting would make the handler
    // answer 500, which is the outcome the isolation exists to avoid.
    const metrics = createMetrics({ collectDefaults: false });
    await assert.doesNotReject(collectSnapshot(metrics, {
      pool: { async query() { throw new Error('nope'); } },
      gpuProvider: { async discover() { throw new Error('nope'); } },
    }));
  });

  test('a deployment that goes away stops reporting, rather than freezing', async () => {
    // The one place absence is the right answer rather than zero: the deployment does not
    // exist, so neither should a series claiming it has zero ready replicas. Without the
    // reset the gauge keeps its last value for ever.
    const metrics = createMetrics({ collectDefaults: false });
    const replicas = [{ project: 'vision', name: 'resnet', desired: 2, ready: 2 }];
    const pool = fakePool({ 'd.ready_replicas::int AS ready': replicas });

    await collectSnapshot(metrics, { pool });
    assert.equal(
      await valueOf(metrics, 'ashml_deployment_replicas_ready', { deployment: 'resnet' }), 2,
    );

    await collectSnapshot(metrics, { pool: fakePool() });
    assert.equal(
      await valueOf(metrics, 'ashml_deployment_replicas_ready', { deployment: 'resnet' }),
      undefined,
    );
  });

  test('only ready nodes contribute schedulable GPUs', async () => {
    // Capacity on a NotReady node is capacity nothing can be placed onto. Counting it
    // would overstate what the cluster can actually grant, which is the number the
    // dashboard puts next to what the driver can see.
    const metrics = createMetrics({ collectDefaults: false });
    const nodes = [
      node('up', { gpu_capacity: 2 }),
      node('down', { gpu_capacity: 4, ready: false }),
    ];

    await collectSnapshot(metrics, { pool: fakePool({ 'FROM compute_nodes n': nodes }) });

    assert.equal(await valueOf(metrics, 'ashml_gpu_schedulable'), 2);
    assert.equal(await valueOf(metrics, 'ashml_node_ready', { node: 'down' }), 0);
  });
});

describe('GPU telemetry', () => {
  test('utilisation is a ratio, not a percentage', async () => {
    const metrics = createMetrics({ collectDefaults: false });
    await collectSnapshot(metrics, { gpuProvider: gpuProvider([device({ utilization_pct: 25 })]) });
    assert.equal(await valueOf(metrics, 'ashml_gpu_utilization_ratio', { index: '0' }), 0.25);
  });

  test('a missing temperature is absent, not zero', async () => {
    // A cold GPU and a GPU that did not answer must not share a graph, and 0 °C is a
    // perfectly plausible reading in the wrong climate.
    const metrics = createMetrics({ collectDefaults: false });
    await collectSnapshot(metrics, {
      gpuProvider: gpuProvider([device({ temperature_c: null, power_watts: null })]),
    });

    assert.equal(await valueOf(metrics, 'ashml_gpu_temperature_celsius', { index: '0' }), undefined);
    assert.equal(await valueOf(metrics, 'ashml_gpu_power_watts', { index: '0' }), undefined);
    // The device itself is still reported; it is the two readings that are missing.
    assert.equal(await valueOf(metrics, 'ashml_gpu_healthy', { index: '0' }), 1);
  });

  test('fabricated telemetry says so on every series it appears in', async () => {
    // Rule 5. Carried as a label rather than dropped, so a panel can filter it out and a
    // panel that forgets to is at least visibly wrong.
    const metrics = createMetrics({ collectDefaults: false });
    await collectSnapshot(metrics, { gpuProvider: gpuProvider([device({ simulated: true })]) });

    const gpuLines = (await scrape(metrics)).filter((l) => l.startsWith('ashml_gpu_utilization'));
    assert.equal(gpuLines.length, 1);
    assert.match(gpuLines[0], /simulated="true"/);
  });

  test('a device that vanishes stops being reported', async () => {
    const metrics = createMetrics({ collectDefaults: false });
    await collectSnapshot(metrics, { gpuProvider: gpuProvider([device(), device({ uuid: 'GPU-1', index: 1 })]) });
    assert.equal(await valueOf(metrics, 'ashml_gpu_visible'), 2);

    await collectSnapshot(metrics, { gpuProvider: gpuProvider([device()]) });
    assert.equal(await valueOf(metrics, 'ashml_gpu_visible'), 1);
    assert.equal(await valueOf(metrics, 'ashml_gpu_healthy', { uuid: 'GPU-1' }), undefined);
  });

  test('an unhealthy device is reported, not omitted', async () => {
    const metrics = createMetrics({ collectDefaults: false });
    await collectSnapshot(metrics, { gpuProvider: gpuProvider([device({ health: 'ERR' })]) });
    assert.equal(await valueOf(metrics, 'ashml_gpu_healthy', { index: '0' }), 0);
  });
});

describe('what a scrape costs', () => {
  test('the collector times itself', async () => {
    // A scrape that costs more than it reports is a bug, on a platform whose scheduler
    // needs the capacity. This is the series that would show it.
    const metrics = createMetrics({ collectDefaults: false });
    await collectSnapshot(metrics, { pool: fakePool() });
    const seconds = await valueOf(metrics, 'ashml_scrape_collect_duration_seconds');
    assert.ok(seconds >= 0 && seconds < 5, `implausible collect duration: ${seconds}`);
  });
});
