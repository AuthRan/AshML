/**
 * Integration tests for artifacts against a **real object store** (MinIO via
 * `make db-up`), a real PostgreSQL, and the `sim` execution backend.
 *
 * The store is real and is not substituted when absent — these tests skip visibly
 * instead. The single thing being tested is whether AshML actually checks that a
 * checkpoint exists, and a fake store is precisely the thing that could not tell the
 * truth about that (spec Rule 5). `artifacts.integration.test.js` covers the other
 * half, where no store is configured and nothing can be verified.
 *
 * Bytes move over the presigned URL with `fetch`, exactly as a training pod would send
 * them — they never pass through the control plane.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { Phase } from '../k8s/backend.js';
import { JobState } from '../domain/job-state.js';
import { ArtifactStatus } from '../domain/artifact-status.js';
import { runOnce } from './executor.js';
import { discoverCluster } from './nodes.js';
import { getJob } from './jobs.js';
import {
  connectOrNull, connectStoreOrNull, truncateAll, uniqueName,
  SKIP_MESSAGE, STORE_SKIP_MESSAGE, authenticateAs, asRun } from '../test-support/db.js';

const pool = await connectOrNull();
const store = pool ? await connectStoreOrNull() : null;

after(async () => {
  await pool?.end();
  await store?.close();
});

const skip = pool ? (store ? false : STORE_SKIP_MESSAGE) : SKIP_MESSAGE;

describe('artifacts against a real store (integration)', { skip }, () => {
  let app;
  let backend;
  let project;
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
    app = await buildApp(config, { logger: false, pool, k8s: backend, store });
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
    runHeaders.clear();
    artifactJob.clear();
    backend._reset();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('proj'), description: 'artifact storage test' },
    });
    assert.equal(res.statusCode, 201);
    project = res.json();
  });

  /** A job in RUNNING, which is where a run registers what it is about to write. */
  async function runningJob() {
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: project.name,
        name: uniqueName('job'),
        spec: { image: 'busybox:1.36', command: ['sh', '-c', 'echo hi'] },
        resources: { cpu: 1 },
      },
    });
    assert.equal(submitted.statusCode, 201, submitted.payload);
    const job = submitted.json();

    await runOnce(pool, backend);
    const launched = await getJob(pool, job.id);
    assert.equal(launched.state, JobState.STARTING, 'setup: the job should have launched');
    backend._setPhase('ashml-test', launched.k8s_job_name, Phase.RUNNING);
    await runOnce(pool, backend);
    return job;
  }

  /**
   * Registers as the run.
   *
   * Registering an artifact and confirming its upload are the run saying what it
   * produced, and no person can do either (ADR 0013) — so these hold a run token, and
   * remember which job each artifact came from so `complete`, addressed by artifact id,
   * can present the right one.
   */
  async function register(jobId, body = {}) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/artifacts`,
      payload: { kind: 'checkpoint', name: 'epoch-1', step: 100, ...body },
      headers: await asJob(jobId),
    });
    if (res.statusCode === 201) artifactJob.set(res.json().artifact.id, jobId);
    return res;
  }

  async function complete(id, body) {
    const jobId = artifactJob.get(id);
    return app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${id}/complete`,
      payload: body,
      headers: jobId ? await asJob(jobId) : {},
    });
  }

  /** Writes bytes exactly as a training pod would: straight to the store. */
  async function upload(url, body) {
    const res = await fetch(url, { method: 'PUT', body });
    assert.ok(res.ok, `presigned upload failed: ${res.status} ${await res.text()}`);
  }

  test('registration allocates a location and presigns an upload', async () => {
    const job = await runningJob();

    const res = await register(job.id);
    assert.equal(res.statusCode, 201, res.payload);
    const { artifact, upload: put } = res.json();

    // The URI names the bucket and key, never the endpoint: MinIO's address in dev is
    // not the address this artifact has anywhere else.
    assert.match(artifact.uri, /^s3:\/\/[^/]+\/.+/);
    assert.ok(artifact.uri.includes(`/${job.id}/`), 'the key groups a run’s output by job id');
    assert.equal(artifact.status, ArtifactStatus.PENDING);
    assert.equal(artifact.verified, null, 'nothing has been checked yet');

    assert.equal(put.method, 'PUT');
    assert.ok(put.url.startsWith('http'), 'the upload URL is fetchable as-is');
    assert.ok(new Date(put.expires_at) > new Date(), 'a presigned URL that has expired is useless');
  });

  test('an uploaded checkpoint is verified against the store', async () => {
    const job = await runningJob();
    const { artifact, upload: put } = (await register(job.id)).json();

    const bytes = Buffer.from('a checkpoint, more or less');
    await upload(put.url, bytes);

    const res = await complete(artifact.id, {
      digest: 'sha256:whatever', size_bytes: bytes.length,
    });
    assert.equal(res.statusCode, 200, res.payload);

    const ready = res.json();
    assert.equal(ready.status, ArtifactStatus.READY);
    // The difference this whole file exists for: AshML asked the bucket.
    assert.equal(ready.verified, true);
    assert.equal(ready.size_bytes, bytes.length);
    assert.ok(ready.metadata.etag, 'the store’s own etag is kept alongside the run’s digest');
  });

  test('a checkpoint that was never uploaded cannot be completed', async () => {
    const job = await runningJob();
    const { artifact } = (await register(job.id)).json();

    // The run crashed between registering and writing. Taking its word here is exactly
    // how "the checkpoint is registered" stops meaning "the checkpoint exists".
    const res = await complete(artifact.id, { digest: 'sha256:lies', size_bytes: 4096 });
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error.code, 'ARTIFACT_NOT_UPLOADED');

    // And it stays PENDING, so a later upload can still confirm it.
    const reread = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${artifact.id}` });
    assert.equal(reread.json().status, ArtifactStatus.PENDING);
  });

  test('a size that disagrees with the stored object is refused', async () => {
    const job = await runningJob();
    const { artifact, upload: put } = (await register(job.id)).json();

    const bytes = Buffer.from('twenty-six bytes exactly!!');
    await upload(put.url, bytes);

    // The run believes it wrote something other than what is there, which means the
    // digest it reported may not describe these bytes.
    const res = await complete(artifact.id, { digest: 'sha256:abc', size_bytes: bytes.length + 1 });
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error.code, 'ARTIFACT_SIZE_MISMATCH');
    assert.match(res.json().error.message, new RegExp(String(bytes.length)));
  });

  test('a completed artifact can be downloaded through a presigned URL', async () => {
    const job = await runningJob();
    const { artifact, upload: put } = (await register(job.id)).json();

    const bytes = Buffer.from('the actual model weights, honestly');
    await upload(put.url, bytes);
    assert.equal(
      (await complete(artifact.id, { digest: 'sha256:x', size_bytes: bytes.length })).statusCode,
      200,
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifact.id}/download`,
    });
    assert.equal(res.statusCode, 200, res.payload);

    // The bytes come from the store, not from this API — but they are the bytes.
    const fetched = await fetch(res.json().url);
    assert.ok(fetched.ok);
    assert.equal(Buffer.from(await fetched.arrayBuffer()).toString(), bytes.toString());
  });

  test('a run cannot choose where its checkpoint lands', async () => {
    const job = await runningJob();

    // `name` comes from the training script. Without sanitisation this would escape the
    // run's prefix and could overwrite another project's artifact.
    const { artifact } = (await register(job.id, { name: '../../../etc/passwd' })).json();

    const key = artifact.uri.split('/').slice(3).join('/');
    assert.ok(!key.includes('..'), `key must not traverse: ${key}`);
    assert.ok(
      key.startsWith(`${project.name}/${job.id}/`),
      `key must stay under the run’s own prefix: ${key}`,
    );
  });

  test('an artifact stored outside AshML completes, but unverified', async () => {
    const job = await runningJob();

    // A run with its own NFS mount. Legitimate — and it must not be able to look like
    // an artifact the store confirmed.
    const { artifact, upload: put } = (await register(job.id, {
      uri: 'file:///mnt/scratch/epoch-1.pt',
    })).json();
    assert.equal(put, null, 'there is nothing for AshML to presign');

    const res = await complete(artifact.id, { digest: 'sha256:y', size_bytes: 123 });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().verified, false);
    assert.match(res.json().metadata.verification_note, /outside the configured store/);
    // With nothing to check against, the run's claim is all there is — and is labelled.
    assert.equal(res.json().size_bytes, 123);
  });

  test('two runs of the same job name do not collide in the bucket', async () => {
    const first = await runningJob();
    const second = await runningJob();

    const a = (await register(first.id, { name: 'final' })).json().artifact;
    const b = (await register(second.id, { name: 'final' })).json().artifact;

    // The job id, not the job name, is what separates them: names are unique only
    // within a project and a retry reuses them.
    assert.notEqual(a.uri, b.uri);
  });
});
