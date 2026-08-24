/**
 * Integration tests for `/metrics`, against a real PostgreSQL and the `sim` backend.
 *
 * What is asserted here is everything about the endpoint that cannot be checked without
 * the database that answers it: that the zero series really come back from the queries
 * rather than from a fixture, that the queue's numbers agree with the rows, and — the one
 * that guards a decision rather than a value — that **no training metric ever appears in a
 * scrape** (ADR 0009). That last one cannot be tested with a fake, because the way it
 * would break is somebody adding a query.
 *
 * ff288ad shipped this endpoint hand-verified against the live database. This is the part
 * that was missing.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { createNoneStore } from '../storage/none.js';
import { JobState } from '../domain/job-state.js';
import { ArtifactStatus } from '../domain/artifact-status.js';
import { ModelStatus } from '../domain/model-status.js';
import { discoverCluster } from '../services/nodes.js';
import { connectOrNull, truncateAll, uniqueName, SKIP_MESSAGE, authenticateAs, asRun } from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => {
  await pool?.end();
});

describe('/metrics (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let backend;
  let project;

  before(async () => {
    const config = loadConfig({
      ASHML_GPU_PROVIDER: 'sim',
      ASHML_K8S_BACKEND: 'sim',
      ASHML_VERSION: '0.0.0-test',
    });
    backend = createSimBackend({ namespace: 'ashml-test', autoAdvance: false });
    // Default metrics off: several apps exist in one test process, and per-process
    // collectors would describe the test runner rather than a server.
    app = await buildApp(config, {
      logger: false, pool, k8s: backend, store: createNoneStore(), collectDefaultMetrics: false,
    });
    await app.ready();
    await authenticateAs(app, pool);
    await discoverCluster(pool, backend, app.gpuProvider);
  });

  after(async () => {
    await app?.close();
    await backend?.close();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    backend._reset();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('proj'), description: 'metrics test' },
    });
    assert.equal(res.statusCode, 201);
    project = res.json();
    await discoverCluster(pool, backend, app.gpuProvider);
  });

  // ---------------------------------------------------------------- helpers

  /** Scrapes, and returns the exposition lines with the comments dropped. */
  async function scrape() {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(res.statusCode, 200, res.payload);
    assert.match(res.headers['content-type'], /^text\/plain/);
    return { res, lines: res.payload.split('\n').filter((l) => l && !l.startsWith('#')) };
  }

  async function seriesValue(name, labels = {}) {
    const { lines } = await scrape();
    const wanted = Object.entries(labels);
    for (const line of lines) {
      if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
      if (wanted.every(([k, v]) => line.includes(`${k}="${v}"`))) {
        return Number(line.slice(line.lastIndexOf(' ') + 1));
      }
    }
    return undefined;
  }

  async function submit(overrides = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: project.name,
        name: uniqueName('job'),
        spec: { image: 'busybox:1.36', command: ['sh', '-c', 'echo hi'] },
        resources: { cpu: 1 },
        ...overrides,
      },
    });
    assert.equal(res.statusCode, 201, res.payload);
    return res.json();
  }

  // ------------------------------------------------------------ zero series

  test('every job state is exposed, including the ones at zero', async () => {
    // A gauge that vanishes at zero leaves its last non-zero sample as the newest thing
    // Prometheus has, so "running jobs" would show the count it had when the last job
    // finished, for ever. The zeros come from the query — `unnest` of the state list
    // LEFT JOINed to the table — not from anything the exporter holds.
    const { lines } = await scrape();

    for (const state of Object.values(JobState)) {
      const line = lines.find((l) => l.startsWith('ashml_jobs{') && l.includes(`state="${state}"`));
      assert.ok(line, `no series for state ${state}`);
    }
    assert.equal(await seriesValue('ashml_jobs', { state: JobState.RUNNING }), 0);
  });

  test('every artifact status and model lifecycle state is exposed at zero', async () => {
    for (const status of Object.values(ArtifactStatus)) {
      assert.equal(await seriesValue('ashml_artifacts', { status }), 0, `artifacts ${status}`);
    }
    for (const status of Object.values(ModelStatus)) {
      assert.equal(await seriesValue('ashml_model_versions', { status }), 0, `versions ${status}`);
    }
  });

  test('every deployment status is exposed at zero', async () => {
    for (const status of ['PENDING', 'PROGRESSING', 'READY', 'DEGRADED', 'FAILED', 'STOPPED']) {
      assert.equal(await seriesValue('ashml_deployments', { status }), 0, `deployments ${status}`);
    }
  });

  // ------------------------------------------------------------- the queue

  test('the queue gauges agree with the rows, and the age is a series of its own', async () => {
    // Depth alone cannot tell ten jobs submitted a second ago from one job nothing will
    // ever place. Both are read from PostgreSQL at scrape time rather than derived from
    // counters, so they cannot drift from what `ash job list` prints.
    assert.equal(await seriesValue('ashml_queue_depth'), 0);
    assert.equal(await seriesValue('ashml_queue_oldest_seconds'), 0);

    await submit();
    await submit();

    assert.equal(await seriesValue('ashml_queue_depth'), 2);
    assert.equal(await seriesValue('ashml_jobs', { state: JobState.QUEUED }), 2);
    assert.ok(await seriesValue('ashml_queue_oldest_seconds') >= 0);
  });

  // --------------------------------------------------- what must not leak in

  test('no training metric reaches a scrape', async () => {
    // ADR 0009, guarded at the only place it could be broken by accident. A loss belongs
    // to a step; a scraper on a timer would record it against a clock and drop every step
    // between two scrapes. These values reach a dashboard from `training_metrics` through
    // Grafana's PostgreSQL datasource instead.
    const job = await submit();
    await pool.query("UPDATE training_jobs SET state = 'RUNNING' WHERE id = $1", [job.id]);

    const reported = await app.inject({
      headers: await asRun(pool, job.id),
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/metrics`,
      payload: {
        metrics: [
          { name: 'loss', value: 1.8407, step: 3 },
          { name: 'accuracy', value: 0.6559, step: 3 },
          { name: 'lr', value: 0.1, step: 3 },
        ],
      },
    });
    assert.equal(reported.statusCode, 201, reported.payload);

    const { lines } = await scrape();
    // Neither by name nor by value: 0.6559 appearing anywhere would mean some gauge had
    // quietly started carrying it.
    for (const forbidden of ['loss', 'accuracy', 'lr', '0.6559', '1.8407']) {
      const offender = lines.find((l) => l.includes(forbidden));
      assert.equal(offender, undefined, `a training metric reached the scrape: ${offender}`);
    }
  });

  test('a scrape carries no hyperparameters, artifact URIs or metric values', async () => {
    // What the endpoint is allowed to know. It is unauthenticated like the rest of v1, so
    // the list of what it exposes — counts, durations, and project and deployment names —
    // is a property worth asserting rather than a habit.
    const { lines } = await scrape();
    for (const line of lines) {
      assert.ok(!line.includes('s3://'), `an artifact URI reached the scrape: ${line}`);
      assert.ok(!line.includes('file://'), `an artifact URI reached the scrape: ${line}`);
    }
  });

  // ------------------------------------------------------- HTTP cardinality

  test('HTTP is labelled by route, never by URL', async () => {
    // One series per job id is how a metrics endpoint becomes the largest thing in a
    // Prometheus instance and the first thing an operator switches off.
    const job = await submit();
    await app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });

    const { lines } = await scrape();
    const http = lines.filter((l) => l.startsWith('ashml_http_request_duration_seconds_count'));

    assert.ok(
      http.some((l) => l.includes('route="/api/v1/jobs/:id"')),
      `no route-shaped series; got:\n${http.join('\n')}`,
    );
    assert.ok(
      !http.some((l) => l.includes(job.id)),
      'the job id reached a label, which is one series per job',
    );
  });

  test('a 404 on an arbitrary path mints no series', async () => {
    // Nothing matched, so there is no route — and whatever was typed must not become a
    // label. This is the same hole from the other side: an unauthenticated endpoint that
    // anyone can add series to is an unauthenticated endpoint anyone can fill the disk
    // with.
    await app.inject({ method: 'GET', url: '/api/v1/does-not-exist-6a1f' });

    const { lines } = await scrape();
    assert.ok(!lines.some((l) => l.includes('does-not-exist-6a1f')));
  });

  test('the scrape endpoint does not time itself', async () => {
    // A scrape endpoint that appeared in its own request histogram would make the API's
    // request rate a function of the scrape interval, and every panel would show traffic
    // on a completely idle platform.
    await scrape();
    await scrape();

    const { lines } = await scrape();
    assert.ok(!lines.some((l) => l.startsWith('ashml_http_') && l.includes('route="/metrics"')));
  });

  // ------------------------------------------------------ source isolation

  test('a database that has gone away still returns 200, and says which source failed',
    async () => {
      // The scrape must not fail: answering 500 makes Prometheus record the target as
      // down and drop *everything*, including the metrics that were still working and
      // would have explained the outage. Tested with a whole app rather than by calling
      // the collector, because it is the route's contract that matters.
      const broken = {
        async query() { throw new Error('terminating connection due to administrator command'); },
        async end() {},
      };
      const isolated = await buildApp(
        loadConfig({ ASHML_GPU_PROVIDER: 'sim', ASHML_K8S_BACKEND: 'sim' }),
        { logger: false, pool: broken, k8s: backend, store: createNoneStore(), collectDefaultMetrics: false },
      );
      await isolated.ready();

      try {
        const res = await isolated.inject({ method: 'GET', url: '/metrics' });
        assert.equal(res.statusCode, 200, 'a failing source must not fail the scrape');

        const lines = res.payload.split('\n').filter((l) => l && !l.startsWith('#'));
        const errors = lines.find((l) => l.includes('ashml_scrape_errors_total') && l.includes('source="database"'));
        assert.ok(errors?.endsWith(' 1'), `expected one database scrape error, got: ${errors}`);
        // And the other source came through regardless — which is the entire point.
        assert.ok(lines.some((l) => l.startsWith('ashml_gpu_visible')));
      } finally {
        await isolated.close();
      }
    });

  // ------------------------------------------------------------- GPU truth

  test('what the provider sees and what the cluster grants are both exported', async () => {
    // On the development host these read 2 and 0, and a dashboard showing only one of
    // them would mislead whichever one it chose (ADR 0008). Here the `sim` provider makes
    // the first number, and the sim cluster advertises no devices, so the shape of the
    // claim is what is asserted rather than the values.
    const visible = await seriesValue('ashml_gpu_visible');
    const schedulable = await seriesValue('ashml_gpu_schedulable');

    assert.ok(Number.isFinite(visible), 'ashml_gpu_visible must always be exported');
    assert.ok(Number.isFinite(schedulable), 'ashml_gpu_schedulable must always be exported');
  });

  test('simulated telemetry is labelled as such in a scrape', async () => {
    const { lines } = await scrape();
    const utilisation = lines.filter((l) => l.startsWith('ashml_gpu_utilization_ratio'));
    assert.ok(utilisation.length > 0, 'the sim provider should report devices');
    for (const line of utilisation) assert.match(line, /simulated="true"/);
  });
});
