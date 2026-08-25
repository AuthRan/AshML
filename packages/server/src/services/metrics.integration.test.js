/**
 * Integration tests for metric ingest and read-back, against a real PostgreSQL and the
 * `sim` execution backend.
 *
 * The database is real because most of what is asserted here is what Postgres does with
 * the batch: ordering, the timestamps actually stored, and the experiment id copied onto
 * every row. The cluster is simulated because these tests need a job in RUNNING on
 * demand, which a real Pod cannot be asked for.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { Phase } from '../k8s/backend.js';
import { JobState } from '../domain/job-state.js';
import { runOnce } from './executor.js';
import { discoverCluster } from './nodes.js';
import { getJob } from './jobs.js';
import { connectOrNull, wipeAll, uniqueName, SKIP_MESSAGE, authenticateAs, asRun } from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => {
  await pool?.end();
});

describe('training metrics (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let backend;
  let project;
  /** jobId -> run-token headers, so a job reports with one identity throughout. */
  const runHeaders = new Map();

  before(async () => {
    const config = loadConfig({
      ASHML_GPU_PROVIDER: 'sim',
      ASHML_K8S_BACKEND: 'sim',
      ASHML_VERSION: '0.0.0-test',
    });
    backend = createSimBackend({ namespace: 'ashml-test', autoAdvance: false });
    app = await buildApp(config, { logger: false, pool, k8s: backend });
    await app.ready();
    await authenticateAs(app, pool);
    await discoverCluster(pool, backend, app.gpuProvider);
  });

  after(async () => {
    await app?.close();
    await backend?.close();
  });

  beforeEach(async () => {
    await wipeAll(pool);
    runHeaders.clear();
    backend._reset();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('proj'), description: 'metrics test' },
    });
    assert.equal(res.statusCode, 201);
    project = res.json();
  });

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

  async function createExperiment() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/experiments',
      payload: { project: project.name, name: 'resnet-baseline' },
    });
    assert.equal(res.statusCode, 201, res.payload);
    return res.json();
  }

  /** Drives a submitted job to RUNNING, which is where a run reports from. */
  async function runToRunning(job) {
    await runOnce(pool, backend);
    const launched = await getJob(pool, job.id);
    assert.equal(launched.state, JobState.STARTING, 'setup: the job should have launched');
    backend._setPhase('ashml-test', launched.k8s_job_name, Phase.RUNNING);
    await runOnce(pool, backend);
    assert.equal((await getJob(pool, job.id)).state, JobState.RUNNING, 'setup: expected RUNNING');
    return launched;
  }

  /**
   * Reports as the run itself.
   *
   * Metric ingest is reachable only by the job that produced the numbers — not by a
   * person, however privileged (ADR 0013) — so this holds a run token. Cached per job
   * because minting a second one revokes the first, which is what a retry does and not
   * what a test reporting twice means.
   */
  async function report(jobId, metrics, { as = 'run' } = {}) {
    // `as: 'user'` is for the cases where no run token can exist — an id that names no
    // job. There is nothing to mint against, and the answer under test is the 404 that
    // comes before any permission is considered.
    if (as === 'user') {
      return app.inject({
        method: 'POST', url: `/api/v1/jobs/${jobId}/metrics`, payload: { metrics },
      });
    }
    if (!runHeaders.has(jobId)) runHeaders.set(jobId, await asRun(pool, jobId));
    return app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/metrics`,
      payload: { metrics },
      headers: runHeaders.get(jobId),
    });
  }

  function readSeries(jobId, query = '') {
    return app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}/metrics${query}` });
  }

  test('a running job records a batch and reads it back as a series', async () => {
    const job = await submit();
    await runToRunning(job);

    const res = await report(job.id, [
      { name: 'loss', value: 2.31, step: 0 },
      { name: 'loss', value: 1.84, step: 1 },
      { name: 'accuracy', value: 0.41, step: 1, epoch: 0 },
    ]);
    assert.equal(res.statusCode, 201, res.payload);
    assert.equal(res.json().written, 3);

    const series = readSeries(job.id);
    const body = (await series).json();
    assert.deepEqual(body.series.map((s) => s.name), ['accuracy', 'loss']);

    const loss = body.series.find((s) => s.name === 'loss');
    assert.deepEqual(loss.points.map((p) => p.step), [0, 1]);
    assert.deepEqual(loss.points.map((p) => p.value), [2.31, 1.84]);

    const accuracy = body.series.find((s) => s.name === 'accuracy');
    assert.equal(accuracy.points[0].epoch, 0, 'epoch is optional but kept when given');
    assert.equal(loss.points[0].epoch, null, 'a metric without an epoch stores null');
  });

  test('a job that has not launched cannot have produced metrics', async () => {
    const job = await submit();
    assert.equal((await getJob(pool, job.id)).state, JobState.QUEUED);

    const res = await report(job.id, [{ name: 'loss', value: 1, step: 0 }]);
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error.code, 'JOB_NOT_STARTED');

    // And nothing was written on the way to refusing.
    const body = (await readSeries(job.id)).json();
    assert.deepEqual(body.series, []);
  });

  test('a finished run may still flush its metrics', async () => {
    const job = await submit();
    const launched = await runToRunning(job);
    backend._setPhase('ashml-test', launched.k8s_job_name, Phase.SUCCEEDED);
    await runOnce(pool, backend);
    assert.equal((await getJob(pool, job.id)).state, JobState.SUCCEEDED);

    // A training loop that buffers its metrics flushes them at the end — after the pod
    // is gone. Refusing this would throw away the whole run's history.
    const res = await report(job.id, [{ name: 'loss', value: 0.4, step: 99 }]);
    assert.equal(res.statusCode, 201, res.payload);
  });

  test('metrics for an unknown job are a 404', async () => {
    const res = await report(
      '00000000-0000-0000-0000-000000000000',
      [{ name: 'loss', value: 1, step: 0 }],
      { as: 'user' },
    );
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
  });

  test('the time the run observed a value survives a batched flush', async () => {
    const job = await submit();
    await runToRunning(job);

    // The whole reason `recorded_at` is a column: this run produced its points over a
    // minute and flushed them in one request. If the API stamped receipt time, all
    // three would collapse onto the same instant and the curve would lose its shape.
    const observed = [
      '2026-08-19T10:00:00.000Z',
      '2026-08-19T10:00:30.000Z',
      '2026-08-19T10:01:00.000Z',
    ];
    const res = await report(job.id, observed.map((recorded_at, step) => ({
      name: 'loss', value: 1 / (step + 1), step, recorded_at,
    })));
    assert.equal(res.statusCode, 201, res.payload);

    const body = (await readSeries(job.id)).json();
    assert.deepEqual(
      body.series[0].points.map((p) => new Date(p.recorded_at).toISOString()),
      observed,
    );
  });

  test('a run that does not timestamp its metrics gets receipt time', async () => {
    const job = await submit();
    await runToRunning(job);

    const before = Date.now();
    assert.equal((await report(job.id, [{ name: 'loss', value: 1, step: 0 }])).statusCode, 201);

    const body = (await readSeries(job.id)).json();
    const recorded = new Date(body.series[0].points[0].recorded_at).getTime();
    // Clock skew between this process and Postgres makes an exact bound wrong; a
    // generous window still proves the column was filled rather than left null.
    assert.ok(recorded >= before - 60_000 && recorded <= Date.now() + 60_000,
      `recorded_at ${body.series[0].points[0].recorded_at} should be around now`);
  });

  test('metrics are append-only: the same step twice records both points', async () => {
    const job = await submit();
    await runToRunning(job);

    assert.equal((await report(job.id, [{ name: 'loss', value: 2.0, step: 5 }])).statusCode, 201);
    assert.equal((await report(job.id, [{ name: 'loss', value: 1.5, step: 5 }])).statusCode, 201);

    const body = (await readSeries(job.id)).json();
    // A run reporting a step twice has done something worth seeing. Overwriting would
    // hide it and leave a curve that looks clean.
    assert.deepEqual(body.series[0].points.map((p) => p.value), [2.0, 1.5]);
  });

  test('name and since_step narrow the read', async () => {
    const job = await submit();
    await runToRunning(job);
    await report(job.id, [
      { name: 'loss', value: 2, step: 0 },
      { name: 'loss', value: 1, step: 1 },
      { name: 'lr', value: 0.1, step: 0 },
    ]);

    const byName = (await readSeries(job.id, '?name=loss')).json();
    assert.deepEqual(byName.series.map((s) => s.name), ['loss']);

    // What a client polling a live run sends: everything after what it already has.
    const tail = (await readSeries(job.id, '?name=loss&since_step=0')).json();
    assert.deepEqual(tail.series[0].points.map((p) => p.step), [1]);
  });

  test('the summary gives the latest value per metric without the series', async () => {
    const job = await submit();
    await runToRunning(job);
    await report(job.id, [
      { name: 'loss', value: 2.0, step: 0 },
      { name: 'loss', value: 0.5, step: 10 },
      { name: 'accuracy', value: 0.9, step: 10 },
    ]);

    const res = await app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}/metrics/summary` });
    assert.equal(res.statusCode, 200, res.payload);
    const byName = Object.fromEntries(res.json().metrics.map((m) => [m.name, m]));

    assert.equal(byName.loss.count, 2);
    assert.equal(byName.loss.first_step, 0);
    assert.equal(byName.loss.last_step, 10);
    assert.equal(byName.loss.last_value, 0.5, 'last means highest step, not first written');
    assert.equal(byName.accuracy.count, 1);
  });

  describe('experiment attribution', () => {
    test('the experiment is taken from the job, not from the reporter', async () => {
      const experiment = await createExperiment();
      const job = await submit({ experiment: experiment.id });
      await runToRunning(job);

      const res = await report(job.id, [{ name: 'loss', value: 1, step: 0 }]);
      assert.equal(res.json().experiment_id, experiment.id);

      const rolled = await app.inject({
        method: 'GET',
        url: `/api/v1/experiments/${experiment.id}/metrics`,
      });
      assert.equal(rolled.statusCode, 200, rolled.payload);
      assert.equal(rolled.json().series.length, 1);
      assert.equal(rolled.json().series[0].job_id, job.id);
    });

    test('two runs of one experiment stay separate series', async () => {
      const experiment = await createExperiment();

      const first = await submit({ experiment: experiment.id });
      await runToRunning(first);
      await report(first.id, [
        { name: 'loss', value: 2.0, step: 0 },
        { name: 'loss', value: 1.0, step: 1 },
      ]);

      const second = await submit({ experiment: experiment.id });
      await runToRunning(second);
      await report(second.id, [
        { name: 'loss', value: 1.9, step: 0 },
        { name: 'loss', value: 0.8, step: 1 },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/experiments/${experiment.id}/metrics?name=loss`,
      });
      const { series } = res.json();

      // Both runs report `loss` from step 0. Merged, they would draw a curve that goes
      // 2.0, 1.9, 1.0, 0.8 — a run that never happened.
      assert.equal(series.length, 2, 'one series per run, not one merged series');
      assert.deepEqual([...new Set(series.map((s) => s.job_id))].sort(), [first.id, second.id].sort());
      for (const s of series) {
        assert.deepEqual(s.points.map((p) => p.step), [0, 1]);
      }
    });

    test('a job with no experiment records metrics that no experiment rolls up', async () => {
      const job = await submit();
      await runToRunning(job);

      const res = await report(job.id, [{ name: 'loss', value: 1, step: 0 }]);
      assert.equal(res.json().experiment_id, null);
      // Still readable by job — the metrics are not lost, they are just not comparable.
      assert.equal((await readSeries(job.id)).json().series.length, 1);
    });

    test('metrics for an unknown experiment are a 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/experiments/00000000-0000-0000-0000-000000000000/metrics',
      });
      assert.equal(res.statusCode, 404);
    });
  });

  test('an empty batch is refused by the schema', async () => {
    const job = await submit();
    await runToRunning(job);
    const res = await report(job.id, []);
    assert.equal(res.statusCode, 400, 'minItems: 1 — an empty report is a caller bug');
  });
});
