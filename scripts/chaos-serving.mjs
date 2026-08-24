/**
 * Chaos: kill the pod that is serving a model, and require it to come back serving the
 * same model.
 *
 * Two claims are under test, and they are different claims.
 *
 * **The deployment recovers.** Kubernetes replaces the pod — AshML does not, and should
 * not; a Deployment already does this and a control plane racing it would fight it. What
 * AshML has to do is *notice*, which is why the status it reports during the gap is
 * `DEGRADED` and not `PROGRESSING`. "Was serving and is now short of replicas" and "has
 * not started serving yet" are different events, and one word for both hides an outage
 * inside something that sounds like startup.
 *
 * **It comes back as the same model.** This is what the artifact-id indirection buys. The
 * pod is handed an artifact id rather than a URL or a baked-in file, and exchanges it for
 * a signed download when it starts — so a replacement pod six hours later fetches the
 * same bytes rather than crash-looping on an expired signature. The check for it is
 * arithmetic rather than trust: the same inputs must produce the same outputs, to the
 * digit, across the replacement.
 *
 * The inputs are deterministic pseudo-random pixels, not CIFAR images. Nothing here says
 * anything about accuracy — what is being compared is one model against itself.
 *
 * Prerequisites: a deployment that is already serving (`ash model deploy`), and a control
 * plane running with its deployment sync loop, reachable at ASHML_ENDPOINT.
 *
 * Run: make chaos-serving
 *   export ASHML_TOKEN=$(make -s token)   # the API is default-deny since Phase 10
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// kubectl is pinned to one context rather than following `current-context`, because this
// script deletes a pod. See scripts/lib/kubectl.mjs.
import { kubectl, requireContext, contextArgs, KUBE_CONTEXT } from './lib/kubectl.mjs';
import { withToken, explainIfUnauthorized } from './lib/token.mjs';

const ENDPOINT = (process.env.ASHML_ENDPOINT ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const NAMESPACE = process.env.ASHML_K8S_NAMESPACE ?? 'ashml-jobs';
const PROJECT = process.env.CHAOS_PROJECT ?? 'vision';
const DEPLOYMENT = process.env.CHAOS_DEPLOYMENT ?? 'resnet18-cifar10';
const LOCAL_PORT = Number(process.env.CHAOS_LOCAL_PORT ?? 18081);
const TIMEOUT_MS = Number(process.env.CHAOS_TIMEOUT_MS ?? 300_000);
const INSTANCES = Number(process.env.CHAOS_INSTANCES ?? 8);

// --------------------------------------------------------------------- plumbing

async function api(method, path, body) {
  const response = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: withToken(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (response.status >= 400) {
    throw new Error(
      `${method} ${path} -> ${response.status}: ${text}${explainIfUnauthorized(response.status)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(what, predicate, { timeout = TIMEOUT_MS, interval = 1000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(interval);
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
}

/**
 * A port-forward, held for as long as the caller needs it.
 *
 * The Service is a ClusterIP by design (a NodePort per model would make the address
 * depend on which node answered), so reaching it from here means forwarding. It is torn
 * down and re-established around the kill rather than kept open: the forward is bound to
 * the pod it chose, and that pod is the one about to be deleted.
 */
async function portForward(service, port) {
  const child = spawn(
    'kubectl',
    [...contextArgs, 'port-forward', '-n', NAMESPACE, `svc/${service}`, `${port}:80`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('port-forward did not come up')), 15_000);
    child.stdout.on('data', (chunk) => {
      if (/Forwarding from/.test(String(chunk))) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`port-forward exited with ${code}`));
    });
  });

  await ready;
  return {
    close: () => new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
    }),
  };
}

async function serve(path, body) {
  const response = await fetch(`http://127.0.0.1:${LOCAL_PORT}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

/** Deterministic pixels. Not images of anything — see the header. */
function fixedInstances(count) {
  let seed = 20260820;
  const next = () => {
    // xorshift32: the point is that this run and the next produce identical bytes.
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed % 256;
  };
  return Array.from({ length: count }, () => Array.from(
    { length: 32 },
    () => Array.from({ length: 32 }, () => [next(), next(), next()]),
  ));
}

const shape = (predictions) => predictions.map((p) => `${p.class_id}:${p.confidence.toFixed(6)}`);

// ------------------------------------------------------------------ the story

function note(line) {
  console.log(`        ${line}`);
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('a deployment is serving, and the cluster agrees', async () => {
  const deployment = await api('GET', `/api/v1/projects/${PROJECT}/deployments/${DEPLOYMENT}`);
  assert.equal(deployment.status, 'READY', `nothing to break: deployment is ${deployment.status}`);

  const readyReplicas = await kubectl(
    'get', 'deploy', deployment.k8s_name, '-n', NAMESPACE,
    '-o', 'jsonpath={.status.readyReplicas}',
  );
  assert.equal(
    Number(readyReplicas), deployment.ready_replicas,
    'AshML and the cluster must not disagree about how many replicas are serving',
  );

  globalThis.__deployment = deployment;
  note(`${deployment.name} serving version ${deployment.target.version} (${readyReplicas} ready)`);
});

check('the pod is serving the artifact AshML recorded, and answers', async () => {
  const deployment = globalThis.__deployment;
  globalThis.__forward = await portForward(deployment.k8s_name, LOCAL_PORT);

  const ready = await serve('/readyz');
  assert.equal(ready.status, 200, `the pod is not ready: ${JSON.stringify(ready.body)}`);

  // The pod's own account of what it loaded, against the registry's account of what it
  // should have. These agreeing is what makes "the deployment serves version 1" a fact
  // rather than a label on a box nobody opened.
  const metadata = await serve('/metadata');
  assert.equal(
    metadata.body.artifact_id, deployment.target.artifact_id,
    'the pod is serving a different artifact from the one the deployment points at',
  );

  const instances = fixedInstances(INSTANCES);
  const before = await serve('/predict', { instances });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.predictions.length, INSTANCES);

  globalThis.__instances = instances;
  globalThis.__before = shape(before.body.predictions);
  note(`artifact ${metadata.body.artifact_id} loaded; ${INSTANCES} predictions recorded`);
});

check('killing the serving pod is reported as DEGRADED, not as starting up', async () => {
  const deployment = globalThis.__deployment;
  const pod = await kubectl(
    'get', 'pods', '-n', NAMESPACE, '-l', `ashml.io/deployment-id=${deployment.id}`,
    '-o', 'jsonpath={.items[0].metadata.name}',
  );
  assert.ok(pod, 'there must be a serving pod to kill');
  globalThis.__killedPod = pod;

  await globalThis.__forward.close();
  note(`killing pod ${pod}`);
  await kubectl('delete', 'pod', pod, '-n', NAMESPACE, '--grace-period=0', '--force');

  // The distinction this whole status vocabulary exists for. PROGRESSING here would say
  // "starting up" about an outage.
  const degraded = await until('AshML to report DEGRADED', async () => {
    const current = await api('GET', `/api/v1/projects/${PROJECT}/deployments/${DEPLOYMENT}`);
    return current.status === 'DEGRADED' ? current : null;
  }, { interval: 500 });

  assert.equal(degraded.ready_replicas, 0);
  note(`status ${degraded.status} with ${degraded.ready_replicas}/${degraded.replicas} ready`);
});

check('Kubernetes replaces the pod and it fetches the model by artifact id', async () => {
  const deployment = globalThis.__deployment;

  const replacement = await until('a replacement pod', async () => {
    const names = (await kubectl(
      'get', 'pods', '-n', NAMESPACE, '-l', `ashml.io/deployment-id=${deployment.id}`,
      '-o', 'jsonpath={.items[*].metadata.name}',
    )).split(/\s+/).filter(Boolean);
    return names.find((n) => n !== globalThis.__killedPod) ?? null;
  });
  note(`replacement pod ${replacement}`);

  // Waiting on the pod's own readiness, which is gated on a forward pass having run —
  // not on the process having started. That is the probe split doing its job.
  await until('the replacement to become ready', async () => {
    const ready = await kubectl(
      'get', 'pod', replacement, '-n', NAMESPACE,
      '-o', 'jsonpath={.status.containerStatuses[0].ready}',
    );
    return ready === 'true';
  }, { interval: 2000 });

  // What the pod resolved the artifact id *into*. The startup banner only echoes the
  // environment variable it was handed; this line is printed after the weights are in
  // memory, and it names the object they came out of — which is the evidence that the
  // indirection actually happened rather than being configured.
  const logs = await kubectl('logs', replacement, '-n', NAMESPACE);
  const loaded = logs.match(/\[serve\] ready: (\S+) from (\S+)/);
  assert.ok(loaded, `the replacement never reported loading a model:\n${logs.slice(0, 400)}`);

  const artifact = await api('GET', `/api/v1/artifacts/${deployment.target.artifact_id}`);
  assert.equal(
    loaded[2], artifact.uri,
    'the replacement loaded a different object from the one the deployment points at',
  );
  assert.equal(loaded[1], deployment.target.arch);
  note(`resolved ${deployment.target.artifact_id} -> ${loaded[2]}`);
});

check('AshML observes it serving again', async () => {
  const recovered = await until('AshML to report READY again', async () => {
    const current = await api('GET', `/api/v1/projects/${PROJECT}/deployments/${DEPLOYMENT}`);
    return current.status === 'READY' ? current : null;
  }, { interval: 1000 });

  const readyReplicas = await kubectl(
    'get', 'deploy', globalThis.__deployment.k8s_name, '-n', NAMESPACE,
    '-o', 'jsonpath={.status.readyReplicas}',
  );
  assert.equal(Number(readyReplicas), recovered.ready_replicas);
  assert.equal(recovered.last_error, null, 'a recovered deployment must not carry a stale error');
  note(`status ${recovered.status} with ${recovered.ready_replicas}/${recovered.replicas} ready`);
});

check('the replacement answers with the same model, to the digit', async () => {
  globalThis.__forward = await portForward(globalThis.__deployment.k8s_name, LOCAL_PORT);

  const after = await serve('/predict', { instances: globalThis.__instances });
  assert.equal(after.status, 200, JSON.stringify(after.body));

  // Identical inputs, identical outputs. A pod that had come back with different weights
  // — a newer artifact, a partial download, a different version of the same model —
  // would answer plausibly and differently, and nothing else here would catch it.
  assert.deepEqual(
    shape(after.body.predictions), globalThis.__before,
    'the replacement is serving different weights from the pod it replaced',
  );
  note(`${INSTANCES}/${INSTANCES} predictions identical across the replacement`);
});

// ------------------------------------------------------------------- driver

await requireContext();

console.log(`\nchaos: killing the pod serving ${PROJECT}/${DEPLOYMENT}`);
console.log(`  cluster: ${KUBE_CONTEXT}\n`);

let passed = 0;
let failed = 0;
for (const { name, fn } of checks) {
  const started = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    break;
  }
}

await globalThis.__forward?.close();

const notRun = checks.length - passed - failed;
console.log(
  `\n${passed}/${checks.length} chaos checks passed`
  + (notRun ? ` (${notRun} not run: the failure above makes them meaningless)` : ''),
);
process.exit(failed === 0 ? 0 : 1);
