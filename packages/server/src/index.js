/**
 * Entry point for ashml-server, the AshML control-plane API.
 *
 * Phase 0 scope: health, version, GPU discovery. Domain endpoints arrive in Phase 1
 * once PostgreSQL is wired up. See docs/roadmap.md.
 */

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

let app;
try {
  app = await buildApp(config);
} catch (err) {
  console.error(`ashml-server failed to start: ${err.message}`);
  process.exit(1);
}

// Terminate cleanly so Kubernetes rollouts and Ctrl-C are not violent.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    try {
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
    { gpu_provider: config.gpuProvider, version: config.version },
    'ashml-server ready',
  );
} catch (err) {
  app.log.error({ err }, 'failed to bind');
  process.exit(1);
}
