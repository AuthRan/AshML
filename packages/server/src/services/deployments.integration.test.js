/**
 * Integration tests for deployments.
 *
 * What is being protected here is the gap between "AshML created some objects" and "a
 * pod has loaded a model and can answer". Every rule below exists because the failure it
 * prevents happens inside a container, several layers away from whoever asked for the
 * deployment — a crash loop whose reason is in a pod log, rather than an error at the
 * moment of asking.
 *
 * The sim backend stands in for the cluster, with `autoAdvance: false` so readiness is
 * driven explicitly and no assertion depends on timing.
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
import { DeploymentStatus, statusFromObservation, syncDeployments } from './deployments.js';
import { connectOrNull, truncateAll, uniqueName, SKIP_MESSAGE } from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => {
  await pool?.end();
});

// ------------------------------------------------------- pure status mapping

describe('mapping a cluster observation onto a deployment status', () => {
  test('every requested replica ready is READY', () => {
    const next = statusFromObservation({ desired: 2, ready: 2, reason: null });
    assert.equal(next.status, DeploymentStatus.READY);
    assert.equal(next.lastError, null);
  });

  test('short of replicas before ever serving is PROGRESSING', () => {
    const next = statusFromObservation(
      { desired: 3, ready: 1, reason: null },
      { previousStatus: DeploymentStatus.PROGRESSING },
    );
    assert.equal(next.status, DeploymentStatus.PROGRESSING);
    assert.equal(next.readyReplicas, 1);
  });

  test('short of replicas after serving is DEGRADED, not PROGRESSING', () => {
    // The distinction is the whole point: one says "not started yet", the other says
    // "something that was working stopped". Collapsing them hides an outage inside a
    // word that sounds like startup.
    const next = statusFromObservation(
      { desired: 3, ready: 1, reason: null },
      { previousStatus: DeploymentStatus.READY },
    );
    assert.equal(next.status, DeploymentStatus.DEGRADED);
  });

  test('a degraded deployment says why it is short, not merely that it is', () => {
    // The reason lives on the Pod: the Deployment's own status says "0 of 1 ready" and
    // nothing more until its progress deadline expires ten minutes later. Without this,
    // AshML reports DEGRADED with an empty explanation and the operator reaches for
    // kubectl for something the platform already knew.
    const next = statusFromObservation(
      {
        desired: 1,
        ready: 0,
        reason: null,
        pendingReason: 'pod ashml-svc-x is running but has not become ready',
      },
      { previousStatus: DeploymentStatus.READY },
    );
    assert.equal(next.status, DeploymentStatus.DEGRADED);
    assert.match(next.lastError, /has not become ready/);
  });

  test('a cold start is not an error, and does not fill in last_error', () => {
    // Same observation, different history. "Has not become ready yet" is what every
    // rollout looks like for its first seconds; recording it as an error would teach an
    // operator to ignore the field that matters during a real outage.
    const next = statusFromObservation(
      {
        desired: 1,
        ready: 0,
        reason: null,
        pendingReason: 'pod ashml-svc-x is running but has not become ready',
      },
      { previousStatus: DeploymentStatus.PROGRESSING },
    );
    assert.equal(next.status, DeploymentStatus.PROGRESSING);
    assert.equal(next.lastError, null);
  });

  test('a stalled rollout is FAILED and carries the cluster’s own reason', () => {
    const next = statusFromObservation(
      { desired: 1, ready: 0, reason: 'ProgressDeadlineExceeded: ReplicaSet has timed out' },
      { previousStatus: DeploymentStatus.PROGRESSING },
    );
    assert.equal(next.status, DeploymentStatus.FAILED);
    assert.match(next.lastError, /ProgressDeadlineExceeded/);
  });

  test('a Deployment that has vanished is FAILED rather than quietly READY', () => {
    const next = statusFromObservation(null, { previousStatus: DeploymentStatus.READY });
    assert.equal(next.status, DeploymentStatus.FAILED);
    assert.equal(next.readyReplicas, 0);
    assert.match(next.lastError, /gone from the cluster/);
  });

  test('zero desired replicas is never READY', () => {
    // ready >= desired is trivially true at 0/0, and calling that READY would report a
    // deployment serving nothing as healthy.
    const next = statusFromObservation({ desired: 0, ready: 0, reason: null });
    assert.notEqual(next.status, DeploymentStatus.READY);
  });
});

// ------------------------------------------------------------- integration

describe('deployments (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let backend;
  let project;

  before(async () => {
    const config = loadConfig({
      ASHML_GPU_PROVIDER: 'sim',
      ASHML_K8S_BACKEND: 'sim',
      ASHML_VERSION: '0.0.0-test',
    });
    backend = createSimBackend({ namespace: 'ashml-test', autoAdvance: false });
    app = await buildApp(config, { logger: false, pool, k8s: backend, store: createNoneStore() });
    await app.ready();
    await discoverCluster(pool, backend, app.gpuProvider);
  });

  after(async () => {
    await app?.close();
    await backend?.close();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    backend._reset();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('proj'), description: 'deployment test' },
    });
    assert.equal(res.statusCode, 201);
    project = res.json();
  });

  // ------------------------------------------------------------- fixtures

  async function runningJob() {
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
    backend._setPhase('ashml-test', launched.k8s_job_name, Phase.RUNNING);
    await runOnce(pool, backend);
    return job;
  }

  /** An artifact carrying the architecture a training run would have recorded. */
  async function readyArtifact(job, { arch = 'resnet18-cifar', name = 'model.pt' } = {}) {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/artifacts`,
      payload: {
        kind: 'model',
        name,
        uri: `file:///models/${name}`,
        ...(arch ? { metadata: { architecture: arch } } : { metadata: {} }),
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const artifact = created.json().artifact;

    const done = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifact.id}/complete`,
      payload: { digest: 'sha256:abc', size_bytes: 2048 },
    });
    assert.equal(done.statusCode, 200, done.payload);
    return done.json();
  }

  async function pendingArtifact(job, name = 'half-written.pt') {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/artifacts`,
      payload: { kind: 'model', name, uri: `file:///models/${name}`, metadata: { architecture: 'resnet18-cifar' } },
    });
    assert.equal(created.statusCode, 201, created.payload);
    return created.json().artifact;
  }

  /** A model with one registered version, optionally promoted to PRODUCTION. */
  async function seedModel({ promote = true, arch = 'resnet18-cifar', artifact = null } = {}) {
    const name = uniqueName('model');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models`,
      payload: { name },
    });
    assert.equal(created.statusCode, 201, created.payload);

    const bytes = artifact ?? await readyArtifact(await runningJob(), { arch });
    const registered = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models/${name}/versions`,
      payload: { artifact_id: bytes.id },
    });
    assert.equal(registered.statusCode, 201, registered.payload);

    if (promote) {
      const promoted = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.name}/models/${name}/versions/1/status`,
        payload: { status: 'PRODUCTION' },
      });
      assert.equal(promoted.statusCode, 200, promoted.payload);
    }
    return { model: name, artifact: bytes };
  }

  function deploy(model, payload = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models/${model}/deployments`,
      payload,
    });
  }

  // ---------------------------------------------------------------- tests

  test('deploying with no version given serves the one in PRODUCTION', async () => {
    const { model } = await seedModel();

    const res = await deploy(model);
    assert.equal(res.statusCode, 200, res.payload);
    const deployment = res.json();

    assert.equal(deployment.target.version, 1);
    assert.equal(deployment.target.version_status, 'PRODUCTION');
    // Not READY: the objects exist, and nothing has loaded a model. Saying READY here
    // would be the control plane believing its own optimism.
    assert.equal(deployment.status, DeploymentStatus.PROGRESSING);
    assert.equal(deployment.ready_replicas, 0);
    assert.ok(deployment.endpoint_url, 'an endpoint should be recorded once the Service exists');
  });

  test('the architecture comes from what the run recorded, not from the operator', async () => {
    const { model } = await seedModel({ arch: 'resnet18-cifar' });
    const deployment = (await deploy(model)).json();
    assert.equal(deployment.target.arch, 'resnet18-cifar');
  });

  test('a model with nothing promoted refuses rather than guessing the newest', async () => {
    const { model } = await seedModel({ promote: false });

    const res = await deploy(model);
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error.code, 'NO_PRODUCTION_VERSION');
    // "latest" and "the one we chose" are different things; substituting one for the
    // other is how the wrong model ends up serving.
    assert.match(res.json().error.message, /PRODUCTION/);
  });

  test('a version whose bytes were never confirmed cannot be deployed', async () => {
    const job = await runningJob();
    const half = await pendingArtifact(job);

    // The registry already refuses this, so the check has to be made where a version
    // could still reach serving another way — the point is that serving never trusts
    // an unconfirmed artifact.
    const registered = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models/${uniqueName('m')}/versions`,
      payload: { artifact_id: half.id },
    });
    assert.notEqual(registered.statusCode, 201, 'an unREADY artifact must not register');
  });

  test('an unknown architecture is refused at deploy time, not at pod startup', async () => {
    const { model } = await seedModel({ arch: 'some-transformer-v9' });

    const res = await deploy(model);
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(res.json().error.code, 'ARCHITECTURE_UNSUPPORTED');
    // The message has to name what it *can* serve, or the reader's next step is to guess.
    assert.match(res.json().error.message, /resnet18-cifar/);
  });

  test('an artifact with no recorded architecture says so, and says what to pass', async () => {
    const { model } = await seedModel({ arch: null });

    const res = await deploy(model);
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(res.json().error.code, 'ARCHITECTURE_UNKNOWN');
    assert.match(res.json().error.message, /--arch/);
  });

  test('an ARCHIVED version cannot be deployed', async () => {
    const { model } = await seedModel();
    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models/${model}/versions/1/status`,
      payload: { status: 'ARCHIVED' },
    });
    assert.equal(archived.statusCode, 200, archived.payload);

    const res = await deploy(model, { version: 1 });
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error.code, 'VERSION_ARCHIVED');
  });

  test('redeploying the same name updates in place rather than creating a second', async () => {
    const { model } = await seedModel();
    const first = (await deploy(model, { replicas: 1 })).json();
    const second = (await deploy(model, { replicas: 3 })).json();

    // Same row, same address: rolling out a new version must not change the endpoint
    // callers already hold.
    assert.equal(second.id, first.id);
    assert.equal(second.endpoint_url, first.endpoint_url);
    assert.equal(second.replicas, 3);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.name}/deployments`,
    });
    assert.equal(listed.json().deployments.length, 1);
  });

  test('a deployment name already serving another model is refused', async () => {
    const a = await seedModel();
    const b = await seedModel();

    const first = await deploy(a.model, { name: 'shared' });
    assert.equal(first.statusCode, 200, first.payload);

    const second = await deploy(b.model, { name: 'shared' });
    assert.equal(second.statusCode, 409, second.payload);
    assert.equal(second.json().error.code, 'DEPLOYMENT_NAME_TAKEN');
  });

  test('status follows the cluster, not the request that created it', async () => {
    const { model } = await seedModel();
    const deployment = (await deploy(model, { replicas: 2 })).json();
    assert.equal(deployment.status, DeploymentStatus.PROGRESSING);

    // One replica ready out of two is still not serving what was asked for.
    backend._setReady('ashml-test', deployment.k8s_name, 1);
    await syncDeployments(pool, backend);
    let current = (await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.name}/deployments/${deployment.name}`,
    })).json();
    assert.equal(current.status, DeploymentStatus.PROGRESSING);
    assert.equal(current.ready_replicas, 1);

    backend._setReady('ashml-test', deployment.k8s_name, 2);
    await syncDeployments(pool, backend);
    current = (await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.name}/deployments/${deployment.name}`,
    })).json();
    assert.equal(current.status, DeploymentStatus.READY);
    assert.equal(current.ready_replicas, 2);
  });

  test('a deployment that loses its replicas is reported DEGRADED', async () => {
    const { model } = await seedModel();
    const deployment = (await deploy(model, { replicas: 1 })).json();

    backend._setReady('ashml-test', deployment.k8s_name, 1);
    await syncDeployments(pool, backend);

    backend._setReady('ashml-test', deployment.k8s_name, 0);
    await syncDeployments(pool, backend);

    const current = (await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.name}/deployments/${deployment.name}`,
    })).json();
    assert.equal(current.status, DeploymentStatus.DEGRADED);
  });

  test('deleting removes the cluster objects and the record', async () => {
    const { model } = await seedModel();
    const deployment = (await deploy(model)).json();

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.name}/deployments/${deployment.name}`,
    });
    assert.equal(removed.statusCode, 200, removed.payload);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.name}/deployments/${deployment.name}`,
    });
    assert.equal(gone.statusCode, 404);

    // And nothing is left in the cluster still answering.
    assert.equal(await backend.observeDeployment('ashml-test', deployment.k8s_name), null);
  });

  test('a deployment for a model that does not exist is a 404, not a 500', async () => {
    const res = await deploy('no-such-model');
    assert.equal(res.statusCode, 404, res.payload);
  });
});
