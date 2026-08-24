/**
 * GPU inventory.
 *
 * Phase 0 queries the active provider live on every request. Phase 3 replaces this
 * with a discovery loop writing into `gpu_devices`, at which point this endpoint
 * reads from the database and the scheduler reads the same rows.
 */

import { Permission } from '../domain/roles.js';

export async function registerGpuRoutes(app) {
  app.get(
    '/api/v1/gpus',
    {
      config: { permission: Permission.PLATFORM_ADMIN },
      schema: {
        tags: ['gpus'],
        summary: 'List GPUs visible to the active provider',
        description:
          'Devices with `simulated: true` are fabricated, not real hardware. '
          + 'Clients must surface that flag to the user (spec Rule 5).',
        response: {
          200: {
            type: 'object',
            required: ['provider', 'gpus'],
            properties: {
              provider: { type: 'string' },
              gpus: { type: 'array', items: { $ref: 'GpuDevice#' } },
            },
          },
          503: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      try {
        const gpus = await app.gpuProvider.discover();
        return { provider: app.gpuProvider.name, gpus };
      } catch (err) {
        request.log.error(
          { err, provider: app.gpuProvider.name },
          'gpu discovery failed',
        );
        return reply.status(503).send({
          error: { code: 'GPU_DISCOVERY_FAILED', message: err.message },
        });
      }
    },
  );
}
