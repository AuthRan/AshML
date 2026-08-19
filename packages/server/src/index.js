/**
 * Entry point for ashml-server, the AshML control-plane API.
 *
 * Serves the control-plane API and, unless disabled, runs the executor loop that puts
 * queued jobs onto Kubernetes and syncs their status back. See docs/roadmap.md.
 */

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { startExecutor } from './services/executor.js';
import { startDiscovery, discoverCluster } from './services/nodes.js';

const config = loadConfig();

let app;
try {
  app = await buildApp(config);
} catch (err) {
  console.error(`ashml-server failed to start: ${err.message}`);
  process.exit(1);
}

let executor = null;
let discovery = null;
if (config.executorEnabled) {
  try {
    // Done before the loop starts, and before the port is bound, so a broken
    // kubeconfig or an unreachable API server is a startup failure with a clear
    // message rather than an error logged every two seconds by a server that looks
    // healthy from the outside.
    await app.k8s.ensureNamespace();
  } catch (err) {
    console.error(
      `ashml-server: cannot reach the Kubernetes cluster: ${err.message}\n`
      + 'Check ASHML_KUBECONFIG / your current context, or start the local cluster '
      + 'with `make cluster`. To run the API without executing jobs, set '
      + 'ASHML_EXECUTOR_ENABLED=false.',
    );
    process.exit(1);
  }

  // One discovery pass before the executor starts. Without it the first scheduling
  // pass runs against an empty node table and every job is refused for "no compute
  // nodes are registered" — technically true, and completely misleading.
  const inventory = await discoverCluster(app.db, app.k8s, app.gpuProvider, { logger: app.log });
  for (const warning of inventory.warnings) {
    app.log.warn({ warning }, 'cluster inventory');
  }

  discovery = startDiscovery(app.db, app.k8s, app.gpuProvider, {
    logger: app.log,
    intervalMs: config.discoveryIntervalMs,
  });

  executor = startExecutor(app.db, app.k8s, {
    logger: app.log,
    intervalMs: config.executorIntervalMs,
    // What training pods are told to report back to (see config.apiAdvertiseUrl).
    apiUrl: config.apiAdvertiseUrl,
  });
}

// Terminate cleanly so Kubernetes rollouts and Ctrl-C are not violent.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    try {
      // The executor stops first: it holds database transactions, and closing the
      // pool underneath an in-flight pass would roll back a state change that has
      // already happened in the cluster.
      await executor?.stop();
      await discovery?.stop();
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'graceful shutdown failed');
      process.exit(1);
    }
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      gpu_provider: config.gpuProvider,
      k8s_backend: config.k8sBackend,
      k8s_namespace: config.k8sNamespace,
      executor: config.executorEnabled ? `every ${config.executorIntervalMs}ms` : 'disabled',
      version: config.version,
    },
    'ashml-server ready',
  );
} catch (err) {
  app.log.error({ err }, 'failed to bind');
  process.exit(1);
}
