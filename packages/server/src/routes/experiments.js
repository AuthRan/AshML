/**
 * Experiment endpoints.
 *
 * Addressed by id, not by name: repeating an experiment is normal and each attempt is
 * its own record (see repos/experiments.js).
 */

import * as experimentService from '../services/experiments.js';
import { Permission } from '../domain/roles.js';

const experimentSchema = {
  $id: 'Experiment',
  type: 'object',
  required: ['id', 'name', 'project', 'reproducibility', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    project: { type: 'string' },
    reproducibility: {
      type: 'object',
      description: 'Everything needed to rerun this experiment and get the same result (spec §34)',
      properties: {
        git_commit: { type: ['string', 'null'] },
        image_digest: {
          type: ['string', 'null'],
          description: 'Immutable image digest; a tag would not pin anything',
        },
        dataset: {
          type: ['object', 'null'],
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            version_id: { type: 'string', format: 'uuid' },
          },
        },
        hyperparameters: { type: 'object', additionalProperties: true },
        random_seed: { type: ['integer', 'null'] },
        observed: {
          type: 'object',
          description:
            'What the run reported about itself, as against everything above, which is '
            + 'what it was asked for. A record built only from intent is a wish; one '
            + 'built only from observation cannot be re-requested.',
          properties: {
            framework: { type: ['string', 'null'] },
            hardware: { type: 'object', additionalProperties: true },
            sdk_version: { type: ['string', 'null'] },
          },
        },
      },
    },
    job_count: { type: 'integer', description: 'Training jobs recorded against this experiment' },
    started_at: { type: ['string', 'null'], format: 'date-time' },
    ended_at: { type: ['string', 'null'], format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export async function registerExperimentRoutes(app) {
  app.addSchema(experimentSchema);

  app.post(
    '/api/v1/experiments',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['experiments'],
        summary: 'Create an experiment',
        description:
          'Captures the reproducibility record for a run. `dataset` and '
          + '`dataset_version` must be supplied together and must already be registered.',
        body: {
          type: 'object',
          required: ['project', 'name'],
          additionalProperties: false,
          properties: {
            project: { type: 'string' },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            git_commit: { type: 'string', maxLength: 40 },
            image_digest: { type: 'string', maxLength: 200 },
            dataset: { type: 'string' },
            dataset_version: { type: 'string' },
            hyperparameters: { type: 'object', additionalProperties: true },
            random_seed: { type: 'integer' },
          },
        },
        response: {
          201: { $ref: 'Experiment#' },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      // The project is in the body, so the declarative check cannot see it.
      await app.requireProject(request, request.body.project, Permission.PROJECT_WRITE);

      const body = request.body;
      const experiment = await experimentService.createExperiment(app.db, {
        projectName: body.project,
        name: body.name,
        gitCommit: body.git_commit ?? '',
        imageDigest: body.image_digest ?? '',
        dataset: body.dataset ?? null,
        datasetVersion: body.dataset_version ?? null,
        hyperparameters: body.hyperparameters ?? {},
        randomSeed: body.random_seed ?? null,
      });
      request.log.info(
        { experiment_id: experiment.id, project: experiment.project },
        'experiment created',
      );
      return reply.status(201).send(experiment);
    },
  );

  app.get(
    '/api/v1/experiments',
    {
      config: { authenticatedOnly: true },
      schema: {
        tags: ['experiments'],
        summary: 'List experiments, newest first',
        querystring: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['experiments'],
            properties: { experiments: { type: 'array', items: { $ref: 'Experiment#' } } },
          },
        },
      },
    },
    async (request) => ({
      experiments: await experimentService.listExperiments(app.db, {
        projectName: request.query.project ?? null,
        limit: request.query.limit ?? 50,
        visibleToUserId: app.listScope(request),
      }),
    }),
  );

  app.get(
    '/api/v1/experiments/:id',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['experiments'],
        summary: 'Get an experiment',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: { $ref: 'Experiment#' },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      await app.requireExperiment(request, request.params.id, Permission.PROJECT_READ);
      return experimentService.getExperiment(app.db, request.params.id);
    },
  );

  app.post(
    '/api/v1/experiments/:id/report',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['experiments'],
        summary: 'A run reports its own start or finish',
        description:
          'Called by the training SDK. `started` stamps `started_at` the first time it '
          + 'is reported and records the framework, hardware and SDK the run actually '
          + 'observed; `finished` stamps `ended_at`. These timestamps are not derived '
          + 'from the job, because a container starting is not training starting.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['phase'],
          additionalProperties: false,
          properties: {
            phase: { type: 'string', enum: ['started', 'finished'] },
            framework: { type: 'string', maxLength: 200 },
            hardware: {
              type: 'object',
              additionalProperties: true,
              description: 'What the run found itself running on: GPUs, driver, CUDA',
            },
            sdk_version: { type: 'string', maxLength: 50 },
          },
        },
        response: {
          200: { $ref: 'Experiment#' },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      // Reproducibility capture is the run describing itself, so it is a run's write.
      // A person cannot make it: the whole value of the record is that the pod reported
      // what it observed rather than what somebody expected (ADR 0009, spec Rule 5).
      await app.requireExperiment(request, request.params.id, Permission.RUN_REPORT);

      const body = request.body;
      const experiment = await experimentService.reportRun(app.db, request.params.id, {
        phase: body.phase,
        framework: body.framework ?? '',
        hardware: body.hardware ?? {},
        sdkVersion: body.sdk_version ?? '',
      });
      request.log.info(
        { experiment_id: experiment.id, phase: body.phase },
        'experiment run reported',
      );
      return experiment;
    },
  );
}
