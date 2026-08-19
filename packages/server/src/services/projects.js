/** Project service. Thin — projects have no lifecycle, unlike jobs. */

import { withTransaction } from '../db/pool.js';
import * as projectsRepo from '../repos/projects.js';
import { ConflictError, NotFoundError, UNIQUE_VIOLATION } from './errors.js';

export async function createProject(pool, { name, description, quota }) {
  try {
    return await withTransaction(pool, (client) =>
      projectsRepo.createProject(client, { name, description, quota }));
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ConflictError('PROJECT_EXISTS', `project "${name}" already exists`);
    }
    throw err;
  }
}

export async function listProjects(pool) {
  return projectsRepo.listProjects(pool);
}

export async function getProject(pool, name) {
  const project = await projectsRepo.getProjectByName(pool, name);
  if (!project) {
    throw new NotFoundError(`project "${name}" not found`);
  }
  return project;
}
