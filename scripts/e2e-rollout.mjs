/**
 * End-to-end proof of §21 against real pods: a weighted rollout, measured.
 *
 *   ash deployment rollout <name> --version 2 --traffic 10   # then 50, then promote
 *
 * The arithmetic behind this has unit tests, and the whole sequence has integration
 * tests against a simulated cluster. Neither can produce the two defects this script was
 * written after, because both of them lived in the gap between what AshML asked
 * Kubernetes for and what Kubernetes then did:
 *
 *  - the front Service hardcoded the model server's port, so the moment the address
 *    moved onto the router *every request through it was refused* — by a router that was
 *    running, ready and listening one port away. Every AshML-visible signal said READY.
 *  - `ash deployment rollout --version 2` matched commander's own `--version`, printed
 *    the client version and exited 0. The rollout never happened and the shell saw
 *    success.
 *
 * Both are invisible to anything that does not send a real request through the real
 * address and look at which pod answered. So that is what this does.
 *
 * **What is measured, and what that means.** The split is sampled over
 * ROLLOUT_SAMPLES requests to `/metadata`, which every model server answers with the
 * artifact id it actually loaded. Each response therefore carries two independent
 * accounts of where it went: the router's `X-AshML-Served-By` header, and the pod's own
 * statement of what it is. Agreement between them is the check — a router that
 * attributed requests to the wrong version would satisfy either one alone.
 *
 * A share of a random split is a binomial sample, so the tolerance is computed from the
 * sample size rather than picked to fit: four standard deviations, which fails on chance
 * about once in fifteen thousand runs and still catches a split that is off by a factor.
 * Asserting an exact percentage would be asserting that a random router is not random.
 *
 * Prerequisites, all of them real:
 *   make cluster && make resnet-image && make model-server-image && make router-image
 *   make db-up && make migrate
 *   a control plane running with its deployment sync loop, reachable from a pod:
 *     HOST_IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')
 *     ASHML_API_ADVERTISE_URL=http://$HOST_IP:8080 ASHML_S3_ENDPOINT=http://$HOST_IP:9000 npm start
 *
 * It trains the two versions it rolls out, because two versions someone made by hand are
 * a test of a hand-made setup. They are deliberately tiny — MAX_STEPS, and they say so —
 * since what is under test is the routing, not the model.
 *
 * Run: make e2e-rollout
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Pinned to one context rather than following `current-context`. See scripts/lib/kubectl.mjs.
import { kubectl, requireContext, contextArgs, KUBE_CONTEXT } from './lib/kubectl.mjs';

const ENDPOINT = (process.env.ASHML_ENDPOINT ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const NAMESPACE = process.env.ASHML_K8S_NAMESPACE ?? 'ashml-jobs';
const IMAGE = process.env.RESNET_IMAGE ?? 'ashml/resnet-trainer:v1';
const LOCAL_PORT = Number(process.env.ROLLOUT_LOCAL_PORT ?? 18082);
const TIMEOUT_MS = Number(process.env.ROLLOUT_TIMEOUT_MS ?? 900_000);
const SAMPLES = Number(process.env.ROLLOUT_SAMPLES ?? 400);
const CONCURRENCY = Number(process.env.ROLLOUT_CONCURRENCY ?? 10);

/** Short enough to be a fixture, long enough to be a real training run. */
const STEPS = Number(process.env.ROLLOUT_STEPS ?? 20);

const suffix = Math.random().toString(36).slice(2, 8);
const project = `rollout-${suffix}`;
const MODEL = 'resnet18-cifar10';
const DEPLOYMENT = MODEL;

// --------------------------------------------------------------------- plumbing

async function api(method, path, body) {
  const response = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `predicate` returns something truthy.
 *
 * The predicate is handed a `because` callback for the case it is *not* yet satisfied.
 * Waiting for a pod is the one place where a timeout with no detail is worst: "timed out
 * waiting for the canary" and "v2 is in CrashLoopBackOff" are the same event, and only
 * one of them tells you what to do.
 */
async function until(what, predicate, { timeout = TIMEOUT_MS, interval = 2000 } = {}) {
  const deadline = Date.now() + timeout;
  let reason = null;
  const because = (why) => { reason = why; };

  while (Date.now() < deadline) {
    const result = await predicate(because);
    if (result) return result;
    await sleep(interval);
  }
  throw new Error(
    `timed out after ${(timeout / 1000).toFixed(0)}s waiting for ${what}`
    + (reason ? `: ${reason}` : ''),
  );
}

/**
 * A port-forward onto the deployment's front Service — the address itself, not a pod.
 *
 * Everything this script asserts about routing has to arrive the way a caller's traffic
 * arrives: through the Service, with whatever selector and port it currently carries.
 * Forwarding to a pod would bypass exactly the two things that were broken.
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

/** One request through the front door, and both accounts of where it went. */
async function ask(path = '/metadata') {
  const response = await fetch(`http://127.0.0.1:${LOCAL_PORT}${path}`, {
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return {
    status: response.status,
    // What the router says answered. Absent when there is no router in the path, which
    // is itself worth asserting: a single-version deployment must not have one.
    servedBy: response.headers.get('x-ashml-served-by'),
    // What the pod says it is, independently of anything AshML wrote down.
    artifactId: body.artifact_id ?? null,
    body,
  };
}

/**
 * What the router is *currently applying*, from the router itself.
 *
 * `/-/routing` is the router's own view: the split it last fetched, how old that is, and
 * which versions it currently considers reachable. It matters because AshML's view and
 * the router's are deliberately not the same thing and do not update together — the
 * control plane writes a weight the moment it is asked, and the router re-reads it on its
 * own timer (`ASHML_ROUTING_REFRESH_MS`, 5s), which is what makes a canary step cost no
 * restart.
 *
 * Sampling the split before the router has re-read it measures the *previous* split
 * perfectly and reports it as a routing failure. So every measurement below waits for the
 * router to say it is applying the split under test, and the wait is on the router rather
 * than on a sleep long enough to probably work.
 */
async function routerTable() {
  const response = await fetch(`http://127.0.0.1:${LOCAL_PORT}/-/routing`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`/-/routing -> ${response.status}`);
  return response.json();
}

/** Waits until the router is applying `weight` for `version`, and considers it reachable. */
async function routerApplying(version, weight) {
  return until(`the router to apply v${version} at ${weight}%`, async (because) => {
    let table;
    try {
      table = await routerTable();
    } catch (err) {
      because(`could not read the router's own view: ${err.message}`);
      return null;
    }
    const target = (table.targets ?? []).find((t) => t.version === version);
    if (!target) {
      because(`the router's table has no v${version} (${table.age_seconds}s old)`);
      return null;
    }
    if (target.weight !== weight) {
      because(`the router still has v${version} at ${target.weight}% `
        + `(table ${table.age_seconds}s old)`);
      return null;
    }
    if (!target.ready) {
      because(`the router considers v${version} unreachable`);
      return null;
    }
    return table;
  }, { timeout: 90_000, interval: 1000 });
}

/**
 * Re-establishes the forward onto the front Service.
 *
 * `kubectl port-forward svc/...` resolves the Service to *one pod* when it starts and
 * stays bound to it. That is invisible until the thing under test is a Service whose
 * selector moves: the forward opened while the address pointed at v1 goes on reaching
 * v1's pod directly after the address has moved onto the router, and every sample comes
 * back unattributed and 90/10-looking-like-100/0 — a measurement of the wrong thing that
 * reports as a routing failure.
 *
 * So the forward is rebound after every move of the front door. The real callers this
 * stands in for resolve the Service per connection and never have this problem.
 */
async function rebindAddress(service) {
  await globalThis.__forward?.close().catch(() => {});
  globalThis.__forward = await portForward(service, LOCAL_PORT);
}

/**
 * Samples the split as it is actually served.
 *
 * Sequentially in `CONCURRENCY` lanes rather than all at once: the point is to observe
 * the router's choices, and a burst large enough to queue would measure the pods' relative
 * speed instead.
 */
async function sample(n) {
  const byVersion = new Map();
  const pairs = new Map();
  const failures = [];

  let issued = 0;
  const lane = async () => {
    while (issued < n) {
      issued += 1;
      try {
        const answer = await ask();
        if (answer.status !== 200) {
          failures.push(`HTTP ${answer.status}: ${JSON.stringify(answer.body).slice(0, 160)}`);
          continue;
        }
        const v = answer.servedBy ?? 'unattributed';
        byVersion.set(v, (byVersion.get(v) ?? 0) + 1);
        pairs.set(`${v}->${answer.artifactId}`, (pairs.get(`${v}->${answer.artifactId}`) ?? 0) + 1);
      } catch (err) {
        failures.push(err.message);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));

  return { byVersion, pairs, failures, total: n };
}

/**
 * The band a share of `n` requests may honestly land in.
 *
 * Binomial, four sigma. Derived from the sample size rather than chosen, so that raising
 * ROLLOUT_SAMPLES tightens the test instead of leaving a tolerance that was picked to fit
 * one run.
 */
function band(expectedPct, n, sigmas = 4) {
  const p = expectedPct / 100;
  const sigma = 100 * Math.sqrt((p * (1 - p)) / n);
  // A floor of one percentage point keeps a 0%-expected share from becoming a zero-width
  // band, and keeps the 10% case honest at small sample sizes.
  const width = Math.max(sigmas * sigma, 1);
  return { low: expectedPct - width, high: expectedPct + width, sigma };
}

function note(line) {
  console.log(`        ${line}`);
}

// ------------------------------------------------------------------ the story

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('two versions of one model, each from its own real training run', async () => {
  await api('POST', '/api/v1/projects', { name: project, description: 'e2e: weighted rollout' });
  await api('POST', `/api/v1/projects/${project}/datasets`, { name: 'cifar10' });
  await api('POST', `/api/v1/projects/${project}/datasets/cifar10/versions`, {
    version: 'v1', uri: 's3://ashml/cifar10/v1', digest: 'sha256:aa11',
  });
  const experiment = await api('POST', '/api/v1/experiments', {
    project,
    name: 'rollout',
    dataset: 'cifar10',
    dataset_version: 'v1',
    random_seed: 1337,
  });

  // Both at once: they fit the cluster side by side, and a rollout test should not spend
  // twice as long as it needs to on the part that is not the rollout.
  const submit = (seed) => api('POST', '/api/v1/jobs', {
    project,
    name: `rollout-train-seed${seed}`,
    experiment: experiment.id,
    resources: { cpu: 2, memory_bytes: 4_294_967_296 },
    spec: {
      image: IMAGE,
      command: ['python', 'resnet_cifar.py'],
      env: {
        EPOCHS: '1',
        MAX_STEPS: String(STEPS),
        MAX_EVAL_BATCHES: '2',
        BATCH_SIZE: '128',
        LR: '0.1',
        SEED: String(seed),
        LOG_EVERY: '10',
        DATALOADER_WORKERS: '2',
        OMP_NUM_THREADS: '2',
      },
    },
  });

  const jobs = await Promise.all([submit(1337), submit(4242)]);

  const artifacts = [];
  for (const job of jobs) {
    await until(`job ${job.name} to finish`, async () => {
      const current = await api('GET', `/api/v1/jobs/${job.id}`);
      if (['FAILED', 'CANCELLED'].includes(current.state)) {
        throw new Error(`training ${current.state} before anything could be rolled out: `
          + `${current.failure_reason ?? 'no reason recorded'}`);
      }
      return current.state === 'SUCCEEDED';
    });

    const { artifacts: produced } = await api('GET', `/api/v1/jobs/${job.id}/artifacts`);
    const model = produced.find((a) => a.kind === 'model' && a.status === 'READY');
    assert.ok(model, `${job.name} produced no READY model artifact`);
    artifacts.push(model);
  }

  await api('POST', `/api/v1/projects/${project}/models`, { name: MODEL });
  const versions = [];
  for (const artifact of artifacts) {
    versions.push(await api('POST', `/api/v1/projects/${project}/models/${MODEL}/versions`, {
      artifact_id: artifact.id,
    }));
  }

  assert.deepEqual(versions.map((v) => v.version), [1, 2], 'versions are numbered in order');
  globalThis.__versions = versions;
  note(`v1 ${artifacts[0].id.slice(0, 8)}  v2 ${artifacts[1].id.slice(0, 8)}  `
    + `(${STEPS} steps each — undertrained on purpose; the routing is what is under test)`);
});

check('deploying one version gives it its own pods, and puts no router in the path', async () => {
  await api('POST', `/api/v1/projects/${project}/models/${MODEL}/versions/1/status`, {
    status: 'PRODUCTION',
  });
  await api('POST', `/api/v1/projects/${project}/models/${MODEL}/deployments`, {
    name: DEPLOYMENT,
  });

  const deployment = await until('the deployment to become READY on v1', async () => {
    const d = await api('GET', `/api/v1/projects/${project}/deployments/${DEPLOYMENT}`);
    return d.status === 'READY' && d.serving_version === 1 ? d : null;
  });

  // A router exists only while there is something to decide, and right now there is not.
  assert.equal(deployment.router_k8s_name, null, 'a single-version deployment needs no router');
  const routers = await kubectl(
    'get', 'deploy', '-n', NAMESPACE,
    '-l', `ashml.io/deployment-id=${deployment.id},app.kubernetes.io/component=model-router`,
    '-o', 'jsonpath={.items[*].metadata.name}',
  );
  assert.equal(routers, '', `the cluster has a router nothing asked for: ${routers}`);

  globalThis.__deployment = deployment;
  globalThis.__clusterIP = await kubectl(
    'get', 'svc', deployment.k8s_name, '-n', NAMESPACE, '-o', 'jsonpath={.spec.clusterIP}',
  );
  note(`${deployment.k8s_name} at ${globalThis.__clusterIP}, serving v1`);
});

check('the address answers, and the pod behind it loaded v1', async () => {
  const deployment = globalThis.__deployment;
  globalThis.__forward = await portForward(deployment.k8s_name, LOCAL_PORT);

  const answer = await ask();
  assert.equal(answer.status, 200, `the deployment's own address does not answer: ${
    JSON.stringify(answer.body)}`);
  assert.equal(
    answer.artifactId, deployment.targets.find((t) => t.version === 1).artifact_id,
    'the pod behind the address is serving a different artifact from the one v1 points at',
  );
  assert.equal(answer.servedBy, null, 'nothing should be attributing requests: there is no router');
  note(`artifact ${answer.artifactId.slice(0, 8)} answering on the front door`);
});

check('a 10% canary puts a router in the path without moving the address', async () => {
  await api('POST', `/api/v1/projects/${project}/deployments/${DEPLOYMENT}/rollout`, {
    version: 2, traffic: 10,
  });

  // Two things have to become true, and they become true in that order rather than
  // together. The address moves onto the router as soon as the *router* is ready — which
  // it is while it still has only v1 to route to, since a router with one reachable
  // version is a working router. The canary is only actually in place once v2's own pods
  // answer as well, and waiting for the first and asserting the second is how a test
  // reports "the canary never came up" as "the split is wrong".
  const deployment = await until('the canary to be in place: router fronting, both versions up', async (because) => {
    const d = await api('GET', `/api/v1/projects/${project}/deployments/${DEPLOYMENT}`);
    if (d.serving_version !== null) {
      because(`the address still resolves to v${d.serving_version} (router ${d.router_status ?? 'not created'})`);
      return null;
    }
    if (!(d.router_ready_replicas > 0)) {
      because(`no router replica is ready (${d.router_status}${d.last_error ? `: ${d.last_error}` : ''})`);
      return null;
    }
    const notReady = d.targets.filter((t) => t.ready_replicas < 1);
    if (notReady.length) {
      because(notReady.map((t) => `v${t.version} ${t.status}`
        + `${t.last_error ? ` (${t.last_error})` : ''}`).join(', '));
      return null;
    }
    return d;
  });

  const selector = JSON.parse(await kubectl(
    'get', 'svc', deployment.k8s_name, '-n', NAMESPACE, '-o', 'jsonpath={.spec.selector}',
  ));
  assert.equal(selector['app.kubernetes.io/component'], 'model-router', 'the front door is not on the router');
  assert.ok(
    !('ashml.io/model-version' in selector),
    'a stale ashml.io/model-version survived the patch — this selector matches no pod at all, '
    + 'which is a routine rollout becoming an outage with no error anywhere',
  );

  // The whole promise of moving a selector instead of recreating a Service.
  const clusterIP = await kubectl(
    'get', 'svc', deployment.k8s_name, '-n', NAMESPACE, '-o', 'jsonpath={.spec.clusterIP}',
  );
  assert.equal(clusterIP, globalThis.__clusterIP, 'the deployment’s address moved');

  // Each version has its own Deployment, because a weight can only be given to something
  // that can be reached. Asked of the cluster rather than of AshML: the whole point of
  // this script is the gap between the two.
  for (const version of [1, 2]) {
    const target = deployment.targets.find((t) => t.version === version);
    assert.ok(target.k8s_name, `v${version} has no Kubernetes objects of its own`);
    const ready = await kubectl(
      'get', 'deploy', target.k8s_name, '-n', NAMESPACE, '-o', 'jsonpath={.status.readyReplicas}',
    );
    assert.equal(Number(ready || 0), 1, `v${version} is not answering on its own Service`);
  }

  // The address now resolves to the router rather than to v1's pods, so the forward
  // opened in the previous check is pointing at the wrong thing. See rebindAddress.
  await rebindAddress(deployment.k8s_name);

  // And the router has to have re-read the split before anything measures it.
  const table = await routerApplying(2, 10);

  globalThis.__deployment = deployment;
  note(`router ${deployment.router_k8s_name} in the path; address still ${clusterIP}; `
    + `router applying ${table.targets.map((t) => `v${t.version} ${t.weight}%`).join(' ')}`);
});

check('real traffic divides 90/10, and both accounts of who answered agree', async () => {
  const { byVersion, pairs, failures, total } = await sample(SAMPLES);

  assert.equal(
    failures.length, 0,
    `${failures.length}/${total} requests through the address failed. First: ${failures[0]}`,
  );

  const unattributed = byVersion.get('unattributed') ?? 0;
  assert.equal(unattributed, 0, 'a prediction nobody can attribute to a version is the failure this exists to prevent');

  const v2 = byVersion.get('v2') ?? 0;
  const v1 = byVersion.get('v1') ?? 0;
  assert.equal(v1 + v2, total, `something other than v1/v2 answered: ${[...byVersion.keys()].join(', ')}`);

  const share = (100 * v2) / total;
  const { low, high, sigma } = band(10, total);
  assert.ok(
    share >= low && share <= high,
    `v2 took ${share.toFixed(1)}% of ${total} requests; a 10% split should land in `
    + `${low.toFixed(1)}–${high.toFixed(1)}% (sigma ${sigma.toFixed(2)})`,
  );

  // The strong form: the router's attribution against the pod's own account of itself.
  // Each version must map to exactly one artifact, and it must be that version's.
  const deployment = globalThis.__deployment;
  for (const version of [1, 2]) {
    const expected = deployment.targets.find((t) => t.version === version).artifact_id;
    const seen = [...pairs.keys()].filter((k) => k.startsWith(`v${version}->`));
    assert.deepEqual(
      seen, [`v${version}->${expected}`],
      `requests attributed to v${version} were answered by ${seen.join(', ')}`,
    );
  }

  note(`v1 ${v1}  v2 ${v2}  (${share.toFixed(1)}% to the canary, band `
    + `${low.toFixed(1)}–${high.toFixed(1)}%)`);
});

check('moving the canary to 50% changes the split and nothing else', async () => {
  await api('POST', `/api/v1/projects/${project}/deployments/${DEPLOYMENT}/rollout`, {
    version: 2, traffic: 50,
  });

  const before = globalThis.__deployment;

  // The router re-reads the split on its own timer; a rollout takes effect within one of
  // those rather than by restarting anything. Waiting for the router to *report* the new
  // split is what distinguishes "applied" from "the control plane wrote a row" — and it
  // is the difference between a canary step and a restart, so it is worth waiting on
  // rather than sleeping past.
  const table = await routerApplying(2, 50);
  assert.ok(table.age_seconds < 30, `the router is applying a ${table.age_seconds}s-old split`);

  const { byVersion, failures, total } = await sample(SAMPLES);
  assert.equal(failures.length, 0, `requests failed during the 50% step: ${failures[0]}`);

  const v2 = byVersion.get('v2') ?? 0;
  const share = (100 * v2) / total;
  const { low, high } = band(50, total);
  assert.ok(
    share >= low && share <= high,
    `v2 took ${share.toFixed(1)}% of ${total} requests at a 50% split; expected `
    + `${low.toFixed(1)}–${high.toFixed(1)}%`,
  );

  const after = await api('GET', `/api/v1/projects/${project}/deployments/${DEPLOYMENT}`);
  assert.equal(after.router_k8s_name, before.router_k8s_name, 'the router was replaced to change a weight');
  const clusterIP = await kubectl(
    'get', 'svc', after.k8s_name, '-n', NAMESPACE, '-o', 'jsonpath={.spec.clusterIP}',
  );
  assert.equal(clusterIP, globalThis.__clusterIP, 'the address moved during a weight change');

  note(`v2 ${share.toFixed(1)}% of ${total}; same router, same address`);
});

check('promote ends the rollout: the address goes to v2 and the router leaves', async () => {
  await api('POST', `/api/v1/projects/${project}/deployments/${DEPLOYMENT}/promote`, { version: 2 });

  const deployment = await until('the address to resolve to v2 alone', async () => {
    const d = await api('GET', `/api/v1/projects/${project}/deployments/${DEPLOYMENT}`);
    return d.serving_version === 2 && d.router_k8s_name === null ? d : null;
  });

  // The rollback is what promote keeps, and it is worth asserting because the tidy-up
  // that removes it would look like housekeeping.
  const v1 = deployment.targets.find((t) => t.version === 1);
  assert.ok(v1, 'v1 was dropped: going back is now a redeploy rather than a weight change');
  assert.equal(v1.traffic_weight, 0, 'v1 should be kept at 0%, not left taking traffic');

  await until('the router pods to go', async () => {
    const names = await kubectl(
      'get', 'pods', '-n', NAMESPACE,
      '-l', `ashml.io/deployment-id=${deployment.id},app.kubernetes.io/component=model-router`,
      '-o', 'jsonpath={.items[*].metadata.name}',
    );
    return names === '';
  }, { timeout: 120_000 });

  // And with the router gone, the address must still answer — now directly from v2.
  await rebindAddress(deployment.k8s_name);
  const answer = await until('v2 to answer on the address directly', async () => {
    const a = await ask();
    return a.status === 200 && a.artifactId === deployment.targets.find((t) => t.version === 2).artifact_id
      ? a : null;
  }, { timeout: 60_000 });

  assert.equal(answer.servedBy, null, 'the router left the path but is still attributing requests');
  const clusterIP = await kubectl(
    'get', 'svc', deployment.k8s_name, '-n', NAMESPACE, '-o', 'jsonpath={.spec.clusterIP}',
  );
  assert.equal(clusterIP, globalThis.__clusterIP, 'the address moved when the rollout ended');

  globalThis.__deployment = deployment;
  note(`v2 alone on ${clusterIP}; v1 kept at 0% as the rollback`);
});

check('the rollback is a weight change, and it brings v1 back', async () => {
  await api('POST', `/api/v1/projects/${project}/deployments/${DEPLOYMENT}/rollout`, {
    version: 1, traffic: 100,
  });

  const deployment = await until('the address to resolve to v1 again', async () => {
    const d = await api('GET', `/api/v1/projects/${project}/deployments/${DEPLOYMENT}`);
    return d.serving_version === 1 ? d : null;
  });

  await rebindAddress(deployment.k8s_name);
  const expected = deployment.targets.find((t) => t.version === 1).artifact_id;
  const answer = await until('v1 to answer on the address', async () => {
    const a = await ask();
    return a.status === 200 && a.artifactId === expected ? a : null;
  }, { timeout: 60_000 });

  assert.equal(answer.artifactId, expected);
  // 100% to one version means nothing to decide, so no router should have been created
  // for a rollback either.
  assert.equal(deployment.router_k8s_name, null, 'a rollback to one version raised a router');

  globalThis.__deployment = deployment;
  note('back on v1 without an image pull: the pods were still there at 0%');
});

check('retiring the version that is serving is refused; retiring the other one works', async () => {
  const response = await fetch(
    `${ENDPOINT}/api/v1/projects/${project}/deployments/${DEPLOYMENT}/targets/1`,
    { method: 'DELETE' },
  );
  const body = await response.json();
  assert.equal(response.status, 409, `retiring the version taking 100% of the traffic returned ${response.status}`);
  assert.equal(body.error.code, 'VERSION_TAKES_TRAFFIC');
  assert.match(body.error.message, /rollout/, 'the refusal must say what to do instead');

  // v2 takes no traffic and the address does not resolve to it, so it can go.
  const after = await api('DELETE', `/api/v1/projects/${project}/deployments/${DEPLOYMENT}/targets/2`);
  assert.deepEqual(after.targets.map((t) => t.version), [1], 'v2 is still a target after being retired');

  await until('v2’s objects to be removed from the cluster', async () => {
    const names = await kubectl(
      'get', 'deploy', '-n', NAMESPACE,
      '-l', `ashml.io/deployment-id=${after.id},ashml.io/model-version=2`,
      '-o', 'jsonpath={.items[*].metadata.name}',
    );
    return names === '';
  }, { timeout: 120_000 });

  // And after all of it, the address is where it started and still answers.
  const answer = await ask();
  assert.equal(answer.status, 200, 'the address stopped answering after the retire');
  const clusterIP = await kubectl(
    'get', 'svc', after.k8s_name, '-n', NAMESPACE, '-o', 'jsonpath={.spec.clusterIP}',
  );
  assert.equal(clusterIP, globalThis.__clusterIP,
    'the address moved at some point across deploy, canary, promote, rollback and retire');
  note(`one address, ${clusterIP}, unmoved through all of it`);
});

// ------------------------------------------------------------------- driver

await requireContext();

console.log(`\ne2e: a weighted rollout, against real pods  (project ${project})`);
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
    // The checks are one sequence: a canary that never started makes every later
    // assertion about a deployment that does not exist, and reporting eight failures
    // for one cause buries it.
    break;
  }
}

// Leave nothing running. A model server and a router hold real capacity on this cluster,
// and the next run of this script asks for the same again.
await globalThis.__forward?.close().catch(() => {});
if (globalThis.__deployment) {
  await api('DELETE', `/api/v1/projects/${project}/deployments/${DEPLOYMENT}`).catch(() => {});
}

console.log(`\n${passed}/${checks.length} rollout checks passed`);
process.exit(failed === 0 ? 0 : 1);
