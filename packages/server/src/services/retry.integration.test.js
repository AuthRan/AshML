/**
 * Integration tests for the retry driver.
 *
 * The policy itself is unit-tested in `domain/retry-policy.test.js`. What is tested here
 * is the part that needs a real database: that a retry walks the state machine properly,
 * that the budget cannot be overspent, that a refusal is recorded once rather than
 * reconsidered forever, and that the next attempt is handed the checkpoint the last one
 * produced.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { createNoneStore } from '../storage/none.js';
import { Phase } from '../k8s/backend.js';
import { JobState } from '../domain/job-state.js';
import { RetryDecision } from '../domain/retry-policy.js';
import { buildJobManifest } from '../k8s/manifest.js';
import { reconcileJob, runOnce } from './executor.js';
import { discoverCluster } from './nodes.js';
import { considerRetry, getJob } from './jobs.js';
import { connectOrNull, wipeAll, uniqueName, SKIP_MESSAGE, authenticateAs, asRun } from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => {
  await pool?.end();
});

describe('retry driver (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let backend;
  let project;
  const runHeaders = new Map();

  /** Producing an artifact is the run's act, not a person's (ADR 0013). */
  async function asJob(jobId) {
    if (!runHeaders.has(jobId)) runHeaders.set(jobId, await asRun(pool, jobId));
    return runHeaders.get(jobId);
  }

  before(async () => {
    const config = loadConfig({
      ASHML_GPU_PROVIDER: 'sim',
      ASHML_K8S_BACKEND: 'sim',
      ASHML_VERSION: '0.0.0-test',
    });
    backend = createSimBackend({ namespace: 'ashml-test', autoAdvance: false });
    app = await buildApp(config, { logger: false, pool, k8s: backend, store: createNoneStore() });
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
      payload: { name: uniqueName('proj'), description: 'retry test' },
    });
    assert.equal(res.statusCode, 201);
    project = res.json();
  });

  // ------------------------------------------------------------- fixtures

  /** Submits a job and drives it to RUNNING. */
  async function runningJob({ maxRetries = 2 } = {}) {
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: project.name,
        name: uniqueName('job'),
        spec: { image: 'busybox:1.36', command: ['sh', '-c', 'true'] },
        resources: { cpu: 1 },
        max_retries: maxRetries,
      },
    });
    assert.equal(submitted.statusCode, 201, submitted.payload);
    const job = submitted.json();

    await runOnce(pool, backend);
    const launched = await getJob(pool, job.id);
    assert.equal(launched.state, JobState.STARTING, 'setup: should have launched');
    backend._setPhase('ashml-test', launched.k8s_job_name, Phase.RUNNING);
    await runOnce(pool, backend);
    return getJob(pool, job.id);
  }

  /**
   * Drives a running job to FAILED, leaving the retry decision unmade.
   *
   * Reconciles the one job rather than running a full pass, because a full pass also
   * rules on the failure *and* relaunches the result — which is the intended behaviour
   * and is asserted separately below, but makes it impossible to observe the requeued
   * state in between.
   */
  async function failJob(job, reason = 'container exited 1 (Error)') {
    backend._setPhase('ashml-test', job.k8s_job_name, Phase.FAILED, reason);
    await reconcileJob(pool, backend, await getJob(pool, job.id));
    return getJob(pool, job.id);
  }

  /** A READY checkpoint attached to a job, as a training run would have produced. */
  async function checkpoint(job, { step = 100, name = 'epoch-1.pt' } = {}) {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/artifacts`,
      headers: await asJob(job.id),
      payload: { kind: 'checkpoint', name, uri: `file:///ckpt/${name}`, step },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const artifact = created.json().artifact;

    const done = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifact.id}/complete`,
      headers: await asJob(job.id),
      payload: { digest: 'sha256:abc', size_bytes: 1024 },
    });
    assert.equal(done.statusCode, 200, done.payload);
    return done.json();
  }

  // ---------------------------------------------------------------- tests

  test('a retryable failure inside budget goes back to the queue as a new attempt', async () => {
    const job = await runningJob({ maxRetries: 2 });
    const failed = await failJob(job);
    assert.equal(failed.state, JobState.FAILED);

    const outcome = await considerRetry(pool, job.id);
    assert.equal(outcome.applied, true);

    const after = await getJob(pool, job.id);
    assert.equal(after.state, JobState.QUEUED);
    assert.equal(after.attempt, 1, 'the attempt number should have advanced');
    // No final verdict is recorded for a retry: only a refusal is final, and marking a
    // retry decided would keep the *next* failure out of the driver's sweep.
    assert.equal(after.retry.decision, null);
    // Everything describing the failed attempt is cleared; the event log keeps it.
    assert.equal(after.failure_reason, null);
    assert.equal(after.k8s_job_name, null);
    assert.equal(after.placement.node_id, null);
  });

  test('one executor pass both requeues a failure and relaunches it', async () => {
    // The retry driver sits between reconciling and launching precisely so a job that
    // died on a lost node is back in flight within a single tick rather than waiting a
    // whole interval to be picked up.
    const job = await runningJob({ maxRetries: 2 });
    backend._setPhase('ashml-test', job.k8s_job_name, Phase.FAILED, 'container exited 1 (Error)');

    const summary = await runOnce(pool, backend);
    assert.equal(summary.retried, 1);

    const after = await getJob(pool, job.id);
    assert.equal(after.state, JobState.STARTING, 'the new attempt should already be launching');
    assert.equal(after.attempt, 1);
    assert.notEqual(after.k8s_job_name, job.k8s_job_name, 'a new attempt gets its own Job');
  });

  test('the event log shows the requeue was a retry, not a fresh submission', async () => {
    const job = await runningJob();
    await failJob(job);
    await runOnce(pool, backend);

    const events = (await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${job.id}/events`,
    })).json().events;

    const path = events.map((e) => e.to_state).filter(Boolean);
    // RETRYING is walked rather than jumping FAILED -> QUEUED, which is what makes the
    // sequence of to_state values the job's actual path through the state machine.
    assert.ok(
      path.join(',').includes(`${JobState.FAILED},${JobState.RETRYING},${JobState.QUEUED}`),
      `expected FAILED -> RETRYING -> QUEUED in ${path.join(' -> ')}`,
    );
  });

  test('the budget cannot be overspent, however many passes run', async () => {
    const job = await runningJob({ maxRetries: 1 });

    // Attempt 0 fails; one pass retries it and launches attempt 1.
    backend._setPhase('ashml-test', job.k8s_job_name, Phase.FAILED, 'container exited 1 (Error)');
    await runOnce(pool, backend);
    let current = await getJob(pool, job.id);
    assert.equal(current.attempt, 1);
    assert.equal(current.state, JobState.STARTING);

    // Attempt 1 fails too, and there is no budget left for a third.
    backend._setPhase('ashml-test', current.k8s_job_name, Phase.FAILED, 'container exited 1 (Error)');
    await runOnce(pool, backend);

    current = await getJob(pool, job.id);
    assert.equal(current.state, JobState.FAILED);
    assert.equal(current.attempt, 1, 'no second retry against a budget of one');
    assert.equal(current.retry.decision, RetryDecision.EXHAUSTED);

    // And it stays decided: further passes must not reconsider it.
    await runOnce(pool, backend);
    await runOnce(pool, backend);
    current = await getJob(pool, job.id);
    assert.equal(current.state, JobState.FAILED);
    assert.equal(current.attempt, 1);
  });

  test('a refusal is recorded once, not on every pass', async () => {
    const job = await runningJob({ maxRetries: 0 });
    await failJob(job);
    for (let i = 0; i < 5; i += 1) await runOnce(pool, backend);

    const events = (await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${job.id}/events`,
    })).json().events;

    const declines = events.filter((e) => e.event_type === 'JOB_RETRY_DECLINED');
    assert.equal(declines.length, 1, 'the decision is made once and recorded once');
    assert.match(declines[0].message, /max_retries 0/);
  });

  test('a permanent failure is not retried even with budget left', async () => {
    const job = await runningJob({ maxRetries: 5 });
    await failJob(job, 'ImagePullBackOff: Back-off pulling image "nope:v1"');
    await runOnce(pool, backend);

    const after = await getJob(pool, job.id);
    assert.equal(after.state, JobState.FAILED);
    assert.equal(after.attempt, 0);
    assert.equal(after.retry.decision, RetryDecision.PERMANENT);
  });

  test('a retry is handed the newest confirmed checkpoint', async () => {
    const job = await runningJob();
    await checkpoint(job, { step: 100, name: 'epoch-1.pt' });
    const newest = await checkpoint(job, { step: 200, name: 'epoch-2.pt' });

    await failJob(job);
    await considerRetry(pool, job.id);

    const after = await getJob(pool, job.id);
    assert.equal(after.retry.resume_artifact_id, newest.id, 'should resume from the latest step');
  });

  test('the resumed checkpoint reaches the container as ASHML_RESUME_FROM', async () => {
    const job = await runningJob();
    const saved = await checkpoint(job, { step: 300 });
    await failJob(job);
    await considerRetry(pool, job.id);

    const requeued = await getJob(pool, job.id);
    const manifest = buildJobManifest(requeued, { namespace: 'ashml-test' });
    const env = Object.fromEntries(
      manifest.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]),
    );
    assert.equal(env.ASHML_RESUME_FROM, saved.id);
    // Same job, same reporting identity: a retry is another attempt at one run, not a
    // new one, so its metrics and artifacts land on the same record.
    assert.equal(env.ASHML_JOB_ID, job.id);
    assert.equal(env.ASHML_ATTEMPT, '1');
  });

  test('a job with no checkpoint is retried without one rather than not at all', async () => {
    const job = await runningJob();
    await failJob(job);
    await considerRetry(pool, job.id);

    const after = await getJob(pool, job.id);
    assert.equal(after.state, JobState.QUEUED);
    assert.equal(after.retry.resume_artifact_id, null);

    const manifest = buildJobManifest(after, { namespace: 'ashml-test' });
    const env = manifest.spec.template.spec.containers[0].env.map((e) => e.name);
    assert.ok(!env.includes('ASHML_RESUME_FROM'), 'nothing to resume from means no variable');
  });

  test('an unconfirmed checkpoint is never resumed from', async () => {
    const job = await runningJob();
    // Registered but never completed: the bytes are not confirmed to exist.
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/artifacts`,
      headers: await asJob(job.id),
      payload: { kind: 'checkpoint', name: 'half.pt', uri: 'file:///ckpt/half.pt', step: 50 },
    });
    assert.equal(created.statusCode, 201);

    await failJob(job);
    await considerRetry(pool, job.id);

    const after = await getJob(pool, job.id);
    assert.equal(
      after.retry.resume_artifact_id,
      null,
      'resuming from unconfirmed bytes turns one failure into two',
    );
  });

  test('deciding twice on the same job does not double-spend the budget', async () => {
    const job = await runningJob({ maxRetries: 2 });
    await failJob(job);
    await considerRetry(pool, job.id);

    const first = await getJob(pool, job.id);
    assert.equal(first.attempt, 1);

    // Simulates a second executor pass racing the first one.
    const second = await considerRetry(pool, job.id);
    assert.equal(second.applied, false);
    assert.equal((await getJob(pool, job.id)).attempt, 1);
  });

  test('a cancelled job is never retried', async () => {
    const job = await runningJob({ maxRetries: 3 });
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/cancel`,
      payload: { reason: 'changed my mind' },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.payload);
    await runOnce(pool, backend);

    const after = await getJob(pool, job.id);
    assert.equal(after.state, JobState.CANCELLED);
    assert.equal(after.attempt, 0);
  });

  test('a workload that vanished is retried, because nothing was learned from it', async () => {
    const job = await runningJob({ maxRetries: 1 });
    // Delete the Job out from under AshML, as an operator or an evicting node would.
    await backend.deleteJob('ashml-test', job.k8s_job_name);
    await reconcileJob(pool, backend, job);

    const failed = await getJob(pool, job.id);
    assert.equal(failed.state, JobState.FAILED);
    assert.match(failed.failure_reason, /disappeared/);

    await considerRetry(pool, job.id);
    const after = await getJob(pool, job.id);
    assert.equal(after.state, JobState.QUEUED);
    assert.equal(after.attempt, 1);
    assert.equal(after.retry.decision, null, 'a retry is not a final decision');
  });
});
