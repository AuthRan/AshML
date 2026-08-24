/** Liveness, readiness, and version. Kubernetes probes target these. */

import { ping } from '../db/pool.js';

export async function registerHealthRoutes(app) {
  app.get(
    '/healthz',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness probe',
        response: {
          200: {
            type: 'object',
            required: ['status'],
            properties: { status: { type: 'string' } },
          },
        },
      },
    },
    async () => ({ status: 'ok' }),
  );

  app.get(
    '/readyz',
    {
      schema: {
        tags: ['system'],
        summary: 'Readiness probe',
        description:
          'Reports ready only when dependencies are reachable. A 503 here tells '
          + 'Kubernetes to stop routing traffic without restarting the pod.',
        response: {
          200: {
            type: 'object',
            required: ['status'],
            properties: {
              status: { type: 'string' },
              database: { type: 'string' },
            },
          },
          503: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      try {
        await ping(app.db);
      } catch (err) {
        // The detail goes to the log, not to the response. This endpoint answers before
        // anyone is known (auth/install.js), and a `pg` connection error routinely
        // carries the host, port, database name and role — `connect ECONNREFUSED
        // 10.0.3.14:5432`, `password authentication failed for user "ashml"`. A probe
        // needs to know the answer is no; it does not need to know why.
        request.log.error({ err }, 'readiness check failed: database unreachable');
        return reply.status(503).send({
          error: {
            code: 'DATABASE_UNAVAILABLE',
            message: 'the control plane cannot reach its database',
          },
        });
      }
      return { status: 'ready', database: 'ok' };
    },
  );

  app.get(
    '/api/v1/version',
    {
      config: { authenticatedOnly: true },
      schema: {
        tags: ['system'],
        summary: 'Server version and active GPU provider',
        response: {
          200: {
            type: 'object',
            required: ['version', 'gpu_provider'],
            properties: {
              version: { type: 'string' },
              gpu_provider: { type: 'string' },
            },
          },
        },
      },
    },
    async () => ({
      version: app.ashmlVersion,
      gpu_provider: app.gpuProvider.name,
    }),
  );
}
