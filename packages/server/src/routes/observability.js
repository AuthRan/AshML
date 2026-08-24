/**
 * The Prometheus scrape endpoint.
 *
 * `/metrics`, not `/api/v1/metrics`: the path is a convention every scraper and every
 * service-discovery default already assumes, and `/api/v1/metrics` is already taken by
 * the training-metric ingest path, which is a different thing in the opposite direction
 * (ADR 0009 — training metrics are pushed by the run, infrastructure metrics are scraped
 * from here).
 *
 * Unauthenticated — the one deliberate exception to Phase 10's default deny, listed in
 * `auth/install.js`'s PUBLIC_PATHS and protected by not being routable from outside the
 * cluster rather than by a credential: a scrape target that needs a token turns an auth
 * misconfiguration into an outage of the thing that would have reported it. What it
 * exposes is counts and
 * durations plus project and deployment *names* — no hyperparameters, no metric values
 * from a run, no artifact URIs. That is not a substitute for authentication and is not
 * offered as one; it is the reason this is the endpoint least urgent to protect.
 */

import { collectSnapshot } from '../observability/metrics.js';

export async function registerObservabilityRoutes(app) {
  app.get(
    '/metrics',
    {
      // Hidden from the OpenAPI document on purpose: that document describes a JSON API
      // and this endpoint answers in the Prometheus text exposition format. Declaring a
      // response schema would also make Fastify serialise the body as JSON, which would
      // produce a quoted string that every scraper rejects.
      schema: { hide: true },
      // The scrape reads the database, and a scraper that gives up before the query
      // finishes leaves the target looking down. This is also why the snapshot is
      // isolated per source: see `collectSnapshot`.
      config: { metricsRoute: true },
    },
    async (request, reply) => {
      await collectSnapshot(app.metrics, {
        pool: app.db,
        gpuProvider: app.gpuProvider,
        logger: request.log,
      });

      reply.header('content-type', app.metrics.registry.contentType);
      return app.metrics.registry.metrics();
    },
  );
}
