/**
 * Integration tests for asking a deployment a question.
 *
 * The thing being protected is the difference between an answer and a plausible-looking
 * answer. A prediction that comes back without saying which model produced it, or a
 * failure that comes back as a bare 502, both leave the caller with something they cannot
 * act on — and both are easy to write by accident, because the happy path looks identical
 * either way.
 *
 * The sim backend stands in for the cluster. It refuses to invent predictions by design,
 * so every test that needs a service to answer installs its own responder: the fixture
 * then lives in the test that wanted it rather than in a backend anything could be
 * pointed at.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { createNoneStore } from '../storage/none.js';
import { Phase } from '../k8s/backend.js';
import { JobState } from '../domain/job-state.js';
import { runOnce } from './executor.js';
import { discoverCluster } from './nodes.js';
import { getJob } from './jobs.js';
import { connectOrNull, truncateAll, uniqueName, SKIP_MESSAGE, authenticateAs, asRun } from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => {
  await pool?.end();
});

describe('predicting through a deployment (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let backend;
  let project;
  const runHeaders = new Map();

  /** Producing an artifact is the run's act, not a person's (ADR 0013). */
  async function asJob(jobId) {
    if (!runHeaders.has(jobId)) runHeaders.set(jobId, await asRun(pool, jobId));
    return runHeaders.get(jobId);
  }

  const NAMESPACE = 'ashml-test';

  /** One 1x1 "image". The shape is the model server's business, not this API's. */
  const INSTANCES = [[[[10, 20, 30]]]];

  before(async () => {
    const config = loadConfig({
      ASHML_GPU_PROVIDER: 'sim',
      ASHML_K8S_BACKEND: 'sim',
      ASHML_VERSION: '0.0.0-test',
    });
    backend = createSimBackend({ namespace: NAMESPACE, autoAdvance: false });
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
    await truncateAll(pool);
    runHeaders.clear();
    backend._reset();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('proj'), description: 'inference test' },
    });
    assert.equal(res.statusCode, 201);
    project = res.json();
  });

  // ------------------------------------------------------------- fixtures

  /** A deployed model, ready to be asked things. Returns its deployment record. */
  async function deployedModel() {
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: project.name,
        name: uniqueName('job'),
        spec: { image: 'busybox:1.36', command: ['sh', '-c', 'true'] },
        resources: { cpu: 1 },
      },
    });
    assert.equal(submitted.statusCode, 201, submitted.payload);
    const job = submitted.json();

    await runOnce(pool, backend);
    const launched = await getJob(pool, job.id);
    assert.equal(launched.state, JobState.STARTING, 'setup: the job should have launched');
    backend._setPhase(NAMESPACE, launched.k8s_job_name, Phase.RUNNING);
    await runOnce(pool, backend);

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/artifacts`,
      headers: await asJob(job.id),
      payload: {
        kind: 'model',
        name: 'model.pt',
        uri: 'file:///models/model.pt',
        metadata: { architecture: 'resnet18-cifar' },
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const artifact = created.json().artifact;
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifact.id}/complete`,
      headers: await asJob(job.id),
      payload: { digest: 'sha256:abc', size_bytes: 2048 },
    });
    assert.equal(completed.statusCode, 200, completed.payload);

    const model = uniqueName('model');
    assert.equal((await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models`,
      payload: { name: model },
    })).statusCode, 201);
    assert.equal((await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models/${model}/versions`,
      payload: { artifact_id: artifact.id },
    })).statusCode, 201);
    assert.equal((await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models/${model}/versions/1/status`,
      payload: { status: 'PRODUCTION' },
    })).statusCode, 200);

    const deployed = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models/${model}/deployments`,
      payload: {},
    });
    assert.equal(deployed.statusCode, 200, deployed.payload);
    const deployment = deployed.json();

    // A ready pod behind the address, so that what these tests exercise is the proxy and
    // not a Service with no endpoints. Predicting through a deployment that has not come
    // up yet is its own test, further down.
    backend._setReady(NAMESPACE, deployment.targets[0].k8s_name, deployment.replicas);
    return deployment;
  }

  const predict = (name, payload = { instances: INSTANCES }) => app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project.name}/deployments/${name}/predict`,
    payload,
  });

  /** A model server that answers one prediction, as the real one would. */
  function answersWith(predictions, { status = 200, extra = {} } = {}) {
    backend._setServiceResponder(async () => ({
      status,
      body: { predictions, latency_ms: 4.2, arch: 'resnet18-cifar', ...extra },
      text: '',
    }));
  }

  // ---------------------------------------------------------------- tests

  test('an answer says which model version produced it', async () => {
    // Provenance is the one thing this endpoint adds over a bare proxy, and it is not
    // optional: a prediction nobody can attribute to a version is how the wrong model
    // serves for a week without anyone noticing.
    const deployment = await deployedModel();
    answersWith([{ class_id: 3, class_name: 'cat', confidence: 0.87 }]);

    const res = await predict(deployment.name);
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    assert.equal(body.predictions[0].class_name, 'cat');
    assert.equal(body.served_by.deployment, deployment.name);
    assert.equal(body.served_by.model, deployment.model);
    assert.equal(body.served_by.version, 1);
    assert.equal(body.served_by.artifact_id, deployment.targets[0].artifact_id);
    assert.equal(body.arch, 'resnet18-cifar');
  });

  test('both latencies are reported, because they measure different things', async () => {
    const deployment = await deployedModel();
    answersWith([{ class_id: 0, class_name: 'airplane', confidence: 0.5 }]);

    const body = (await predict(deployment.name)).json();
    // The pod's own measurement of the forward pass, and ours of the whole round trip.
    // Reporting only the first credits the platform with a latency it does not deliver.
    assert.equal(body.latency_ms, 4.2);
    assert.ok(body.round_trip_ms >= 0);
  });

  test('the instances are relayed unchanged, not reshaped on the way', async () => {
    // The transform belongs to the server that owns the weights. A second implementation
    // on this side of the wire is a silent accuracy loss no error message points at.
    const deployment = await deployedModel();
    let seen = null;
    backend._setServiceResponder(async (ns, name, options) => {
      seen = options.body;
      return { status: 200, body: { predictions: [], latency_ms: 1 }, text: '' };
    });

    await predict(deployment.name, { instances: INSTANCES });
    assert.deepEqual(seen, { instances: INSTANCES });
  });

  test('the sim backend refuses to invent a prediction', async () => {
    // Rule 5, at the point it would be easiest to break. Every other thing sim fabricates
    // is infrastructure; model output is not, and a fabricated class label is
    // indistinguishable from a real one once it has been copied into a demo.
    const deployment = await deployedModel();

    const res = await predict(deployment.name);
    assert.equal(res.statusCode, 502, res.payload);
    assert.match(res.json().error.message, /will not\s+fabricate model output/);
  });

  test('a deployment that was never launched says so, rather than timing out', async () => {
    const deployment = await deployedModel();
    // Undo the launch the way a failed create would leave it: a record with no objects.
    await pool.query('UPDATE deployments SET k8s_name = NULL WHERE id = $1', [deployment.id]);

    const res = await predict(deployment.name);
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error.code, 'DEPLOYMENT_NOT_LAUNCHED');
  });

  test('predicting through a deployment that does not exist is a 404', async () => {
    const res = await predict('no-such-deployment');
    assert.equal(res.statusCode, 404, res.payload);
  });

  test('an empty batch is refused before anything is called', async () => {
    const deployment = await deployedModel();
    let called = false;
    backend._setServiceResponder(async () => {
      called = true;
      return { status: 200, body: { predictions: [] }, text: '' };
    });

    const res = await predict(deployment.name, { instances: [] });
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(called, false, 'nothing should be asked to predict on nothing');
  });

  test("a model server's complaint about the batch comes back as the caller's 400", async () => {
    // The shape is the server's business, so its message is the useful one. Relaying it
    // as a 502 would tell the caller their request was fine and something broke.
    const deployment = await deployedModel();
    backend._setServiceResponder(async () => ({
      status: 400,
      body: { error: 'expected each instance to be 32x32x3, got batch shape (1, 1, 1, 3)' },
      text: '',
    }));

    const res = await predict(deployment.name);
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(res.json().error.code, 'INVALID_INSTANCES');
    assert.match(res.json().error.message, /32x32x3/);
  });

  test('a pod with no model loaded is a 503 that carries what AshML last saw', async () => {
    // 503 is above the threshold at which the error handler hides messages, and this is
    // exactly the case where the message is the whole value of the response.
    const deployment = await deployedModel();
    backend._setServiceResponder(async () => ({
      status: 503,
      body: { error: 'model not loaded', detail: 'ConnectionRefusedError' },
      text: '',
    }));

    const res = await predict(deployment.name);
    assert.equal(res.statusCode, 503, res.payload);
    const { code, message } = res.json().error;
    assert.equal(code, 'DEPLOYMENT_NOT_SERVING');
    assert.match(message, /model not loaded/);
    assert.match(message, /AshML last observed it PROGRESSING/);
    assert.match(message, /0\/1 replicas ready/);
  });

  test('a service that cannot be reached blames the path, not the pod', async () => {
    const deployment = await deployedModel();
    backend._setServiceResponder(async () => {
      throw new Error('no answer from ashml-svc-x within 15000ms');
    });

    const res = await predict(deployment.name);
    assert.equal(res.statusCode, 502, res.payload);
    assert.equal(res.json().error.code, 'DEPLOYMENT_UNREACHABLE');
    assert.match(res.json().error.message, /no answer from/);
  });

  test('an internal failure is still masked, so `expose` did not open the floodgate', async () => {
    // The error handler was taught to show messages for deliberately-constructed upstream
    // errors. This is the check that it did not start showing them for everything: an
    // unexpected exception's message is an internal detail.
    const deployment = await deployedModel();
    backend._setServiceResponder(async () => ({
      status: 200,
      // A body the response schema cannot serialise: `predictions` must be an array.
      body: { predictions: { not: 'an array' } },
      text: '',
    }));

    const res = await predict(deployment.name);
    assert.equal(res.statusCode, 500, res.payload);
    assert.equal(res.json().error.message, 'Internal server error');
  });

  // ------------------------------------------------------------- metadata

  const metadata = (name) => app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project.name}/deployments/${name}/metadata`,
  });

  test('metadata puts what the pod loaded next to what AshML recorded', async () => {
    const deployment = await deployedModel();
    backend._setServiceResponder(async () => ({
      status: 200,
      body: {
        arch: 'resnet18-cifar',
        artifact_id: deployment.targets[0].artifact_id,
        ready: true,
        source_uri: 'file:///models/model.pt',
      },
      text: '',
    }));

    const body = (await metadata(deployment.name)).json();
    assert.equal(body.artifact_id, deployment.targets[0].artifact_id);
    assert.equal(body.reported.artifact_id, deployment.targets[0].artifact_id);
    assert.equal(body.matches_record, true);
  });

  test('a pod serving something else is reported as a mismatch, not averaged away', async () => {
    // The failure this catches produces predictions that cannot be reproduced from the
    // registered version, and nothing else in the platform would ever mention it.
    const deployment = await deployedModel();
    backend._setServiceResponder(async () => ({
      status: 200,
      body: { arch: 'resnet18-cifar', artifact_id: '00000000-0000-4000-8000-000000000000', ready: true },
      text: '',
    }));

    const body = (await metadata(deployment.name)).json();
    assert.equal(body.matches_record, false);
  });

  test('a pod that does not say what it loaded is null, which is not a mismatch', async () => {
    const deployment = await deployedModel();
    backend._setServiceResponder(async () => ({
      status: 200, body: { arch: 'resnet18-cifar', ready: true }, text: '',
    }));

    const body = (await metadata(deployment.name)).json();
    assert.equal(body.matches_record, null);
  });
});
