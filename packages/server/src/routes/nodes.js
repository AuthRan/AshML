/** Compute node and capacity endpoints. */

import * as nodeService from '../services/nodes.js';
import { freeCapacity, schedulableGpus } from '../domain/placement.js';

const nodeSchema = {
  $id: 'ComputeNode',
  type: 'object',
  required: ['id', 'name', 'ready', 'cpu_cores', 'memory_bytes', 'allocated', 'gpus'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    ready: { type: 'boolean' },
    cpu_cores: { type: 'integer' },
    memory_bytes: { type: 'integer' },
    running_jobs: { type: 'integer' },
    gpu_capacity: {
      type: 'integer',
      description:
        'GPUs Kubernetes will actually grant. Zero with devices present means no '
        + 'device plugin is installed (ADR 0008)',
    },
    reserved_cpu: {
      type: 'integer',
      description: 'CPU already requested by pods AshML did not create',
    },
    reserved_memory: { type: 'integer' },
    allocated: {
      type: 'object',
      description: 'What AshML has committed on this node, from its own records',
      properties: {
        cpu: { type: 'integer' },
        memory_bytes: { type: 'integer' },
        gpu: { type: 'integer' },
      },
    },
    schedulable_gpus: {
      type: 'integer',
      description: 'min(advertised, healthy) — what placement may actually use',
    },
    free: {
      type: 'object',
      description: 'Capacity minus commitments — what the scheduler places against',
      properties: {
        cpu: { type: 'integer' },
        memory_bytes: { type: 'integer' },
        gpu: { type: 'integer' },
      },
    },
    gpus: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          uuid: { type: 'string' },
          index: { type: 'integer' },
          model: { type: 'string' },
          memory_total_bytes: { type: 'integer' },
          memory_used_bytes: { type: 'integer' },
          utilization_pct: { type: 'integer' },
          health: { type: 'string' },
          simulated: {
            type: 'boolean',
            description: 'True when this device is fabricated rather than real hardware',
          },
        },
      },
    },
    last_seen_at: { type: ['string', 'null'], format: 'date-time' },
  },
};

export async function registerNodeRoutes(app) {
  app.addSchema(nodeSchema);

  app.get(
    '/api/v1/nodes',
    {
      schema: {
        tags: ['nodes'],
        summary: 'List compute nodes and their capacity',
        description:
          'The cluster as the scheduler sees it. `allocated` comes from AshML\'s own '
          + 'job records rather than from the node\'s reported usage, which lags — a '
          + 'Pod created a moment ago has not appeared in it yet.',
        response: {
          200: {
            type: 'object',
            required: ['nodes'],
            properties: { nodes: { type: 'array', items: { $ref: 'ComputeNode#' } } },
          },
        },
      },
    },
    async () => {
      const nodes = await nodeService.listNodes(app.db);
      return {
        // `free` comes from the same function the scheduler places against. Computing
        // it here instead would let the number a user reads drift from the number
        // admission actually uses — which it did, by forgetting `reserved_cpu`.
        nodes: nodes.map((node) => ({
          ...node,
          schedulable_gpus: schedulableGpus(node),
          free: freeCapacity(node),
        })),
      };
    },
  );
}
