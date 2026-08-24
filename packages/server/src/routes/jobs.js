/** Training job endpoints. */

import { ALL_STATES } from '../domain/job-state.js';
import { Permission } from '../domain/roles.js';
import * as jobService from '../services/jobs.js';
import * as schedulerService from '../services/scheduler.js';

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
    experiment: {
      type: ['object', 'null'],
      description: 'The reproducibility record this run belongs to, if any',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
      },
    },
    attempt: { type: 'integer' },
    max_retries: { type: 'integer' },
    k8s_job_name: {
      type: ['string', 'null'],
      description: 'Name of the Kubernetes Job running this attempt, once launched',
    },
    failure_reason: { type: ['string', 'null'] },
    pending_reason: {
      type: ['string', 'null'],
      description:
        'Why a launched job is not yet running — an image pull, an unschedulable Pod. '
        + 'Cleared once it runs. Not a failure.',
    },
    placement: {
      type: 'object',
      description: 'Where the scheduler put this job, and why',
      properties: {
        node_id: { type: ['string', 'null'] },
        node_name: { type: ['string', 'null'] },
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
      config: { authorization: 'handler' },
      schema: {
        tags: ['jobs'],
        summary: 'Submit a training job',
        description:
          'Creates the job and admits it to the queue in one transaction. The executor '
          + 'claims it from there and runs it as a Kubernetes Job.',
        body: {
          type: 'object',
          required: ['project', 'name', 'spec'],
          additionalProperties: false,
          properties: {
            project: { type: 'string' },
            experiment: {
              type: 'string',
              format: 'uuid',
              description: 'Optional experiment to attribute this run to; must be in the same project',
            },
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
      // The project is in the body rather than the path, so the declarative check cannot
      // see it. Submitting spends the project's quota, so it is a write.
      await app.requireProject(request, request.body.project, Permission.PROJECT_WRITE);

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
        experimentId: body.experiment ?? null,
      });

      request.log.info({ job_id: job.id, project: job.project, state: job.state }, 'job submitted');
      return reply.status(201).send(job);
    },
  );

  app.get(
    '/api/v1/jobs',
    {
      config: { authenticatedOnly: true },
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
        // Applied in SQL, before the LIMIT — see repos/jobs.js.
        visibleToUserId: app.listScope(request),
      }),
    }),
  );

  app.get(
    '/api/v1/jobs/:id',
    {
      config: { authorization: 'handler' },
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
    async (request) => {
      await app.requireJob(request, request.params.id, Permission.PROJECT_READ);
      return jobService.getJob(app.db, request.params.id);
    },
  );

  app.get(
    '/api/v1/jobs/:id/events',
    {
      config: { authorization: 'handler' },
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
    async (request) => {
      await app.requireJob(request, request.params.id, Permission.PROJECT_READ);
      return { events: await jobService.getJobEvents(app.db, request.params.id) };
    },
  );

  app.post(
    '/api/v1/jobs/:id/cancel',
    {
      config: { authorization: 'handler' },
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
      await app.requireJob(request, request.params.id, Permission.PROJECT_WRITE);
      const job = await jobService.cancelJob(app.db, request.params.id, {
        reason: request.body?.reason ?? 'cancelled by user',
      });
      request.log.info({ job_id: job.id, state: job.state }, 'job cancelled');
      return job;
    },
  );

  app.get(
    '/api/v1/jobs/:id/scheduling',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['jobs'],
        summary: 'Explain why a job was, or was not, scheduled',
        description:
          'Every node the scheduler considered on each of the most recent passes, and '
          + 'what was wrong with the ones it rejected. This is the answer to "why is my '
          + 'job still queued" — a question a single placement summary cannot answer '
          + 'once the situation that produced it has passed.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          properties: {
            passes: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['job_id', 'state', 'passes'],
            properties: {
              job_id: { type: 'string', format: 'uuid' },
              state: { type: 'string', enum: ALL_STATES },
              placement: {
                type: 'object',
                properties: {
                  node_id: { type: ['string', 'null'] },
                  node_name: { type: ['string', 'null'] },
                  reason: { type: ['string', 'null'] },
                },
              },
              passes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    pass_id: { type: 'string' },
                    attempt: { type: 'integer' },
                    at: { type: 'string', format: 'date-time' },
                    last_seen_at: { type: ['string', 'null'], format: 'date-time' },
                    repeat_count: {
                      type: 'integer',
                      description:
                        'How many consecutive passes reached this same verdict. '
                        + 'Identical refusals are folded together rather than repeated.',
                    },
                    decisions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          node_id: { type: ['string', 'null'] },
                          node_name: { type: ['string', 'null'] },
                          outcome: {
                            type: 'string',
                            enum: ['SELECTED', 'VIABLE', 'REJECTED', 'NO_CAPACITY', 'QUOTA_EXCEEDED'],
                          },
                          reason: { type: 'string' },
                          details: { type: 'object', additionalProperties: true },
                        },
                      },
                    },
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
      const job = await jobService.getJob(app.db, request.params.id);
      const passes = await schedulerService.getSchedulingHistory(app.db, job.id, {
        passes: request.query.passes ?? 5,
      });

      return { job_id: job.id, state: job.state, placement: job.placement, passes };
    },
  );

  app.get(
    '/api/v1/jobs/:id/logs',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['jobs'],
        summary: 'Read a job\'s container logs',
        description:
          'Returns the training container\'s stdout/stderr as read from Kubernetes. '
          + 'Logs live in the cluster, not in AshML: once the Pod is garbage-collected '
          + 'they are gone, which is why the response says whether they are still '
          + 'available rather than returning an empty string.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          properties: {
            tail: {
              type: 'integer',
              minimum: 1,
              maximum: 10000,
              description: 'Return only the most recent N lines',
            },
            previous: {
              type: 'boolean',
              default: false,
              description:
                'Read the previous container instance instead of the current one — '
                + 'where the output of a crashed run is found',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['job_id', 'available', 'logs'],
            properties: {
              job_id: { type: 'string', format: 'uuid' },
              state: { type: 'string', enum: ALL_STATES },
              k8s_job_name: { type: ['string', 'null'] },
              available: {
                type: 'boolean',
                description: 'False when no Pod exists to read logs from',
              },
              reason: {
                type: ['string', 'null'],
                description: 'Why logs are unavailable, when they are not',
              },
              logs: { type: 'string' },
            },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      await app.requireJob(request, request.params.id, Permission.PROJECT_READ);
      const job = await jobService.getJob(app.db, request.params.id);

      // A job that was never launched has no logs, and that is not an error — it is
      // the honest answer, and a distinct one from "the Pod is gone".
      if (!job.k8s_job_name) {
        return {
          job_id: job.id,
          state: job.state,
          k8s_job_name: null,
          available: false,
          reason: `job is ${job.state}; no container has been started yet`,
          logs: '',
        };
      }

      const logs = await app.k8s.readLogs(app.k8s.namespace, job.k8s_job_name, {
        tailLines: request.query.tail ?? null,
        previous: request.query.previous ?? false,
      });

      if (logs === null) {
        return {
          job_id: job.id,
          state: job.state,
          k8s_job_name: job.k8s_job_name,
          available: false,
          reason: 'the Pod for this job no longer exists in the cluster',
          logs: '',
        };
      }

      return {
        job_id: job.id,
        state: job.state,
        k8s_job_name: job.k8s_job_name,
        available: true,
        reason: null,
        logs,
      };
    },
  );
}
