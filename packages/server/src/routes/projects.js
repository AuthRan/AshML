/** Project endpoints. */

import * as projectService from '../services/projects.js';
import { Permission, PrincipalKind } from '../domain/roles.js';
import { ForbiddenError } from '../services/auth.js';

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
      config: { authorization: 'handler' },
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
      // Any authenticated *person* may create a project and owns what they create. There
      // is no permission to check against, because there is nothing yet to hold one on —
      // the creation is the grant. What must still be refused is a run token: a training
      // pod has no business creating projects, and `can` denies it every permission
      // except reporting for its own job, so there is no permission that expresses this.
      if (request.principal.kind !== PrincipalKind.USER) {
        throw new ForbiddenError('a run token may not create projects');
      }

      const project = await projectService.createProject(app.db, {
        ...request.body,
        ownerId: request.principal.userId,
      });
      request.log.info(
        { project: project.name, owner: request.principal.email }, 'project created',
      );
      return reply.status(201).send(project);
    },
  );

  app.get(
    '/api/v1/projects',
    {
      config: { authenticatedOnly: true },
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
    async (request) => ({
      // An administrator sees every project; everyone else sees the ones they are in;
      // a workload is refused (auth/install.js).
      projects: await projectService.listProjects(app.db, { userId: app.listScope(request) }),
    }),
  );

  app.get(
    '/api/v1/projects/:name',
    {
      config: { permission: Permission.PROJECT_READ },
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
    async (request) => app.readableProject(request, request.params.name),
  );

  app.patch(
    '/api/v1/projects/:name/quota',
    {
      config: { permission: Permission.PLATFORM_ADMIN },
      schema: {
        tags: ['projects'],
        summary: 'Change a project\'s resource quota',
        description:
          'Quotas are enforced at admission, before any Kubernetes object exists '
          + '(ADR 0003). A limit of 0 means unlimited. Lowering a limit does not stop '
          + 'jobs already running under the old one — it governs the next admission.',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          // Every field optional: a request changes only what it names, so raising the
          // GPU limit cannot silently reset the others to unlimited.
          properties: {
            gpu: { type: 'integer', minimum: 0 },
            cpu: { type: 'integer', minimum: 0 },
            memory_bytes: { type: 'integer', minimum: 0 },
            jobs: { type: 'integer', minimum: 0 },
          },
        },
        response: {
          200: { $ref: 'Project#' },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      const project = await projectService.updateQuota(app.db, request.params.name, request.body ?? {});
      request.log.info({ project: project.name, quota: project.quota }, 'quota updated');
      return project;
    },
  );
}
