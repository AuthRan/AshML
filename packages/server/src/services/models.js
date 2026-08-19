/**
 * Model registry service.
 *
 * Two rules are enforced here and nowhere else, because both need a transaction:
 *
 * 1. **A version may only be registered from a READY artifact.** This is the payoff of
 *    the artifact lifecycle. A registry entry that points at bytes nobody confirmed is
 *    the failure the whole `PENDING -> READY` dance exists to prevent — it just moves
 *    the moment of discovery from "the upload failed" to "production cannot load the
 *    model".
 *
 * 2. **At most one version of a model is in PRODUCTION.** Promoting displaces the
 *    incumbent inside the same transaction, so there is never an instant when two
 *    versions both claim to be what the model means, and never one when none does.
 */

import { withTransaction } from '../db/pool.js';
import {
  ModelStatus, INITIAL_STATUS, DISPLACED_TO, isExclusive, transition,
} from '../domain/model-status.js';
import { ArtifactStatus } from '../domain/artifact-status.js';
import * as modelsRepo from '../repos/models.js';
import * as artifactsRepo from '../repos/artifacts.js';
import * as projectsRepo from '../repos/projects.js';
import * as metricsRepo from '../repos/metrics.js';
import { ConflictError, NotFoundError, ValidationError, UNIQUE_VIOLATION } from './errors.js';

async function requireProject(client, projectName) {
  const project = await projectsRepo.getProjectByName(client, projectName);
  if (!project) {
    throw new NotFoundError(`project "${projectName}" not found`);
  }
  return project;
}

async function requireModel(client, projectName, name) {
  const model = await modelsRepo.getModelByName(client, projectName, name);
  if (!model) {
    // Tell the two typos apart; the same 404 for both is miserable to debug.
    await requireProject(client, projectName);
    throw new NotFoundError(`model "${name}" not found in project "${projectName}"`);
  }
  return model;
}

export async function createModel(pool, { projectName, name }) {
  try {
    return await withTransaction(pool, async (client) => {
      const project = await requireProject(client, projectName);
      const id = await modelsRepo.insertModel(client, { projectId: project.id, name });
      return modelsRepo.getModelById(client, id);
    });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ConflictError(
        'MODEL_EXISTS',
        `model "${name}" already exists in project "${projectName}"`,
      );
    }
    throw err;
  }
}

export async function getModel(pool, projectName, name) {
  return withTransaction(pool, (client) => requireModel(client, projectName, name));
}

export async function listModels(pool, projectName) {
  return withTransaction(pool, async (client) => {
    await requireProject(client, projectName);
    return modelsRepo.listModels(client, projectName);
  });
}

/**
 * Registers a new version of a model from an artifact.
 *
 * The version number is allocated under a lock on the model row, so two concurrent
 * registrations cannot both compute the same next number.
 *
 * `metrics` default to the source job's own reported numbers — the last value of each
 * metric it logged. That is not an invention: it is what the run said about itself, and
 * copying it here is what lets someone compare two versions without going back to the
 * jobs. Passing `metrics` explicitly overrides them.
 */
export async function registerVersion(pool, { projectName, modelName, artifactId, description = '', metrics = null }) {
  return withTransaction(pool, async (client) => {
    const model = await requireModel(client, projectName, modelName);

    const artifact = await artifactsRepo.getArtifactById(client, artifactId);
    if (!artifact) {
      throw new NotFoundError(`artifact ${artifactId} not found`);
    }

    // Rule 1. 409 rather than 400: the request is well-formed, and it will succeed once
    // the artifact's upload is confirmed.
    if (artifact.status !== ArtifactStatus.READY) {
      throw new ConflictError(
        'ARTIFACT_NOT_READY',
        `artifact ${artifactId} is ${artifact.status}; a model version cannot point at `
        + 'bytes that are not confirmed to exist',
      );
    }

    // An artifact belongs to a job, which belongs to a project. Registering another
    // project's artifact would let one project's registry depend on another's retention.
    if (artifact.project !== null && artifact.project !== projectName) {
      throw new ValidationError(
        'ARTIFACT_PROJECT_MISMATCH',
        `artifact ${artifactId} belongs to project "${artifact.project}", not "${projectName}"`,
      );
    }

    await modelsRepo.lockModel(client, model.id);
    const version = await modelsRepo.nextVersionNumber(client, model.id);

    const jobId = artifact.job?.id ?? null;
    const resolved = metrics ?? (jobId ? await summariseJob(client, jobId) : {});

    const id = await modelsRepo.insertVersion(client, {
      modelId: model.id,
      version,
      experimentId: artifact.experiment_id,
      artifactId,
      jobId,
      status: INITIAL_STATUS,
      metrics: resolved,
      description,
    });

    return modelsRepo.getVersionById(client, id);
  });
}

/** The last value of each metric the job reported, as a flat object. */
async function summariseJob(client, jobId) {
  const summary = await metricsRepo.summariseJobMetrics(client, jobId);
  return Object.fromEntries(summary.map((metric) => [metric.name, metric.last_value]));
}

export async function getVersion(pool, projectName, modelName, version) {
  return withTransaction(pool, async (client) => {
    await requireModel(client, projectName, modelName);
    const found = await modelsRepo.getVersion(client, projectName, modelName, version);
    if (!found) {
      throw new NotFoundError(`model "${modelName}" has no version ${version}`);
    }
    return found;
  });
}

export async function listVersions(pool, projectName, modelName, { status = null } = {}) {
  return withTransaction(pool, async (client) => {
    const model = await requireModel(client, projectName, modelName);
    return modelsRepo.listVersions(client, model.id, { status });
  });
}

/**
 * Moves a version to `status`, displacing the incumbent where the status is exclusive.
 *
 * One transaction, with the model row locked first: a promotion that read the incumbent
 * and then wrote in two steps could interleave with another promotion and leave two
 * versions in PRODUCTION, which is the one thing this registry promises cannot happen.
 *
 * @returns {Promise<{version: object, displaced: object|null}>}
 */
export async function setStatus(pool, projectName, modelName, version, status) {
  return withTransaction(pool, async (client) => {
    const model = await requireModel(client, projectName, modelName);
    // Taken before anything is read, so a concurrent promotion of a different version
    // of the same model waits here rather than racing.
    await modelsRepo.lockModel(client, model.id);

    const target = await modelsRepo.getVersion(client, projectName, modelName, version);
    if (!target) {
      throw new NotFoundError(`model "${modelName}" has no version ${version}`);
    }

    // Throws IllegalModelTransitionError, which carries its own 409.
    transition(target.status, status);

    let displaced = null;
    if (isExclusive(status)) {
      const incumbents = await modelsRepo.lockVersionsWithStatus(client, model.id, status);
      for (const incumbent of incumbents) {
        if (incumbent.id === target.id) continue;
        await modelsRepo.setVersionStatus(client, incumbent.id, DISPLACED_TO);
        displaced = await modelsRepo.getVersionById(client, incumbent.id);
      }
    }

    await modelsRepo.setVersionStatus(client, target.id, status, {
      stampPromotion: status === ModelStatus.PRODUCTION,
    });

    return {
      version: await modelsRepo.getVersionById(client, target.id),
      displaced,
    };
  });
}

/**
 * The version a model currently means, or null.
 *
 * A separate call rather than a filter on the list, because it is the question the
 * Phase 5 router will ask on a hot path and it should not have to reason about a list.
 */
export async function getProductionVersion(pool, projectName, modelName) {
  return withTransaction(pool, async (client) => {
    const model = await requireModel(client, projectName, modelName);
    const versions = await modelsRepo.listVersions(client, model.id, {
      status: ModelStatus.PRODUCTION,
    });
    return versions[0] ?? null;
  });
}
