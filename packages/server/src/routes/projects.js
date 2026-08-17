/** Project endpoints. */

import * as projectService from '../services/projects.js';

const quotaSchema = {
  type: 'object',
  properties: {
    gpu: { type: 'integer', minimum: 0 },
    cpu: { type: 'integer', minimum: 0 },
    memory_bytes: { type: 'integer', minimum: 0 },
    jobs: { type: 'integer', minimum: 0 },
  },
};

const projectSchema = {
  $id: 'Project',
  type: 'object',
  required: ['id', 'name', 'created_at', 'quota'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    quota: {
      type: 'object',
      required: ['gpu', 'cpu', 'memory_bytes', 'jobs'],
      properties: {
        gpu: { type: 'integer' },
        cpu: { type: 'integer' },
        memory_bytes: { type: 'integer' },
        jobs: { type: 'integer' },
      },
    },
  },
};

export async function registerProjectRoutes(app) {
  app.addSchema(projectSchema);

  app.post(
    '/api/v1/projects',
    {
      schema: {
        tags: ['projects'],
        summary: 'Create a project',
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            // Used in Kubernetes resource names from Phase 2, so it must already be
            // a valid DNS label.
            name: { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' },
            description: { type: 'string', maxLength: 1000 },
            quota: quotaSchema,
          },
        },
        response: {
          201: { $ref: 'Project#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const project = await projectService.createProject(app.db, request.body);
      request.log.info({ project: project.name }, 'project created');
      return reply.status(201).send(project);
    },
  );

  app.get(
    '/api/v1/projects',
    {
      schema: {
        tags: ['projects'],
        summary: 'List projects',
        response: {
          200: {
            type: 'object',
            required: ['projects'],
            properties: { projects: { type: 'array', items: { $ref: 'Project#' } } },
          },
        },
      },
    },
    async () => ({ projects: await projectService.listProjects(app.db) }),
  );

  app.get(
    '/api/v1/projects/:name',
    {
      schema: {
        tags: ['projects'],
        summary: 'Get a project by name',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { $ref: 'Project#' },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => projectService.getProject(app.db, request.params.name),
  );
}
