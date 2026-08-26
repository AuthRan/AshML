/**
 * End-to-end proof that one project's pods cannot reach another's.
 *
 *   Two projects, four real containers on k3d, and one question asked of the cluster
 *   rather than of AshML: can a pod in project A open a connection to a pod in
 *   project B?
 *
 * This is the gap Phase 10 named and left open. AshML's own authorization cannot close
 * it, because that traffic never goes near the control plane: it is pod to pod, and only
 * the cluster can refuse it (`k8s/manifest.js`, ADR 0017).
 *
 * It is now closed twice over, and the checks below are deliberately written against
 * both halves. Each project has a **namespace of its own** (ADR 0019), which is the
 * structural half: separate namespaces, separate service accounts, and a Pod Security
 * Admission label the cluster applies to each. And each project keeps its **egress
 * NetworkPolicy**, which is the half that still does the refusing — a namespace by
 * itself does not stop a pod dialling an IP in another one.
 *
 * Both are checked because either alone would leave a false claim in the README. The
 * namespaces could be right while the policy is unenforced, and the policy could be
 * enforced while a change quietly puts two projects back in one namespace.
 *
 * Which is exactly why this script exists in the shape it does. A NetworkPolicy is an
 * object every cluster *accepts* and only some clusters *enforce* — a CNI without a
 * policy controller stores it, lists it back, and routes the traffic anyway. So none of
 * the checks below assert on the manifest AshML built. They run `wget` inside a pod and
 * read the exit code.
 *
 * The negative result is only worth something next to a positive one, so every refusal
 * here is paired with the same request succeeding from inside the project that owns the
 * address. "alpha cannot reach beta" proves nothing on its own; "alpha cannot reach the
 * address beta reaches at the same moment" is the claim.
 *
 * The last check is the other half, and it is the one that would have failed the obvious
 * implementation: the API server's `/proxy` endpoint must still reach a model server's
 * pod, because that is how `callService` — `ash predict` — talks to a deployment from
 * outside the cluster. An ingress-shaped policy passes every check above it and breaks
 * this one, intermittently, depending on which node the pod landed on.
 *
 * Prerequisites:  make cluster && make db-up && make migrate
 * Run:            make e2e-isolation
 */

import assert from 'node:assert/strict';

import { buildApp } from '../packages/server/src/app.js';
import { loadConfig } from '../packages/server/src/config.js';
import { runOnce } from '../packages/server/src/services/executor.js';
import { discoverCluster } from '../packages/server/src/services/nodes.js';
import { getJob } from '../packages/server/src/services/jobs.js';
import { JobState } from '../packages/server/src/domain/job-state.js';
import { projectNetworkPolicyName } from '../packages/server/src/k8s/manifest.js';
import { kubectl, requireContext, KUBE_CONTEXT } from './lib/kubectl.mjs';
import { authenticate } from './lib/auth.mjs';

const NAMESPACE = process.env.ASHML_K8S_NAMESPACE ?? 'ashml-jobs';
// busybox rather than the AshML trainer image: these pods need to serve one line of HTTP
// and to run `wget`, not to train anything, and a 2 MB image keeps this script runnable
// on a CI runner that has built nothing.
const IMAGE = process.env.ISOLATION_IMAGE ?? 'busybox:1.36';
const PORT = 8080;
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180_000);

const config = loadConfig({
  ...process.env,
  ASHML_GPU_PROVIDER: 'sim',       // Not what is under test.
  ASHML_K8S_BACKEND: 'kubernetes', // Very much what is under test.
  ASHML_K8S_NAMESPACE: NAMESPACE,
  ASHML_KUBECONFIG_CONTEXT: KUBE_CONTEXT,
});

await requireContext();

const app = await buildApp(config, { logger: false });
await app.ready();
await authenticate(app);

/**
 * Actually listen, because one of the checks below is answered by a pod rather than by
 * this process.
 *
 * Every other assertion here is made through `app.inject`, which needs no socket. "A pod
 * can still reach the control plane" cannot be: it runs `wget` inside a container against
 * `apiAdvertiseUrl`, and something has to be on the other end. Nothing was — this script
 * had an unwritten prerequisite that a control plane be running, and in CI, where none is,
 * the check failed with `Connection refused` on every run since it was added while the
 * five checks around it passed.
 *
 * Bound to 0.0.0.0 on the port the advertise URL names, so the address a training pod is
 * told to report to is the address this answers on — `host.k3d.internal` from inside the
 * cluster and the host's own interface from outside are the same socket.
 *
 * An address already in use is not an error. It means a control plane is already running
 * here, which is the condition this is arranging for; the check will reach that one
 * instead. Any other listen failure is real and is left to surface.
 */
const advertised = new URL(config.apiAdvertiseUrl);
try {
  await app.listen({ host: '0.0.0.0', port: Number(advertised.port || 80) });
} catch (err) {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log(`        port ${advertised.port} is already served; using what is there`);
}

const suffix = Math.random().toString(36).slice(2, 8);
const alpha = `iso-a-${suffix}`;
const beta = `iso-b-${suffix}`;

/** Every job this script started, so the cluster is left as it was found. */
const started = [];
const results = [];

function check(name, fn) {
  results.push({ name, fn });
}

async function createProject(name) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name, description: 'per-project network isolation' },
  });
  assert.equal(res.statusCode, 201, res.payload);
  // Returned rather than discarded: a project's namespace is named from its id as well
  // as its name, so the checks below need the row and not just the string they passed in.
  return res.json();
}

/**
 * A pod that answers one line of HTTP, or one that just waits.
 *
 * Both run until cancelled. `serve` is the address another project will try to reach;
 * `idle` is the pod the attempt is made *from*, because `kubectl exec` needs somewhere
 * to run and a pod busy serving is a worse place to run it.
 */
async function submit(project, name, kind) {
  const command = kind === 'serve'
    ? ['sh', '-c', `mkdir -p /www && echo "${project}" > /www/index.html `
      + `&& httpd -f -p ${PORT} -h /www`]
    : ['sh', '-c', 'sleep 3600'];

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    payload: {
      project,
      name,
      spec: { image: IMAGE, image_pull_policy: 'IfNotPresent', command },
      resources: { cpu: 1 },
    },
  });
  assert.equal(res.statusCode, 201, res.payload);

  const job = res.json();
  started.push(job.id);
  return job;
}

/** Drives executor passes until the job is RUNNING, then returns its pod. */
async function runningPod(jobId, what) {
  const deadline = Date.now() + TIMEOUT_MS;
  let job;
  while (Date.now() < deadline) {
    await runOnce(app.db, app.k8s);
    job = await getJob(app.db, jobId);
    if (job.state === JobState.RUNNING) break;
    if (job.state === JobState.FAILED || job.state === JobState.CANCELLED) {
      throw new Error(`${what} ended as ${job.state}: ${job.failure_reason ?? 'no reason given'}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
  if (job?.state !== JobState.RUNNING) {
    throw new Error(`timed out waiting for ${what} to run; it is ${job?.state}`);
  }

  // The namespace the job recorded when it launched, not the one this script is
  // configured with. They are different now: a job runs in its project's own namespace,
  // and `NAMESPACE` is only the base those names are built from.
  const ns = job.namespace;
  assert.ok(ns, `${what} is running but recorded no namespace`);

  const pod = await kubectl(
    'get', 'pods', '-n', ns, '-l', `job-name=${job.k8s_job_name}`,
    '-o', 'jsonpath={.items[0].metadata.name}',
  );
  const ip = await kubectl('get', 'pod', pod, '-n', ns, '-o', 'jsonpath={.status.podIP}');
  const node = await kubectl('get', 'pod', pod, '-n', ns, '-o', 'jsonpath={.spec.nodeName}');
  assert.ok(ip, `${what} is running but has no pod IP`);
  return { pod, ip, node, namespace: ns };
}

/** The address another pod would use to reach a pod that is serving. */
const served = (target) => `http://${target.ip}:${PORT}/`;

/**
 * Whether one pod can fetch a URL, asked by running `wget` inside it.
 *
 * The timeout is short and deliberate. A policy that refuses gets a TCP reset back from
 * kube-router and fails immediately; one that drops instead would hang, and four seconds
 * is long enough to tell those apart from a slow answer without adding a minute to the
 * run for each blocked check.
 */
async function canReach(from, url) {
  try {
    const body = await kubectl(
      'exec', '-n', from.namespace, from.pod, '--',
      'wget', '-q', '-O', '-', '-T', '4', url,
    );
    return { ok: true, body: body.trim() };
  } catch (err) {
    return { ok: false, body: (err.stderr ?? err.message ?? '').trim() };
  }
}

const pods = {};
/** The project rows, kept because a namespace is named from the id as well as the name. */
const projects = {};

// --------------------------------------------------------------- the checks

check('two projects, two real containers each, all running on the cluster', async () => {
  await app.k8s.ensureNamespace();
  await discoverCluster(app.db, app.k8s, app.gpuProvider);

  projects.alpha = await createProject(alpha);
  projects.beta = await createProject(beta);

  const submitted = {
    alphaServer: await submit(alpha, `srv-a-${suffix}`, 'serve'),
    alphaClient: await submit(alpha, `cli-a-${suffix}`, 'idle'),
    betaServer: await submit(beta, `srv-b-${suffix}`, 'serve'),
    betaClient: await submit(beta, `cli-b-${suffix}`, 'idle'),
  };

  for (const [key, job] of Object.entries(submitted)) {
    pods[key] = await runningPod(job.id, key);
  }

  // Not an assertion about isolation — an assertion about what the next checks mean. If
  // both projects happened to land on one node, the run still proves the policy works,
  // but it has not exercised the cross-node path that broke the ingress-shaped version.
  const nodes = new Set(Object.values(pods).map((p) => p.node));
  console.log(`        pods are on ${nodes.size} node(s): ${[...nodes].join(', ')}`);
});

check('the two projects are in different namespaces, and the cluster hardens both', async () => {
  // The structural half of the boundary, and the one that does not depend on a CNI
  // enforcing anything. Two namespaces is what makes every rule below a rule Kubernetes
  // applies rather than one AshML remembers to.
  const nsAlpha = pods.alphaServer.namespace;
  const nsBeta = pods.betaServer.namespace;
  assert.notEqual(nsAlpha, nsBeta, 'each project must have a namespace of its own');
  assert.equal(nsAlpha, app.k8s.namespaceFor(projects.alpha));
  assert.equal(nsBeta, app.k8s.namespaceFor(projects.beta));

  // Pod Security Admission is the cluster refusing a privileged pod whoever asks for it,
  // including anything with write access that is not AshML. It was won for the shared
  // namespace in Phase 10 and would be silently lost by moving workloads to namespaces
  // that do not carry it, which is exactly the kind of regression a manifest assertion
  // would not catch.
  for (const ns of [nsAlpha, nsBeta]) {
    const enforce = await kubectl(
      'get', 'namespace', ns,
      '-o', 'jsonpath={.metadata.labels.pod-security\\.kubernetes\\.io/enforce}',
    );
    assert.equal(enforce, 'baseline', `${ns} should be labelled for Pod Security Admission`);
  }
});

check('each project has a NetworkPolicy, applied by the platform and not by hand', async () => {
  for (const [key, project] of [['alphaServer', alpha], ['betaServer', beta]]) {
    const name = projectNetworkPolicyName(project);
    const found = await kubectl(
      'get', 'networkpolicy', name, '-n', pods[key].namespace,
      '-o', 'jsonpath={.metadata.labels.app\\.kubernetes\\.io/managed-by}',
    );
    assert.equal(found, 'ashml', `${name} should exist and be managed by AshML`);
  }
});

check('a project can reach its own pods — the control for every refusal below', async () => {
  const own = await canReach(pods.alphaClient, served(pods.alphaServer));
  assert.ok(own.ok, `alpha could not reach its own server: ${own.body}`);
  assert.equal(own.body, alpha);

  const theirs = await canReach(pods.betaClient, served(pods.betaServer));
  assert.ok(theirs.ok, `beta could not reach its own server: ${theirs.body}`);
  assert.equal(theirs.body, beta);
});

check('a pod cannot reach another project\'s pod, at the address that project just used', async () => {
  // The whole point, and the reason the check above runs first: this address answered a
  // request seconds ago, from a pod in the project that owns it.
  const across = await canReach(pods.alphaClient, served(pods.betaServer));
  assert.equal(
    across.ok, false,
    `alpha reached beta's pod and got "${across.body}" — the network policy is not being `
    + 'enforced. The manifest exists either way; a CNI without a policy controller '
    + 'accepts it and routes the traffic anyway.',
  );

  // And symmetrically, which is what makes this a boundary rather than a one-way filter.
  const back = await canReach(pods.betaClient, served(pods.alphaServer));
  assert.equal(back.ok, false, `beta reached alpha's pod and got "${back.body}"`);
});

check('a pod can still reach the control plane, which is outside the cluster', async () => {
  // The rule that allows "everything that is not a pod here" is what keeps a training job
  // able to report metrics, upload a checkpoint and fetch a dataset. A policy that
  // isolated projects by isolating them from the platform would pass every check above.
  const health = await canReach(
    pods.alphaClient,
    new URL('/healthz', config.apiAdvertiseUrl).toString(),
  );
  assert.ok(
    health.ok,
    `a pod could not reach the control plane at ${config.apiAdvertiseUrl}: ${health.body}. `
    + 'Isolating a project from the platform is not what this policy is for.',
  );
});

check('the API server can still proxy to a pod, which is how ash predict works', async () => {
  // The check that decides between an egress policy and an ingress one. `callService`
  // reaches a model server through the API server's /proxy endpoint, and on k3s that
  // traffic arrives at a pod on another node from *inside* the cluster's pod network —
  // so an ingress policy written as "only my own project may connect" refuses it, and
  // refuses it only for the pods that happen not to share a node with the API server.
  const body = await kubectl(
    'get', '--raw',
    `/api/v1/namespaces/${pods.betaServer.namespace}/pods/${pods.betaServer.pod}:${PORT}/proxy/`,
  );
  assert.equal(
    body.trim(), beta,
    'the API server must still be able to proxy to a pod; serving depends on it',
  );
});

// ------------------------------------------------------------------- driver

let failed = 0;
for (const { name, fn } of results) {
  const at = Date.now();
  try {
    await fn();
    console.log(`  ok    ${name}  (${((Date.now() - at) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
  }
}

// These pods sleep for an hour and serve until told otherwise, so leaving them behind
// would hold cluster capacity long after the run that created them. Cancelled through
// the API rather than with `kubectl delete`, so the teardown goes through the same path
// a user's cancel does and a job left RUNNING in the database is not the price of a
// failed check.
for (const id of started) {
  try {
    await app.inject({ method: 'POST', url: `/api/v1/jobs/${id}/cancel`, payload: {} });
  } catch { /* reported below by whatever is left in the namespace */ }
}
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  await runOnce(app.db, app.k8s);
  const states = await Promise.all(started.map((id) => getJob(app.db, id)));
  if (states.every((job) => job.state === JobState.CANCELLED)) break;
  await new Promise((resolve) => { setTimeout(resolve, 1000); });
}

// And the namespaces the two throwaway projects were given. Nothing else removes them:
// a project has no delete endpoint, so its namespace outlives every run that made one,
// and a script that leaves two behind on every invocation is how a cluster ends up with
// hundreds. Deleted by name, after the pods inside them are gone, and only ever the ones
// this run created.
for (const project of Object.values(projects)) {
  if (!project) continue;
  try {
    await kubectl('delete', 'namespace', app.k8s.namespaceFor(project), '--wait=false');
  } catch { /* the checks above already reported anything that matters */ }
}

console.log(`\n${results.length - failed}/${results.length} isolation checks passed`);

await app.close();
process.exit(failed === 0 ? 0 : 1);
