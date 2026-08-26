/**
 * Integration tests for the artifact lifecycle, with **no artifact store configured**.
 *
 * This is the `none` store: a run that has arranged its own storage registers the URI it
 * already has, and AshML records the lifecycle without ever being able to check the
 * bytes. Everything here therefore completes as `verified: false`, which is the point —
 * an unverifiable artifact must not be able to look like a verified one.
 *
 * The other half, where AshML owns the bucket and really does check, is
 * `artifacts-storage.integration.test.js`, which needs MinIO.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { createNoneStore } from '../storage/none.js';
import { Phase } from '../k8s/backend.js';
import { JobState } from '../domain/job-state.js';
import { ArtifactStatus } from '../domain/artifact-status.js';
import { runOnce } from './executor.js';
import { discoverCluster } from './nodes.js';
import { getJob } from './jobs.js';
import { connectOrNull, wipeAll, uniqueName, SKIP_MESSAGE, authenticateAs, asRun } from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => {
  await pool?.end();
});

describe('artifacts (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let backend;
  let project;
  /**
   * Run-token headers, because the ingest endpoints belong to the run.
   *
   * Registering an artifact, confirming it and abandoning it are all the run saying what
   * it produced, and no person can do them — not even an administrator (ADR 0013). So the
   * tests hold a run token per job, and remember which job each artifact came from so that
   * `complete` and `fail`, which are addressed by artifact id, can present the right one.
   */
  const runHeaders = new Map();
  const artifactJob = new Map();

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
    artifactJob.clear();
    backend._reset();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('proj'), description: 'artifact test' },
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

  async function runToRunning(job) {
    await runOnce(pool, backend);
    const launched = await getJob(pool, job.id);
    assert.equal(launched.state, JobState.STARTING, 'setup: the job should have launched');
    backend._setPhase(launched.namespace, launched.k8s_job_name, Phase.RUNNING);
    await runOnce(pool, backend);
    return launched;
  }

  /** A job in RUNNING, which is where a run registers what it is about to write. */
  async function runningJob(overrides = {}) {
    const job = await submit(overrides);
    await runToRunning(job);
    return job;
  }

  /** `as: 'user'` for the cases where the job id names nothing to mint against. */
  async function register(jobId, body = {}, { as = 'run' } = {}) {
    const headers = as === 'user' ? {} : await asJob(jobId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/artifacts`,
      payload: {
        kind: 'checkpoint',
        name: 'epoch-1',
        uri: 's3://ashml/ckpt/epoch-1.pt',
        step: 100,
        ...body,
      },
      headers,
    });
    const artifact = res.statusCode === 201 ? res.json().artifact : null;
    if (artifact) artifactJob.set(artifact.id, jobId);
    return res;
  }

  async function headersForArtifact(id) {
    const jobId = artifactJob.get(id);
    // An artifact this suite did not register — an invented id, or one belonging to a job
    // it never made — has no run to speak for it. The ordinary identity is right there:
    // the answer under test is a 404, which comes before any permission is considered.
    return jobId ? asJob(jobId) : {};
  }

  async function complete(id, body = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${id}/complete`,
      payload: { digest: 'sha256:abc123', size_bytes: 4096, ...body },
      headers: await headersForArtifact(id),
    });
  }

  async function fail(id, payload) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${id}/fail`,
      payload,
      headers: await headersForArtifact(id),
    });
  }

  test('registration records intent, not existence', async () => {
    const job = await runningJob();

    const res = await register(job.id);
    assert.equal(res.statusCode, 201, res.payload);
    const artifact = res.json().artifact;

    // Nothing has been uploaded yet, and the row says so rather than implying otherwise.
    assert.equal(artifact.status, ArtifactStatus.PENDING);
    assert.equal(artifact.digest, null, 'a digest cannot exist before the bytes do');
    assert.equal(artifact.size_bytes, 0);
    assert.equal(artifact.kind, 'checkpoint');
    assert.equal(artifact.step, 100);
    assert.equal(artifact.job.id, job.id);
    assert.equal(artifact.project, project.name);
  });

  test('confirming the upload makes it READY and records what was written', async () => {
    const job = await runningJob();
    const artifact = (await register(job.id)).json().artifact;

    const res = await complete(artifact.id, { digest: 'sha256:deadbeef', size_bytes: 1_048_576 });
    assert.equal(res.statusCode, 200, res.payload);

    const ready = res.json();
    assert.equal(ready.status, ArtifactStatus.READY);
    assert.equal(ready.digest, 'sha256:deadbeef');
    assert.equal(ready.size_bytes, 1_048_576);

    // With no store configured there is nothing to ask, so the size is the run's own
    // claim — and the artifact says as much rather than passing for a checked one.
    assert.equal(ready.verified, false);
    assert.match(ready.metadata.verification_note, /no artifact store is configured/);

    // And the change is durable, not just what the response said.
    const reread = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${artifact.id}` });
    assert.equal(reread.json().status, ArtifactStatus.READY);
    assert.equal(reread.json().digest, 'sha256:deadbeef');
    assert.equal(reread.json().verified, false);
  });

  test('with no store, AshML cannot allocate a location and says so', async () => {
    const job = await runningJob();

    // `uri` is optional in the schema because a configured store fills it in. Without
    // one there is nowhere to put the bytes, and guessing a URI would invent a location
    // nothing writes to.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/artifacts`,
      payload: { kind: 'checkpoint', name: 'epoch-1' },
      headers: await asJob(job.id),
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(res.json().error.code, 'URI_REQUIRED');
  });

  test('a caller-supplied URI comes back with no presigned upload', async () => {
    const job = await runningJob();
    const res = await register(job.id);

    // The run arranged its own storage; there is nothing for AshML to sign.
    assert.equal(res.json().upload, null);
  });

  test('an unverifiable artifact cannot be downloaded through AshML', async () => {
    const job = await runningJob();
    const artifact = (await register(job.id)).json().artifact;
    await complete(artifact.id);

    // AshML has no credentials for wherever this URI points. Signing it would produce a
    // URL that does not work, which is worse than saying so.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifact.id}/download`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(res.json().error.code, 'ARTIFACT_NOT_IN_STORE');
  });

  test('a PENDING artifact is never signed for download', async () => {
    const job = await runningJob();
    const artifact = (await register(job.id)).json().artifact;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifact.id}/download`,
    });
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error.code, 'ARTIFACT_NOT_READY');
  });

  test('an artifact cannot be registered as already READY', async () => {
    const job = await runningJob();

    // This API cannot see the bytes. If a caller could name the status, READY would
    // mean "someone said so", which is not what every consumer downstream reads it as.
    //
    // Fastify strips properties the body schema does not declare rather than rejecting
    // them, so the request succeeds — but `status` is not a field this endpoint accepts,
    // and the artifact comes back PENDING like any other.
    const res = await register(job.id, { status: ArtifactStatus.READY });
    assert.equal(res.statusCode, 201, res.payload);
    assert.equal(res.json().artifact.status, ArtifactStatus.PENDING);
  });

  test('a settled artifact cannot be settled again', async () => {
    const job = await runningJob();
    const artifact = (await register(job.id)).json().artifact;
    assert.equal((await complete(artifact.id)).statusCode, 200);

    // A second confirm with a different digest would silently rewrite what the stored
    // bytes are claimed to be.
    const again = await complete(artifact.id, { digest: 'sha256:different', size_bytes: 1 });
    assert.equal(again.statusCode, 409, again.payload);
    assert.equal(again.json().error.code, 'ILLEGAL_ARTIFACT_TRANSITION');

    const reread = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${artifact.id}` });
    assert.equal(reread.json().digest, 'sha256:abc123', 'the first digest stands');
  });

  test('an abandoned upload is recorded, not deleted', async () => {
    const job = await runningJob();
    const artifact = (await register(job.id)).json().artifact;

    const res = await fail(artifact.id, { reason: 'pod evicted mid-write' });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().status, ArtifactStatus.FAILED);
    assert.equal(res.json().metadata.failure_reason, 'pod evicted mid-write');

    // The row survives: a checkpoint the run meant to write and did not is a fact about
    // that run, and deleting it would make the gap indistinguishable from never trying.
    const listed = await app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}/artifacts` });
    assert.equal(listed.json().artifacts.length, 1);
    assert.equal(listed.json().artifacts[0].status, ArtifactStatus.FAILED);
  });

  test('a failed upload cannot later be confirmed', async () => {
    const job = await runningJob();
    const artifact = (await register(job.id)).json().artifact;
    assert.equal((await fail(artifact.id)).statusCode, 200);

    const res = await complete(artifact.id);
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error.code, 'ILLEGAL_ARTIFACT_TRANSITION');
  });

  test('failing takes no body', async () => {
    const job = await runningJob();
    const artifact = (await register(job.id)).json().artifact;

    // The reason is useful but not required; a reporter that has crashed may have none.
    const res = await fail(artifact.id, undefined);
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().metadata.failure_reason, 'upload abandoned');
  });

  test('confirmation metadata is merged into what registration recorded', async () => {
    const job = await runningJob();
    const artifact = (await register(job.id, {
      metadata: { framework: 'pytorch', optimizer: 'adamw' },
    })).json().artifact;

    const res = await complete(artifact.id, { metadata: { compression: 'zstd' } });
    assert.equal(res.statusCode, 200, res.payload);

    // The uploading side does not get to discard what the registering side knew.
    const metadata = res.json().metadata;
    assert.equal(metadata.framework, 'pytorch');
    assert.equal(metadata.optimizer, 'adamw');
    assert.equal(metadata.compression, 'zstd');
  });

  test('a job that has not launched cannot have produced an artifact', async () => {
    const job = await submit();
    assert.equal((await getJob(pool, job.id)).state, JobState.QUEUED);

    const res = await register(job.id);
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error.code, 'JOB_NOT_STARTED');
  });

  test('a finished run may still confirm its final checkpoint', async () => {
    const job = await submit();
    const launched = await runToRunning(job);
    const artifact = (await register(job.id, { kind: 'model', name: 'final' })).json().artifact;

    backend._setPhase(launched.namespace, launched.k8s_job_name, Phase.SUCCEEDED);
    await runOnce(pool, backend);
    assert.equal((await getJob(pool, job.id)).state, JobState.SUCCEEDED);

    // The upload finishes after the pod is gone. Refusing the confirm here would leave
    // every successful run's final model stuck at PENDING forever.
    assert.equal((await complete(artifact.id)).statusCode, 200);
  });

  test('unknown jobs and artifacts are 404s', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    assert.equal((await register(missing, {}, { as: 'user' })).statusCode, 404);
    assert.equal((await complete(missing)).statusCode, 404);
    assert.equal((await fail(missing, {})).statusCode, 404);
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/v1/artifacts/${missing}` })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/v1/jobs/${missing}/artifacts` })).statusCode,
      404,
    );
  });

  test('listing filters by kind and by status', async () => {
    const job = await runningJob();
    const ckpt = (await register(job.id, { name: 'epoch-1', step: 100 })).json().artifact;
    await register(job.id, { name: 'epoch-2', step: 200 });
    const model = (await register(job.id, { kind: 'model', name: 'final', step: null })).json().artifact;
    await complete(ckpt.id);
    await complete(model.id);

    const list = async (query) => (await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${job.id}/artifacts${query}`,
    })).json().artifacts;

    assert.equal((await list('')).length, 3);
    assert.equal((await list('?kind=model')).length, 1);
    assert.deepEqual((await list('?kind=checkpoint')).map((a) => a.name), ['epoch-1', 'epoch-2']);

    // The filter that matters: "what can I actually resume from".
    const usable = await list('?status=READY');
    assert.deepEqual(usable.map((a) => a.name).sort(), ['epoch-1', 'final']);
  });

  describe('experiment attribution', () => {
    test('the experiment is taken from the job, not from the registering run', async () => {
      const experiment = await createExperiment();
      const job = await runningJob({ experiment: experiment.id });

      const artifact = (await register(job.id)).json().artifact;
      assert.equal(artifact.experiment_id, experiment.id);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/experiments/${experiment.id}/artifacts`,
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(res.json().artifacts.map((a) => a.id), [artifact.id]);
    });

    test('an experiment collects the artifacts of every one of its runs', async () => {
      const experiment = await createExperiment();

      const first = await runningJob({ experiment: experiment.id });
      const a = (await register(first.id, { name: 'run1-final', kind: 'model' })).json().artifact;
      await complete(a.id);

      const second = await runningJob({ experiment: experiment.id });
      const b = (await register(second.id, { name: 'run2-final', kind: 'model' })).json().artifact;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/experiments/${experiment.id}/artifacts?kind=model`,
      });
      assert.deepEqual(res.json().artifacts.map((x) => x.name), ['run1-final', 'run2-final']);

      // Both runs produced a model; only one of them is real so far, and the list says
      // which without the caller having to guess.
      assert.deepEqual(res.json().artifacts.map((x) => x.status), [
        ArtifactStatus.READY,
        ArtifactStatus.PENDING,
      ]);
      assert.equal(b.status, ArtifactStatus.PENDING);
    });

    test('artifacts for an unknown experiment are a 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/experiments/00000000-0000-0000-0000-000000000000/artifacts',
      });
      assert.equal(res.statusCode, 404);
    });
  });
});
