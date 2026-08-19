/**
 * Experiment service.
 *
 * Creating an experiment is where reproducibility is either captured or lost, so the
 * validation here is deliberately fussier than elsewhere: a dataset must be named
 * together with its version, and the version must already exist. Recording a run
 * against data nobody can identify later is worse than refusing the request.
 */

import { withTransaction } from '../db/pool.js';
import * as experimentsRepo from '../repos/experiments.js';
import * as projectsRepo from '../repos/projects.js';
import { resolveVersionId } from './datasets.js';
import { NotFoundError, ValidationError } from './errors.js';

export async function createExperiment(pool, {
  projectName,
  name,
  gitCommit = '',
  imageDigest = '',
  dataset = null,
  datasetVersion = null,
  hyperparameters = {},
  randomSeed = null,
}) {
  // Half a dataset reference pins nothing. Reject it rather than storing NULL and
  // letting the run look reproducible when it is not.
  if ((dataset === null) !== (datasetVersion === null)) {
    throw new ValidationError(
      'INCOMPLETE_DATASET_REFERENCE',
      'dataset and dataset_version must be given together',
    );
  }

  return withTransaction(pool, async (client) => {
    const project = await projectsRepo.getProjectByName(client, projectName);
    if (!project) {
      throw new NotFoundError(`project "${projectName}" not found`);
    }

    const datasetVersionId = dataset === null
      ? null
      : await resolveVersionId(client, projectName, dataset, datasetVersion);

    const id = await experimentsRepo.insertExperiment(client, {
      projectId: project.id,
      name,
      gitCommit,
      imageDigest,
      datasetVersionId,
      hyperparameters,
      randomSeed,
    });

    return experimentsRepo.getExperimentById(client, id);
  });
}

export async function getExperiment(pool, id) {
  const experiment = await experimentsRepo.getExperimentById(pool, id);
  if (!experiment) {
    throw new NotFoundError(`experiment ${id} not found`);
  }
  return experiment;
}

export async function listExperiments(pool, filters) {
  return experimentsRepo.listExperiments(pool, filters);
}
