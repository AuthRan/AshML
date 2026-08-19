/**
 * Integration tests for the executor against a real PostgreSQL and the `sim`
 * execution backend.
 *
 * The database is real because the executor's correctness is mostly about
 * transactions and row locks. The cluster is simulated because these tests are about
 * the executor's *logic* — which transition follows which observation — and driving a
 * real Pod through every phase on demand is not something a test can do reliably.
 * The real backend is exercised end to end by `make e2e` against k3d instead.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { Phase } from '../k8s/backend.js';
import { JobState } from '../domain/job-state.js';
import { runOnce, launchJob, reconcileJob } from './executor.js';
import { getJob, getJobEvents, cancelJob, claimNextJob } from './jobs.js';
import { connectOrNull, truncateAll, uniqueName, SKIP_MESSAGE } from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => {
  await pool?.end();
});

describe('executor (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let backend;
  let project;

  before(async () => {
    const config = loadConfig({
      ASHML_GPU_PROVIDER: 'sim',
      ASHML_K8S_BACKEND: 'sim',
      ASHML_VERSION: '0.0.0-test',
    });
    // autoAdvance off: every phase change in these tests is made explicitly, so a
    // failure means the executor did the wrong thing, never that a tick was slow.
    backend = createSimBackend({ namespace: 'ashml-test', autoAdvance: false });
    app = await buildApp(config, { logger: false, pool, k8s: backend });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await backend?.close();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    // The fake cluster is wiped alongside the database. Leaving workloads behind for
    // jobs that no longer exist is not a state a real cluster and database ever share.
    backend._reset();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('proj'), description: 'executor test' },
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

  /** The states a job passed through, in order, from its event log. */
  async function statePath(jobId) {
    const events = await getJobEvents(pool, jobId);
    return events.map((e) => e.to_state).filter(Boolean);
  }

  test('a queued job is launched and reaches STARTING with its Job name recorded', async () => {
    const submitted = await submit();

    const summary = await runOnce(pool, backend);
    assert.equal(summary.launched, 1);
    assert.equal(summary.errors, 0);

    const job = await getJob(pool, submitted.id);
    assert.equal(job.state, JobState.STARTING);
    assert.ok(job.k8s_job_name, 'the Kubernetes Job name must be persisted at launch');
    assert.match(job.k8s_job_name, /^ashml-/);
  });

  test('a pending pod does not move the job off STARTING', async () => {
    const submitted = await submit();
    await runOnce(pool, backend);

    // Sim jobs begin PENDING and autoAdvance is off, so this pass observes PENDING.
    await runOnce(pool, backend);

    assert.equal((await getJob(pool, submitted.id)).state, JobState.STARTING);
  });

  test('an observed running pod moves the job to RUNNING and stamps started_at', async () => {
    const submitted = await submit();
    await runOnce(pool, backend);

    const { k8s_job_name: name } = await getJob(pool, submitted.id);
    backend._setPhase('ashml-test', name, Phase.RUNNING, 'pod running');
    await runOnce(pool, backend);

    const job = await getJob(pool, submitted.id);
    assert.equal(job.state, JobState.RUNNING);
    assert.ok(job.started_at, 'started_at is stamped from the observed transition');
  });

  test('a completed pod carries the job to SUCCEEDED', async () => {
    const submitted = await submit();
    await runOnce(pool, backend);
    const { k8s_job_name: name } = await getJob(pool, submitted.id);

    backend._setPhase('ashml-test', name, Phase.RUNNING);
    await runOnce(pool, backend);
    backend._setPhase('ashml-test', name, Phase.SUCCEEDED, 'completed');
    await runOnce(pool, backend);

    const job = await getJob(pool, submitted.id);
    assert.equal(job.state, JobState.SUCCEEDED);
    assert.ok(job.finished_at);
    assert.deepEqual(
      await statePath(submitted.id),
      ['CREATED', 'QUEUED', 'SCHEDULING', 'STARTING', 'RUNNING', 'SUCCEEDED'],
    );
  });

  test('a container that finishes between two ticks is still recorded as having run', async () => {
    const submitted = await submit();
    await runOnce(pool, backend);
    const { k8s_job_name: name } = await getJob(pool, submitted.id);

    // Never observed RUNNING: the pod started and finished inside one interval.
    backend._setPhase('ashml-test', name, Phase.SUCCEEDED, 'completed');
    await runOnce(pool, backend);

    const job = await getJob(pool, submitted.id);
    assert.equal(job.state, JobState.SUCCEEDED);
    // The run passed through RUNNING rather than skipping it — the container did run,
    // and started_at would otherwise be null for a job that plainly executed.
    assert.deepEqual(
      await statePath(submitted.id),
      ['CREATED', 'QUEUED', 'SCHEDULING', 'STARTING', 'RUNNING', 'SUCCEEDED'],
    );
    assert.ok(job.started_at);
  });

  test('a failed pod fails the job and keeps the reason', async () => {
    const submitted = await submit();
    await runOnce(pool, backend);
    const { k8s_job_name: name } = await getJob(pool, submitted.id);

    backend._setPhase('ashml-test', name, Phase.FAILED, 'container exited 1 (Error)');
    await runOnce(pool, backend);

    const job = await getJob(pool, submitted.id);
    assert.equal(job.state, JobState.FAILED);
    assert.equal(job.failure_reason, 'container exited 1 (Error)');
  });

  test('a workload that vanishes fails the job rather than being called a success', async () => {
    const submitted = await submit();
    await runOnce(pool, backend);
    const { k8s_job_name: name } = await getJob(pool, submitted.id);

    // Someone ran `kubectl delete job` by hand, or the pod was evicted.
    await backend.deleteJob('ashml-test', name);
    await runOnce(pool, backend);

    const job = await getJob(pool, submitted.id);
    assert.equal(job.state, JobState.FAILED);
    assert.match(job.failure_reason, /disappeared before reporting a result/);
  });

  test('cancelling a running job tears the workload down before it is CANCELLED', async () => {
    const submitted = await submit();
    await runOnce(pool, backend);
    const { k8s_job_name: name } = await getJob(pool, submitted.id);
    backend._setPhase('ashml-test', name, Phase.RUNNING);
    await runOnce(pool, backend);

    const cancelled = await cancelJob(pool, submitted.id);
    // The job is not cancelled yet: the Pod is still there.
    assert.equal(cancelled.state, JobState.CANCELLING);
    assert.equal(backend._size(), 1, 'the workload must still exist at this point');

    await runOnce(pool, backend);

    assert.equal((await getJob(pool, submitted.id)).state, JobState.CANCELLED);
    assert.equal(backend._size(), 0, 'the workload must be gone before CANCELLED');
  });

  test('a job cancelled while still queued needs no executor pass', async () => {
    const submitted = await submit();

    const cancelled = await cancelJob(pool, submitted.id);
    assert.equal(cancelled.state, JobState.CANCELLED);

    // And the executor must not then launch it.
    const summary = await runOnce(pool, backend);
    assert.equal(summary.launched, 0);
    assert.equal(backend._size(), 0);
  });

  test('a job cancelled mid-launch still has its workload deleted', async () => {
    // Reproduces the race the CANCELLING path exists for: the executor has claimed the
    // job (SCHEDULING) and created the Kubernetes Job, but the cancel arrives before
    // the launch is recorded, so the database has no Job name to delete by.
    const submitted = await submit();
    const claimed = await claimNextJob(pool);
    assert.equal(claimed.state, JobState.SCHEDULING);
    assert.equal(claimed.k8s_job_name, null);

    const { buildJobManifest } = await import('../k8s/manifest.js');
    await backend.createJob(buildJobManifest(claimed, { namespace: 'ashml-test' }));
    assert.equal(backend._size(), 1);

    const cancelled = await cancelJob(pool, submitted.id);
    assert.equal(cancelled.state, JobState.CANCELLING);

    await runOnce(pool, backend);

    assert.equal((await getJob(pool, submitted.id)).state, JobState.CANCELLED);
    assert.equal(backend._size(), 0, 'the orphaned workload must be deleted anyway');
  });

  test('a launch interrupted before it was recorded is finished, not abandoned', async () => {
    const submitted = await submit();
    // Claimed off the queue, then the process died — nothing else will pick this up,
    // because it is no longer QUEUED.
    const claimed = await claimNextJob(pool);
    assert.equal(claimed.state, JobState.SCHEDULING);

    await runOnce(pool, backend);

    const job = await getJob(pool, submitted.id);
    assert.equal(job.state, JobState.STARTING);
    assert.ok(job.k8s_job_name);
    assert.equal(backend._size(), 1, 'exactly one workload, not two');
  });

  test('relaunching an already-created workload adopts it instead of duplicating it', async () => {
    const submitted = await submit();
    const claimed = await claimNextJob(pool);

    await launchJob(pool, backend, claimed);
    assert.equal(backend._size(), 1);

    // The same attempt launched twice — what a crash between create and commit causes.
    await assert.rejects(
      () => launchJob(pool, backend, claimed),
      /illegal job transition STARTING -> STARTING/,
      'the state machine is what rejects the second recording',
    );
    assert.equal(backend._size(), 1, 'no second Kubernetes Job was created');
    assert.equal((await getJob(pool, submitted.id)).state, JobState.STARTING);
  });

  test('launches are capped per pass so one project cannot take the whole queue', async () => {
    for (let i = 0; i < 5; i += 1) await submit();

    const summary = await runOnce(pool, backend, { maxLaunches: 2 });
    assert.equal(summary.launched, 2);

    const stillQueued = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs?project=${project.name}&state=QUEUED`,
    });
    assert.equal(stillQueued.json().jobs.length, 3);
  });

  test('one job failing to launch does not stop the others in the same pass', async () => {
    const good = await submit();
    const bad = await submit({ name: uniqueName('bad') });

    // A backend that refuses exactly one job, as an unpullable image or a rejected
    // manifest would. Every other job in the pass must still be launched.
    const flaky = {
      ...backend,
      async createJob(manifest) {
        if (manifest.metadata.labels['ashml.io/job-id'] === bad.id) {
          throw new Error('simulated API server rejection');
        }
        return backend.createJob(manifest);
      },
    };

    const summary = await runOnce(pool, flaky);
    assert.equal(summary.errors, 1);
    assert.equal(summary.launched, 1);

    assert.equal((await getJob(pool, good.id)).state, JobState.STARTING);
    // The rejected job stays claimed and is retried, rather than being failed for
    // what is a platform problem rather than the user's.
    assert.equal((await getJob(pool, bad.id)).state, JobState.SCHEDULING);
  });

  test('the job event log explains a run without needing the cluster', async () => {
    const submitted = await submit();
    await runOnce(pool, backend);
    const { k8s_job_name: name } = await getJob(pool, submitted.id);
    backend._setPhase('ashml-test', name, Phase.RUNNING);
    await runOnce(pool, backend);

    const events = await getJobEvents(pool, submitted.id);
    const starting = events.find((e) => e.to_state === JobState.STARTING);
    const running = events.find((e) => e.to_state === JobState.RUNNING);

    assert.equal(starting.details.k8s_job_name, name);
    assert.equal(starting.details.namespace, 'ashml-test');
    // The sim backend never hides that nothing really ran (spec Rule 5).
    assert.equal(starting.details.simulated, true);
    assert.equal(running.details.simulated, true);
    assert.equal(running.details.node, 'sim-node-0');
  });

  test('logs are reported as unavailable, not empty, for a job that never launched', async () => {
    const submitted = await submit();

    const res = await app.inject({ method: 'GET', url: `/api/v1/jobs/${submitted.id}/logs` });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.available, false);
    assert.match(body.reason, /no container has been started yet/);
    assert.equal(body.logs, '');
  });

  test('logs come back once a workload exists', async () => {
    const submitted = await submit();
    await runOnce(pool, backend);

    const res = await app.inject({ method: 'GET', url: `/api/v1/jobs/${submitted.id}/logs` });
    const body = res.json();

    assert.equal(body.available, true);
    assert.ok(body.k8s_job_name);
    assert.match(body.logs, /\[sim\]/, 'sim output must announce itself as fabricated');
  });

  test('reconcileJob on a terminal job is a no-op, not an illegal transition', async () => {
    const submitted = await submit();
    await runOnce(pool, backend);
    const { k8s_job_name: name } = await getJob(pool, submitted.id);
    backend._setPhase('ashml-test', name, Phase.SUCCEEDED);
    await runOnce(pool, backend);

    const finished = await getJob(pool, submitted.id);
    assert.equal(finished.state, JobState.SUCCEEDED);

    // A stale list from a concurrent pass can hand a finished job back to reconcile.
    const changed = await reconcileJob(pool, backend, finished);
    assert.equal(changed, null);
    assert.equal((await getJob(pool, submitted.id)).state, JobState.SUCCEEDED);
  });
});
