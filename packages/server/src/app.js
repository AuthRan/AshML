/**
 * Builds the Fastify application.
 *
 * Kept separate from index.js so tests can build an app and call `.inject()` without
 * binding a port.
 */

import Fastify, { LogController } from 'fastify';
import fastifySwagger from '@fastify/swagger';

// Importing a provider module is what registers it. Both are linked in; which one is
// used is a config decision (ADR 0005).
import './gpu/nvidia.js';
import './gpu/sim.js';

// Same story for the execution backend: importing registers it, config chooses it.
import './k8s/kubernetes.js';
import './k8s/sim.js';

// And for artifact storage.
import './storage/s3.js';
import './storage/none.js';

import { availableProviders, createProvider, deviceSchema } from './gpu/provider.js';
import { availableBackends, createBackend } from './k8s/backend.js';
import { availableStores, createStore } from './storage/store.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerGpuRoutes } from './routes/gpus.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerDatasetRoutes } from './routes/datasets.js';
import { registerExperimentRoutes } from './routes/experiments.js';
import { registerMetricRoutes } from './routes/metrics.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { createPool } from './db/pool.js';
import { IllegalTransitionError } from './domain/job-state.js';

/**
 * The single error shape used by every endpoint (spec §45).
 * Declared once and reused so error bodies cannot drift between handlers.
 */
export const errorSchema = {
  $id: 'Error',
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', description: 'Stable, machine-readable error code' },
        message: { type: 'string' },
      },
    },
  },
};

/**
 * @param {object} config from loadConfig
 * @param {object} [options]
 * @param {boolean} [options.logger] set false in tests
 * @param {import('pg').Pool} [options.pool] inject a pool; otherwise one is created
 *   from config and closed on app.close()
 * @param {object} [options.k8s] inject an execution backend; otherwise one is built
 *   from config
 * @param {object} [options.store] inject an artifact store; otherwise one is built
 *   from config
 *
 * Note this does not start the executor loop — that belongs to index.js, alongside
 * binding a port, so that building an app for a test never starts claiming jobs off
 * a shared queue.
 */
export async function buildApp(config, { logger = true, pool = null, k8s = null, store = null } = {}) {
  const app = Fastify({
    logger: logger === false ? false : { level: config.logLevel },
    // Correlates every log line for a request; carried into job_id/experiment_id
    // correlation in Phase 1 (spec §24).
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
  });

  let provider;
  try {
    provider = createProvider(config.gpuProvider, config.gpuProviderOptions);
  } catch (err) {
    throw new Error(
      `${err.message}\nSet ASHML_GPU_PROVIDER to one of: ${availableProviders().join(', ')}`,
      { cause: err },
    );
  }
  app.decorate('gpuProvider', provider);
  app.decorate('ashmlVersion', config.version);

  let backend;
  try {
    backend = k8s ?? createBackend(config.k8sBackend, {
      namespace: config.k8sNamespace,
      kubeconfig: config.kubeconfig,
    });
  } catch (err) {
    throw new Error(
      `${err.message}\nSet ASHML_K8S_BACKEND to one of: ${availableBackends().join(', ')}`,
      { cause: err },
    );
  }
  app.decorate('k8s', backend);

  let artifactStore;
  try {
    artifactStore = store ?? createStore(config.artifactStore, config.artifactStoreOptions);
  } catch (err) {
    throw new Error(
      `${err.message}\nSet ASHML_ARTIFACT_STORE to one of: ${availableStores().join(', ')}`,
      { cause: err },
    );
  }
  app.decorate('artifactStore', artifactStore);

  // An injected pool belongs to the caller; one we create is ours to close. Same rule
  // for the artifact store, whose S3 client holds sockets open.
  const ownsPool = pool === null;
  const ownsStore = store === null;
  app.decorate('db', pool ?? createPool(config));
  app.addHook('onClose', async (instance) => {
    if (ownsPool) await instance.db.end();
    if (ownsStore) await instance.artifactStore.close();
  });

  app.addSchema(errorSchema);
  app.addSchema(deviceSchema);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AshML API',
        description:
          'Control-plane API for the AshML Kubernetes-native GPU ML platform. '
          + 'Generated from the route schemas — do not edit by hand.',
        version: config.version,
      },
      servers: [{ url: '/', description: 'Current host' }],
      tags: [
        { name: 'system', description: 'Health and version' },
        { name: 'gpus', description: 'GPU inventory and telemetry' },
        { name: 'projects', description: 'Projects and quotas' },
        { name: 'datasets', description: 'Datasets and their immutable versions' },
        { name: 'experiments', description: 'Experiments and reproducibility capture' },
        { name: 'jobs', description: 'Training jobs' },
        { name: 'nodes', description: 'Compute nodes, capacity, and GPU inventory' },
        { name: 'metrics', description: 'Training metrics reported by running jobs' },
        { name: 'artifacts', description: 'Checkpoints and models produced by runs' },
      ],
    },
  });

  // Uniform error envelope, so a thrown error anywhere still matches spec §45.
  app.setErrorHandler((err, request, reply) => {
    // An illegal state transition is a conflict with current state, not a bad
    // request — the same call may succeed later or have succeeded earlier.
    if (err instanceof IllegalTransitionError) {
      return reply.status(409).send({
        error: { code: err.code, message: err.message },
      });
    }

    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'request failed');
    }
    reply.status(status).send({
      error: {
        code: err.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
        message: status >= 500 ? 'Internal server error' : err.message,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    });
  });

  await app.register(registerHealthRoutes);
  await app.register(registerGpuRoutes);
  await app.register(registerProjectRoutes);
  await app.register(registerDatasetRoutes);
  await app.register(registerExperimentRoutes);
  await app.register(registerJobRoutes);
  await app.register(registerNodeRoutes);
  await app.register(registerMetricRoutes);
  await app.register(registerArtifactRoutes);

  return app;
}
