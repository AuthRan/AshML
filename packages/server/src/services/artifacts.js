/**
 * Artifacts — checkpoints and final models produced by a run.
 *
 * Registration is two calls, deliberately. The run registers what it is about to write
 * (PENDING), uploads the bytes, then confirms. The alternative — one call after the
 * upload — loses the ability to see an upload that never finished, and there is nothing
 * to presign against.
 *
 * The bytes never pass through this process. Registration hands back a presigned PUT
 * URL and the pod writes straight to object storage; a 2 GB checkpoint proxied through a
 * Fastify handler would occupy an event loop that has a scheduler to run.
 *
 * **What makes READY mean something:** on completion, AshML asks the store whether the
 * object is actually there and how big it is. A run cannot talk its checkpoint into
 * existence. Where the store cannot be asked — no bucket configured, or a URI the run
 * brought from somewhere AshML knows nothing about — the artifact still completes, but
 * it is recorded as unverified rather than being allowed to look identical to one that
 * was checked (spec Rule 5).
 *
 * See `domain/artifact-status.js` for the lifecycle and ADR 0009 for why the run
 * reports rather than being scraped.
 */

import { withTransaction } from '../db/pool.js';
import { hasLaunched, OUTCOME_STATES } from '../domain/job-state.js';
import { ArtifactStatus, transition } from '../domain/artifact-status.js';
import * as artifactsRepo from '../repos/artifacts.js';
import * as jobsRepo from '../repos/jobs.js';
import * as experimentsRepo from '../repos/experiments.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/**
 * Registers an artifact a run is about to write.
 *
 * Always PENDING. There is no way to register something already READY, because this
 * process cannot see the bytes: READY would then mean nothing more than that a caller
 * said so, and every consumer downstream reads it as "these bytes exist".
 *
 * With no `uri`, the store allocates one and the response carries a presigned upload.
 * With a `uri`, the run has arranged its own storage and AshML records the location
 * without claiming any control over it.
 *
 * @returns {Promise<{artifact: object, upload: object|null}>}
 */
export async function registerArtifact(pool, store, jobId, {
  kind, name, uri = null, step = null, metadata = {},
}) {
  // The presign happens outside the transaction: it is a network call to another
  // service, and holding a Postgres row lock across it would let a slow bucket stall
  // the queue. Nothing is written until it has succeeded.
  const placement = await allocate(pool, store, jobId, { name, uri });

  const artifact = await withTransaction(pool, async (client) => {
    const job = await jobsRepo.getJobById(client, jobId);
    if (!job) {
      throw new NotFoundError(`job ${jobId} not found`);
    }

    if (!hasLaunched(job.state)) {
      throw new ConflictError(
        'JOB_NOT_STARTED',
        `job ${jobId} is ${job.state}; no workload has run to produce an artifact`,
      );
    }

    // Copied from the job, never accepted from the caller — same reasoning as metrics.
    const id = await artifactsRepo.insertArtifact(client, {
      jobId,
      experimentId: job.experiment?.id ?? null,
      kind,
      name,
      uri: placement.uri,
      step,
      metadata,
      status: ArtifactStatus.PENDING,
    });

    return artifactsRepo.getArtifactById(client, id);
  });

  return { artifact, upload: placement.upload };
}

/**
 * Decides where an artifact's bytes will live, and how they get there.
 *
 * The job is read once here purely to build the key from its project; the authoritative
 * check that the job exists and has launched happens inside the transaction below.
 * Doing it twice is cheap and means a presign is never issued for a job that is about to
 * be rejected.
 */
async function allocate(pool, store, jobId, { name, uri }) {
  if (uri !== null) {
    // The run brought its own location. Nothing to allocate, and nothing to presign.
    return { uri, upload: null };
  }

  if (!store.managed) {
    throw new ValidationError(
      'URI_REQUIRED',
      'no artifact store is configured, so AshML cannot allocate a location; supply `uri`',
    );
  }

  const job = await jobsRepo.getJobById(pool, jobId);
  if (!job) {
    throw new NotFoundError(`job ${jobId} not found`);
  }

  await store.ensureBucket();
  const key = store.keyFor({ project: job.project, jobId, name });
  const upload = await store.presignPut(key);

  return {
    uri: store.uriFor(key),
    upload: { method: 'PUT', url: upload.url, expires_at: upload.expires_at },
  };
}

/**
 * Confirms the bytes landed: PENDING -> READY.
 *
 * Verified against the store wherever the store owns the URI. A claimed size that does
 * not match what is actually stored is refused rather than recorded: the run believes it
 * wrote something other than what is there, and the digest it reported describes bytes
 * that may not be these ones.
 */
export async function completeArtifact(pool, store, id, { digest, sizeBytes, metadata = {} }) {
  const existing = await artifactsRepo.getArtifactById(pool, id);
  if (!existing) {
    throw new NotFoundError(`artifact ${id} not found`);
  }

  const verification = await verify(store, existing, sizeBytes);

  return settle(pool, id, ArtifactStatus.READY, {
    digest,
    // What the store reports wins over what the caller claimed. They agree or the
    // verification above has already thrown; where there was no verification, the
    // caller's number is all there is.
    sizeBytes: verification.size_bytes ?? sizeBytes,
    metadata: { ...metadata, ...verification.metadata },
  });
}

/**
 * Asks the store whether the object is there.
 *
 * Returns what to record. Throws where the store gave a definite negative answer —
 * "checked, and it is not there" — which is a refusal, not a store failure.
 */
async function verify(store, artifact, claimedSize) {
  const key = store.managed ? store.keyFromUri(artifact.uri) : null;

  if (key === null) {
    // Either no store, or a URI belonging to storage AshML does not control. Both are
    // legitimate; neither may masquerade as a checked artifact.
    return {
      size_bytes: null,
      metadata: {
        verified: false,
        verification_note: store.managed
          ? `uri is outside the configured store (${artifact.uri})`
          : 'no artifact store is configured',
      },
    };
  }

  const head = await store.head(key);
  if (head === null) {
    throw new ConflictError(
      'ARTIFACT_NOT_UPLOADED',
      `nothing is stored at ${artifact.uri}; the upload did not land, so this artifact cannot be READY`,
    );
  }

  if (claimedSize !== head.size_bytes) {
    throw new ConflictError(
      'ARTIFACT_SIZE_MISMATCH',
      `the run reported ${claimedSize} bytes but ${artifact.uri} holds ${head.size_bytes}; `
      + 'the digest reported may not describe the stored bytes',
    );
  }

  return {
    size_bytes: head.size_bytes,
    metadata: { verified: true, etag: head.etag },
  };
}

/**
 * Records that the upload was abandoned: PENDING -> FAILED.
 *
 * The row stays. A checkpoint the run intended to write and did not is a fact about
 * that run, and deleting the row would make the failure indistinguishable from never
 * having tried.
 */
export async function failArtifact(pool, id, { reason = 'upload abandoned' } = {}) {
  return settle(pool, id, ArtifactStatus.FAILED, {
    digest: '',
    sizeBytes: 0,
    metadata: { failure_reason: reason },
  });
}

async function settle(pool, id, toStatus, { digest, sizeBytes, metadata }) {
  return withTransaction(pool, async (client) => {
    const locked = await artifactsRepo.getArtifactStatusForUpdate(client, id);
    if (!locked) {
      throw new NotFoundError(`artifact ${id} not found`);
    }

    // Throws IllegalArtifactTransitionError, which carries its own 409. The row is
    // locked first, so two confirmations cannot both observe PENDING.
    transition(locked.status, toStatus);

    const current = await artifactsRepo.getArtifactById(client, id);
    await artifactsRepo.settleArtifact(client, id, toStatus, {
      digest,
      sizeBytes,
      // Merged rather than replaced: registration metadata (the framework's own
      // checkpoint fields, say) is not the confirming caller's to discard.
      metadata: { ...current.metadata, ...metadata },
    });

    return artifactsRepo.getArtifactById(client, id);
  });
}

// ---- reaping abandoned uploads ---------------------------------------------------

/**
 * How long after a job ends before its unconfirmed artifacts are given up on.
 *
 * Not a round number picked for looking sensible. It has to be **longer than
 * `ASHML_RUN_TOKEN_GRACE`**, because a successful run's final checkpoint is confirmed
 * after the pod has already exited — that grace window exists precisely so the last
 * upload can land. A reaper that swept inside it would mark the one artifact anybody
 * cares about FAILED, on the runs that worked. `startArtifactReaper` refuses to start
 * with the two set the wrong way round rather than leaving that to be discovered.
 */
export const DEFAULT_REAP_AFTER_TERMINAL_SECONDS = 900;

/** The backstop, for a job whose ending was never observed at all. */
export const DEFAULT_MAX_PENDING_SECONDS = 86_400;

/**
 * Settles artifacts that were registered and never confirmed.
 *
 * PENDING means "a run said it was about to write this". Left alone, a pod killed
 * between registering a checkpoint and confirming it leaves that sentence hanging for
 * ever, and a reader cannot tell an upload still in flight from one abandoned three
 * weeks ago. This turns the second kind into FAILED, which the lifecycle already means
 * exactly this by (`domain/artifact-status.js`).
 *
 * **It asks the store first, and records the answer, because the two cases are not the
 * same fact.** Nothing stored means the upload never landed. Bytes stored but never
 * confirmed means something was written that no record points at — which might be a
 * perfectly good checkpoint whose confirming call was lost, and might be a half-written
 * file. Both become FAILED, and the reason says which, because "your checkpoint is not
 * there" and "your checkpoint is there and AshML will not vouch for it" send a person
 * to different places.
 *
 * **Nothing is deleted.** Reaping the record is safe and reversible-by-inspection;
 * deleting bytes on a timer is neither, and the bytes it would delete are exactly the
 * ones nobody has been able to look at yet. The count is reported instead
 * (`ashml_artifacts_reaped_total{outcome="orphaned_bytes"}`), so an operator can decide.
 *
 * @returns {Promise<{reaped: number, orphanedBytes: number, missing: number, errors: number}>}
 */
export async function reapAbandonedArtifacts(pool, store, {
  afterTerminalSeconds = DEFAULT_REAP_AFTER_TERMINAL_SECONDS,
  maxPendingSeconds = DEFAULT_MAX_PENDING_SECONDS,
  limit = 50,
  logger = null,
  metrics = null,
} = {}) {
  const summary = { reaped: 0, orphanedBytes: 0, missing: 0, errors: 0 };

  // Selected in its own short transaction and released. Holding the row locks across the
  // store lookups below would mean a slow bucket blocks a confirmation that is trying to
  // arrive — and a confirmation arriving late is the outcome this whole function is
  // built to avoid destroying.
  const candidates = await withTransaction(pool, (client) =>
    artifactsRepo.lockAbandonedArtifacts(client, {
      terminalStates: OUTCOME_STATES,
      afterTerminalSeconds,
      maxPendingSeconds,
      limit,
    }));

  for (const candidate of candidates) {
    try {
      const stored = await storedBytes(store, candidate.uri);
      const reason = stored === null
        ? reasonFor(candidate, 'nothing was ever stored at its location')
        : reasonFor(candidate, `${stored.size_bytes} bytes are stored at its location, `
          + 'but no run ever confirmed them');

      // `failArtifact` re-locks and re-checks the status, so a confirmation that arrived
      // between the select above and here wins: the transition PENDING -> FAILED is
      // refused for an artifact that is already READY, and this is counted as an error
      // rather than being allowed to overwrite it.
      await failArtifact(pool, candidate.id, { reason });

      summary.reaped += 1;
      if (stored === null) summary.missing += 1;
      else summary.orphanedBytes += 1;
      metrics?.artifactsReaped?.inc({ outcome: stored === null ? 'missing' : 'orphaned_bytes' });

      logger?.info(
        { artifact_id: candidate.id, job_id: candidate.job_id, orphaned: stored !== null },
        'reaped an artifact that was never confirmed',
      );
    } catch (err) {
      summary.errors += 1;
      logger?.warn({ err, artifact_id: candidate.id }, 'could not reap an artifact');
    }
  }

  return summary;
}

/**
 * Why this artifact was given up on, in a sentence that names the rule that fired.
 *
 * The rule is worked out from the job's *state*, not from whether there is a job row.
 * An earlier version asked only the second question and produced "job … ended RUNNING"
 * for every artifact caught by the backstop — a reason that contradicts itself, on
 * precisely the case where the reader most needs to be told the job never finished.
 */
function reasonFor(candidate, detail) {
  const ended = candidate.job_state !== null && OUTCOME_STATES.includes(candidate.job_state);
  const because = ended
    ? `job ${candidate.job_id} ended ${candidate.job_state}`
    : 'it stayed PENDING past the maximum with its job still unfinished';
  return `upload abandoned: ${because} and this artifact was never confirmed; ${detail}`;
}

/** What the store holds at a URI, or null. A store that cannot be asked answers null. */
async function storedBytes(store, uri) {
  const key = store.managed ? store.keyFromUri(uri) : null;
  if (key === null) return null;
  return store.head(key);
}

/**
 * Runs the reaper on a timer.
 *
 * Slow, because it is looking for something that takes minutes to become true and would
 * otherwise stay untrue for ever. One pass an hour would also work; the default is five
 * minutes so that a killed pod's record settles inside the time somebody is still
 * looking at it.
 */
export function startArtifactReaper(pool, store, {
  intervalMs = 300_000,
  afterTerminalSeconds = DEFAULT_REAP_AFTER_TERMINAL_SECONDS,
  runTokenGraceSeconds = 300,
  maxPendingSeconds = DEFAULT_MAX_PENDING_SECONDS,
  logger = null,
  metrics = null,
} = {}) {
  if (afterTerminalSeconds <= runTokenGraceSeconds) {
    throw new Error(
      `ASHML_ARTIFACT_REAP_AFTER=${afterTerminalSeconds}s is not longer than `
      + `ASHML_RUN_TOKEN_GRACE=${runTokenGraceSeconds}s. A finished run confirms its last `
      + 'checkpoint inside that grace window, so a reaper that sweeps first would mark '
      + 'successful runs\' final models FAILED.',
    );
  }

  let stopped = false;
  let timer = null;
  let settled = Promise.resolve();

  async function tick() {
    if (stopped) return;
    try {
      const summary = await reapAbandonedArtifacts(pool, store, {
        afterTerminalSeconds, maxPendingSeconds, logger, metrics,
      });
      if (summary.reaped > 0 || summary.errors > 0) {
        logger?.info(summary, 'artifact reaper pass');
      }
    } catch (err) {
      // As with the executor: reaching here means the database is unreachable, not that
      // one artifact was awkward. Keep looping rather than needing an operator to notice.
      logger?.error({ err }, 'artifact reaper pass failed');
    }
    if (!stopped) {
      timer = setTimeout(() => { settled = tick(); }, intervalMs);
      timer.unref?.();
    }
  }

  settled = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await settled.catch(() => {});
    },
  };
}

/**
 * A time-limited URL to read an artifact's bytes.
 *
 * Only for READY artifacts. Handing out a link to a PENDING or FAILED one would produce
 * a 404 from the bucket at best, and at worst a partial checkpoint that loads.
 */
export async function presignDownload(pool, store, id) {
  const artifact = await getArtifact(pool, id);

  if (artifact.status !== ArtifactStatus.READY) {
    throw new ConflictError(
      'ARTIFACT_NOT_READY',
      `artifact ${id} is ${artifact.status}; its bytes are not confirmed to exist`,
    );
  }

  const key = store.managed ? store.keyFromUri(artifact.uri) : null;
  if (key === null) {
    throw new ValidationError(
      'ARTIFACT_NOT_IN_STORE',
      `${artifact.uri} is not in AshML's artifact store, so it cannot be signed for; `
      + 'fetch it from wherever the run put it',
    );
  }

  const { url, expires_at } = await store.presignGet(key);
  return { artifact_id: id, uri: artifact.uri, url, expires_at };
}

export async function getArtifact(pool, id) {
  const artifact = await artifactsRepo.getArtifactById(pool, id);
  if (!artifact) {
    throw new NotFoundError(`artifact ${id} not found`);
  }
  return artifact;
}

export async function listJobArtifacts(pool, jobId, filters = {}) {
  const job = await jobsRepo.getJobById(pool, jobId);
  if (!job) {
    throw new NotFoundError(`job ${jobId} not found`);
  }
  return artifactsRepo.listArtifactsForJob(pool, jobId, filters);
}

export async function listExperimentArtifacts(pool, experimentId, filters = {}) {
  const experiment = await experimentsRepo.getExperimentById(pool, experimentId);
  if (!experiment) {
    throw new NotFoundError(`experiment ${experimentId} not found`);
  }
  return artifactsRepo.listArtifactsForExperiment(pool, experimentId, filters);
}
