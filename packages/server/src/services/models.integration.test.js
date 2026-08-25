/**
 * Integration tests for the model registry.
 *
 * Two things are being protected, and both need a real database to mean anything:
 *
 * - a version cannot point at bytes nobody confirmed, and
 * - a model has at most one version in PRODUCTION, with no instant where it has two
 *   or none.
 *
 * The `none` artifact store is used, so artifacts here complete unverified. That is
 * deliberate: the registry's rule is about `status`, not about verification, and using
 * the weaker artifact keeps this suite testing the registry rather than MinIO.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { createNoneStore } from '../storage/none.js';
import { Phase } from '../k8s/backend.js';
import { JobState } from '../domain/job-state.js';
import { ModelStatus } from '../domain/model-status.js';
import { runOnce } from './executor.js';
import { discoverCluster } from './nodes.js';
import { getJob } from './jobs.js';
import { connectOrNull, wipeAll, uniqueName, SKIP_MESSAGE, authenticateAs, asRun } from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => {
  await pool?.end();
});

describe('model registry (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
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
      payload: { name: uniqueName('proj'), description: 'registry test' },
    });
    assert.equal(res.statusCode, 201);
    project = res.json();
  });

  // ------------------------------------------------------------- fixtures

  async function runningJob(payload = {}) {
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: project.name,
        name: uniqueName('job'),
        spec: { image: 'busybox:1.36', command: ['sh', '-c', 'true'] },
        resources: { cpu: 1 },
        ...payload,
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
   * A PENDING artifact belonging to a running job.
   *
   * Registered with a run token, because producing an artifact is the run's act and no
   * person can perform it (ADR 0013). Everything downstream here — registering a version
   * from it, promoting that version — is a person's act and uses the ordinary identity.
   */
  async function pendingArtifact(job, name = 'final.pt') {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/artifacts`,
      payload: { kind: 'model', name, uri: `file:///models/${name}` },
      headers: await asJob(job.id),
    });
    assert.equal(res.statusCode, 201, res.payload);
    artifactJob.set(res.json().artifact.id, job.id);
    return res.json().artifact;
  }

  /** A READY artifact — what a version may actually be registered from. */
  async function readyArtifact(job, name = 'final.pt') {
    const artifact = await pendingArtifact(job, name);
    const done = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifact.id}/complete`,
      payload: { digest: 'sha256:abc', size_bytes: 2048 },
      headers: await asJob(job.id),
    });
    assert.equal(done.statusCode, 200, done.payload);
    return done.json();
  }

  function createModel(name = 'fraud-detector') {
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models`,
      payload: { name },
    });
  }

  function registerVersion(model, artifactId, body = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models/${model}/versions`,
      payload: { artifact_id: artifactId, ...body },
    });
  }

  function setStatus(model, version, status) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models/${model}/versions/${version}/status`,
      payload: { status },
    });
  }

  async function seedVersion(model = 'fraud-detector', name = 'final.pt') {
    const job = await runningJob();
    const artifact = await readyArtifact(job, name);
    const res = await registerVersion(model, artifact.id);
    assert.equal(res.statusCode, 201, res.payload);
    return { job, artifact, version: res.json() };
  }

  // ---------------------------------------------------------------- models

  test('a model is a name, and starts with nothing in it', async () => {
    const res = await createModel();
    assert.equal(res.statusCode, 201, res.payload);

    const model = res.json();
    assert.equal(model.name, 'fraud-detector');
    assert.equal(model.project, project.name);
    assert.equal(model.version_count, 0);
    assert.equal(model.latest_version, null);
    assert.equal(model.production_version, null);
  });

  test('two models in one project cannot share a name', async () => {
    assert.equal((await createModel()).statusCode, 201);
    const again = await createModel();
    assert.equal(again.statusCode, 409, again.payload);
    assert.equal(again.json().error.code, 'MODEL_EXISTS');
  });

  test('a model in another project may reuse the name', async () => {
    assert.equal((await createModel()).statusCode, 201);

    const other = (await app.inject({
      method: 'POST', url: '/api/v1/projects', payload: { name: uniqueName('other') },
    })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${other.name}/models`,
      payload: { name: 'fraud-detector' },
    });
    assert.equal(res.statusCode, 201, res.payload);
  });

  test('a model in a project that does not exist is a 404, not a 409', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/projects/no-such-project/models', payload: { name: 'm' },
    });
    assert.equal(res.statusCode, 404);
  });

  // -------------------------------------------------------------- versions

  describe('registering a version', () => {
    beforeEach(async () => {
      assert.equal((await createModel()).statusCode, 201);
    });

    test('a version points at confirmed bytes and does not serve anything yet', async () => {
      const { artifact, version } = await seedVersion();

      assert.equal(version.version, 1);
      // Registering is not promoting: a successful training run is not a deploy.
      assert.equal(version.status, ModelStatus.CREATED);
      assert.equal(version.artifact.id, artifact.id);
      assert.equal(version.artifact.digest, 'sha256:abc');
      assert.equal(version.model, 'fraud-detector');
    });

    test('an artifact whose upload was never confirmed cannot become a model', async () => {
      const job = await runningJob();
      const artifact = await pendingArtifact(job);

      const res = await registerVersion('fraud-detector', artifact.id);
      assert.equal(res.statusCode, 409, res.payload);
      assert.equal(res.json().error.code, 'ARTIFACT_NOT_READY');

      // The whole point: this failure happens here, at registration, rather than in
      // production when something tries to load the file.
      const versions = await app.inject({
        method: 'GET', url: `/api/v1/projects/${project.name}/models/fraud-detector/versions`,
      });
      assert.deepEqual(versions.json().versions, []);
    });

    test('an abandoned artifact cannot become a model either', async () => {
      const job = await runningJob();
      const artifact = await pendingArtifact(job);
      await app.inject({
        method: 'POST',
        url: `/api/v1/artifacts/${artifact.id}/fail`,
        payload: {},
        headers: await asJob(job.id),
      });

      const res = await registerVersion('fraud-detector', artifact.id);
      assert.equal(res.statusCode, 409, res.payload);
      assert.equal(res.json().error.code, 'ARTIFACT_NOT_READY');
    });

    test('versions number from one and count up per model', async () => {
      await seedVersion('fraud-detector', 'v1.pt');
      await seedVersion('fraud-detector', 'v2.pt');

      // A second model in the same project starts at 1 again — a global sequence would
      // have it start at 3, which tells the reader nothing.
      assert.equal((await createModel('churn')).statusCode, 201);
      const { version: other } = await seedVersion('churn', 'other.pt');

      const listed = (await app.inject({
        method: 'GET', url: `/api/v1/projects/${project.name}/models/fraud-detector/versions`,
      })).json().versions;

      assert.deepEqual(listed.map((v) => v.version), [2, 1], 'newest first');
      assert.equal(other.version, 1);
    });

    test('a version inherits the run’s own reported metrics', async () => {
      const job = await runningJob();
      // As the run: these are the numbers the training loop measured, and nothing else
      // is allowed to author them (ADR 0013).
      const reported = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${job.id}/metrics`,
        payload: {
          metrics: [
            { name: 'accuracy', value: 0.80, step: 0 },
            { name: 'accuracy', value: 0.94, step: 100 },
            { name: 'loss', value: 0.12, step: 100 },
          ],
        },
        headers: await asJob(job.id),
      });
      assert.equal(reported.statusCode, 201, reported.payload);
      const artifact = await readyArtifact(job);

      const version = (await registerVersion('fraud-detector', artifact.id)).json();

      // Copied, not invented: this is what the run said about itself, and having it
      // here is what lets two versions be compared without going back to their jobs.
      assert.equal(version.metrics.accuracy, 0.94, 'the last value, not the first');
      assert.equal(version.metrics.loss, 0.12);
      assert.equal(version.job_id, job.id);
    });

    test('explicit metrics override what the run reported', async () => {
      const job = await runningJob();
      await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${job.id}/metrics`,
        payload: { metrics: [{ name: 'accuracy', value: 0.94, step: 0 }] },
      });
      const artifact = await readyArtifact(job);

      // A held-out evaluation done after the run is a real thing to record, and it is
      // not something the training loop could have reported.
      const version = (await registerVersion('fraud-detector', artifact.id, {
        metrics: { holdout_accuracy: 0.91 },
        description: 'evaluated against the 2026 holdout set',
      })).json();

      assert.deepEqual(version.metrics, { holdout_accuracy: 0.91 });
      assert.equal(version.description, 'evaluated against the 2026 holdout set');
    });

    test('a version carries the experiment its run belonged to', async () => {
      const experiment = (await app.inject({
        method: 'POST',
        url: '/api/v1/experiments',
        payload: { project: project.name, name: 'resnet-baseline' },
      })).json();

      const job = await runningJob({ experiment: experiment.id });
      const artifact = await readyArtifact(job);
      const version = (await registerVersion('fraud-detector', artifact.id)).json();

      // The chain the whole phase exists for: version -> artifact -> job -> experiment
      // -> dataset version. "What produced this model" has one answer.
      assert.equal(version.experiment_id, experiment.id);
    });

    test('another project’s artifact is refused', async () => {
      const other = (await app.inject({
        method: 'POST', url: '/api/v1/projects', payload: { name: uniqueName('other') },
      })).json();

      const foreign = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        payload: {
          project: other.name,
          name: uniqueName('job'),
          spec: { image: 'busybox:1.36' },
          resources: { cpu: 1 },
        },
      });
      const job = foreign.json();
      await runOnce(pool, backend);
      const launched = await getJob(pool, job.id);
      backend._setPhase('ashml-test', launched.k8s_job_name, Phase.RUNNING);
      await runOnce(pool, backend);

      const artifact = await readyArtifact(job, 'foreign.pt');
      const res = await registerVersion('fraud-detector', artifact.id);

      // One project's registry must not depend on another's retention.
      assert.equal(res.statusCode, 400, res.payload);
      assert.equal(res.json().error.code, 'ARTIFACT_PROJECT_MISMATCH');
    });

    test('an artifact that does not exist is a 404', async () => {
      const res = await registerVersion('fraud-detector', '00000000-0000-0000-0000-000000000000');
      assert.equal(res.statusCode, 404);
    });
  });

  // ------------------------------------------------------------- promotion

  describe('promotion', () => {
    beforeEach(async () => {
      assert.equal((await createModel()).statusCode, 201);
    });

    test('promoting sets the version the model means', async () => {
      await seedVersion();

      const res = await setStatus('fraud-detector', 1, ModelStatus.PRODUCTION);
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(res.json().version.status, ModelStatus.PRODUCTION);
      assert.ok(res.json().version.promoted_at, 'entering production is stamped');
      assert.equal(res.json().displaced, null, 'there was no incumbent');

      const model = (await app.inject({
        method: 'GET', url: `/api/v1/projects/${project.name}/models/fraud-detector`,
      })).json();
      assert.equal(model.production_version, 1);
    });

    test('a second promotion displaces the first, and only one is ever in production', async () => {
      await seedVersion('fraud-detector', 'v1.pt');
      await seedVersion('fraud-detector', 'v2.pt');
      assert.equal((await setStatus('fraud-detector', 1, ModelStatus.PRODUCTION)).statusCode, 200);

      const res = await setStatus('fraud-detector', 2, ModelStatus.PRODUCTION);
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(res.json().version.version, 2);
      assert.equal(res.json().displaced.version, 1);

      const versions = (await app.inject({
        method: 'GET', url: `/api/v1/projects/${project.name}/models/fraud-detector/versions`,
      })).json().versions;

      const production = versions.filter((v) => v.status === ModelStatus.PRODUCTION);
      assert.equal(production.length, 1, 'exactly one version may be in production');
      assert.equal(production[0].version, 2);

      // The displaced version goes where it can be rolled back from, not to the bin.
      const old = versions.find((v) => v.version === 1);
      assert.equal(old.status, ModelStatus.STAGING);
      assert.ok(old.promoted_at, 'it did once serve traffic, and that stays on the record');
    });

    test('a rollback is just promoting the previous version again', async () => {
      await seedVersion('fraud-detector', 'v1.pt');
      await seedVersion('fraud-detector', 'v2.pt');
      await setStatus('fraud-detector', 1, ModelStatus.PRODUCTION);
      await setStatus('fraud-detector', 2, ModelStatus.PRODUCTION);

      const res = await setStatus('fraud-detector', 1, ModelStatus.PRODUCTION);
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(res.json().displaced.version, 2);

      const model = (await app.inject({
        method: 'GET', url: `/api/v1/projects/${project.name}/models/fraud-detector`,
      })).json();
      assert.equal(model.production_version, 1);
    });

    test('promoting the version already in production is refused, not silently restamped', async () => {
      await seedVersion();
      const first = await setStatus('fraud-detector', 1, ModelStatus.PRODUCTION);
      const stamp = first.json().version.promoted_at;

      const again = await setStatus('fraud-detector', 1, ModelStatus.PRODUCTION);
      assert.equal(again.statusCode, 409, again.payload);
      assert.equal(again.json().error.code, 'ILLEGAL_MODEL_TRANSITION');

      const version = (await app.inject({
        method: 'GET', url: `/api/v1/projects/${project.name}/models/fraud-detector/versions/1`,
      })).json();
      assert.equal(version.promoted_at, stamp, 'the original promotion time stands');
    });

    test('an archived version cannot come back', async () => {
      await seedVersion();
      assert.equal((await setStatus('fraud-detector', 1, ModelStatus.ARCHIVED)).statusCode, 200);

      const res = await setStatus('fraud-detector', 1, ModelStatus.PRODUCTION);
      assert.equal(res.statusCode, 409, res.payload);
      assert.equal(res.json().error.code, 'ILLEGAL_MODEL_TRANSITION');
    });

    test('several versions may sit in staging at once', async () => {
      await seedVersion('fraud-detector', 'v1.pt');
      await seedVersion('fraud-detector', 'v2.pt');

      assert.equal((await setStatus('fraud-detector', 1, ModelStatus.STAGING)).statusCode, 200);
      assert.equal((await setStatus('fraud-detector', 2, ModelStatus.STAGING)).statusCode, 200);

      const staged = (await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.name}/models/fraud-detector/versions?status=STAGING`,
      })).json().versions;

      // Evaluating candidates is exactly what several-at-once looks like; only
      // production is exclusive.
      assert.deepEqual(staged.map((v) => v.version), [2, 1]);
    });

    test('a version that does not exist is a 404', async () => {
      await seedVersion();
      assert.equal((await setStatus('fraud-detector', 99, ModelStatus.PRODUCTION)).statusCode, 404);
    });
  });

  // ------------------------------------------------------- the production read

  describe('what is serving', () => {
    beforeEach(async () => {
      assert.equal((await createModel()).statusCode, 201);
    });

    test('a model with nothing promoted has no production version', async () => {
      await seedVersion();

      const res = await app.inject({
        method: 'GET', url: `/api/v1/projects/${project.name}/models/fraud-detector/production`,
      });
      // Not an error condition for a human, but a router asking "what do I serve" needs
      // a definite no rather than an empty success.
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error.code, 'NO_PRODUCTION_VERSION');
    });

    test('the production read answers with the whole version, artifact included', async () => {
      const { artifact } = await seedVersion();
      await setStatus('fraud-detector', 1, ModelStatus.PRODUCTION);

      const res = await app.inject({
        method: 'GET', url: `/api/v1/projects/${project.name}/models/fraud-detector/production`,
      });
      assert.equal(res.statusCode, 200, res.payload);

      const version = res.json().version;
      assert.equal(version.version, 1);
      // Everything needed to actually pull the bytes, without a second round trip.
      assert.equal(version.artifact.id, artifact.id);
      assert.equal(version.artifact.uri, artifact.uri);
    });

    test('an unverified artifact is flagged on the version, not hidden', async () => {
      await seedVersion();
      await setStatus('fraud-detector', 1, ModelStatus.PRODUCTION);

      const version = (await app.inject({
        method: 'GET', url: `/api/v1/projects/${project.name}/models/fraud-detector/production`,
      })).json().version;

      // This suite runs with no artifact store, so nothing could be checked. The
      // registry says so rather than letting READY imply AshML saw the bytes.
      assert.equal(version.artifact.verified, false);
    });
  });
});
