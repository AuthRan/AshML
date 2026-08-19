/**
 * Dataset service.
 *
 * Datasets have no lifecycle, but their versions have a rule the job service's state
 * machine is the analogue of: a version is written once and never updated. There is
 * deliberately no `updateVersion` here. If the bytes change, that is a new version —
 * otherwise an experiment that recorded `dataset_version_id` months ago would silently
 * start describing different data (spec §34).
 */

import { withTransaction } from '../db/pool.js';
import * as datasetsRepo from '../repos/datasets.js';
import * as projectsRepo from '../repos/projects.js';
import { ConflictError, NotFoundError, UNIQUE_VIOLATION } from './errors.js';

/** @returns the project row, or throws 404. */
async function requireProject(client, projectName) {
  const project = await projectsRepo.getProjectByName(client, projectName);
  if (!project) {
    throw new NotFoundError(`project "${projectName}" not found`);
  }
  return project;
}

/** @returns the dataset, or throws 404. Also validates that the project exists. */
async function requireDataset(client, projectName, name) {
  const dataset = await datasetsRepo.getDatasetByName(client, projectName, name);
  if (!dataset) {
    // Distinguish "no such project" from "no such dataset in it" — a typo in either
    // half produces the same 404 otherwise, which is a miserable thing to debug.
    await requireProject(client, projectName);
    throw new NotFoundError(`dataset "${name}" not found in project "${projectName}"`);
  }
  return dataset;
}

export async function createDataset(pool, { projectName, name }) {
  try {
    return await withTransaction(pool, async (client) => {
      const project = await requireProject(client, projectName);
      const id = await datasetsRepo.insertDataset(client, { projectId: project.id, name });
      return datasetsRepo.getDatasetById(client, id);
    });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ConflictError(
        'DATASET_EXISTS',
        `dataset "${name}" already exists in project "${projectName}"`,
      );
    }
    throw err;
  }
}

export async function listDatasets(pool, projectName) {
  await requireProject(pool, projectName);
  return datasetsRepo.listDatasets(pool, projectName);
}

export async function getDataset(pool, projectName, name) {
  return requireDataset(pool, projectName, name);
}

/**
 * Registers a new version of a dataset.
 *
 * The digest is what makes the version verifiable rather than merely named, so it is
 * worth insisting on at the API layer; this function accepts an empty one because
 * migrating existing data into the platform sometimes cannot produce it.
 */
export async function addVersion(pool, { projectName, datasetName, version, uri, digest, sizeBytes }) {
  try {
    return await withTransaction(pool, async (client) => {
      const dataset = await requireDataset(client, projectName, datasetName);
      const id = await datasetsRepo.insertDatasetVersion(client, {
        datasetId: dataset.id,
        version,
        uri,
        digest,
        sizeBytes,
      });
      return datasetsRepo.getVersionById(client, id);
    });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      // Not an accident to paper over: versions are immutable, so a repeat means the
      // caller either re-ran something or is trying to change published data.
      throw new ConflictError(
        'DATASET_VERSION_EXISTS',
        `dataset "${datasetName}" already has version "${version}"; versions are immutable`,
      );
    }
    throw err;
  }
}

export async function listVersions(pool, projectName, datasetName) {
  const dataset = await requireDataset(pool, projectName, datasetName);
  return datasetsRepo.listVersions(pool, dataset.id);
}

export async function getVersion(pool, projectName, datasetName, version) {
  const dataset = await requireDataset(pool, projectName, datasetName);
  const found = await datasetsRepo.getVersion(pool, dataset.id, version);
  if (!found) {
    throw new NotFoundError(`dataset "${datasetName}" has no version "${version}"`);
  }
  return found;
}

/**
 * Resolves a dataset name + version to its id, inside a caller's transaction.
 *
 * Used by the experiment service to pin a run to specific data. Exported separately
 * from `getVersion` because the caller supplies the client, not the pool.
 */
export async function resolveVersionId(client, projectName, datasetName, version) {
  const dataset = await requireDataset(client, projectName, datasetName);
  const found = await datasetsRepo.getVersion(client, dataset.id, version);
  if (!found) {
    throw new NotFoundError(`dataset "${datasetName}" has no version "${version}"`);
  }
  return found.id;
}
