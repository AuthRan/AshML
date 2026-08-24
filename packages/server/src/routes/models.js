/**
 * Model registry endpoints.
 *
 * Project-scoped and addressed by name, like datasets: a model is a name someone says
 * out loud ("promote fraud-detector v7"), and an id in that sentence helps nobody.
 * Versions are integers within a model, allocated by the platform rather than chosen by
 * the caller — a registry where the client picks the version number is one where two
 * clients pick the same one.
 */

import * as modelService from '../services/models.js';
import { Permission } from '../domain/roles.js';
import { ALL_STATUSES, ModelStatus } from '../domain/model-status.js';

const modelSchema = {
  $id: 'Model',
  type: 'object',
  required: ['id', 'name', 'project', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    project: { type: 'string' },
    version_count: { type: 'integer' },
    latest_version: { type: ['integer', 'null'] },
    production_version: {
      type: ['integer', 'null'],
      description: 'The version this model currently means. At most one, ever.',
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const modelVersionSchema = {
  $id: 'ModelVersion',
  type: 'object',
  required: ['id', 'model', 'version', 'status', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    model: { type: 'string' },
    project: { type: 'string' },
    version: { type: 'integer' },
    status: { type: 'string', enum: ALL_STATUSES },
    description: { type: ['string', 'null'] },
    metrics: {
      type: 'object',
      additionalProperties: true,
      description:
        'The run’s own last reported value per metric, copied here so two versions can '
        + 'be compared without going back to their jobs',
    },
    artifact: {
      type: ['object', 'null'],
      description: 'The bytes this version is. Always READY — a version cannot be registered otherwise.',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        uri: { type: 'string' },
        digest: { type: ['string', 'null'] },
        size_bytes: { type: 'integer' },
        status: { type: 'string' },
        verified: {
          type: ['boolean', 'null'],
          description: 'Whether AshML checked the bytes itself, rather than the run claiming so',
        },
      },
    },
    experiment_id: { type: ['string', 'null'], format: 'uuid' },
    job_id: { type: ['string', 'null'], format: 'uuid' },
    promoted_at: {
      type: ['string', 'null'],
      format: 'date-time',
      description: 'When this version first entered PRODUCTION',
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const modelParams = {
  type: 'object',
  required: ['name', 'model'],
  properties: {
    name: { type: 'string', description: 'Project name' },
    model: { type: 'string' },
  },
};

const versionParams = {
  type: 'object',
  required: ['name', 'model', 'version'],
  properties: {
    name: { type: 'string' },
    model: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
  },
};

export async function registerModelRoutes(app) {
  app.addSchema(modelSchema);
  app.addSchema(modelVersionSchema);

  app.post(
    '/api/v1/projects/:name/models',
    {
      config: { permission: Permission.PROJECT_WRITE },
      schema: {
        tags: ['models'],
        summary: 'Create a model',
        description: 'A model is a name. What gets served is a *version* of it.',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
        },
        response: {
          201: { $ref: 'Model#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const model = await modelService.createModel(app.db, {
        projectName: request.params.name,
        name: request.body.name,
      });
      request.log.info({ project: model.project, model: model.name }, 'model created');
      return reply.status(201).send(model);
    },
  );

  app.get(
    '/api/v1/projects/:name/models',
    {
      config: { permission: Permission.PROJECT_READ },
      schema: {
        tags: ['models'],
        summary: 'List a project’s models',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['models'],
            properties: { models: { type: 'array', items: { $ref: 'Model#' } } },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => ({ models: await modelService.listModels(app.db, request.params.name) }),
  );

  app.get(
    '/api/v1/projects/:name/models/:model',
    {
      config: { permission: Permission.PROJECT_READ },
      schema: {
        tags: ['models'],
        summary: 'Get a model',
        params: modelParams,
        response: { 200: { $ref: 'Model#' }, 404: { $ref: 'Error#' } },
      },
    },
    async (request) => modelService.getModel(app.db, request.params.name, request.params.model),
  );

  app.post(
    '/api/v1/projects/:name/models/:model/versions',
    {
      config: { permission: Permission.PROJECT_WRITE },
      schema: {
        tags: ['models'],
        summary: 'Register a new version from an artifact',
        description:
          'The artifact must be READY. A registry entry pointing at bytes nobody '
          + 'confirmed only moves the moment of discovery from "the upload failed" to '
          + '"production cannot load the model". The version number is allocated by the '
          + 'platform, and the version starts in CREATED — registering is not promoting.',
        params: modelParams,
        body: {
          type: 'object',
          required: ['artifact_id'],
          additionalProperties: false,
          properties: {
            artifact_id: { type: 'string', format: 'uuid' },
            description: { type: 'string', maxLength: 2000 },
            metrics: {
              type: 'object',
              additionalProperties: true,
              description:
                'Defaults to the source job’s own last reported value per metric. Give '
                + 'this only to record something the run did not, such as a held-out '
                + 'evaluation done afterwards.',
            },
          },
        },
        response: {
          201: { $ref: 'ModelVersion#' },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const version = await modelService.registerVersion(app.db, {
        projectName: request.params.name,
        modelName: request.params.model,
        artifactId: request.body.artifact_id,
        description: request.body.description ?? '',
        metrics: request.body.metrics ?? null,
      });
      request.log.info(
        { model: version.model, version: version.version, artifact_id: request.body.artifact_id },
        'model version registered',
      );
      return reply.status(201).send(version);
    },
  );

  app.get(
    '/api/v1/projects/:name/models/:model/versions',
    {
      config: { permission: Permission.PROJECT_READ },
      schema: {
        tags: ['models'],
        summary: 'List a model’s versions, newest first',
        params: modelParams,
        querystring: {
          type: 'object',
          properties: { status: { type: 'string', enum: ALL_STATUSES } },
        },
        response: {
          200: {
            type: 'object',
            required: ['versions'],
            properties: { versions: { type: 'array', items: { $ref: 'ModelVersion#' } } },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => ({
      versions: await modelService.listVersions(app.db, request.params.name, request.params.model, {
        status: request.query.status ?? null,
      }),
    }),
  );

  app.get(
    '/api/v1/projects/:name/models/:model/production',
    {
      config: { permission: Permission.PROJECT_READ },
      schema: {
        tags: ['models'],
        summary: 'The version this model currently means',
        description:
          'Its own endpoint rather than a filter on the list: this is what an inference '
          + 'router asks, and it should not have to reason about an array to get an answer.',
        params: modelParams,
        response: {
          200: {
            type: 'object',
            properties: { version: { $ref: 'ModelVersion#' } },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const version = await modelService.getProductionVersion(
        app.db, request.params.name, request.params.model,
      );
      if (!version) {
        // A model with nothing in production is not an error, but it is also not a
        // model anything can serve. 404 is what a router needs to hear.
        return reply.status(404).send({
          error: {
            code: 'NO_PRODUCTION_VERSION',
            message: `model "${request.params.model}" has no version in PRODUCTION`,
          },
        });
      }
      return { version };
    },
  );

  app.get(
    '/api/v1/projects/:name/models/:model/versions/:version',
    {
      config: { permission: Permission.PROJECT_READ },
      schema: {
        tags: ['models'],
        summary: 'Get one version',
        params: versionParams,
        response: { 200: { $ref: 'ModelVersion#' }, 404: { $ref: 'Error#' } },
      },
    },
    async (request) => modelService.getVersion(
      app.db, request.params.name, request.params.model, request.params.version,
    ),
  );

  app.post(
    '/api/v1/projects/:name/models/:model/versions/:version/status',
    {
      config: { permission: Permission.PROJECT_WRITE },
      schema: {
        tags: ['models'],
        summary: 'Move a version through the lifecycle',
        description:
          'Promoting to PRODUCTION displaces the incumbent in the same transaction, so '
          + 'there is never an instant with two production versions and never one with '
          + 'none. The displaced version goes to STAGING, not ARCHIVED — it is the most '
          + 'likely rollback target, and retiring it is a separate decision.',
        params: versionParams,
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ALL_STATUSES } },
        },
        response: {
          200: {
            type: 'object',
            required: ['version'],
            properties: {
              version: { $ref: 'ModelVersion#' },
              displaced: {
                type: ['object', 'null'],
                description: 'The version this promotion pushed out of PRODUCTION, if any',
                properties: {
                  version: { type: 'integer' },
                  status: { type: 'string' },
                },
              },
            },
          },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      const result = await modelService.setStatus(
        app.db,
        request.params.name,
        request.params.model,
        request.params.version,
        request.body.status,
      );
      request.log.info(
        {
          model: result.version.model,
          version: result.version.version,
          status: result.version.status,
          displaced: result.displaced?.version ?? null,
        },
        result.version.status === ModelStatus.PRODUCTION ? 'model promoted' : 'model version status changed',
      );
      return result;
    },
  );
}
