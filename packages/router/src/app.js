/**
 * The model router: one process in front of a deployment's versions, choosing which one
 * answers each request (spec §21).
 *
 * It exists because a traffic weight has to be applied *per request*. The tempting
 * alternative — one Service and a replica count per version — makes the split a function
 * of capacity, needs a hundred pods for a 99/1 canary, and changes the split every time
 * someone resizes a version. `domain/routing.js` records that argument in full; this
 * process is the half of it that runs.
 *
 * ## What it adds beyond forwarding
 *
 * **Every answer says which version produced it.** `X-AshML-Served-By` is on every
 * response, success or failure. A split whose outputs cannot be attributed is not a
 * canary — it is two models answering and no way to compare them, which is the one thing
 * §21 exists to make possible.
 *
 * **It does not touch the body.** The version is reported in headers and nowhere else.
 * A router that reached into a JSON payload to add a field would make every client's
 * parser depend on the router being in the path, so a deployment that dropped back to a
 * single version — no router — would break its callers.
 *
 * **A version that cannot be reached is skipped, once.** A connection-level failure is
 * this router's own evidence that a version is not answering, which is better information
 * than the control plane's last observation, and it fails the request over to whoever
 * else is taking traffic. An error *from* the model is not that: a 400 or a 500 with a
 * body is the version answering, and retrying it elsewhere would hide a broken canary
 * behind a healthy incumbent — which is the failure that makes a canary pointless.
 */

import Fastify from 'fastify';

// One file from the control plane, by path rather than as a package dependency. It is
// pure and imports nothing, so the image copies the file and carries none of the control
// plane's dependencies. Two implementations of "which version served this" would be two
// answers to the question the router exists to answer, which is why it is not copied.
import { chooseTarget } from '../../server/src/domain/routing.js';

/** Paths the router answers itself. Everything else belongs to the model server. */
const ROUTER_PATHS = new Set(['/healthz', '/readyz', '/metrics', '/-/routing']);

/** The header a caller sets to be routed consistently. See `chooseTarget`. */
export const ROUTE_KEY_HEADER = 'x-ashml-route-key';

/**
 * Headers that belong to one hop and must not be copied onto the next.
 *
 * `host` is the router's, not the target's. `content-length` is recomputed by whatever
 * sends the body. The connection headers are per-hop by definition, and forwarding them
 * is how a proxy ends up negotiating a transfer encoding on someone else's behalf.
 */
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'content-length',
]);

function forwardableHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())),
  );
}

/**
 * Builds the router.
 *
 * @param {object} options
 * @param {object} options.table a routing table from `routing-table.js`
 * @param {object} [options.metrics] from `metrics.js`
 * @param {function} [options.forward] injectable transport, so tests need no pods
 * @param {function} [options.random] injectable, so a routing test is not statistical
 */
export function createRouter({
  table,
  metrics = null,
  forward = fetchForward,
  random = Math.random,
  logger = true,
  timeoutMs = 30_000,
}) {
  const app = Fastify({
    logger,
    // The model server owns the shape of a prediction request, and a body this process
    // parsed would be a body it could get wrong. It is read as bytes and passed on.
    bodyLimit: 32 * 1024 * 1024,
  });

  app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, payload, done) => {
    done(null, payload);
  });

  /** Answers as soon as the process is listening. Never consults the routing table. */
  app.get('/healthz', async () => ({ status: 'ok' }));

  /**
   * Answers once there is a split to apply and something eligible to apply it to.
   *
   * Deliberately *not* conditional on the control plane being reachable. A router that
   * failed readiness while the control plane restarted would be pulled out of its
   * Service's endpoints, and the deployment behind it would stop answering — a control
   * plane's availability becoming inference's availability, which is the coupling this
   * whole design refuses. A stale table still routes.
   */
  app.get('/readyz', async (request, reply) => {
    const status = table.status();
    const eligible = table.targets().filter((t) => t.weight > 0 && t.ready);

    if (!status.loaded) {
      reply.code(503);
      return {
        status: 'not-ready',
        reason: 'no routing table has been fetched yet; nothing here knows what to serve',
        detail: status,
      };
    }
    if (eligible.length === 0) {
      reply.code(503);
      return {
        status: 'not-ready',
        reason: 'no version is both taking traffic and reachable',
        detail: status,
      };
    }
    return { status: 'ok', ...status, eligible: eligible.map((t) => t.version) };
  });

  if (metrics) {
    app.get('/metrics', async (request, reply) => {
      metrics.observeTable(table.status(), table.targets());
      reply.type(metrics.contentType);
      return metrics.render();
    });
  }

  /**
   * What this router currently believes, and how old that belief is.
   *
   * The age is the point. A split read without its age is a split that might be last
   * week's, and the failure mode of a router that has lost its control plane is exactly
   * that: it keeps working, correctly, on information that has stopped being true.
   */
  app.get('/-/routing', async () => ({
    ...table.status(),
    targets: table.targets(),
  }));

  app.all('/*', async (request, reply) => {
    if (ROUTER_PATHS.has(request.url.split('?')[0])) {
      reply.code(404);
      return { error: 'not found' };
    }

    const key = request.headers[ROUTE_KEY_HEADER] ?? null;
    const targets = table.targets();
    const attempted = [];

    let choice = chooseTarget(targets, { key, random });
    if (!choice) {
      metrics?.noTarget();
      reply.code(503);
      // Which versions exist and why none of them can answer, because "no target" on
      // its own sends an operator to look at the router when the answer is always in
      // the deployment behind it.
      return {
        error: 'no version of this deployment can answer',
        detail: targets.length === 0
          ? 'the router has no routing table; the control plane has not been reachable'
          : `none of ${targets.map((t) => `v${t.version} (weight ${t.weight}, `
            + `${t.ready ? 'reachable' : 'unreachable'})`).join(', ')} is both taking `
            + 'traffic and reachable',
        deployment: table.status().deployment,
      };
    }

    // At most one failover. A second would mean a request outliving two connection
    // timeouts before the caller hears anything, and a deployment where every version is
    // down should say so quickly rather than walking the list.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const target = choice.target;
      const startedAt = process.hrtime.bigint();
      attempted.push(target.version);

      let response;
      try {
        response = await forward(target, request, { timeoutMs });
        table.markReachable(target.version);
      } catch (err) {
        // A transport failure: nothing answered. Distinct from an error *response*,
        // which is the version answering and must be returned as it stands.
        table.markUnreachable(target.version);
        metrics?.failover(target.version, err.name === 'TimeoutError' ? 'timeout' : 'unreachable');
        request.log.warn({
          version: target.version, url: target.url, err: err.message,
        }, 'version unreachable, failing over');

        const remaining = table.targets().filter((t) => !attempted.includes(t.version));
        choice = chooseTarget(remaining, { key, random });
        if (!choice || attempt === 1) {
          metrics?.request(target.version, 502);
          reply.code(502);
          reply.header('x-ashml-served-by', 'none');
          reply.header('x-ashml-route-reason', 'unreachable');
          return {
            error: `could not reach any version of this deployment: ${err.message}`,
            attempted: attempted.map((v) => `v${v}`),
            deployment: table.status().deployment,
          };
        }
        // The next attempt is a failover whatever the arithmetic said, and calling it
        // "weighted" in the header would misattribute a request the weights did not send.
        choice = { ...choice, reason: 'failover' };
        continue;
      }

      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      metrics?.request(target.version, response.status, seconds);

      // Attribution goes on every response including the failures, because a 500 from a
      // canary is the single most important thing a canary produces.
      reply.code(response.status);
      for (const [name, value] of Object.entries(response.headers ?? {})) {
        if (!HOP_BY_HOP.has(name.toLowerCase())) reply.header(name, value);
      }
      reply.header('x-ashml-served-by', `v${target.version}`);
      reply.header('x-ashml-deployment', table.status().deployment ?? '');
      reply.header('x-ashml-route-reason', choice.reason);
      if (target.artifact_id) reply.header('x-ashml-artifact-id', target.artifact_id);
      return reply.send(response.body);
    }

    // Unreachable: the loop returns on every path. Kept so a future edit that adds a
    // `continue` cannot fall out of the handler with no response at all.
    reply.code(500);
    return { error: 'the router reached an impossible state and answered nothing' };
  });

  return app;
}

/**
 * The default transport: one HTTP request to a version's own Service.
 *
 * Throws on a transport failure and returns on any status code, because the router treats
 * those two as different things and a client that collapsed them would make the
 * distinction unavailable.
 */
async function fetchForward(target, request, { timeoutMs }) {
  const url = new URL(request.url, target.url);
  const response = await fetch(url, {
    method: request.method,
    headers: forwardableHeaders(request.headers),
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer()),
  };
}
