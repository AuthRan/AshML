/**
 * The dashboard the spec asks for in §49, served by the control plane itself.
 *
 * §49 wants a place to see the cluster, the jobs, the experiments, the models and the
 * deployments, and says in the same breath: "Do not spend months building a beautiful
 * frontend. The backend and infrastructure are the project." So this is one HTML file
 * with no build step, no framework and no new dependency — served from `/`, which means
 * `npm start` gives you the API and the dashboard at one address and there is no second
 * thing to deploy or keep in sync.
 *
 * **It holds no logic.** The page is a browser client of the same public API `ash` calls,
 * which is the rule the CLI already follows (spec §28): anything the dashboard shows, the
 * API can be asked for directly, and nothing is computed here that is not computed for
 * every other caller. That is also why it adds no endpoints of its own — a `/overview`
 * built for one page would be a second, quietly different account of the same state.
 *
 * **It is read-only**, and that is a decision rather than an omission. Writes stay in the
 * CLI and the API where they are logged, attributable and scriptable; a button that
 * promotes a model version is a thing to design carefully, not to add because a page
 * happened to exist.
 *
 * Grafana is still the right place for time series — scrape intervals, latency
 * histograms, GPU telemetry — and this does not duplicate it. What this shows is the
 * platform's own *state*: what exists, what it is doing, and what is serving right now.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../ui/index.html', import.meta.url));

export async function registerUiRoutes(app) {
  // Read once at startup rather than per request: it is a static asset, and a dashboard
  // that stats a file on every refresh is a dashboard that gets slower the more people
  // watch it. A failure here must not take the API down — the control plane's job is to
  // run training, and it should keep doing that with the page missing.
  let page = null;
  try {
    page = await readFile(PAGE, 'utf8');
  } catch (err) {
    app.log.warn({ err: err.message, path: PAGE }, 'dashboard not available; the API is unaffected');
  }

  app.get('/', {
    // Hidden from the OpenAPI document on purpose: that document describes the API, and
    // an HTML page in among the resources would be noise in every generated client.
    schema: { hide: true },
  }, async (request, reply) => {
    if (!page) {
      reply.code(503);
      return reply.type('text/plain').send(
        'The dashboard file could not be read at startup. The API is unaffected — see /docs.\n',
      );
    }
    // no-store: the page is a few kilobytes and always reflects the live API. A cached
    // copy of a dashboard is the one thing a dashboard must never be.
    reply.header('cache-control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(page);
  });
}
