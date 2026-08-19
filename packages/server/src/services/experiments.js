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

/**
 * A run reporting on itself (spec 34).
 *
 * `started_at` and `ended_at` are stamped from here and nowhere else. They could have
 * been derived from the job's timestamps in Phase 1, and deliberately were not: a job
 * starts when Kubernetes runs its container, which is not when training starts -- there
 * is image pull, dataset download and framework init in between. Deriving the two from
 * each other would record a number nobody measured.
 *
 * `phase` is the whole of the request's meaning, so it is validated by the route
 * schema; anything reaching here is one of the two.
 */
export async function reportRun(pool, id, { phase, framework = '', hardware = {}, sdkVersion = '' }) {
  return withTransaction(pool, async (client) => {
    const experiment = await experimentsRepo.getExperimentById(client, id);
    if (!experiment) {
      throw new NotFoundError(`experiment ${id} not found`);
    }

    if (phase === 'started') {
      await experimentsRepo.startExperimentRun(client, id, { framework, hardware, sdkVersion });
    } else {
      // Finishing something that never reported a start is accepted rather than
      // refused. The alternative loses the end of a run because its start was lost --
      // a crashed reporter, or an SDK upgraded mid-run -- and half a record beats none.
      await experimentsRepo.finishExperimentRun(client, id);
    }

    return experimentsRepo.getExperimentById(client, id);
  });
}
