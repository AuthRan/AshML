/**
 * Integration tests for datasets against a real PostgreSQL.
 *
 * The property worth defending here is version immutability: once a version exists it
 * cannot be redefined, because experiments pin to it.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { connectOrNull, truncateAll, uniqueName, SKIP_MESSAGE, authenticateAs } from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => {
  await pool?.end();
});

describe('datasets (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
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

  function createDataset(name, projectName = project.name) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectName}/datasets`,
      payload: { name },
    });
  }

  function addVersion(dataset, payload) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/datasets/${dataset}/versions`,
      payload,
    });
  }

  test('a new dataset has no versions yet', async () => {
    const res = await createDataset('cifar10');
    assert.equal(res.statusCode, 201);

    const body = res.json();
    assert.equal(body.name, 'cifar10');
    assert.equal(body.project, project.name);
    assert.equal(body.version_count, 0);
    assert.equal(body.latest_version, null);
  });

  test('duplicate dataset names within a project are a 409', async () => {
    assert.equal((await createDataset('cifar10')).statusCode, 201);

    const res = await createDataset('cifar10');
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'DATASET_EXISTS');
  });

  test('the same dataset name in another project is fine', async () => {
    assert.equal((await createDataset('cifar10')).statusCode, 201);

    // Names are unique per project, not globally — two teams may both have "cifar10".
    const other = await createProject();
    assert.equal((await createDataset('cifar10', other.name)).statusCode, 201);
  });

  test('creating a dataset in a project that does not exist is a 404', async () => {
    const res = await createDataset('cifar10', 'no-such-project');
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error.message, /project "no-such-project"/);
  });

  test('registering a version returns it with its uri and digest', async () => {
    await createDataset('cifar10');

    const res = await addVersion('cifar10', {
      version: 'v1',
      uri: 's3://ashml/datasets/cifar10/v1',
      digest: 'sha256:abc123',
      size_bytes: 170_498_071,
    });
    assert.equal(res.statusCode, 201);

    const body = res.json();
    assert.equal(body.version, 'v1');
    assert.equal(body.dataset, 'cifar10');
    assert.equal(body.project, project.name);
    assert.equal(body.uri, 's3://ashml/datasets/cifar10/v1');
    assert.equal(body.digest, 'sha256:abc123');
    assert.equal(body.size_bytes, 170_498_071);
  });

  test('a version cannot be redefined', async () => {
    await createDataset('cifar10');
    assert.equal((await addVersion('cifar10', { version: 'v1', uri: 's3://a' })).statusCode, 201);

    // Immutability is the whole point: an experiment pinned to v1 must keep meaning
    // the same bytes forever (spec §34).
    const res = await addVersion('cifar10', { version: 'v1', uri: 's3://something-else' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'DATASET_VERSION_EXISTS');

    const check = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.name}/datasets/cifar10/versions/v1`,
    });
    assert.equal(check.json().uri, 's3://a', 'the original uri must survive the rejected write');
  });

  test('versions list newest first and drive latest_version', async () => {
    await createDataset('cifar10');
    for (const version of ['v1', 'v2', 'v3']) {
      assert.equal((await addVersion('cifar10', { version, uri: `s3://${version}` })).statusCode, 201);
    }

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.name}/datasets/cifar10/versions`,
    });
    assert.deepEqual(list.json().versions.map((v) => v.version), ['v3', 'v2', 'v1']);

    const dataset = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.name}/datasets/cifar10`,
    });
    assert.equal(dataset.json().version_count, 3);
    assert.equal(dataset.json().latest_version, 'v3');
  });

  test('sizes larger than a 32-bit integer round-trip as numbers', async () => {
    await createDataset('imagenet');
    const sizeBytes = 150 * 1024 ** 3; // 150 GiB, well past INT4 and still exact as a double

    const res = await addVersion('imagenet', { version: 'v1', uri: 's3://imagenet', size_bytes: sizeBytes });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().size_bytes, sizeBytes);
    assert.equal(typeof res.json().size_bytes, 'number', 'BIGINT must not surface as a string');
  });

  test('a missing dataset and a missing project produce different messages', async () => {
    const missingDataset = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.name}/datasets/nope`,
    });
    assert.equal(missingDataset.statusCode, 404);
    assert.match(missingDataset.json().error.message, /dataset "nope"/);

    const missingProject = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/no-such-project/datasets/nope',
    });
    assert.equal(missingProject.statusCode, 404);
    assert.match(missingProject.json().error.message, /project "no-such-project"/);
  });

  test('listing datasets for an unknown project is a 404, not an empty list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/no-such-project/datasets' });
    assert.equal(res.statusCode, 404);
  });

  test('a version with no digest is allowed but reports null rather than an empty string', async () => {
    await createDataset('scraped');
    const res = await addVersion('scraped', { version: 'v1', uri: 's3://scraped' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().digest, null);
  });
});
