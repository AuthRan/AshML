/**
 * The model router, as a process.
 *
 * Configuration is entirely environmental because this runs as a pod created by the
 * control plane, and the control plane is the only thing that knows what to put in it.
 * There are no flags: a flag would be something an operator could set to disagree with
 * the deployment the router is in front of.
 *
 *   ASHML_ENDPOINT       the control plane, e.g. http://ashml.ashml.svc.cluster.local:8080
 *   ASHML_DEPLOYMENT_ID  which deployment's split to apply
 *   ASHML_PORT           the port to listen on (8082)
 *   ASHML_ROUTING_REFRESH_MS  how often to re-read the split (5000)
 *
 * The deployment is identified by **id** rather than by project and name. A name is the
 * thing an operator holds and can therefore be changed; an id cannot, and a router whose
 * deployment had been renamed under it would start asking about something that no longer
 * exists, at the exact moment nobody was watching it.
 */

import { createRoutingTable } from './routing-table.js';
import { createRouterMetrics } from './metrics.js';
import { createRouter } from './app.js';

function required(name) {
  const value = process.env[name];
  if (!value) {
    // Named plainly and at startup. A router that guessed at its endpoint would fail on
    // every request with a connection error, which is a much longer way round to the
    // same information.
    console.error(`${name} is required: the router is created by the control plane and `
      + 'is told what it is in front of. Nothing here can be guessed.');
    process.exit(2);
  }
  return value;
}

const endpoint = required('ASHML_ENDPOINT');
const deploymentId = required('ASHML_DEPLOYMENT_ID');
const port = Number(process.env.ASHML_PORT ?? 8082);
const refreshMs = Number(process.env.ASHML_ROUTING_REFRESH_MS ?? 5_000);
// Mounted from the deployment's Secret. Optional rather than `required` because a
// control plane with authentication disabled injects none, and the router should still
// come up there — the request simply goes out unauthenticated and is accepted.
const token = process.env.ASHML_RUN_TOKEN ?? null;

const metrics = createRouterMetrics({ deployment: process.env.ASHML_DEPLOYMENT_NAME ?? deploymentId });
const table = createRoutingTable({ endpoint, deploymentId, refreshMs, token });
const app = createRouter({ table, metrics });

// Fetched before listening, and a failure here is not fatal. The pod's readiness probe
// is what keeps it out of the Service's endpoints until it has a table, so refusing to
// start would only replace a pod that is honestly not ready with one that is not running
// — and a CrashLoopBackOff is a much worse way to say "the control plane is restarting".
const first = await table.start();
if (!first.ok) {
  app.log.warn({ err: first.error }, 'starting without a routing table; readiness will fail until one arrives');
}

await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await table.stop();
    await app.close();
    process.exit(0);
  });
}
