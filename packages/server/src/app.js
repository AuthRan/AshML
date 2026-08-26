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
import { registerModelRoutes } from './routes/models.js';
import { registerDeploymentRoutes } from './routes/deployments.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerUiRoutes } from './routes/ui.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAuditRoutes } from './routes/audit.js';
import { installAuth } from './auth/install.js';
import { installRateLimit } from './auth/rate-limit.js';
import { AuditLog } from './services/audit.js';
import { createMetrics } from './observability/metrics.js';
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
 * @param {boolean} [options.collectDefaultMetrics] register prom-client's process
 *   collectors. Off in tests, where several apps exist at once and per-process metrics
 *   would describe the test runner rather than a server
 *
 * Note this does not start the executor loop — that belongs to index.js, alongside
 * binding a port, so that building an app for a test never starts claiming jobs off
 * a shared queue.
 */
export async function buildApp(config, {
  logger = true, pool = null, k8s = null, store = null, collectDefaultMetrics = true,
} = {}) {
  const app = Fastify({
    logger: logger === false ? false : { level: config.logLevel },
    // Correlates every log line for a request; carried into job_id/experiment_id
    // correlation in Phase 1 (spec §24).
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
    // Whether `request.ip` may come from `X-Forwarded-For`. Off unless a proxy that
    // rewrites that header is known to be in front — see config.trustProxy, and
    // auth/rate-limit.js, which is what reads the answer.
    trustProxy: config.trustProxy === true,
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
  // The address a *container* should call this API on, which is never the address this
  // API bound to. The executor gets it passed in from index.js; the deployment routes
  // need it too, because a model server fetches its own weights through the API.
  app.decorate('apiAdvertiseUrl', config.apiAdvertiseUrl);

  let backend;
  try {
    backend = k8s ?? createBackend(config.k8sBackend, {
      namespace: config.k8sNamespace,
      kubeconfig: config.kubeconfig,
      kubeconfigContext: config.kubeconfigContext,
      networkPolicyEnabled: config.networkPolicyEnabled,
      clusterPodCidr: config.clusterPodCidr,
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

  // One registry per app. prom-client throws on a duplicate metric name, and tests build
  // several apps in one process, so this cannot be a module-level singleton.
  const metrics = createMetrics({ collectDefaults: collectDefaultMetrics });
  app.decorate('metrics', metrics);

  /**
   * Times every request by *route*, never by URL.
   *
   * `request.routeOptions.url` is the pattern — `/api/v1/jobs/:id` — so one job is one
   * sample on one series. Labelling by `request.url` instead gives a new series per job
   * id, which is the standard way a metrics endpoint grows until it is the largest thing
   * in a Prometheus instance and the first thing to be turned off.
   */
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url;
    // No route means nothing matched: a 404 on an arbitrary path, which must not be
    // allowed to mint a series for whatever was typed.
    if (!route || route === '/metrics') return;
    metrics.httpRequestDuration.observe(
      { method: request.method, route, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  // An injected pool belongs to the caller; one we create is ours to close. Same rule
  // for the artifact store, whose S3 client holds sockets open.
  const ownsPool = pool === null;
  const ownsStore = store === null;
  app.decorate('db', pool ?? createPool(config));
  app.addHook('onClose', async (instance) => {
    // Before the pool closes, or the last denials of the process are written to a pool
    // that has gone — which is the moment they are most worth having.
    await instance.audit.close();
    if (ownsPool) await instance.db.end();
    if (ownsStore) await instance.artifactStore.close();
  });

  /**
   * The authorization audit trail, buffered.
   *
   * Started here rather than in index.js — unlike the executor, this has to exist for
   * `app.inject` too, because a refusal in a test is a refusal. It writes on a timer and
   * is drained on close, so nothing is lost to a graceful shutdown.
   */
  const audit = new AuditLog(app.db, {
    logger: app.log,
    metrics,
    intervalMs: config.auditFlushIntervalMs,
    capacity: config.auditBufferSize,
  }).start();
  app.decorate('audit', audit);

  app.addSchema(errorSchema);
  app.addSchema(deviceSchema);

  // Before authentication, and that order is load-bearing rather than tidy: the
  // anonymous limiter's whole purpose is to refuse a request before the token lookup it
  // would otherwise pay for, and Fastify runs same-stage hooks in registration order.
  installRateLimit(app, config.rateLimit);

  // Before any route is registered, so that every route inherits the default-deny hook
  // and there is no window in which a route exists unprotected (auth/install.js).
  await installAuth(app, { enabled: config.authEnabled });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AshML API',
        description:
          'Control-plane API for the AshML Kubernetes-native GPU ML platform. '
          + 'Generated from the route schemas — do not edit by hand.\n\n'
          + 'Default deny: every `/api/v1` request needs `Authorization: Bearer <token>`. '
          + 'A person gets one from `ash token create`; the first one comes from '
          + '`make token`, which writes it straight to the database because the endpoint '
          + 'that mints tokens needs one itself. Training and serving pods are handed '
          + 'their own scoped credentials by the platform and do not use these.\n\n'
          + 'Every response except the probe and scrape endpoints carries '
          + '`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` — those three '
          + 'are exempt, because a throttled health probe is a restart. Over budget is '
          + '`429` with `Retry-After`, and a refused '
          + 'request is not itself charged, so backing off for that long is enough. An '
          + 'authenticated caller is counted by identity rather than by token; requests '
          + 'with no valid credential are counted, far more tightly, by source address.',
        version: config.version,
      },
      // Declared so the /docs page offers an Authorize box. Without it every "Try it
      // out" on this page answers 401 with nothing the reader can do about it, and a
      // generated client emits no auth support at all — which is a poor advertisement
      // for an API whose first property is that it authenticates.
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'An AshML API token. See `ash token create`.',
          },
        },
      },
      security: [{ bearerAuth: [] }],
      servers: [{ url: '/', description: 'Current host' }],
      tags: [
        { name: 'system', description: 'Health and version' },
        { name: 'auth', description: 'Tokens, identity, and project membership' },
        { name: 'audit', description: 'What the platform refused, and to whom' },
        { name: 'gpus', description: 'GPU inventory and telemetry' },
        { name: 'projects', description: 'Projects and quotas' },
        { name: 'datasets', description: 'Datasets and their immutable versions' },
        { name: 'experiments', description: 'Experiments and reproducibility capture' },
        { name: 'jobs', description: 'Training jobs' },
        { name: 'nodes', description: 'Compute nodes, capacity, and GPU inventory' },
        { name: 'metrics', description: 'Training metrics reported by running jobs' },
        { name: 'artifacts', description: 'Checkpoints and models produced by runs' },
        { name: 'models', description: 'The model registry: versions and their lifecycle' },
        { name: 'deployments', description: 'Serving a model version, and what the cluster reports back' },
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

    // The one funnel every refusal already passes through, which is why the audit is
    // written from here. What it records is the `denial` the *service* attached at the
    // decision — not the status below it, which for project isolation deliberately says
    // 404 about a refusal that was really a 403 (services/auth.js). Both are stored, and
    // they are allowed to disagree.
    if (err.denial && request.principal) {
      app.audit.record({
        principal: request.principal,
        denial: err.denial,
        status,
        request: {
          method: request.method,
          route: request.routeOptions?.url ?? request.url,
          requestId: request.id,
          remoteAddr: request.ip,
        },
      });
    }

    // 5xx messages are hidden by default because an unexpected exception's message is
    // an internal detail — a SQL fragment, a stack, a connection string. `expose` is
    // for the 5xx that were *constructed* to be read: an upstream's own answer relayed
    // back to whoever asked. Masking those would replace the only useful sentence in
    // the response with "Internal server error".
    const readable = status < 500 || err.expose === true;
    reply.status(status).send({
      error: {
        code: err.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
        message: readable ? err.message : 'Internal server error',
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    });
  });

  await app.register(registerHealthRoutes);
  await app.register(registerAuthRoutes);
  await app.register(registerAuditRoutes);
  await app.register(registerObservabilityRoutes);
  await app.register(registerUiRoutes);
  await app.register(registerGpuRoutes);
  await app.register(registerProjectRoutes);
  await app.register(registerDatasetRoutes);
  await app.register(registerExperimentRoutes);
  await app.register(registerJobRoutes);
  await app.register(registerNodeRoutes);
  await app.register(registerDeploymentRoutes);
  await app.register(registerMetricRoutes);
  await app.register(registerArtifactRoutes);
  await app.register(registerModelRoutes);

  return app;
}
