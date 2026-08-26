/**
 * Reaping artifacts that were registered and never confirmed.
 *
 * PENDING means "a run said it was about to write this". A pod killed between
 * registering a checkpoint and confirming it leaves that sentence hanging for ever, and
 * nothing else in the system will ever come along to finish it.
 *
 * The test that matters most here is the one that asserts nothing happens. A successful
 * run confirms its *final* checkpoint after the pod has already exited — that is what
 * `ASHML_RUN_TOKEN_GRACE` exists for — so a reaper that swept too eagerly would mark the
 * one artifact anybody cares about FAILED, on the runs that worked. Everything else in
 * this file is arithmetic; that one is the reason the arithmetic has to be right.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { createNoneStore } from '../storage/none.js';
import { Phase } from '../k8s/backend.js';
import { JobState } from '../domain/job-state.js';
import { ArtifactStatus } from '../domain/artifact-status.js';
import { runOnce } from './executor.js';
import { discoverCluster } from './nodes.js';
import { getJob } from './jobs.js';
import {
  reapAbandonedArtifacts, startArtifactReaper, completeArtifact, getArtifact,
} from './artifacts.js';
import {
  connectOrNull, wipeAll, uniqueName, SKIP_MESSAGE, authenticateAs, asRun,
} from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => { await pool?.end(); });

describe('artifact reaper (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let backend;
  let project;

  /**
   * A store that says a URI holds bytes.
   *
   * The `none` store used elsewhere in this file cannot be asked, which is the "the
   * upload never landed" case. This is the other one — something *is* stored that no
   * record vouches for — and it is a different fact about the run.
   */
  function storeHolding(sizeBytes, { onHead = null } = {}) {
    return {
      name: 'fake',
      managed: true,
      keyFromUri: (uri) => uri.replace(/^s3:\/\/[^/]+\//, ''),
      head: async (key) => {
        if (onHead) await onHead(key);
        return { size_bytes: sizeBytes, etag: 'deadbeef' };
      },
      close: async () => {},
    };
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
    await wipeAll(pool);
    backend._reset();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: uniqueName('proj'), description: 'reaper test' },
    });
    assert.equal(res.statusCode, 201);
    project = res.json();
  });

  /** A job in RUNNING, with a PENDING artifact registered against it. */
  async function runningJobWithPendingArtifact() {
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: project.name,
        name: uniqueName('job'),
        spec: { image: 'busybox:1.36' },
        resources: { cpu: 1 },
      },
    });
    assert.equal(submitted.statusCode, 201, submitted.payload);
    const job = submitted.json();

    await runOnce(pool, backend);
    const launched = await getJob(pool, job.id);
    backend._setPhase(launched.namespace, launched.k8s_job_name, Phase.RUNNING);
    await runOnce(pool, backend);

    const registered = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/artifacts`,
      headers: await asRun(pool, job.id),
      // A URI the run brought itself, so the `none` store has something to record.
      payload: { kind: 'checkpoint', name: 'ckpt.pt', uri: 's3://elsewhere/ckpt.pt' },
    });
    assert.equal(registered.statusCode, 201, registered.payload);

    return { job, artifact: registered.json().artifact };
  }

  /** Puts a job into a terminal state that ended `secondsAgo`. */
  async function endJob(jobId, state, secondsAgo) {
    await pool.query(
      `UPDATE training_jobs
       SET state = $2, finished_at = now() - ($3 * INTERVAL '1 second'),
           updated_at = now() - ($3 * INTERVAL '1 second')
       WHERE id = $1`,
      [jobId, state, secondsAgo],
    );
  }

  const WINDOW = { afterTerminalSeconds: 900, maxPendingSeconds: 86_400 };

  describe('what it settles', () => {
    test('an artifact whose job ended long ago, with nothing stored', async () => {
      const { job, artifact } = await runningJobWithPendingArtifact();
      await endJob(job.id, JobState.FAILED, 3600);

      const summary = await reapAbandonedArtifacts(pool, createNoneStore(), WINDOW);
      assert.deepEqual(summary, { reaped: 1, orphanedBytes: 0, missing: 1, errors: 0 });

      const settled = await getArtifact(pool, artifact.id);
      assert.equal(settled.status, ArtifactStatus.FAILED);
      // The reason names the rule that fired, so the record answers "why is this FAILED"
      // without anybody having to reconstruct the window arithmetic.
      assert.match(settled.metadata.failure_reason, /ended FAILED/);
      assert.match(settled.metadata.failure_reason, /nothing was ever stored/);
    });

    test('an artifact whose bytes are there but were never confirmed', async () => {
      const { job, artifact } = await runningJobWithPendingArtifact();
      await endJob(job.id, JobState.SUCCEEDED, 3600);

      const summary = await reapAbandonedArtifacts(pool, storeHolding(4096), WINDOW);
      assert.deepEqual(summary, { reaped: 1, orphanedBytes: 1, missing: 0, errors: 0 });

      const settled = await getArtifact(pool, artifact.id);
      assert.equal(settled.status, ArtifactStatus.FAILED);
      // A different sentence, because it sends a person somewhere different: there is a
      // file, and AshML will not vouch for it.
      assert.match(settled.metadata.failure_reason, /4096 bytes are stored/);
      assert.match(settled.metadata.failure_reason, /no run ever confirmed them/);
    });

    test('the backstop catches a job whose ending was never observed', async () => {
      // Still RUNNING as far as the platform knows, and will be for ever — nothing else
      // will come along to settle this.
      const { artifact } = await runningJobWithPendingArtifact();
      await pool.query(
        "UPDATE artifacts SET created_at = now() - INTERVAL '2 days' WHERE id = $1",
        [artifact.id],
      );

      const summary = await reapAbandonedArtifacts(pool, createNoneStore(), WINDOW);
      assert.equal(summary.reaped, 1);
      const settled = await getArtifact(pool, artifact.id);
      assert.match(settled.metadata.failure_reason, /stayed PENDING past the maximum/);
      // Not "job … ended RUNNING", which is what the first version of this said. A
      // reason that contradicts itself is worse than no reason on the one case where the
      // reader most needs to be told the job never finished.
      assert.doesNotMatch(settled.metadata.failure_reason, /ended RUNNING/);
    });
  });

  describe('what it leaves alone', () => {
    test('a job that ended a moment ago — the run-token grace window', async () => {
      // The case this whole design is arranged around. A successful run's final
      // checkpoint is confirmed *after* the pod exits; reaping inside that window would
      // mark the final model of every run that worked FAILED.
      const { job, artifact } = await runningJobWithPendingArtifact();
      await endJob(job.id, JobState.SUCCEEDED, 60);

      const summary = await reapAbandonedArtifacts(pool, createNoneStore(), WINDOW);
      assert.equal(summary.reaped, 0);
      assert.equal((await getArtifact(pool, artifact.id)).status, ArtifactStatus.PENDING);
    });

    test('a job that is still running', async () => {
      const { artifact } = await runningJobWithPendingArtifact();
      const summary = await reapAbandonedArtifacts(pool, createNoneStore(), WINDOW);
      assert.equal(summary.reaped, 0);
      assert.equal((await getArtifact(pool, artifact.id)).status, ArtifactStatus.PENDING);
    });

    test('an artifact that was confirmed', async () => {
      const { job, artifact } = await runningJobWithPendingArtifact();
      await completeArtifact(pool, createNoneStore(), artifact.id, {
        digest: 'sha256:abc', sizeBytes: 10,
      });
      await endJob(job.id, JobState.SUCCEEDED, 3600);

      const summary = await reapAbandonedArtifacts(pool, createNoneStore(), WINDOW);
      assert.equal(summary.reaped, 0);
      assert.equal((await getArtifact(pool, artifact.id)).status, ArtifactStatus.READY);
    });
  });

  describe('the race it has to lose', () => {
    test('a confirmation arriving mid-pass wins, and the artifact stays READY', async () => {
      // Not hypothetical, and not something a sleep could test reliably. The reaper asks
      // the store about the bytes between selecting the candidate and settling it, so a
      // store whose `head` confirms the artifact reproduces the window exactly — which is
      // the same window a real confirmation lands in.
      const { job, artifact } = await runningJobWithPendingArtifact();
      await endJob(job.id, JobState.SUCCEEDED, 3600);

      const racing = storeHolding(4096, {
        onHead: async () => {
          await completeArtifact(pool, createNoneStore(), artifact.id, {
            digest: 'sha256:abc', sizeBytes: 4096,
          });
        },
      });

      const summary = await reapAbandonedArtifacts(pool, racing, WINDOW);
      assert.equal(summary.reaped, 0, 'the reap must fail rather than overwrite');
      assert.equal(summary.errors, 1);

      const settled = await getArtifact(pool, artifact.id);
      assert.equal(settled.status, ArtifactStatus.READY, 'the confirmation is the truth');
    });
  });

  describe('the window it refuses to start with', () => {
    test('a reap window inside the run-token grace is a startup failure', async () => {
      // The two settings look unrelated and are not, so the check is at startup with the
      // arithmetic in the message rather than left to be discovered days later by a
      // successful run whose model says FAILED.
      assert.throws(
        () => startArtifactReaper(pool, createNoneStore(), {
          afterTerminalSeconds: 120,
          runTokenGraceSeconds: 300,
        }),
        /ASHML_RUN_TOKEN_GRACE/,
      );
    });

    test('a window outside it starts, and stops cleanly', async () => {
      const reaper = startArtifactReaper(pool, createNoneStore(), {
        afterTerminalSeconds: 900,
        runTokenGraceSeconds: 300,
        intervalMs: 60_000,
      });
      await reaper.stop();
    });
  });
});
