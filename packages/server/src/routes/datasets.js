/**
 * Dataset endpoints, nested under their project.
 *
 * Dataset names are unique per project rather than globally, so the project is part of
 * the path — there is no way to name a dataset without also naming its project.
 */

import * as datasetService from '../services/datasets.js';

const datasetSchema = {
  $id: 'Dataset',
  type: 'object',
  required: ['id', 'name', 'project', 'version_count', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    project: { type: 'string' },
    version_count: { type: 'integer' },
    latest_version: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const datasetVersionSchema = {
  $id: 'DatasetVersion',
  type: 'object',
  required: ['id', 'dataset', 'project', 'version', 'uri', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    dataset: { type: 'string' },
    project: { type: 'string' },
    version: { type: 'string' },
    uri: { type: 'string', description: 'Where the bytes live; never Postgres (ADR 0001)' },
    digest: { type: ['string', 'null'], description: 'Content hash, e.g. sha256:…' },
    size_bytes: { type: 'integer' },
    created_at: { type: 'string', format: 'date-time' },
  },
};

/** Same rule as project and job names: it may end up in a Kubernetes object name. */
const nameParam = { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' };

/** Versions are labels, not DNS names — `v1`, `2024-01-05`, `1.2.0` all belong. */
const versionString = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };

const projectParams = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
};

const datasetParams = {
  type: 'object',
  required: ['name', 'dataset'],
  properties: { name: { type: 'string' }, dataset: { type: 'string' } },
};

export async function registerDatasetRoutes(app) {
  app.addSchema(datasetSchema);
  app.addSchema(datasetVersionSchema);

  app.post(
    '/api/v1/projects/:name/datasets',
    {
      schema: {
        tags: ['datasets'],
        summary: 'Create a dataset',
        params: projectParams,
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: nameParam },
        },
        response: {
          201: { $ref: 'Dataset#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const dataset = await datasetService.createDataset(app.db, {
        projectName: request.params.name,
        name: request.body.name,
      });
      request.log.info({ project: dataset.project, dataset: dataset.name }, 'dataset created');
      return reply.status(201).send(dataset);
    },
  );

  app.get(
    '/api/v1/projects/:name/datasets',
    {
      schema: {
        tags: ['datasets'],
        summary: 'List a project\'s datasets',
        params: projectParams,
        response: {
          200: {
            type: 'object',
            required: ['datasets'],
            properties: { datasets: { type: 'array', items: { $ref: 'Dataset#' } } },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => ({ datasets: await datasetService.listDatasets(app.db, request.params.name) }),
  );

  app.get(
    '/api/v1/projects/:name/datasets/:dataset',
    {
      schema: {
        tags: ['datasets'],
        summary: 'Get a dataset',
        params: datasetParams,
        response: {
          200: { $ref: 'Dataset#' },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => datasetService.getDataset(app.db, request.params.name, request.params.dataset),
  );

  app.post(
    '/api/v1/projects/:name/datasets/:dataset/versions',
    {
      schema: {
        tags: ['datasets'],
        summary: 'Register a dataset version',
        description:
          'Versions are immutable. Re-registering an existing version is a 409 rather '
          + 'than an update, so an experiment pinned to a version always describes the '
          + 'same data (spec §34).',
        params: datasetParams,
        body: {
          type: 'object',
          required: ['version', 'uri'],
          additionalProperties: false,
          properties: {
            version: versionString,
            uri: { type: 'string', minLength: 1, maxLength: 2048 },
            digest: { type: 'string', maxLength: 200 },
            size_bytes: { type: 'integer', minimum: 0 },
          },
        },
        response: {
          201: { $ref: 'DatasetVersion#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const created = await datasetService.addVersion(app.db, {
        projectName: request.params.name,
        datasetName: request.params.dataset,
        version: request.body.version,
        uri: request.body.uri,
        digest: request.body.digest ?? '',
        sizeBytes: request.body.size_bytes ?? 0,
      });
      request.log.info(
        { project: created.project, dataset: created.dataset, version: created.version },
        'dataset version registered',
      );
      return reply.status(201).send(created);
    },
  );

  app.get(
    '/api/v1/projects/:name/datasets/:dataset/versions',
    {
      schema: {
        tags: ['datasets'],
        summary: 'List a dataset\'s versions, newest first',
        params: datasetParams,
        response: {
          200: {
            type: 'object',
            required: ['versions'],
            properties: { versions: { type: 'array', items: { $ref: 'DatasetVersion#' } } },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => ({
      versions: await datasetService.listVersions(app.db, request.params.name, request.params.dataset),
    }),
  );

  app.get(
    '/api/v1/projects/:name/datasets/:dataset/versions/:version',
    {
      schema: {
        tags: ['datasets'],
        summary: 'Get one dataset version',
        params: {
          type: 'object',
          required: ['name', 'dataset', 'version'],
          properties: {
            name: { type: 'string' },
            dataset: { type: 'string' },
            version: { type: 'string' },
          },
        },
        response: {
          200: { $ref: 'DatasetVersion#' },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => datasetService.getVersion(
      app.db,
      request.params.name,
      request.params.dataset,
      request.params.version,
    ),
  );
}
