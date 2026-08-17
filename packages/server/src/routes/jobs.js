/** Training job endpoints. */

import { ALL_STATES } from '../domain/job-state.js';
import * as jobService from '../services/jobs.js';

const jobSchema = {
  $id: 'TrainingJob',
  type: 'object',
  required: ['id', 'name', 'project', 'state', 'priority', 'resources', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    project: { type: 'string' },
    state: { type: 'string', enum: ALL_STATES },
    priority: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
    resources: {
      type: 'object',
      properties: {
        cpu: { type: 'integer' },
        memory_bytes: { type: 'integer' },
        gpu: { type: 'integer' },
        gpu_memory_min_bytes: { type: 'integer' },
      },
    },
    spec: { type: 'object', additionalProperties: true },
    attempt: { type: 'integer' },
    max_retries: { type: 'integer' },
    failure_reason: { type: ['string', 'null'] },
    placement: {
      type: 'object',
      properties: {
        node_id: { type: ['string', 'null'] },
        reason: { type: ['string', 'null'] },
      },
    },
    queued_at: { type: ['string', 'null'], format: 'date-time' },
    started_at: { type: ['string', 'null'], format: 'date-time' },
    finished_at: { type: ['string', 'null'], format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: ['string', 'null'], format: 'date-time' },
  },
};

const jobEventSchema = {
  $id: 'JobEvent',
  type: 'object',
  required: ['id', 'event_type', 'created_at'],
  properties: {
    id: { type: 'integer' },
    event_type: { type: 'string' },
    from_state: { type: ['string', 'null'] },
    to_state: { type: ['string', 'null'] },
    message: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export async function registerJobRoutes(app) {
  app.addSchema(jobSchema);
  app.addSchema(jobEventSchema);

  app.post(
    '/api/v1/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Submit a training job',
        description:
          'Creates the job and admits it to the queue in one transaction. Nothing '
          + 'executes until Phase 2 wires up Kubernetes.',
        body: {
          type: 'object',
          required: ['project', 'name', 'spec'],
          additionalProperties: false,
          properties: {
            project: { type: 'string' },
            name: { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' },
            priority: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], default: 'MEDIUM' },
            max_retries: { type: 'integer', minimum: 0, maximum: 10, default: 0 },
            resources: {
              type: 'object',
              additionalProperties: false,
              properties: {
                cpu: { type: 'integer', minimum: 0, default: 1 },
                memory_bytes: { type: 'integer', minimum: 0, default: 0 },
                gpu: { type: 'integer', minimum: 0, default: 0 },
                gpu_memory_min_bytes: { type: 'integer', minimum: 0, default: 0 },
              },
            },
            // The container spec, carried through to Kubernetes in Phase 2.
            spec: {
              type: 'object',
              required: ['image'],
              properties: {
                image: { type: 'string', minLength: 1 },
                command: { type: 'array', items: { type: 'string' } },
                args: { type: 'array', items: { type: 'string' } },
                env: { type: 'object', additionalProperties: { type: 'string' } },
              },
              additionalProperties: true,
            },
          },
        },
        response: {
          201: { $ref: 'TrainingJob#' },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const resources = {
        cpu: body.resources?.cpu ?? 1,
        memory_bytes: body.resources?.memory_bytes ?? 0,
        gpu: body.resources?.gpu ?? 0,
        gpu_memory_min_bytes: body.resources?.gpu_memory_min_bytes ?? 0,
      };

      if (resources.cpu === 0 && resources.gpu === 0) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_RESOURCES',
            message: 'job must request at least one CPU or GPU',
          },
        });
      }
      if (resources.gpu === 0 && resources.gpu_memory_min_bytes > 0) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_RESOURCES',
            message: 'gpu_memory_min_bytes was set but no GPUs were requested',
          },
        });
      }

      const job = await jobService.submitJob(app.db, {
        projectName: body.project,
        name: body.name,
        spec: body.spec,
        resources,
        priority: body.priority ?? 'MEDIUM',
        maxRetries: body.max_retries ?? 0,
      });

      request.log.info({ job_id: job.id, project: job.project, state: job.state }, 'job submitted');
      return reply.status(201).send(job);
    },
  );

  app.get(
    '/api/v1/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'List training jobs',
        querystring: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            state: { type: 'string', enum: ALL_STATES },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['jobs'],
            properties: { jobs: { type: 'array', items: { $ref: 'TrainingJob#' } } },
          },
        },
      },
    },
    async (request) => ({
      jobs: await jobService.listJobs(app.db, {
        projectName: request.query.project ?? null,
        state: request.query.state ?? null,
        limit: request.query.limit ?? 50,
      }),
    }),
  );

  app.get(
    '/api/v1/jobs/:id',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Get a job',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: { $ref: 'TrainingJob#' },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => jobService.getJob(app.db, request.params.id),
  );

  app.get(
    '/api/v1/jobs/:id/events',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Get a job\'s event history',
        description:
          'The append-only audit trail of everything that happened to this job, '
          + 'oldest first (spec §47).',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['events'],
            properties: { events: { type: 'array', items: { $ref: 'JobEvent#' } } },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => ({ events: await jobService.getJobEvents(app.db, request.params.id) }),
  );

  app.post(
    '/api/v1/jobs/:id/cancel',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Cancel a job',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        // The body is optional — cancelling without giving a reason is valid, so a
        // request with no payload at all must not fail validation. Declaring `null`
        // alongside `object` is what allows an absent body through.
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { reason: { type: 'string', maxLength: 500 } },
        },
        response: {
          200: { $ref: 'TrainingJob#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      const job = await jobService.cancelJob(app.db, request.params.id, {
        reason: request.body?.reason ?? 'cancelled by user',
      });
      request.log.info({ job_id: job.id, state: job.state }, 'job cancelled');
      return job;
    },
  );
}
