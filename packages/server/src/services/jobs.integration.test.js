/**
 * Integration tests for the job lifecycle against a real PostgreSQL.
 *
 * These cover the Phase 1 exit criteria: submit a job, watch it reach QUEUED,
 * cancel it, and read back the full event history.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { lockNextQueuedJob, queueDepth } from '../repos/jobs.js';
import { claimNextJob, getJobEvents } from './jobs.js';
import { connectOrNull, wipeAll, uniqueName, SKIP_MESSAGE, authenticateAs } from '../test-support/db.js';

const pool = await connectOrNull();

// One pool is shared by every suite in this file, so it is closed once here rather than
// in any single suite's `after` — otherwise the first suite to finish pulls the
// connection out from under the ones that run after it.
after(async () => {
  await pool?.end();
});

describe('job lifecycle (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let project;

  before(async () => {
    const config = loadConfig({ ASHML_GPU_PROVIDER: 'sim', ASHML_VERSION: '0.0.0-test' });
    app = await buildApp(config, { logger: false, pool });
    await app.ready();
    await authenticateAs(app, pool);
  });

  after(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await wipeAll(pool);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('proj'), description: 'integration test' },
    });
    assert.equal(res.statusCode, 201);
    project = res.json();
  });

  /** Submits a minimal valid job and returns the created resource. */
  async function submit(overrides = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: project.name,
        name: uniqueName('job'),
        spec: { image: 'ash/ml-pytorch:latest', command: ['python', 'train.py'] },
        resources: { cpu: 4, gpu: 1 },
        ...overrides,
      },
    });
    return { status: res.statusCode, body: res.json() };
  }

  test('a submitted job lands in QUEUED, not CREATED', async () => {
    const { status, body } = await submit();
    assert.equal(status, 201);
    // Submission creates and queues in one transaction, so a job is never left
    // in CREATED with nobody responsible for advancing it.
    assert.equal(body.state, 'QUEUED');
    assert.ok(body.queued_at, 'queued_at should be stamped on entry to QUEUED');
    assert.equal(body.project, project.name);
  });

  test('submission records both the creation and the queueing event', async () => {
    const { body } = await submit();
    const res = await app.inject({ method: 'GET', url: `/api/v1/jobs/${body.id}/events` });
    const { events } = res.json();

    assert.deepEqual(
      events.map((e) => e.event_type),
      ['JOB_CREATED', 'JOB_QUEUED'],
    );
    assert.equal(events[1].from_state, 'CREATED');
    assert.equal(events[1].to_state, 'QUEUED');
  });

  test('cancelling a queued job passes through CANCELLING', async () => {
    const { body } = await submit();

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${body.id}/cancel`,
      payload: { reason: 'no longer needed' },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().state, 'CANCELLED');
    assert.ok(cancelled.json().finished_at, 'finished_at should be stamped');

    const events = (await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${body.id}/events`,
    })).json().events;

    // The intermediate CANCELLING state must appear in the audit trail even though
    // Phase 1 passes through it immediately — Phase 2 will pause there.
    assert.deepEqual(
      events.map((e) => e.event_type),
      ['JOB_CREATED', 'JOB_QUEUED', 'JOB_CANCELLING', 'JOB_CANCELLED'],
    );
    assert.equal(events[2].message, 'no longer needed');
  });

  test('cancelling twice is a 409, not a second cancellation', async () => {
    const { body } = await submit();
    // Asserted, not fired and forgotten: when this call silently 400s, the second one
    // returns the same 400 and the test below passes for entirely the wrong reason.
    const first = await app.inject({ method: 'POST', url: `/api/v1/jobs/${body.id}/cancel` });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().state, 'CANCELLED');

    const second = await app.inject({ method: 'POST', url: `/api/v1/jobs/${body.id}/cancel` });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error.code, 'ALREADY_CANCELLED');
  });

  test('submitting to a nonexistent project is a 404', async () => {
    const { status, body } = await submit({ project: 'no-such-project' });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  test('a job requesting neither CPU nor GPU is rejected', async () => {
    const { status, body } = await submit({ resources: { cpu: 0, gpu: 0 } });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_RESOURCES');
  });

  test('gpu_memory_min without any GPU is rejected', async () => {
    const { status, body } = await submit({
      resources: { cpu: 4, gpu: 0, gpu_memory_min_bytes: 8 * 1024 ** 3 },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_RESOURCES');
  });

  test('jobs can be filtered by project and state', async () => {
    await submit();
    await submit();

    const all = await app.inject({ method: 'GET', url: `/api/v1/jobs?project=${project.name}` });
    assert.equal(all.json().jobs.length, 2);

    const queued = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs?project=${project.name}&state=QUEUED`,
    });
    assert.equal(queued.json().jobs.length, 2);

    const running = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs?project=${project.name}&state=RUNNING`,
    });
    assert.equal(running.json().jobs.length, 0);
  });

  test('duplicate project names are a 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: project.name },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'PROJECT_EXISTS');
  });

  test('readiness reports the database is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().database, 'ok');
  });
});

describe('job queue (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let project;

  before(async () => {
    const config = loadConfig({ ASHML_GPU_PROVIDER: 'sim' });
    app = await buildApp(config, { logger: false, pool });
    await app.ready();
    await authenticateAs(app, pool);
  });

  after(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await wipeAll(pool);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('queue') },
    });
    project = res.json();
  });

  async function submitWithPriority(priority) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: project.name,
        name: uniqueName('job'),
        priority,
        spec: { image: 'busybox' },
        resources: { cpu: 1 },
      },
    });
    return res.json();
  }

  test('claims jobs by priority, then by arrival', async () => {
    // Submitted low-to-high so arrival order and priority order disagree.
    const low = await submitWithPriority('LOW');
    const mediumFirst = await submitWithPriority('MEDIUM');
    const mediumSecond = await submitWithPriority('MEDIUM');
    const high = await submitWithPriority('HIGH');

    const claimed = [];
    for (let i = 0; i < 4; i += 1) {
      // Each claim in its own transaction, as the scheduler will do. A claim must leave
      // QUEUED, or every iteration returns the same job.
      const job = await claimNextJob(pool);
      claimed.push(job.id);
    }

    assert.deepEqual(claimed, [high.id, mediumFirst.id, mediumSecond.id, low.id]);
  });

  test('a claimed job leaves the queue and records the transition', async () => {
    const job = await submitWithPriority('HIGH');

    const claimed = await claimNextJob(pool, { claimedBy: 'scheduler-1' });
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.state, 'SCHEDULING');

    // Gone from the queue, so a second scheduler finds nothing.
    assert.equal((await queueDepth(pool)).total, 0);
    assert.equal(await claimNextJob(pool), null);

    // The claim is auditable, like every other transition (spec §47).
    const events = await getJobEvents(pool, job.id);
    assert.deepEqual(
      events.map((e) => e.event_type),
      ['JOB_CREATED', 'JOB_QUEUED', 'JOB_SCHEDULING'],
    );
    assert.equal(events.at(-1).message, 'claimed by scheduler-1');
  });

  test('SKIP LOCKED gives concurrent claimers different jobs', async () => {
    const a = await submitWithPriority('MEDIUM');
    const b = await submitWithPriority('MEDIUM');

    // Hold both transactions open simultaneously — this is the exact scenario two
    // scheduler replicas create, and the reason the queue does not need Redis.
    const clientOne = await pool.connect();
    const clientTwo = await pool.connect();
    try {
      await clientOne.query('BEGIN');
      await clientTwo.query('BEGIN');

      const first = await lockNextQueuedJob(clientOne);
      const second = await lockNextQueuedJob(clientTwo);

      assert.ok(first, 'first claimer should get a job');
      assert.ok(second, 'second claimer should get a different job, not block');
      assert.notEqual(first.id, second.id, 'the same job was claimed twice');
      assert.deepEqual([first.id, second.id].sort(), [a.id, b.id].sort());
    } finally {
      await clientOne.query('ROLLBACK');
      await clientTwo.query('ROLLBACK');
      clientOne.release();
      clientTwo.release();
    }
  });

  test('an empty queue yields null rather than blocking', async () => {
    const job = await claimNextJob(pool);
    assert.equal(job, null);
  });

  test('queue depth counts by priority', async () => {
    await submitWithPriority('HIGH');
    await submitWithPriority('LOW');
    await submitWithPriority('LOW');

    const depth = await queueDepth(pool);
    assert.equal(depth.HIGH, 1);
    assert.equal(depth.LOW, 2);
    assert.equal(depth.MEDIUM, 0);
    assert.equal(depth.total, 3);
  });

  test('cancelled jobs leave the queue', async () => {
    const job = await submitWithPriority('HIGH');
    await app.inject({ method: 'POST', url: `/api/v1/jobs/${job.id}/cancel` });

    const depth = await queueDepth(pool);
    assert.equal(depth.total, 0);

    const claimed = await claimNextJob(pool);
    assert.equal(claimed, null);
  });
});
