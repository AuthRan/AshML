/**
 * Integration tests for experiments and the job -> experiment link.
 *
 * An experiment exists to answer "what exactly produced this model", so most of what
 * is asserted here is that a half-specified run is refused rather than stored.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { connectOrNull, truncateAll, uniqueName, SKIP_MESSAGE } from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => {
  await pool?.end();
});

describe('experiments (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let project;

  before(async () => {
    const config = loadConfig({ ASHML_GPU_PROVIDER: 'sim', ASHML_VERSION: '0.0.0-test' });
    app = await buildApp(config, { logger: false, pool });
    await app.ready();
  });

  after(async () => {
    await app?.close();
  });

  async function createProject() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('proj') },
    });
    assert.equal(res.statusCode, 201);
    return res.json();
  }

  beforeEach(async () => {
    await truncateAll(pool);
    project = await createProject();
  });

  function createExperiment(payload) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/experiments',
      payload: { project: project.name, name: 'resnet-baseline', ...payload },
    });
  }

  /** Registers a dataset with one version and returns [datasetName, version]. */
  async function seedDataset(name = 'cifar10', version = 'v1') {
    let res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/datasets`,
      payload: { name },
    });
    assert.equal(res.statusCode, 201);

    res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/datasets/${name}/versions`,
      payload: { version, uri: `s3://ashml/${name}/${version}`, digest: 'sha256:beef' },
    });
    assert.equal(res.statusCode, 201);
    return [name, version, res.json().id];
  }

  function submitJob(payload = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: project.name,
        name: uniqueName('job'),
        spec: { image: 'ash/ml-pytorch@sha256:abc' },
        resources: { cpu: 4, gpu: 1 },
        ...payload,
      },
    });
  }

  test('an experiment records the full reproducibility set', async () => {
    const [dataset, version, versionId] = await seedDataset();

    const res = await createExperiment({
      git_commit: '9f2c1ab',
      image_digest: 'sha256:deadbeef',
      dataset,
      dataset_version: version,
      hyperparameters: { lr: 0.001, batch_size: 128, optimizer: 'adamw' },
      random_seed: 1337,
    });
    assert.equal(res.statusCode, 201);

    const { reproducibility } = res.json();
    assert.equal(reproducibility.git_commit, '9f2c1ab');
    assert.equal(reproducibility.image_digest, 'sha256:deadbeef');
    assert.deepEqual(reproducibility.dataset, { name: dataset, version, version_id: versionId });
    assert.deepEqual(reproducibility.hyperparameters, { lr: 0.001, batch_size: 128, optimizer: 'adamw' });
    assert.equal(reproducibility.random_seed, 1337);
  });

  test('an experiment pins the dataset version id, not the version name', async () => {
    const [dataset, version, versionId] = await seedDataset();
    const created = await createExperiment({ dataset, dataset_version: version });

    // The id is the durable reference; the name is shown for humans.
    assert.equal(created.json().reproducibility.dataset.version_id, versionId);
  });

  test('naming a dataset without a version is refused', async () => {
    const [dataset] = await seedDataset();
    const res = await createExperiment({ dataset });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'INCOMPLETE_DATASET_REFERENCE');
  });

  test('naming a version without a dataset is refused', async () => {
    const res = await createExperiment({ dataset_version: 'v1' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'INCOMPLETE_DATASET_REFERENCE');
  });

  test('pinning to a version that was never registered is a 404', async () => {
    const [dataset] = await seedDataset();
    const res = await createExperiment({ dataset, dataset_version: 'v99' });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error.message, /no version "v99"/);
  });

  test('an experiment without a dataset is allowed and says so plainly', async () => {
    const res = await createExperiment({});
    assert.equal(res.statusCode, 201);

    const { reproducibility } = res.json();
    assert.equal(reproducibility.dataset, null);
    assert.equal(reproducibility.git_commit, null, 'an unrecorded commit must read as null, not ""');
    assert.deepEqual(reproducibility.hyperparameters, {});
  });

  test('experiments may share a name — each run is its own record', async () => {
    const first = await createExperiment({ random_seed: 1 });
    const second = await createExperiment({ random_seed: 2 });
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.notEqual(first.json().id, second.json().id);
  });

  test('a job submitted against an experiment reports it, and the experiment counts it', async () => {
    const experiment = (await createExperiment({})).json();

    const res = await submitJob({ experiment: experiment.id });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json().experiment, { id: experiment.id, name: experiment.name });

    const after = await app.inject({ method: 'GET', url: `/api/v1/experiments/${experiment.id}` });
    assert.equal(after.json().job_count, 1);
  });

  test('a job without an experiment reports null', async () => {
    const res = await submitJob();
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().experiment, null);
  });

  test('a job cannot borrow another project\'s experiment', async () => {
    const experiment = (await createExperiment({})).json();

    // Quotas and scheduling are per project; cross-project attribution would make
    // both projects' accounting wrong.
    const other = await createProject();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: other.name,
        name: uniqueName('job'),
        spec: { image: 'ash/ml-pytorch:latest' },
        resources: { cpu: 1 },
        experiment: experiment.id,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'EXPERIMENT_PROJECT_MISMATCH');
  });

  test('submitting against an unknown experiment is a 404 and creates no job', async () => {
    const ghost = '00000000-0000-0000-0000-0000000000ff';
    const res = await submitJob({ experiment: ghost });
    assert.equal(res.statusCode, 404);

    // The whole submission is one transaction, so the rejected job must not linger.
    const jobs = await app.inject({ method: 'GET', url: `/api/v1/jobs?project=${project.name}` });
    assert.equal(jobs.json().jobs.length, 0);
  });

  test('experiments list newest first and filter by project', async () => {
    const mine = (await createExperiment({ name: 'mine' })).json();

    const other = await createProject();
    const theirs = await app.inject({
      method: 'POST',
      url: '/api/v1/experiments',
      payload: { project: other.name, name: 'theirs' },
    });
    assert.equal(theirs.statusCode, 201);

    const res = await app.inject({ method: 'GET', url: `/api/v1/experiments?project=${project.name}` });
    assert.deepEqual(res.json().experiments.map((e) => e.id), [mine.id]);
  });

  test('a seed of zero is stored, not treated as absent', async () => {
    // 0 is a perfectly ordinary seed; `??` rather than `||` is what keeps it.
    const res = await createExperiment({ random_seed: 0 });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().reproducibility.random_seed, 0);
  });

  describe('a run reporting on itself', () => {
    function report(id, payload) {
      return app.inject({ method: 'POST', url: `/api/v1/experiments/${id}/report`, payload });
    }

    test('a fresh experiment has started nothing and observed nothing', async () => {
      const experiment = (await createExperiment()).json();
      assert.equal(experiment.started_at, null);
      assert.equal(experiment.ended_at, null);
      // Deliberately empty rather than guessed from the job: a container starting is
      // not training starting, and there is nothing here to copy from anyway.
      assert.deepEqual(experiment.reproducibility.observed, {
        framework: null, hardware: {}, sdk_version: null,
      });
    });

    test('reporting a start stamps the time and records what the run observed', async () => {
      const experiment = (await createExperiment()).json();

      const res = await report(experiment.id, {
        phase: 'started',
        framework: 'pytorch 2.4.1',
        hardware: { gpus: 1, model: 'NVIDIA GeForce RTX 2080 Ti', cuda: '12.4' },
        sdk_version: '0.1.0',
      });
      assert.equal(res.statusCode, 200, res.payload);

      const reported = res.json();
      assert.ok(reported.started_at, 'started_at must be stamped by the run');
      assert.equal(reported.ended_at, null);
      assert.equal(reported.reproducibility.observed.framework, 'pytorch 2.4.1');
      assert.equal(reported.reproducibility.observed.sdk_version, '0.1.0');
      assert.equal(reported.reproducibility.observed.hardware.model, 'NVIDIA GeForce RTX 2080 Ti');

      // What was asked for is untouched by what was observed; both halves are the record.
      assert.equal(reported.reproducibility.random_seed, null);
    });

    test('finishing stamps the end without disturbing the start', async () => {
      const experiment = (await createExperiment()).json();
      const started = (await report(experiment.id, { phase: 'started' })).json();

      const finished = (await report(experiment.id, { phase: 'finished' })).json();
      assert.equal(finished.started_at, started.started_at);
      assert.ok(finished.ended_at);
      assert.ok(
        new Date(finished.ended_at) >= new Date(finished.started_at),
        'a run cannot end before it began',
      );
    });

    test('a second run does not reset when the experiment started', async () => {
      const experiment = (await createExperiment()).json();
      const first = (await report(experiment.id, {
        phase: 'started', framework: 'pytorch 2.4.1',
      })).json();

      // A retry is the ordinary case. The experiment started when its first run did.
      const second = (await report(experiment.id, {
        phase: 'started', framework: 'pytorch 2.5.0',
      })).json();

      assert.equal(second.started_at, first.started_at, 'started_at is COALESCEd, not overwritten');
      // The observed fields do move: the useful answer to "what did this run on" is
      // the most recent run, not the first.
      assert.equal(second.reproducibility.observed.framework, 'pytorch 2.5.0');
    });

    test('finishing a run whose start was never reported is accepted', async () => {
      const experiment = (await createExperiment()).json();

      // A crashed reporter, or an SDK upgraded mid-run. Half a record beats none, so
      // this is stamped rather than refused.
      const res = await report(experiment.id, { phase: 'finished' });
      assert.equal(res.statusCode, 200, res.payload);
      assert.ok(res.json().ended_at);
      assert.equal(res.json().started_at, null, 'and the gap stays visible');
    });

    test('a phase the platform does not know is refused', async () => {
      const experiment = (await createExperiment()).json();
      const res = await report(experiment.id, { phase: 'paused' });
      assert.equal(res.statusCode, 400, res.payload);
    });

    test('reporting against an unknown experiment is a 404', async () => {
      const res = await report('00000000-0000-0000-0000-000000000000', { phase: 'started' });
      assert.equal(res.statusCode, 404);
    });
  });
});
