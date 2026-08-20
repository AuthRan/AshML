/**
 * Unit tests for the AshML deployment -> Kubernetes Deployment/Service translation.
 *
 * No cluster and no database, for the same reason as the Job translation tests: a
 * mistake here produces a Service that routes to pods with no model loaded, or a probe
 * that restarts a healthy pod, and both are much harder to read from the cluster than
 * from here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeploymentManifest,
  buildServiceManifest,
  kubeDeploymentName,
  serviceUrl,
  MANAGED_BY,
  SERVING_PORT,
} from './manifest.js';

/** A deployment shaped as the repo returns one, joined with its single target. */
function makeDeployment(overrides = {}) {
  return {
    id: '7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    name: 'resnet-cifar',
    project: 'vision',
    model: 'resnet18-cifar10',
    image: 'ashml/model-server:v1',
    replicas: 2,
    cpu: 2,
    memory_bytes: 2147483648,
    gpu: 0,
    target: {
      version: 1,
      artifact_id: '77beb71e-21d4-48e3-b1ed-76d1bac79b02',
      arch: 'resnet18-cifar',
    },
    ...overrides,
  };
}

function containerOf(manifest) {
  return manifest.spec.template.spec.containers[0];
}

function envOf(manifest) {
  return Object.fromEntries(containerOf(manifest).env.map((e) => [e.name, e.value]));
}

describe('the deployment name', () => {
  test('carries the human name and the id', () => {
    const name = kubeDeploymentName(makeDeployment());
    assert.match(name, /^ashml-svc-resnet-cifar-7a1b2c3d$/);
  });

  test('fits inside the 63-character DNS label limit', () => {
    const name = kubeDeploymentName(makeDeployment({ name: 'a'.repeat(200) }));
    assert.ok(name.length <= 63, `${name.length} > 63`);
  });

  test('never ends in a dash, which is an illegal DNS label', () => {
    // Truncation lands mid-name; a trailing dash would be rejected by the API server
    // only at create time, which is a long way from the mistake.
    for (let length = 30; length < 80; length += 1) {
      const name = kubeDeploymentName(makeDeployment({ name: `${'x'.repeat(length)}-` }));
      assert.ok(!name.endsWith('-'), `"${name}" ends in a dash`);
    }
  });

  test('the Service shares the Deployment name', () => {
    const deployment = makeDeployment();
    assert.equal(
      buildServiceManifest(deployment).metadata.name,
      buildDeploymentManifest(deployment).metadata.name,
    );
  });
});

describe('the Deployment manifest', () => {
  test('requests the replicas asked for', () => {
    assert.equal(buildDeploymentManifest(makeDeployment()).spec.replicas, 2);
  });

  test('labels everything so a stray kubectl can find it', () => {
    const manifest = buildDeploymentManifest(makeDeployment());
    assert.equal(manifest.metadata.labels['app.kubernetes.io/managed-by'], MANAGED_BY);
    assert.equal(manifest.metadata.labels['ashml.io/deployment-id'], makeDeployment().id);
    assert.equal(manifest.metadata.labels['app.kubernetes.io/component'], 'model-server');
  });

  test('the selector holds nothing that can change on an update', () => {
    // spec.selector is immutable in Kubernetes. If the version or the artifact appeared
    // in it, deploying a new version of the same deployment would need the object
    // deleted and recreated — an outage caused entirely by a label choice.
    const selector = buildDeploymentManifest(makeDeployment()).spec.selector.matchLabels;
    const volatile = ['ashml.io/model-version', 'ashml.io/artifact-id', 'app.kubernetes.io/component'];
    for (const key of volatile) {
      assert.ok(!(key in selector), `${key} must not be part of the selector`);
    }
    assert.equal(selector['ashml.io/deployment-id'], makeDeployment().id);
  });

  test('the pod template matches its own selector', () => {
    // A Deployment whose template does not match its selector is rejected, and the
    // message points at the selector rather than at the template that drifted.
    const manifest = buildDeploymentManifest(makeDeployment());
    const selector = manifest.spec.selector.matchLabels;
    const podLabels = manifest.spec.template.metadata.labels;
    for (const [key, value] of Object.entries(selector)) {
      assert.equal(podLabels[key], value, `pod label ${key} does not match the selector`);
    }
  });

  test('tells the server which model to load, by id rather than by URL', () => {
    const env = envOf(buildDeploymentManifest(makeDeployment(), { apiUrl: 'http://ashml:8080' }));
    assert.equal(env.ASHML_ARTIFACT_ID, '77beb71e-21d4-48e3-b1ed-76d1bac79b02');
    assert.equal(env.ASHML_MODEL_ARCH, 'resnet18-cifar');
    assert.equal(env.ASHML_ENDPOINT, 'http://ashml:8080');
    // A presigned URL in the manifest would expire; the id does not.
    assert.ok(!('ASHML_MODEL_URL' in env));
  });

  test('omits the endpoint rather than inventing one', () => {
    const env = envOf(buildDeploymentManifest(makeDeployment()));
    assert.ok(!('ASHML_ENDPOINT' in env));
  });

  test('exposes the serving port under a name the Service can target', () => {
    const ports = containerOf(buildDeploymentManifest(makeDeployment())).ports;
    assert.deepEqual(ports, [{ name: 'http', containerPort: SERVING_PORT }]);
  });

  test('readiness asks whether the model is loaded, liveness only whether it is alive', () => {
    const container = containerOf(buildDeploymentManifest(makeDeployment()));
    assert.equal(container.readinessProbe.httpGet.path, '/readyz');
    assert.equal(container.livenessProbe.httpGet.path, '/healthz');
    // The inverse is the bug this test exists for: liveness on /readyz kills a pod that
    // is still downloading its weights, and restarting it starts the download again.
    assert.notEqual(container.livenessProbe.httpGet.path, '/readyz');
  });

  test('a startup probe covers a slow first load', () => {
    const { startupProbe, livenessProbe } = containerOf(buildDeploymentManifest(makeDeployment()));
    assert.equal(startupProbe.httpGet.path, '/readyz');
    const budget = startupProbe.failureThreshold * startupProbe.periodSeconds;
    const livenessBudget = livenessProbe.failureThreshold * livenessProbe.periodSeconds;
    assert.ok(
      budget > livenessBudget,
      `startup budget ${budget}s must exceed liveness ${livenessBudget}s or it buys nothing`,
    );
  });

  test('passes CPU and memory as requests, and no GPU when none was asked for', () => {
    const resources = containerOf(buildDeploymentManifest(makeDeployment())).resources;
    assert.equal(resources.requests.cpu, '2');
    assert.equal(resources.requests.memory, '2147483648');
    assert.ok(!resources.limits, 'a CPU-only deployment needs no limits block');
  });

  test('a GPU deployment sets the extended resource in both requests and limits', () => {
    const resources = containerOf(
      buildDeploymentManifest(makeDeployment({ gpu: 1 })),
    ).resources;
    assert.equal(resources.requests['nvidia.com/gpu'], '1');
    assert.equal(resources.limits['nvidia.com/gpu'], '1');
  });

  test('refuses to build without an image or a target artifact', () => {
    assert.throws(
      () => buildDeploymentManifest(makeDeployment({ image: null })),
      /image is required/,
    );
    assert.throws(
      () => buildDeploymentManifest(makeDeployment({ target: { version: 1, arch: 'x' } })),
      /artifact_id is required/,
    );
  });
});

describe('the Service manifest', () => {
  test('routes port 80 to the container port', () => {
    const port = buildServiceManifest(makeDeployment()).spec.ports[0];
    assert.equal(port.port, 80);
    assert.equal(port.targetPort, SERVING_PORT);
  });

  test('selects the same pods the Deployment creates', () => {
    const deployment = makeDeployment();
    const serviceSelector = buildServiceManifest(deployment).spec.selector;
    const podLabels = buildDeploymentManifest(deployment).spec.template.metadata.labels;
    for (const [key, value] of Object.entries(serviceSelector)) {
      assert.equal(podLabels[key], value, `Service selector ${key} matches no pod label`);
    }
  });

  test('is a ClusterIP: exposing each model on a node port is a gateway concern', () => {
    assert.equal(buildServiceManifest(makeDeployment()).spec.type, 'ClusterIP');
  });

  test('the recorded URL resolves to the Service that was created', () => {
    const deployment = makeDeployment();
    const url = serviceUrl(deployment, { namespace: 'ashml-jobs' });
    const name = buildServiceManifest(deployment, { namespace: 'ashml-jobs' }).metadata.name;
    assert.equal(url, `http://${name}.ashml-jobs.svc.cluster.local`);
  });
});
