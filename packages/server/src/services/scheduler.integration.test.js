/**
 * Integration tests for the scheduler against a real PostgreSQL.
 *
 * These cover the Phase 3 exit criteria: more jobs than the cluster can hold are
 * admitted only as capacity allows, the rest wait in the queue, and every job can say
 * exactly why it is where it is.
 *
 * The cluster is the `sim` backend so node capacity can be stated precisely — the
 * scheduler's arithmetic is what is under test, not Kubernetes'. The real cluster path
 * is covered by `make e2e`.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { Phase } from '../k8s/backend.js';
import { JobState } from '../domain/job-state.js';
import { runOnce } from './executor.js';
import { scheduleJob, getSchedulingHistory, Placement } from './scheduler.js';
import { discoverCluster, listNodes } from './nodes.js';
import { getJob, claimNextJob } from './jobs.js';
import { connectOrNull, wipeAll, uniqueName, SKIP_MESSAGE, authenticateAs } from '../test-support/db.js';

const pool = await connectOrNull();
const GIB = 1024 ** 3;

after(async () => {
  await pool?.end();
});

describe('scheduler (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let backend;
  let project;

  /** A fake cluster with exactly one 2-GPU node — the shape of the real dev host. */
  function twoGpuCluster() {
    return createSimBackend({
      namespace: 'ashml-test',
      autoAdvance: false,
      nodes: [{
        name: 'gpu-node-0',
        ready: true,
        cpu_cores: 8,
        memory_bytes: 32 * GIB,
        gpu_capacity: 2,
        labels: {},
      }],
    });
  }

  before(async () => {
    const config = loadConfig({
      ASHML_GPU_PROVIDER: 'sim',
      ASHML_SIM_GPUS: '2',
      ASHML_K8S_BACKEND: 'sim',
      ASHML_VERSION: '0.0.0-test',
    });
    backend = twoGpuCluster();
    app = await buildApp(config, { logger: false, pool, k8s: backend });
    await app.ready();
    await authenticateAs(app, pool);
  });

  after(async () => {
    await app?.close();
    await backend?.close();
  });

  beforeEach(async () => {
    await wipeAll(pool);
    await pool.query('TRUNCATE compute_nodes CASCADE');
    backend._reset();
    await discoverCluster(pool, backend, app.gpuProvider);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('proj'), description: 'scheduler test' },
    });
    assert.equal(res.statusCode, 201);
    project = res.json();
  });

  async function submit(overrides = {}) {
    const { resources, ...rest } = overrides;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: project.name,
        name: uniqueName('job'),
        spec: { image: 'busybox:1.36' },
        resources: { cpu: 1, ...resources },
        ...rest,
      },
    });
    assert.equal(res.statusCode, 201, res.payload);
    return res.json();
  }

  async function setQuota(quota) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.name}/quota`,
      payload: quota,
    });
    return res;
  }

  describe('discovery', () => {
    test('registers the cluster\'s nodes and attaches their GPUs', async () => {
      const nodes = await listNodes(pool);

      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].name, 'gpu-node-0');
      assert.equal(nodes[0].cpu_cores, 8);
      assert.equal(nodes[0].gpus.length, 2);
      // The sim GPU provider must not be able to pass its devices off as real.
      assert.ok(nodes[0].gpus.every((g) => g.simulated === true));
    });

    test('a node that disappears is marked not ready, not deleted', async () => {
      // Deleting it would break every scheduling decision that referred to it.
      const empty = createSimBackend({ namespace: 'ashml-test', nodes: [] });
      await discoverCluster(pool, empty, app.gpuProvider);

      const nodes = await listNodes(pool);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].ready, false);
    });

    test('re-running discovery does not duplicate nodes or devices', async () => {
      await discoverCluster(pool, backend, app.gpuProvider);
      await discoverCluster(pool, backend, app.gpuProvider);

      const nodes = await listNodes(pool);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].gpus.length, 2);
    });
  });

  describe('placement', () => {
    test('a job that fits is bound to the node and can then launch', async () => {
      const submitted = await submit({ resources: { cpu: 1, gpu: 1 } });
      await claimNextJob(pool);

      const result = await scheduleJob(pool, submitted.id);
      assert.equal(result.placement, Placement.BOUND);
      assert.equal(result.node.name, 'gpu-node-0');

      const job = await getJob(pool, submitted.id);
      assert.equal(job.placement.node_name, 'gpu-node-0');
      assert.match(job.placement.reason, /1 of 2 free GPU\(s\), leaving 1/);
    });

    test('two 1-GPU jobs run at once on a 2-GPU node; the third waits', async () => {
      // The Phase 3 exit criterion, at the smallest scale that demonstrates it.
      for (let i = 0; i < 3; i += 1) await submit({ resources: { cpu: 1, gpu: 1 } });

      await runOnce(pool, backend);

      const running = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs?project=${project.name}&state=STARTING`,
      });
      const queued = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs?project=${project.name}&state=QUEUED`,
      });

      assert.equal(running.json().jobs.length, 2, 'exactly the node\'s GPU count runs');
      assert.equal(queued.json().jobs.length, 1, 'the surplus waits rather than failing');
    });

    test('a queued job runs as soon as a running one finishes', async () => {
      for (let i = 0; i < 3; i += 1) await submit({ resources: { cpu: 1, gpu: 1 } });
      await runOnce(pool, backend);

      const started = (await app.inject({
        method: 'GET', url: `/api/v1/jobs?project=${project.name}&state=STARTING`,
      })).json().jobs;
      assert.equal(started.length, 2);

      // Finish one, freeing a GPU. The namespace comes from the backend rather than from
      // the listing: a job's namespace is internal, so the API response does not carry it.
      backend._setPhase(
        backend.namespaceFor(project), started[0].k8s_job_name, Phase.SUCCEEDED,
      );
      await runOnce(pool, backend);

      const queued = (await app.inject({
        method: 'GET', url: `/api/v1/jobs?project=${project.name}&state=QUEUED`,
      })).json().jobs;
      assert.equal(queued.length, 0, 'the waiting job must be admitted once a GPU frees');
    });

    test('a job asking for more GPUs than the node has is queued, not failed', async () => {
      // The cluster could grow. Failing it now would throw away work that would
      // succeed on a bigger node, and a user cannot tell a permanent refusal from a
      // temporary one after the fact.
      const submitted = await submit({ resources: { cpu: 1, gpu: 4 } });
      await runOnce(pool, backend);

      const job = await getJob(pool, submitted.id);
      assert.equal(job.state, JobState.QUEUED);
      assert.equal(job.placement.node_id, null);
    });

    test('a requeued job does not keep holding the node it was refused from', async () => {
      const big = await submit({ resources: { cpu: 1, gpu: 4 } });
      await runOnce(pool, backend);
      assert.equal((await getJob(pool, big.id)).state, JobState.QUEUED);

      // If the refused job still held capacity, this one could not be placed.
      const small = await submit({ resources: { cpu: 1, gpu: 2 } });
      await runOnce(pool, backend);

      assert.equal((await getJob(pool, small.id)).state, JobState.STARTING);
    });

    test('CPU capacity limits admission just as GPU capacity does', async () => {
      // The node has 8 cores.
      for (let i = 0; i < 3; i += 1) await submit({ resources: { cpu: 3 } });
      await runOnce(pool, backend);

      const starting = (await app.inject({
        method: 'GET', url: `/api/v1/jobs?project=${project.name}&state=STARTING`,
      })).json().jobs;
      assert.equal(starting.length, 2, '3 + 3 fits in 8 cores; 9 does not');
    });

    test('a job needing a bigger GPU than exists waits, and says which size it needed', async () => {
      const submitted = await submit({
        resources: { cpu: 1, gpu: 1, gpu_memory_min_bytes: 80 * GIB },
      });
      await runOnce(pool, backend);

      assert.equal((await getJob(pool, submitted.id)).state, JobState.QUEUED);

      const [pass] = await getSchedulingHistory(pool, submitted.id);
      assert.match(pass.decisions[0].reason, /GPU\(s\) of at least 80\.0 GiB/);
    });
  });

  describe('quotas', () => {
    test('a job beyond the project GPU quota is queued with the quota as the reason', async () => {
      const patched = await setQuota({ gpu: 1 });
      assert.equal(patched.statusCode, 200, patched.payload);

      await submit({ resources: { cpu: 1, gpu: 1 } });
      const second = await submit({ resources: { cpu: 1, gpu: 1 } });
      await runOnce(pool, backend);

      const job = await getJob(pool, second.id);
      assert.equal(job.state, JobState.QUEUED);

      const [pass] = await getSchedulingHistory(pool, second.id);
      assert.equal(pass.decisions[0].outcome, 'QUOTA_EXCEEDED');
      assert.match(pass.decisions[0].reason, /1 of 1 GPU\(s\) in use/);
    });

    test('quota is checked before placement, so an empty cluster still reports the quota', async () => {
      // Otherwise a project over quota is told "no capacity", sending the user to
      // investigate a cluster that is in fact idle.
      await setQuota({ jobs: 0, gpu: 0, cpu: 1 });
      const submitted = await submit({ resources: { cpu: 4 } });
      await runOnce(pool, backend);

      const [pass] = await getSchedulingHistory(pool, submitted.id);
      assert.equal(pass.decisions[0].outcome, 'QUOTA_EXCEEDED');
      assert.equal(pass.decisions[0].node_name, null);
    });

    test('a job is not charged twice for its own request', async () => {
      // The job is already SCHEDULING when the quota is evaluated, so it is counted in
      // the project's usage. Failing to exclude it would refuse every first job whose
      // request equals the whole quota.
      await setQuota({ gpu: 1 });
      const submitted = await submit({ resources: { cpu: 1, gpu: 1 } });
      await runOnce(pool, backend);

      assert.equal((await getJob(pool, submitted.id)).state, JobState.STARTING);
    });
  });

  describe('the audit trail', () => {
    test('a placement records the node chosen and every node rejected', async () => {
      const submitted = await submit({ resources: { cpu: 1, gpu: 1 } });
      await runOnce(pool, backend);

      const [pass] = await getSchedulingHistory(pool, submitted.id);
      assert.equal(pass.decisions.length, 1, 'one node in this cluster, one decision');
      assert.equal(pass.decisions[0].outcome, 'SELECTED');
      assert.equal(pass.decisions[0].node_name, 'gpu-node-0');
    });

    test('a repeated identical refusal is counted, not written again', async () => {
      // The executor re-evaluates every queued job on every pass. Writing the same rows
      // each time would produce tens of thousands of identical rows a day for one stuck
      // job, and an audit trail nobody can read is not an audit trail.
      const submitted = await submit({ resources: { cpu: 1, gpu: 4 } });
      await runOnce(pool, backend);
      await runOnce(pool, backend);
      await runOnce(pool, backend);

      const passes = await getSchedulingHistory(pool, submitted.id);
      assert.equal(passes.length, 1, 'three identical refusals are one pass');
      assert.equal(passes[0].repeat_count, 3, 'but the count records that it happened three times');
      assert.ok(passes[0].last_seen_at >= passes[0].at);
    });

    test('a changed verdict starts a new pass rather than being folded away', async () => {
      // Folding must apply only to *identical* verdicts. One job, refused and then
      // admitted, has to leave both facts on the record.
      const first = await submit({ resources: { cpu: 1, gpu: 2 } });
      await runOnce(pool, backend);
      assert.equal((await getJob(pool, first.id)).state, JobState.STARTING);

      // No GPUs left, so this one is refused.
      const second = await submit({ resources: { cpu: 1, gpu: 2 } });
      await runOnce(pool, backend);
      assert.equal((await getJob(pool, second.id)).state, JobState.QUEUED);

      // Free the GPUs; the same job now gets a different verdict.
      const firstJob = await getJob(pool, first.id);
      backend._setPhase(firstJob.namespace, firstJob.k8s_job_name, Phase.SUCCEEDED);
      await runOnce(pool, backend);
      assert.equal((await getJob(pool, second.id)).state, JobState.STARTING);

      const passes = await getSchedulingHistory(pool, second.id);
      assert.equal(passes.length, 2, 'the refusal and the admission are separate passes');
      assert.notEqual(passes[0].pass_id, passes[1].pass_id);

      // Newest first: admitted now, refused before.
      assert.equal(passes[0].decisions[0].outcome, 'SELECTED');
      assert.equal(passes[1].decisions[0].outcome, 'REJECTED');
    });

    test('a decision keeps the numbers it was made from', async () => {
      const submitted = await submit({ resources: { cpu: 2, gpu: 1 } });
      await runOnce(pool, backend);

      const [pass] = await getSchedulingHistory(pool, submitted.id);
      const details = pass.decisions[0].details;

      assert.equal(details.requested.cpu, 2);
      assert.equal(details.requested.gpu, 1);
      assert.equal(details.free.gpu, 2, 'what was free at the time, not what is free now');
    });

    test('the scheduling endpoint explains a queued job over HTTP', async () => {
      const submitted = await submit({ resources: { cpu: 1, gpu: 4 } });
      await runOnce(pool, backend);

      const res = await app.inject({
        method: 'GET', url: `/api/v1/jobs/${submitted.id}/scheduling`,
      });
      assert.equal(res.statusCode, 200);

      const body = res.json();
      assert.equal(body.state, JobState.QUEUED);
      assert.equal(body.placement.node_id, null);
      assert.ok(body.passes.length >= 1);
      assert.match(body.passes[0].decisions[0].reason, /GPU\(s\) free; 4 requested/);
    });
  });

  /**
   * Two control-plane replicas scheduling at the same time.
   *
   * The row lock on the job being scheduled is not what makes this safe, so these do not
   * test it. Each pass locks a *different* job row and is entirely correct about the row
   * it holds; what they share is the unlocked aggregate underneath — `clusterView` sums
   * `training_jobs` to work out what is already committed — and under READ COMMITTED
   * neither pass can see the other's uncommitted binding. See `db/locks.js`.
   */
  describe('concurrent schedulers', () => {
    const LOCK_CLASSID = 0x4153;
    const LOCK_OBJID = 1;

    /** Is some backend waiting on the scheduling advisory lock right now? */
    async function waiterCount() {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND NOT granted`,
        [LOCK_CLASSID, LOCK_OBJID],
      );
      return rows[0].n;
    }

    test('a scheduling pass waits for the advisory lock rather than reading past it', async () => {
      const submitted = await submit({ resources: { cpu: 1, gpu: 1 } });
      await claimNextJob(pool);

      // Stand in for the other replica: hold the lock, and nothing else.
      const holder = await pool.connect();
      let pass;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_CLASSID, LOCK_OBJID]);

        pass = scheduleJob(pool, submitted.id);

        // Poll rather than sleep: the assertion is "it is blocked on this lock", and
        // pg_locks is the only thing that answers that without guessing at a duration.
        let waiting = 0;
        for (let i = 0; i < 100 && waiting === 0; i += 1) {
          waiting = await waiterCount();
          if (waiting === 0) await new Promise((r) => { setTimeout(r, 20); });
        }
        assert.equal(waiting, 1, 'the pass should be blocked on the scheduling lock');

        // And blocked means blocked: it has not quietly decided anything meanwhile.
        const stillQueued = await getJob(pool, submitted.id);
        assert.equal(stillQueued.placement?.node_id ?? null, null);

        await holder.query('COMMIT');
      } finally {
        holder.release();
      }

      // Released, so it proceeds — the lock delays a pass, it does not lose one.
      const result = await pass;
      assert.equal(result.placement, Placement.BOUND);
    });

    test('two passes cannot both bind the same free GPUs', async () => {
      // The node has 2 GPUs. Each job wants both, so exactly one can ever be right.
      const first = await submit({ resources: { cpu: 1, gpu: 2 } });
      const second = await submit({ resources: { cpu: 1, gpu: 2 } });

      // Both must be SCHEDULING before either pass runs, so that the passes overlap
      // rather than queueing behind the claim.
      await claimNextJob(pool);
      await claimNextJob(pool);

      const [a, b] = await Promise.all([
        scheduleJob(pool, first.id),
        scheduleJob(pool, second.id),
      ]);

      const bound = [a, b].filter((r) => r.placement === Placement.BOUND);
      const requeued = [a, b].filter((r) => r.placement === Placement.REQUEUED);
      assert.equal(bound.length, 1, 'exactly one job may hold the node\'s 2 GPUs');
      assert.equal(requeued.length, 1);
      assert.match(requeued[0].reason, /GPU/);

      // The invariant the race would have broken, asserted against the ledger itself
      // rather than against the two return values.
      const [node] = await listNodes(pool);
      const committed = await pool.query(
        `SELECT COALESCE(SUM(gpu_request), 0)::int AS gpu
         FROM training_jobs
         WHERE scheduled_node_id = $1
           AND state = ANY($2::text[])`,
        [node.id, [JobState.SCHEDULING, JobState.STARTING, JobState.RUNNING]],
      );
      assert.ok(
        committed.rows[0].gpu <= 2,
        `node over-committed: ${committed.rows[0].gpu} GPUs promised of 2`,
      );
    });
  });
});
