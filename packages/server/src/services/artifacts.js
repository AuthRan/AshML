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
import { hasLaunched } from '../domain/job-state.js';
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
