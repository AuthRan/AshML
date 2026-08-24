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
import { connectOrNull, truncateAll, uniqueName, SKIP_MESSAGE, authenticateAs, asRun } from '../test-support/db.js';

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
    await truncateAll(pool);
    runHeaders.clear();
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
      headers: await asJob(job.id),
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
      headers: await asJob(job.id),
      payload: { digest: 'sha256:abc', size_bytes: 2048 },
    });
    assert.equal(done.statusCode, 200, done.payload);
    return done.json();
  }

  async function pendingArtifact(job, name = 'half-written.pt') {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/artifacts`,
      headers: await asJob(job.id),
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

  /** A second version of an existing model, so a rollout has somewhere to go. */
  async function addVersion(model, { arch = 'resnet18-cifar' } = {}) {
    const bytes = await readyArtifact(await runningJob(), { arch, name: uniqueName('m') + '.pt' });
    const registered = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models/${model}/versions`,
      payload: { artifact_id: bytes.id },
    });
    assert.equal(registered.statusCode, 201, registered.payload);
    return registered.json().version;
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

    assert.equal(deployment.targets.length, 1);
    assert.equal(deployment.targets[0].version, 1);
    assert.equal(deployment.targets[0].version_status, 'PRODUCTION');
    // Deploying one version gives it all of the traffic. There is nothing to decide, and
    // a weight that was anything but 100 would be a split with one side missing.
    assert.equal(deployment.targets[0].traffic_weight, 100);
    // Not READY: the objects exist, and nothing has loaded a model. Saying READY here
    // would be the control plane believing its own optimism.
    assert.equal(deployment.status, DeploymentStatus.PROGRESSING);
    assert.equal(deployment.ready_replicas, 0);
    assert.ok(deployment.endpoint_url, 'an endpoint should be recorded once the Service exists');
  });

  test('the architecture comes from what the run recorded, not from the operator', async () => {
    const { model } = await seedModel({ arch: 'resnet18-cifar' });
    const deployment = (await deploy(model)).json();
    assert.equal(deployment.targets[0].arch, 'resnet18-cifar');
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
    // Readiness is a property of a version's pods, not of the deployment's address:
    // `k8s_name` on the deployment is the front Service, which has no pods of its own.
    const pods = deployment.targets[0].k8s_name;

    // One replica ready out of two is still not serving what was asked for.
    backend._setReady('ashml-test', pods, 1);
    await syncDeployments(pool, backend);
    let current = (await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.name}/deployments/${deployment.name}`,
    })).json();
    assert.equal(current.status, DeploymentStatus.PROGRESSING);
    assert.equal(current.ready_replicas, 1);

    backend._setReady('ashml-test', pods, 2);
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
    const pods = deployment.targets[0].k8s_name;

    backend._setReady('ashml-test', pods, 1);
    await syncDeployments(pool, backend);

    backend._setReady('ashml-test', pods, 0);
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

    // And nothing is left in the cluster still answering — the version's pods, which is
    // where the model actually runs, not just the address in front of them.
    assert.equal(
      await backend.observeDeployment('ashml-test', deployment.targets[0].k8s_name),
      null,
    );
  });

  test('a deployment for a model that does not exist is a 404, not a 500', async () => {
    const res = await deploy('no-such-model');
    assert.equal(res.statusCode, 404, res.payload);
  });

  // ------------------------------------------------ changing what is served

  test('a new version starts alongside the old one; the address moves only when it is ready', async () => {
    const { model } = await seedModel();
    const first = (await deploy(model, { replicas: 1 })).json();
    const oldPods = first.targets[0].k8s_name;

    backend._setReady('ashml-test', oldPods, 1);
    await syncDeployments(pool, backend);
    assert.equal((await get(first.name)).status, DeploymentStatus.READY);

    await addVersion(model);
    const second = (await deploy(model, { version: 2, replicas: 1 })).json();
    const newPods = second.targets.find((t) => t.version === 2).k8s_name;
    assert.notEqual(newPods, oldPods, 'a version gets its own objects, not the previous one\'s');

    // Both exist. The old one is still the only thing that can answer, and it is still
    // what the address resolves to — this is the window a rolling update does not have.
    assert.ok(await backend.observeDeployment('ashml-test', oldPods));
    assert.ok(await backend.observeDeployment('ashml-test', newPods));
    let current = await get(first.name);
    assert.equal(current.serving_version, 1, 'the address must not move to pods with no model');
    assert.equal(current.status, DeploymentStatus.PROGRESSING);

    // Still nothing ready on the new version: syncing must not move the address either.
    await syncDeployments(pool, backend);
    assert.equal((await get(first.name)).serving_version, 1);

    backend._setReady('ashml-test', newPods, 1);
    await syncDeployments(pool, backend);

    current = await get(first.name);
    assert.equal(current.serving_version, 2, 'once the new version is ready the address moves');
    assert.equal(current.status, DeploymentStatus.READY);

    // v1 is still a target and takes none of the traffic. Kept rather than deleted, so
    // going back to it is a weight change rather than a redeploy.
    const byVersion = Object.fromEntries(current.targets.map((t) => [t.version, t]));
    assert.equal(byVersion[1].traffic_weight, 0);
    assert.equal(byVersion[2].traffic_weight, 100);
  });

  test('the version being replaced keeps its pods until the address has left it', async () => {
    const { model } = await seedModel();
    const first = (await deploy(model, { replicas: 1 })).json();
    const oldPods = first.targets[0].k8s_name;
    backend._setReady('ashml-test', oldPods, 1);
    await syncDeployments(pool, backend);

    await addVersion(model);
    const second = (await deploy(model, { version: 2, replicas: 1 })).json();
    const newPods = second.targets.find((t) => t.version === 2).k8s_name;

    // Scaling the old version down here would drop every request in flight: it has been
    // taken out of rotation and it is still the only thing answering.
    assert.equal(
      (await backend.observeDeployment('ashml-test', oldPods)).desired,
      1,
      'the outgoing version must keep its pods as long as the address points at it',
    );

    backend._setReady('ashml-test', newPods, 1);
    await syncDeployments(pool, backend);

    assert.equal(
      (await backend.observeDeployment('ashml-test', oldPods)).desired,
      0,
      'once nothing points at it, its pods are capacity held for no one',
    );
    // And it is still there to go back to — the objects are the rollback.
    assert.ok(await backend.observeDeployment('ashml-test', oldPods));
  });

  test('redeploying the version already serving changes nothing about the address', async () => {
    const { model } = await seedModel();
    const first = (await deploy(model, { replicas: 1 })).json();
    backend._setReady('ashml-test', first.targets[0].k8s_name, 1);
    await syncDeployments(pool, backend);

    const again = (await deploy(model)).json();
    assert.equal(again.targets[0].k8s_name, first.targets[0].k8s_name);
    assert.deepEqual(again.dropped_versions, []);
    assert.equal((await get(first.name)).serving_version, 1);
  });

  // -------------------------------------------------------- weighted routing

  /** Drives every version of a deployment, and its router, to ready. */
  async function makeEverythingReady(name) {
    let d = await get(name);
    for (const target of d.targets) {
      if (target.traffic_weight > 0 || target.version === d.serving_version) {
        backend._setReady('ashml-test', target.k8s_name, target.replicas);
      }
    }
    if (d.router_k8s_name) {
      backend._setReady('ashml-test', d.router_k8s_name, 2);
    }
    await syncDeployments(pool, backend);
    d = await get(name);
    return d;
  }

  function rollout(name, version, traffic) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/deployments/${name}/rollout`,
      payload: { version, traffic },
    });
  }

  test('the spec\'s sequence: 10%, then 50%, then promote', async () => {
    const { model } = await seedModel();
    const first = (await deploy(model, { replicas: 1 })).json();
    await makeEverythingReady(first.name);
    await addVersion(model);

    // 10% to v2. The weights are written immediately; the split takes effect when the
    // router is ready and the address has been moved onto it, which is a separate thing
    // and is why the status is not READY yet.
    const canary = (await rollout(first.name, 2, 10)).json();
    assert.deepEqual(
      canary.targets.map((t) => [t.version, t.traffic_weight]),
      [[1, 90], [2, 10]],
    );
    assert.ok(canary.router_k8s_name, 'two versions taking traffic needs something to decide');
    assert.equal(canary.serving_version, 1, 'the address does not move onto an unready router');
    assert.equal(canary.status, DeploymentStatus.PROGRESSING);

    const routed = await makeEverythingReady(first.name);
    assert.equal(routed.serving_version, null, 'null means the address resolves to the router');
    assert.equal(routed.status, DeploymentStatus.READY);

    // 50%. The router is already in place, so this is only a weight change — nothing is
    // created, nothing waits.
    const half = (await rollout(first.name, 2, 50)).json();
    assert.deepEqual(half.targets.map((t) => t.traffic_weight), [50, 50]);
    assert.equal(half.serving_version, null, 'the address has not moved; only the split changed');

    // Promote. v1 goes to 0 and stays as a target, so going back is a weight change.
    const promoted = (await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/deployments/${first.name}/promote`,
      payload: { version: 2 },
    })).json();
    assert.deepEqual(
      promoted.targets.map((t) => [t.version, t.traffic_weight]),
      [[1, 0], [2, 100]],
    );

    const settled = await makeEverythingReady(first.name);
    assert.equal(settled.serving_version, 2, 'one version taking traffic: the address goes direct');
    assert.equal(settled.router_k8s_name, null, 'and the router is removed, having nothing to decide');
    assert.equal(settled.status, DeploymentStatus.READY);
  });

  test('the weights an operator did not name are taken in proportion', async () => {
    const { model } = await seedModel();
    const first = (await deploy(model, { replicas: 1 })).json();
    await makeEverythingReady(first.name);
    await addVersion(model);
    await addVersion(model);

    await rollout(first.name, 2, 50);
    await makeEverythingReady(first.name);
    // v1 and v2 hold 50/50; giving v3 20% leaves 80 split between them in proportion.
    const three = (await rollout(first.name, 3, 20)).json();
    assert.deepEqual(
      three.targets.map((t) => [t.version, t.traffic_weight]),
      [[1, 40], [2, 40], [3, 20]],
    );
    assert.equal(three.targets.reduce((sum, t) => sum + t.traffic_weight, 0), 100);
  });

  test('a version that cannot be served is refused before it takes any traffic', async () => {
    // A canary that fails because its artifact was never confirmed looks like the model
    // is bad, which is the worst possible outcome for a mechanism whose only purpose is
    // to find out whether the model is bad.
    const { model } = await seedModel();
    const first = (await deploy(model)).json();

    const job = await runningJob();
    const half = await pendingArtifact(job);
    const registered = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/models/${model}/versions`,
      payload: { artifact_id: half.id },
    });
    assert.equal(registered.statusCode, 409, registered.payload);

    const res = await rollout(first.name, 2, 10);
    assert.equal(res.statusCode, 404, res.payload);
    const unchanged = await get(first.name);
    assert.equal(unchanged.targets.length, 1);
  });

  test('a weight outside 0-100 is refused with the arithmetic, not clamped', async () => {
    const { model } = await seedModel();
    const first = (await deploy(model)).json();
    const res = await rollout(first.name, 1, 140);
    assert.equal(res.statusCode, 400, res.payload);
  });

  test('retiring a version taking traffic is refused, and says what to do first', async () => {
    const { model } = await seedModel();
    const first = (await deploy(model, { replicas: 1 })).json();
    await makeEverythingReady(first.name);
    await addVersion(model);
    await rollout(first.name, 2, 50);
    await makeEverythingReady(first.name);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.name}/deployments/${first.name}/targets/1`,
    });
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error.code, 'VERSION_TAKES_TRAFFIC');
    assert.match(res.json().error.message, /rollout/);
  });

  test('retiring a version out of rotation removes its pods for good', async () => {
    const { model } = await seedModel();
    const first = (await deploy(model, { replicas: 1 })).json();
    const v1Pods = first.targets[0].k8s_name;
    await makeEverythingReady(first.name);
    await addVersion(model);

    await rollout(first.name, 2, 50);
    await makeEverythingReady(first.name);
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.name}/deployments/${first.name}/promote`,
      payload: { version: 2 },
    });
    await makeEverythingReady(first.name);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.name}/deployments/${first.name}/targets/1`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json().targets.map((t) => t.version), [2]);
    assert.equal(await backend.observeDeployment('ashml-test', v1Pods), null);
  });

  async function get(name) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.name}/deployments/${name}`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    return res.json();
  }
});
