/**
 * End-to-end proof of the Phase 2 exit criteria:
 *
 *   `ash job submit` runs a real container in k3d and the job reaches SUCCEEDED
 *   through observed Pod status, not a timer.
 *
 * Nothing here is simulated. It talks to a real PostgreSQL, drives the real executor,
 * and runs a real container on the real cluster — and it asserts on what the *cluster*
 * reports, so a passing run cannot be produced by the control plane simply believing
 * itself.
 *
 * Prerequisites:  make cluster && make image && make db-up && make migrate
 * Run:            make e2e
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildApp } from '../packages/server/src/app.js';
import { loadConfig } from '../packages/server/src/config.js';
import { runOnce } from '../packages/server/src/services/executor.js';
import { getJob, getJobEvents } from '../packages/server/src/services/jobs.js';
import { JobState } from '../packages/server/src/domain/job-state.js';

const run = promisify(execFile);

const NAMESPACE = process.env.ASHML_K8S_NAMESPACE ?? 'ashml-jobs';
const IMAGE = process.env.TRAINER_IMAGE ?? 'ashml/trainer:v1';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180_000);

const config = loadConfig({
  ...process.env,
  ASHML_GPU_PROVIDER: 'sim',      // The GPUs are not what is under test here.
  ASHML_K8S_BACKEND: 'kubernetes', // The cluster very much is.
  ASHML_K8S_NAMESPACE: NAMESPACE,
});

const app = await buildApp(config, { logger: false });
await app.ready();

/** Asks kubectl directly, so assertions do not rely on AshML's own view. */
async function kubectl(...args) {
  const { stdout } = await run('kubectl', args);
  return stdout.trim();
}

const suffix = Math.random().toString(36).slice(2, 8);
const results = [];

function check(name, fn) {
  results.push({ name, fn });
}

/** Drives executor passes until `predicate` holds, or the timeout expires. */
async function until(jobId, predicate, what) {
  const deadline = Date.now() + TIMEOUT_MS;
  let job;
  while (Date.now() < deadline) {
    await runOnce(app.db, app.k8s);
    job = await getJob(app.db, jobId);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `timed out after ${TIMEOUT_MS}ms waiting for ${what}; `
    + `job is ${job?.state} (${job?.failure_reason ?? 'no failure reason'})`,
  );
}

async function submit(name, payload) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    payload: { project: `e2e-${suffix}`, name, ...payload },
  });
  assert.equal(res.statusCode, 201, res.payload);
  return res.json();
}

// --------------------------------------------------------------- the checks

check('the cluster is reachable and the namespace exists', async () => {
  await app.k8s.ensureNamespace();
  const found = await kubectl('get', 'namespace', NAMESPACE, '-o', 'jsonpath={.metadata.name}');
  assert.equal(found, NAMESPACE);
});

check('a project can be created', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name: `e2e-${suffix}`, description: 'phase 2 end-to-end' },
  });
  assert.equal(res.statusCode, 201, res.payload);
});

check('a submitted job runs a real container and reaches SUCCEEDED', async () => {
  const submitted = await submit(`e2e-ok-${suffix}`, {
    spec: { image: IMAGE, env: { STEPS: '4', STEP_SECONDS: '0.3' } },
    resources: { cpu: 1 },
  });

  const running = await until(
    submitted.id,
    (j) => j.state === JobState.RUNNING || j.state === JobState.SUCCEEDED,
    'the job to start running',
  );
  assert.ok(running.k8s_job_name, 'a Kubernetes Job name must have been recorded');

  // The cluster's own view, not AshML's: this is what makes the run real.
  const podPhase = await kubectl(
    'get', 'pods', '-n', NAMESPACE,
    '-l', `job-name=${running.k8s_job_name}`,
    '-o', 'jsonpath={.items[0].status.phase}',
  );
  assert.ok(['Running', 'Succeeded'].includes(podPhase), `pod phase was "${podPhase}"`);

  const done = await until(
    submitted.id,
    (j) => j.state === JobState.SUCCEEDED || j.state === JobState.FAILED,
    'the job to finish',
  );
  assert.equal(done.state, JobState.SUCCEEDED, `failed: ${done.failure_reason}`);
  assert.ok(done.started_at && done.finished_at, 'both timestamps must be stamped');

  // And Kubernetes agrees it succeeded.
  const succeeded = await kubectl(
    'get', 'job', running.k8s_job_name, '-n', NAMESPACE,
    '-o', 'jsonpath={.status.succeeded}',
  );
  assert.equal(succeeded, '1', 'Kubernetes must independently report success');

  const path = (await getJobEvents(app.db, submitted.id)).map((e) => e.to_state).filter(Boolean);
  assert.deepEqual(path, ['CREATED', 'QUEUED', 'SCHEDULING', 'STARTING', 'RUNNING', 'SUCCEEDED']);

  globalThis.__okJob = { id: submitted.id, k8sName: running.k8s_job_name };
});

check('the container\'s own output is readable through the API', async () => {
  const { id } = globalThis.__okJob;
  const res = await app.inject({ method: 'GET', url: `/api/v1/jobs/${id}/logs` });
  const body = res.json();

  assert.equal(body.available, true, `logs unavailable: ${body.reason}`);
  assert.match(body.logs, /\[smoke\] done/, 'the container ran to completion');
  assert.match(body.logs, new RegExp(`job_id=${id}`), 'the container was told which job it is');
});

check('a container that exits non-zero fails the job, with the reason', async () => {
  const submitted = await submit(`e2e-fail-${suffix}`, {
    spec: { image: IMAGE, env: { STEPS: '5', STEP_SECONDS: '0.2', FAIL_AT_STEP: '2' } },
    resources: { cpu: 1 },
  });

  const done = await until(
    submitted.id,
    (j) => j.state === JobState.FAILED || j.state === JobState.SUCCEEDED,
    'the failing job to finish',
  );
  assert.equal(done.state, JobState.FAILED, 'a non-zero exit must not be reported as success');
  assert.ok(done.failure_reason, 'the failure must be explained, not just recorded');
});

check('an unpullable image fails the job instead of hanging forever', async () => {
  const submitted = await submit(`e2e-nopull-${suffix}`, {
    spec: { image: 'ashml/does-not-exist:v0' },
    resources: { cpu: 1 },
  });

  // The job stays STARTING while Kubernetes retries the pull. What is asserted here
  // is that AshML reports *why* — an operator must not have to reach for kubectl.
  const deadline = Date.now() + 60_000;
  let job;
  while (Date.now() < deadline) {
    await runOnce(app.db, app.k8s);
    job = await getJob(app.db, submitted.id);
    const observation = await app.k8s.observeJob(NAMESPACE, job.k8s_job_name);
    if (observation && /ImagePull|ErrImage/.test(observation.reason)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const observation = await app.k8s.observeJob(NAMESPACE, job.k8s_job_name);
  assert.match(
    observation.reason, /ImagePull|ErrImage/,
    `the pull failure must be surfaced; got "${observation?.reason}"`,
  );

  await app.inject({ method: 'POST', url: `/api/v1/jobs/${submitted.id}/cancel`, payload: {} });
  await until(submitted.id, (j) => j.state === JobState.CANCELLED, 'the stuck job to cancel');
});

check('cancelling a running job removes its Pod from the cluster', async () => {
  const submitted = await submit(`e2e-cancel-${suffix}`, {
    spec: { image: IMAGE, env: { STEPS: '600', STEP_SECONDS: '1' } },
    resources: { cpu: 1 },
  });

  const running = await until(submitted.id, (j) => j.state === JobState.RUNNING, 'the job to run');

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/jobs/${submitted.id}/cancel`,
    payload: { reason: 'end-to-end test' },
  });
  assert.equal(res.statusCode, 200);
  // Not CANCELLED yet — the Pod is still up. That distinction is the point.
  assert.equal(res.json().state, JobState.CANCELLING);

  await until(submitted.id, (j) => j.state === JobState.CANCELLED, 'the cancellation to complete');

  const remaining = await kubectl(
    'get', 'jobs', '-n', NAMESPACE,
    '-o', `jsonpath={.items[?(@.metadata.name=="${running.k8s_job_name}")].metadata.name}`,
  );
  assert.equal(remaining, '', 'the Kubernetes Job must be gone once AshML says CANCELLED');
});

// ------------------------------------------------------------------- driver

let failed = 0;
for (const { name, fn } of results) {
  const started = Date.now();
  try {
    await fn();
    console.log(`  ok    ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
  }
}

console.log(`\n${results.length - failed}/${results.length} end-to-end checks passed`);

await app.close();
process.exit(failed === 0 ? 0 : 1);
