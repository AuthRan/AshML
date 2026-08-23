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
  buildTargetManifest,
  buildTargetServiceManifest,
  buildServiceManifest,
  frontSelector,
  kubeDeploymentName,
  kubeTargetName,
  serviceUrl,
  targetServiceUrl,
  MANAGED_BY,
  PORT_NAME,
  SERVING_PORT,
  ROUTER_COMPONENT,
  ROUTER_PORT,
  ROUTER_REPLICAS,
  buildRouterManifest,
  kubeRouterName,
} from './manifest.js';

/** A deployment shaped as the repo returns one. */
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
    ...overrides,
  };
}

/** One of its targets, resolved through to the artifact. */
function makeTarget(overrides = {}) {
  return {
    version: 1,
    traffic_weight: 100,
    replicas: 2,
    artifact_id: '77beb71e-21d4-48e3-b1ed-76d1bac79b02',
    arch: 'resnet18-cifar',
    ...overrides,
  };
}

function build(deploymentOverrides = {}, targetOverrides = {}, options = {}) {
  return buildTargetManifest(
    makeDeployment(deploymentOverrides),
    makeTarget(targetOverrides),
    options,
  );
}

function containerOf(manifest) {
  return manifest.spec.template.spec.containers[0];
}

function envOf(manifest) {
  return Object.fromEntries(containerOf(manifest).env.map((e) => [e.name, e.value]));
}

describe('the deployment name', () => {
  test('carries the human name and the id', () => {
    assert.match(kubeDeploymentName(makeDeployment()), /^ashml-svc-resnet-cifar-7a1b2c3d$/);
  });

  test("a version's own objects add the version, and only that", () => {
    // The front door and one version's pods must never collide on a name: one is the
    // address callers hold and the other is a thing that comes and goes underneath it.
    const deployment = makeDeployment();
    assert.equal(kubeTargetName(deployment, 7), `${kubeDeploymentName(deployment)}-v7`);
  });

  test('fits inside the 63-character DNS label limit', () => {
    const long = makeDeployment({ name: 'a'.repeat(200) });
    assert.ok(kubeDeploymentName(long).length <= 63);
    // The version suffix eats into the same budget, so the truncation has to account
    // for it — a name that fits only until a two-digit version appears is a deploy that
    // fails on v10 and nowhere earlier.
    assert.ok(kubeTargetName(long, 100).length <= 63, kubeTargetName(long, 100));
  });

  test('never ends in a dash, which is an illegal DNS label', () => {
    // Truncation lands mid-name; a trailing dash would be rejected by the API server
    // only at create time, which is a long way from the mistake.
    for (let length = 30; length < 80; length += 1) {
      const deployment = makeDeployment({ name: `${'x'.repeat(length)}-` });
      assert.ok(!kubeDeploymentName(deployment).endsWith('-'));
      assert.ok(!kubeTargetName(deployment, 3).endsWith('-'));
    }
  });

  test("a version's Service shares its Deployment's name", () => {
    const deployment = makeDeployment();
    const target = makeTarget();
    assert.equal(
      buildTargetServiceManifest(deployment, target).metadata.name,
      buildTargetManifest(deployment, target).metadata.name,
    );
  });
});

describe("one version's Deployment", () => {
  test('requests the replicas that version asked for', () => {
    assert.equal(build({}, { replicas: 3 }).spec.replicas, 3);
  });

  test('a version at weight 0 runs no pods', () => {
    // Out of rotation is not the same as deleted: the objects and the row stay, so
    // putting the version back is a weight change rather than a redeploy. Running pods
    // for it in the meantime is capacity spent on traffic that cannot arrive.
    assert.equal(build({}, { traffic_weight: 0, replicas: 2 }).spec.replicas, 0);
  });

  test('labels everything so a stray kubectl can find it', () => {
    const manifest = build();
    assert.equal(manifest.metadata.labels['app.kubernetes.io/managed-by'], MANAGED_BY);
    assert.equal(manifest.metadata.labels['ashml.io/deployment-id'], makeDeployment().id);
    assert.equal(manifest.metadata.labels['app.kubernetes.io/component'], 'model-server');
  });

  test('the selector holds the version, and nothing that can change', () => {
    // `spec.selector` is immutable in Kubernetes, so everything in it must be constant
    // for the life of the object. The version qualifies precisely because a target *is*
    // a version: rolling out a different one creates a different Deployment rather than
    // mutating this one. The artifact does not — a version could in principle be
    // repointed — and the weight certainly does not, since it changes every rollout step.
    const selector = build().spec.selector.matchLabels;
    assert.equal(selector['ashml.io/deployment-id'], makeDeployment().id);
    assert.equal(selector['ashml.io/model-version'], '1');
    for (const key of ['ashml.io/artifact-id', 'ashml.io/traffic-weight']) {
      assert.ok(!(key in selector), `${key} must not be part of the selector`);
    }
  });

  test('two versions of one deployment get selectors that do not overlap', () => {
    // The failure this prevents is the whole feature failing silently: if both versions'
    // pods matched both selectors, each Service would front all the pods and the split
    // would be an even spread no matter what weights were set.
    const deployment = makeDeployment();
    const six = buildTargetManifest(deployment, makeTarget({ version: 6 }));
    const seven = buildTargetManifest(deployment, makeTarget({ version: 7 }));

    const matches = (selector, labels) => Object.entries(selector)
      .every(([key, value]) => labels[key] === value);

    assert.ok(matches(six.spec.selector.matchLabels, six.spec.template.metadata.labels));
    assert.ok(!matches(six.spec.selector.matchLabels, seven.spec.template.metadata.labels));
    assert.ok(!matches(seven.spec.selector.matchLabels, six.spec.template.metadata.labels));
  });

  test('the pod template matches its own selector', () => {
    // A Deployment whose template does not match its selector is rejected, and the
    // message points at the selector rather than at the template that drifted.
    const manifest = build();
    for (const [key, value] of Object.entries(manifest.spec.selector.matchLabels)) {
      assert.equal(manifest.spec.template.metadata.labels[key], value, `pod label ${key}`);
    }
  });

  test('records the weight as an annotation, not a label', () => {
    // It changes on every rollout step. A label that churned that often would rewrite
    // every hand-written selector's meaning underneath whoever wrote it.
    const manifest = build({}, { traffic_weight: 10 });
    assert.equal(manifest.metadata.annotations['ashml.io/traffic-weight'], '10');
    assert.ok(!('ashml.io/traffic-weight' in manifest.metadata.labels));
  });

  test('tells the server which model to load, by id rather than by URL', () => {
    const env = envOf(build({}, {}, { apiUrl: 'http://ashml:8080' }));
    assert.equal(env.ASHML_ARTIFACT_ID, '77beb71e-21d4-48e3-b1ed-76d1bac79b02');
    assert.equal(env.ASHML_MODEL_ARCH, 'resnet18-cifar');
    assert.equal(env.ASHML_MODEL_VERSION, '1');
    assert.equal(env.ASHML_ENDPOINT, 'http://ashml:8080');
    // A presigned URL in the manifest would expire; the id does not.
    assert.ok(!('ASHML_MODEL_URL' in env));
  });

  test('omits the endpoint rather than inventing one', () => {
    assert.ok(!('ASHML_ENDPOINT' in envOf(build())));
  });

  test('exposes the serving port under a name the Service can target', () => {
    assert.deepEqual(containerOf(build()).ports, [{ name: 'http', containerPort: SERVING_PORT }]);
  });

  test('readiness asks whether the model is loaded, liveness only whether it is alive', () => {
    const container = containerOf(build());
    assert.equal(container.readinessProbe.httpGet.path, '/readyz');
    assert.equal(container.livenessProbe.httpGet.path, '/healthz');
    // The inverse is the bug this test exists for: liveness on /readyz kills a pod that
    // is still downloading its weights, and restarting it starts the download again.
    assert.notEqual(container.livenessProbe.httpGet.path, '/readyz');
  });

  test('a startup probe covers a slow first load', () => {
    const { startupProbe, livenessProbe } = containerOf(build());
    assert.equal(startupProbe.httpGet.path, '/readyz');
    const budget = startupProbe.failureThreshold * startupProbe.periodSeconds;
    const livenessBudget = livenessProbe.failureThreshold * livenessProbe.periodSeconds;
    assert.ok(
      budget > livenessBudget,
      `startup budget ${budget}s must exceed liveness ${livenessBudget}s or it buys nothing`,
    );
  });

  test('passes CPU and memory as requests, and no GPU when none was asked for', () => {
    const resources = containerOf(build()).resources;
    assert.equal(resources.requests.cpu, '2');
    assert.equal(resources.requests.memory, '2147483648');
    assert.ok(!resources.limits, 'a CPU-only deployment needs no limits block');
  });

  test('a GPU deployment sets the extended resource in both requests and limits', () => {
    const resources = containerOf(build({ gpu: 1 })).resources;
    assert.equal(resources.requests['nvidia.com/gpu'], '1');
    assert.equal(resources.limits['nvidia.com/gpu'], '1');
  });

  test('refuses to build without an image or a target artifact', () => {
    assert.throws(() => build({ image: null }), /image is required/);
    assert.throws(() => build({}, { artifact_id: null }), /no artifact_id/);
  });
});

describe("one version's Service", () => {
  test('selects that version\'s pods and no other', () => {
    const deployment = makeDeployment();
    const six = makeTarget({ version: 6 });
    const selector = buildTargetServiceManifest(deployment, six).spec.selector;
    const sixLabels = buildTargetManifest(deployment, six).spec.template.metadata.labels;
    const sevenLabels = buildTargetManifest(deployment, makeTarget({ version: 7 }))
      .spec.template.metadata.labels;

    for (const [key, value] of Object.entries(selector)) {
      assert.equal(sixLabels[key], value, `selector ${key} matches no pod label`);
    }
    assert.notEqual(selector['ashml.io/model-version'], sevenLabels['ashml.io/model-version']);
  });

  test('the recorded URL resolves to the Service that was created', () => {
    const deployment = makeDeployment();
    const url = targetServiceUrl(deployment, 6, { namespace: 'ashml-jobs' });
    const name = buildTargetServiceManifest(deployment, makeTarget({ version: 6 }), {
      namespace: 'ashml-jobs',
    }).metadata.name;
    assert.equal(url, `http://${name}.ashml-jobs.svc.cluster.local`);
  });
});

const port = (service) => service.spec.ports[0];

describe("the deployment's front Service", () => {
  test('routes port 80 to the container port, by name rather than by number', () => {
    // By name because this Service's backing pods change *kind*: a model server on
    // SERVING_PORT while one version takes traffic, a router on ROUTER_PORT the moment
    // two do. A number can only be right about one of them.
    const port = buildServiceManifest(makeDeployment(), { version: 1 }).spec.ports[0];
    assert.equal(port.port, 80);
    assert.equal(port.targetPort, PORT_NAME);
  });

  test('reaches whichever kind of pod it is pointed at, on that pod’s own port', () => {
    // The regression this replaces: the front Service hardcoded SERVING_PORT, so the
    // moment the address moved onto the router every request through it was refused —
    // by a router that was running, ready, and listening on ROUTER_PORT one port away.
    // Nothing reported it. The pods were ready and AshML said READY.
    //
    // So the check is the one that would have caught it: whatever the front Service
    // targets must be a port the selected pod actually declares, in *both* directions.
    const deployment = makeDeployment();
    const target = { ...port(buildServiceManifest(deployment, { version: 1 })) };
    const routed = { ...port(buildServiceManifest(deployment, { version: null })) };

    const serverPorts = buildTargetManifest(deployment, makeTarget())
      .spec.template.spec.containers[0].ports;
    const routerPorts = buildRouterManifest(
      makeDeployment({ router_image: 'ashml/model-router:v1' }),
      { apiUrl: 'http://ashml' },
    ).spec.template.spec.containers[0].ports;

    assert.ok(
      serverPorts.some((p) => p.name === target.targetPort && p.containerPort === SERVING_PORT),
      'the front door onto a version must name a port the model server declares',
    );
    assert.ok(
      routerPorts.some((p) => p.name === routed.targetPort && p.containerPort === ROUTER_PORT),
      'the front door onto the router must name a port the router declares',
    );
    assert.notEqual(SERVING_PORT, ROUTER_PORT, 'if these were equal the check above proves nothing');
  });

  test('selects the pods of the version it was pointed at', () => {
    const deployment = makeDeployment();
    const selector = buildServiceManifest(deployment, { version: 1 }).spec.selector;
    const podLabels = buildTargetManifest(deployment, makeTarget()).spec.template.metadata.labels;
    for (const [key, value] of Object.entries(selector)) {
      assert.equal(podLabels[key], value, `front selector ${key} matches no pod label`);
    }
  });

  test('with no version it selects the router, and is still fully specified', () => {
    // Null means "the router", which is where the front door goes the moment a second
    // version starts taking traffic. What it must never mean is "no constraint": an
    // empty or partial selector matches every pod AshML has created in the namespace,
    // which is worse than matching none — the deployment would front another model's
    // pods and answer with them.
    const selector = frontSelector(makeDeployment(), null);
    assert.equal(selector['app.kubernetes.io/component'], ROUTER_COMPONENT);
    assert.equal(selector['ashml.io/deployment-id'], makeDeployment().id);
    assert.ok(!('ashml.io/model-version' in selector), 'router pods carry no version');
    assert.ok(Object.keys(selector).length >= 3);
  });

  test('the two destinations never select the same pods', () => {
    // If they overlapped, moving the front door would be a no-op and the split would
    // silently never take effect.
    const deployment = makeDeployment();
    const toVersion = frontSelector(deployment, 1);
    const toRouter = frontSelector(deployment, null);
    assert.notEqual(
      toVersion['app.kubernetes.io/component'],
      toRouter['app.kubernetes.io/component'],
    );
  });

  test('is a ClusterIP: exposing each model on a node port is a gateway concern', () => {
    assert.equal(buildServiceManifest(makeDeployment(), { version: 1 }).spec.type, 'ClusterIP');
  });

  test('the recorded URL resolves to the Service that was created', () => {
    const deployment = makeDeployment();
    const url = serviceUrl(deployment, { namespace: 'ashml-jobs' });
    const name = buildServiceManifest(deployment, { namespace: 'ashml-jobs', version: 1 })
      .metadata.name;
    assert.equal(url, `http://${name}.ashml-jobs.svc.cluster.local`);
  });
});

describe('the router', () => {
  function router(overrides = {}, options = {}) {
    return buildRouterManifest(
      makeDeployment({ router_image: 'ashml/model-router:v1', targets: [], ...overrides }),
      { apiUrl: 'http://ashml:8080', ...options },
    );
  }

  test('its name collides with neither the front door nor any version', () => {
    const deployment = makeDeployment();
    const names = new Set([
      kubeDeploymentName(deployment),
      kubeTargetName(deployment, 6),
      kubeTargetName(deployment, 7),
      kubeRouterName(deployment),
    ]);
    assert.equal(names.size, 4);
    assert.ok(kubeRouterName(makeDeployment({ name: 'a'.repeat(200) })).length <= 63);
  });

  test('carries the component label the front Service selects it by', () => {
    const manifest = router();
    assert.equal(
      manifest.spec.template.metadata.labels['app.kubernetes.io/component'],
      ROUTER_COMPONENT,
    );
    for (const [key, value] of Object.entries(manifest.spec.selector.matchLabels)) {
      assert.equal(manifest.spec.template.metadata.labels[key], value);
    }
  });

  test('runs more than one, so a restart is not a gap in service', () => {
    // The router is in front of every request the deployment answers. One replica makes
    // an ordinary rolling restart an outage for model pods nothing touched.
    assert.ok(ROUTER_REPLICAS >= 2);
    assert.equal(router().spec.replicas, ROUTER_REPLICAS);
  });

  test('is told an id and an endpoint, and nothing about the split', () => {
    // Weights in the environment would mean every step of a canary restarted the thing
    // measuring it. It reads them from the control plane instead.
    const env = Object.fromEntries(
      router().spec.template.spec.containers[0].env.map((e) => [e.name, e.value]),
    );
    assert.equal(env.ASHML_DEPLOYMENT_ID, makeDeployment().id);
    assert.equal(env.ASHML_ENDPOINT, 'http://ashml:8080');
    assert.equal(env.ASHML_PORT, String(ROUTER_PORT));
    for (const name of Object.keys(env)) {
      assert.ok(!/WEIGHT|TRAFFIC|VERSION/.test(name), `${name} would pin the split into the pod`);
    }
  });

  test('refuses to be built without the control plane\'s address', () => {
    // A router that cannot reach the control plane never gets a split, so it never
    // becomes ready, so the front door is never moved onto it — and nothing says why.
    assert.throws(() => router({}, { apiUrl: null }), /can never fetch a split/);
  });

  test('readiness asks whether it has a split; liveness only whether it is alive', () => {
    const container = router().spec.template.spec.containers[0];
    assert.equal(container.readinessProbe.httpGet.path, '/readyz');
    assert.equal(container.livenessProbe.httpGet.path, '/healthz');
    // No startup probe: there is no slow first load to protect, unlike a model server.
    assert.ok(!container.startupProbe);
  });

  test('listens on a different port from the model server', () => {
    // So a pod that ended up running the wrong image fails to bind rather than answering
    // as the wrong thing.
    assert.notEqual(ROUTER_PORT, SERVING_PORT);
  });
});
