/** Project service. Thin — projects have no lifecycle, unlike jobs. */

import { withTransaction } from '../db/pool.js';
import * as projectsRepo from '../repos/projects.js';
import { ConflictError, NotFoundError, UNIQUE_VIOLATION } from './errors.js';

export async function createProject(pool, { name, description, quota, ownerId }) {
  try {
    return await withTransaction(pool, (client) =>
      projectsRepo.createProject(client, { name, description, quota, ownerId }));
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ConflictError('PROJECT_EXISTS', `project "${name}" already exists`);
    }
    throw err;
  }
}

/**
 * Changes a project's quota.
 *
 * Lowering a limit below what is already running does not stop those jobs. Killing
 * work that was admitted under the old quota would destroy results a user is entitled
 * to; the new limit governs the next admission instead, and the project simply runs
 * over its quota until enough jobs finish.
 */
export async function updateQuota(pool, name, quota) {
  return withTransaction(pool, async (client) => {
    const project = await projectsRepo.getProjectByName(client, name);
    if (!project) {
      throw new NotFoundError(`project "${name}" not found`);
    }

    await projectsRepo.updateQuota(client, project.id, quota);
    return projectsRepo.getProjectByName(client, name);
  });
}

/** @param {string|null} userId null for a platform administrator, who sees all. */
export async function listProjects(pool, { userId = null } = {}) {
  return projectsRepo.listProjects(pool, { userId });
}

export async function getProject(pool, name) {
  const project = await projectsRepo.getProjectByName(pool, name);
  if (!project) {
    throw new NotFoundError(`project "${name}" not found`);
  }
  return project;
}
