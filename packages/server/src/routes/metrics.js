/**
 * Metric ingest and read-back.
 *
 * The write endpoint is the one part of the API called from inside a training
 * container rather than by a person, so it is shaped for a training loop: a batch of
 * points in one request, and a body that a fifteen-line reporter can build (ADR 0009).
 */

import * as metricService from '../services/metrics.js';
import { Permission } from '../domain/roles.js';

/** One metric's points, ordered by step. Reused by the job and experiment reads. */
const metricSeriesSchema = {
  $id: 'MetricSeries',
  type: 'object',
  required: ['name', 'points'],
  properties: {
    name: { type: 'string' },
    job_id: {
      type: 'string',
      format: 'uuid',
      description: 'Present on experiment reads, where one metric has a series per run',
    },
    points: {
      type: 'array',
      items: {
        type: 'object',
        required: ['step', 'value'],
        properties: {
          step: { type: 'integer' },
          epoch: { type: ['integer', 'null'] },
          value: { type: 'number' },
          recorded_at: {
            type: 'string',
            format: 'date-time',
            description: 'When the run observed the value, not when the API received it',
          },
        },
      },
    },
  },
};

const seriesResponse = {
  type: 'object',
  required: ['series'],
  properties: {
    job_id: { type: 'string', format: 'uuid' },
    experiment_id: { type: 'string', format: 'uuid' },
    series: { type: 'array', items: { $ref: 'MetricSeries#' } },
  },
};

export async function registerMetricRoutes(app) {
  app.addSchema(metricSeriesSchema);

  app.post(
    '/api/v1/jobs/:id/metrics',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['metrics'],
        summary: 'Report training metrics for a job',
        description:
          'Called by the training process itself. Metrics are append-only: reporting '
          + 'the same step twice records both points rather than replacing the first. '
          + 'The experiment is taken from the job, not from the request.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['metrics'],
          additionalProperties: false,
          properties: {
            metrics: {
              type: 'array',
              minItems: 1,
              // A cap, so one request cannot pin the event loop building a giant
              // insert. A run with more than this to flush sends several batches.
              maxItems: 1000,
              items: {
                type: 'object',
                required: ['name', 'value', 'step'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 200 },
                  value: { type: 'number' },
                  step: { type: 'integer', minimum: 0 },
                  epoch: { type: 'integer', minimum: 0 },
                  recorded_at: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['written', 'job_id'],
            properties: {
              written: { type: 'integer' },
              job_id: { type: 'string', format: 'uuid' },
              experiment_id: { type: ['string', 'null'], format: 'uuid' },
            },
          },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      // Only the run itself may report its own numbers — not a person, not another job.
      // This is the ingest path that had no authentication at all before Phase 10.
      await app.requireJob(request, request.params.id, Permission.RUN_REPORT);

      const result = await metricService.recordMetrics(app.db, request.params.id, request.body.metrics);
      request.log.info(
        { job_id: result.job_id, experiment_id: result.experiment_id, written: result.written },
        'metrics recorded',
      );
      return reply.status(201).send(result);
    },
  );

  app.get(
    '/api/v1/jobs/:id/metrics',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['metrics'],
        summary: 'Read a job’s metric series',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Return only this metric' },
            since_step: {
              type: 'integer',
              minimum: 0,
              description: 'Only points after this step, for polling a live run',
            },
            limit: { type: 'integer', minimum: 1, maximum: 20000, default: 2000 },
          },
        },
        response: { 200: seriesResponse, 404: { $ref: 'Error#' } },
      },
    },
    async (request) => {
      await app.requireJob(request, request.params.id, Permission.PROJECT_READ);
      return metricService.getJobMetrics(app.db, request.params.id, {
        name: request.query.name ?? null,
        sinceStep: request.query.since_step ?? null,
        limit: request.query.limit ?? 2000,
      });
    },
  );

  app.get(
    '/api/v1/jobs/:id/metrics/summary',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['metrics'],
        summary: 'Latest value and point count per metric',
        description: 'Answers "how is this run doing" without transferring the series.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['job_id', 'metrics'],
            properties: {
              job_id: { type: 'string', format: 'uuid' },
              metrics: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    count: { type: 'integer' },
                    first_step: { type: 'integer' },
                    last_step: { type: 'integer' },
                    last_value: { type: 'number' },
                    last_recorded_at: { type: ['string', 'null'], format: 'date-time' },
                  },
                },
              },
            },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      await app.requireJob(request, request.params.id, Permission.PROJECT_READ);
      return metricService.getJobMetricSummary(app.db, request.params.id);
    },
  );

  app.get(
    '/api/v1/experiments/:id/metrics',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['metrics'],
        summary: 'Read metrics across every run of an experiment',
        description:
          'One series per metric per job. Runs are kept apart rather than merged: two '
          + 'runs both report from step 0, and combining them would draw a curve that '
          + 'never existed.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 20000, default: 2000 },
          },
        },
        response: { 200: seriesResponse, 404: { $ref: 'Error#' } },
      },
    },
    async (request) => {
      await app.requireExperiment(request, request.params.id, Permission.PROJECT_READ);
      return metricService.getExperimentMetrics(app.db, request.params.id, {
        name: request.query.name ?? null,
        limit: request.query.limit ?? 2000,
      });
    },
  );
}
