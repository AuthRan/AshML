/**
 * End-to-end proof of the Phase 3 exit criteria against a real k3d cluster.
 *
 *   submit more jobs than the cluster can hold; they queue correctly, run only as
 *   capacity allows, and the platform explains every placement.
 *
 * **On GPUs.** The exit criterion is written in terms of GPUs. This machine has two
 * real RTX 2080 Tis, but Docker here has no `nvidia` container runtime and installing
 * the NVIDIA container toolkit needs root, so no GPU can be passed into a k3d node and
 * the cluster advertises `nvidia.com/gpu: 0`. Rather than fake it, this script
 * constrains on **CPU**, which is real capacity on this cluster and exercises exactly
 * the same scheduler code path — capacity accounting, admission, requeue, and the
 * decision record. The GPU-specific arithmetic is covered by the unit tests in
 * `domain/placement.test.js` and against a precisely-sized fake cluster in
 * `services/scheduler.integration.test.js`.
 *
 * A GPU check is still run here, and it asserts the honest outcome: a GPU job stays
 * queued and says why. Claiming a GPU run this environment cannot perform is exactly
 * what spec Rule 5 forbids.
 *
 * Prerequisites:  make cluster && make image && make db-up && make migrate
 * Run:            make e2e-scheduler
 */

import assert from 'node:assert/strict';

import { buildApp } from '../packages/server/src/app.js';
import { loadConfig } from '../packages/server/src/config.js';
import { runOnce } from '../packages/server/src/services/executor.js';
import { discoverCluster, listNodes } from '../packages/server/src/services/nodes.js';
import { getSchedulingHistory } from '../packages/server/src/services/scheduler.js';
import { getJob, listJobs } from '../packages/server/src/services/jobs.js';
import { JobState } from '../packages/server/src/domain/job-state.js';
// kubectl is pinned to the same context the control plane below is built with, so a
// workstation with two clusters cannot assert against one while testing the other.
// See scripts/lib/kubectl.mjs.
import { kubectl, requireContext, KUBE_CONTEXT } from './lib/kubectl.mjs';
import { authenticate } from './lib/auth.mjs';

const NAMESPACE = process.env.ASHML_K8S_NAMESPACE ?? 'ashml-jobs';
const IMAGE = process.env.TRAINER_IMAGE ?? 'ashml/trainer:v1';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 120_000);

const config = loadConfig({
  ...process.env,
  ASHML_GPU_PROVIDER: process.env.ASHML_GPU_PROVIDER ?? 'nvidia',
  ASHML_K8S_BACKEND: 'kubernetes',
  ASHML_K8S_NAMESPACE: NAMESPACE,
  // One setting pins both halves of this test: the control plane built here, and the
  // kubectl the assertions read the cluster back with. See scripts/lib/kubectl.mjs.
  ASHML_KUBECONFIG_CONTEXT: KUBE_CONTEXT,
});

await requireContext();

const app = await buildApp(config, { logger: false });
await app.ready();
// The API is default-deny. This script is evidence, so it authenticates rather than
// turning authentication off (scripts/lib/auth.mjs).
await authenticate(app);

const suffix = Math.random().toString(36).slice(2, 8);
const project = `sched-${suffix}`;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

async function submit(name, { cpu = 1, gpu = 0, steps = 30 }) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    payload: {
      project,
      name,
      resources: { cpu, gpu },
      spec: { image: IMAGE, env: { STEPS: String(steps), STEP_SECONDS: '1' } },
    },
  });
  assert.equal(res.statusCode, 201, res.payload);
  return res.json();
}

/** Runs executor passes until `predicate` holds over the project's jobs. */
async function until(predicate, what) {
  const deadline = Date.now() + TIMEOUT_MS;
  let jobs;
  while (Date.now() < deadline) {
    await runOnce(app.db, app.k8s, { maxLaunches: 20 });
    jobs = await listJobs(app.db, { projectName: project, limit: 100 });
    if (predicate(jobs)) return jobs;
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
  const summary = jobs?.map((j) => `${j.name}=${j.state}`).join(' ');
  throw new Error(`timed out waiting for ${what}; jobs were: ${summary}`);
}

const byState = (jobs, state) => jobs.filter((j) => j.state === state);
const active = (jobs) => jobs.filter((j) => ['STARTING', 'RUNNING'].includes(j.state));

let nodeCapacity = null;

// --------------------------------------------------------------- the checks

check('discovery registers the real cluster nodes with their real capacity', async () => {
  await app.k8s.ensureNamespace();
  const summary = await discoverCluster(app.db, app.k8s, app.gpuProvider);
  assert.ok(summary.nodes >= 1, 'at least one node must be discovered');

  const nodes = await listNodes(app.db);
  const fromKubectl = (await kubectl('get', 'nodes', '-o', 'jsonpath={.items[*].metadata.name}')).split(/\s+/);

  // Compared on *ready* nodes. A node AshML has seen before but the cluster no longer
  // reports is kept and marked not ready rather than deleted, so that the scheduling
  // decisions referring to it stay readable — the shared development database can
  // therefore hold nodes from other runs, and that is the designed behaviour, not drift.
  const ready = nodes.filter((n) => n.ready);
  assert.deepEqual(
    ready.map((n) => n.name).sort(),
    fromKubectl.sort(),
    'AshML must know exactly the nodes the cluster currently has ready',
  );

  // Capacity is read from allocatable, not capacity — what Kubernetes will actually grant.
  assert.ok(ready.length >= 1);
  assert.ok(ready[0].cpu_cores > 0, 'a node with no CPU would make every job unschedulable');
  nodeCapacity = { nodes: ready.length, cpu: ready[0].cpu_cores };
  console.log(`        (cluster: ${ready.length} ready node(s), ${nodeCapacity.cpu} CPU each)`);
});

check('a project can be created', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name: project, description: 'phase 3 end-to-end' },
  });
  assert.equal(res.statusCode, 201, res.payload);
  // Kept so the teardown can reclaim its namespace. A project's namespace is named from
  // its id as well as its name, so the row is what is needed and not the string above.
  globalThis.__project = res.json();
});

check('more jobs than fit are admitted only as capacity allows', async () => {
  // The expected number is derived from the cluster rather than assumed. Each node's
  // usable CPU is its allocatable minus what non-AshML Pods already requested, and that
  // reservation differs between the server and agent nodes — hardcoding "two per node"
  // would be asserting against a number that is not actually true of this cluster.
  const nodes = (await listNodes(app.db)).filter((n) => n.ready);
  const usable = nodes.map((n) => n.cpu_cores - n.reserved_cpu);

  const perJob = Math.max(1, Math.floor(Math.min(...usable) / 2));
  const capacity = usable.reduce((sum, cpu) => sum + Math.floor(cpu / perJob), 0);
  const total = capacity + 3;
  console.log(`        (usable CPU per node: ${usable.join(', ')}; ${perJob} per job => ${capacity} concurrent)`);

  // Long enough that none finishes while the check runs — a job completing would free a
  // slot and make the concurrent count ambiguous. They are cancelled during cleanup.
  for (let i = 0; i < total; i += 1) {
    await submit(`fill-${suffix}-${i}`, { cpu: perJob, steps: 600 });
  }

  // Waits for every job to have *settled*, not just for enough of them to be running.
  //
  // `active(js).length >= capacity` alone is satisfiable while one job is still
  // SCHEDULING — claimed off the queue but not yet placed or returned to it — and a job
  // in that state is neither active nor QUEUED. The next assertion then finds one fewer
  // queued job than were submitted and fails, intermittently and for no real reason.
  // Requiring the two counts to add up to what was submitted closes the window.
  const jobs = await until(
    (js) => active(js).length >= capacity
      && active(js).length + byState(js, JobState.QUEUED).length === total,
    `${capacity} jobs running and the other ${total - capacity} queued`,
  );

  assert.equal(
    active(jobs).length, capacity,
    `exactly ${capacity} jobs should run given ${usable.join('+')} usable CPU`,
  );
  assert.equal(
    byState(jobs, JobState.QUEUED).length, total - capacity,
    'the surplus must wait in the queue rather than failing or over-committing',
  );
});

check('every running job landed on the node AshML chose', async () => {
  // The decision has to be a cause, not a record of an intention.
  const jobs = await listJobs(app.db, { projectName: project, limit: 100 });
  let checked = 0;

  for (const job of active(jobs)) {
    assert.ok(job.placement.node_name, `${job.name} is running with no recorded placement`);

    // A Pod is bound a moment after it is created, so poll rather than reading once —
    // an empty nodeName means "not yet scheduled", not "scheduled somewhere else".
    const deadline = Date.now() + 30_000;
    let actual = '';
    while (Date.now() < deadline && actual === '') {
      actual = await kubectl(
        'get', 'pods', '-n', job.namespace ?? NAMESPACE,
        '-l', `job-name=${job.k8s_job_name}`,
        '-o', 'jsonpath={.items[0].spec.nodeName}',
      ).catch(() => '');
      if (actual === '') await new Promise((r) => { setTimeout(r, 1000); });
    }

    assert.notEqual(actual, '', `${job.name}: Pod was never bound to any node`);
    assert.equal(
      actual, job.placement.node_name,
      `${job.name}: AshML chose ${job.placement.node_name} but the Pod is on ${actual}`,
    );
    checked += 1;
  }

  assert.ok(checked > 0, 'this check needs at least one running job');
});

check('a queued job explains itself, naming every node and what was wrong with it', async () => {
  const jobs = await listJobs(app.db, { projectName: project, limit: 100 });
  const [queued] = byState(jobs, JobState.QUEUED);
  assert.ok(queued, 'this check needs a queued job');

  const res = await app.inject({ method: 'GET', url: `/api/v1/jobs/${queued.id}/scheduling` });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.ok(body.passes.length > 0, 'a queued job must have recorded scheduling passes');

  const decisions = body.passes[0].decisions;

  // Every node the cluster currently has ready must appear — the point of the record is
  // that it accounts for all of them, not just the first one tried. Nodes AshML has
  // seen before and since retired may also appear; they are kept deliberately so old
  // decisions stay readable, and they are rejected as NOT_READY.
  const readyNodes = (await listNodes(app.db)).filter((n) => n.ready).map((n) => n.name);
  const named = decisions.map((d) => d.node_name);
  for (const name of readyNodes) {
    assert.ok(named.includes(name), `node ${name} was not accounted for in the decision`);
  }

  const forReadyNodes = decisions.filter((d) => readyNodes.includes(d.node_name));
  assert.ok(
    forReadyNodes.every((d) => d.outcome === 'REJECTED' && d.details.code === 'INSUFFICIENT_CPU'),
    `expected every ready node rejected for CPU, got: ${JSON.stringify(forReadyNodes.map((d) => d.reason))}`,
  );
  // The numbers that produced the decision are kept, not just the verdict.
  assert.ok(decisions[0].details.requested.cpu > 0);
});

check('capacity freed by a finished job is given to the queue', async () => {
  const before = await listJobs(app.db, { projectName: project, limit: 100 });
  const queuedBefore = byState(before, JobState.QUEUED).length;
  assert.ok(queuedBefore > 0, 'this check needs a backlog');

  // Cancel one running job to free its slot.
  const [victim] = active(before);
  await app.inject({ method: 'POST', url: `/api/v1/jobs/${victim.id}/cancel`, payload: {} });

  // Same settling requirement as above: the admitted job must have reached STARTING or
  // RUNNING, not merely have left the queue. "No longer QUEUED" is also true of a job
  // that is mid-pass, and of one that was refused and is about to be queued again.
  const after = await until(
    (js) => byState(js, JobState.QUEUED).length < queuedBefore
      && js.every((j) => j.state !== 'SCHEDULING'),
    'a queued job to be admitted once capacity frees',
  );

  assert.ok(
    byState(after, JobState.QUEUED).length < queuedBefore,
    'freeing capacity must admit waiting work',
  );
});

check('an unschedulable job does not block the queue behind it', async () => {
  // Clear the backlog first. With the cluster already full, a job waiting behind an
  // unschedulable one is waiting for capacity, not for the scheduler to look past it —
  // and the check would pass or fail for the wrong reason either way.
  const existing = await listJobs(app.db, { projectName: project, limit: 100 });
  for (const job of existing) {
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.state)) {
      await app.inject({ method: 'POST', url: `/api/v1/jobs/${job.id}/cancel`, payload: {} });
    }
  }
  await until(
    (js) => js.every((j) => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(j.state)),
    'the cluster to drain before testing head-of-line blocking',
  );

  // Head-of-line blocking: this job can never fit, and it is at the front of the queue
  // because it was submitted first. Everything behind it must still be considered.
  const impossible = await submit(`impossible-${suffix}`, { cpu: nodeCapacity.cpu * 4, steps: 5 });
  const small = await submit(`small-${suffix}`, { cpu: 1, steps: 5 });

  const jobs = await until(
    (js) => {
      const s = js.find((j) => j.id === small.id);
      return s && s.state !== JobState.QUEUED;
    },
    'the small job behind an unschedulable one to be admitted',
  );

  const blocked = jobs.find((j) => j.id === impossible.id);
  assert.equal(blocked.state, JobState.QUEUED, 'the impossible job waits rather than failing');

  const history = await getSchedulingHistory(app.db, impossible.id);
  assert.ok(history.length > 0, 'and it says why, repeatedly');
});

check('a GPU job is queued with an honest reason on a cluster with no GPU capacity', async () => {
  // This machine has two real RTX 2080 Tis, but no nvidia container runtime is
  // installed, so no GPU can reach a k3d node. The correct behaviour is to queue the
  // job and say so — not to run it on a node that cannot give it a GPU.
  const nodes = await listNodes(app.db);
  // What the cluster will grant, not what the hardware has — the whole distinction
  // this check exists to hold the platform to.
  const advertised = nodes.filter((n) => n.ready).reduce((sum, n) => sum + n.gpu_capacity, 0);

  const gpuJob = await submit(`gpu-${suffix}`, { cpu: 1, gpu: 1, steps: 5 });
  await runOnce(app.db, app.k8s, { maxLaunches: 20 });

  const job = await getJob(app.db, gpuJob.id);

  if (advertised === 0) {
    assert.equal(job.state, JobState.QUEUED, 'a GPU job must not run where no GPU exists');
    const [pass] = await getSchedulingHistory(app.db, gpuJob.id);
    assert.ok(pass, 'and the refusal must be recorded');
    console.log(`        (no GPU capacity in this cluster — job correctly queued: ${pass.decisions[0].reason})`);
  } else {
    assert.ok(
      [JobState.SCHEDULING, JobState.STARTING, JobState.RUNNING].includes(job.state),
      `GPU capacity exists (${advertised}) so the job should have been placed, but it is ${job.state}`,
    );
  }
});

// ------------------------------------------------------------------- driver

let failed = 0;
for (const { name, fn } of checks) {
  const started = Date.now();
  try {
    await fn();
    console.log(`  ok    ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
  }
}

// Leave the cluster as we found it: these jobs run for 90s and would otherwise sit
// there holding capacity for the next run.
const leftovers = await listJobs(app.db, { projectName: project, limit: 100 });
for (const job of leftovers) {
  if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.state)) {
    await app.inject({ method: 'POST', url: `/api/v1/jobs/${job.id}/cancel`, payload: {} })
      .catch(() => {});
  }
}
await runOnce(app.db, app.k8s, { maxLaunches: 20 }).catch(() => {});

// And the namespace the throwaway project was given, for the same reason the jobs above
// are cancelled: nothing else reclaims it, and one per run accumulates forever.
if (globalThis.__project) {
  await kubectl(
    'delete', 'namespace', app.k8s.namespaceFor(globalThis.__project), '--wait=false',
  ).catch(() => {});
}

console.log(`\n${checks.length - failed}/${checks.length} scheduler checks passed`);

await app.close();
process.exit(failed === 0 ? 0 : 1);
