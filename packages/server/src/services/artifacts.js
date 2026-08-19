/**
 * Artifacts — checkpoints and final models produced by a run.
 *
 * Registration is two calls, deliberately. The run registers what it is about to write
 * (PENDING), uploads the bytes itself, then confirms with the digest and size it
 * computed while writing. The alternative — one call after the upload — loses the
 * ability to see an upload that never finished, and takes the digest on trust from a
 * process that has already moved on.
 *
 * See `domain/artifact-status.js` for why the row is written before the bytes, and
 * ADR 0009 for why the run reports rather than being scraped.
 */

import { withTransaction } from '../db/pool.js';
import { hasLaunched } from '../domain/job-state.js';
import { ArtifactStatus, transition } from '../domain/artifact-status.js';
import * as artifactsRepo from '../repos/artifacts.js';
import * as jobsRepo from '../repos/jobs.js';
import * as experimentsRepo from '../repos/experiments.js';
import { ConflictError, NotFoundError } from './errors.js';

/**
 * Registers an artifact a run is about to write.
 *
 * Always PENDING. There is no way to register something already READY, because this
 * process cannot see the bytes: "READY" would then mean nothing more than that a caller
 * said so, and every consumer downstream reads it as "these bytes exist".
 */
export async function registerArtifact(pool, jobId, { kind, name, uri, step = null, metadata = {} }) {
  return withTransaction(pool, async (client) => {
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
    const experimentId = job.experiment?.id ?? null;

    const id = await artifactsRepo.insertArtifact(client, {
      jobId,
      experimentId,
      kind,
      name,
      uri,
      step,
      metadata,
      status: ArtifactStatus.PENDING,
    });

    return artifactsRepo.getArtifactById(client, id);
  });
}

/**
 * Confirms the bytes landed: PENDING -> READY.
 *
 * The row is locked before the transition is evaluated, so two confirmations of the
 * same artifact cannot both observe PENDING and both write a digest.
 */
export async function completeArtifact(pool, id, { digest, sizeBytes, metadata = null }) {
  return settle(pool, id, ArtifactStatus.READY, { digest, sizeBytes, metadata });
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

    // Throws IllegalArtifactTransitionError, which carries its own 409.
    transition(locked.status, toStatus);

    await artifactsRepo.settleArtifact(client, id, toStatus, {
      digest,
      sizeBytes,
      // Merged rather than replaced: registration metadata (the framework's own
      // checkpoint fields, say) is not the confirming caller's to discard.
      metadata: metadata === null ? null : { ...(await currentMetadata(client, id)), ...metadata },
    });

    return artifactsRepo.getArtifactById(client, id);
  });
}

async function currentMetadata(client, id) {
  const artifact = await artifactsRepo.getArtifactById(client, id);
  return artifact?.metadata ?? {};
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
