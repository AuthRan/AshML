/**
 * What the router exposes to Prometheus.
 *
 * These are the numbers a canary is made of. A 90/10 split whose per-version error rate
 * nobody can see is a split that has been *performed* rather than *measured*, and the
 * measuring is the entire reason to run one — which is why every series here is labelled
 * by version.
 *
 * `prom-client`, and a registry per router rather than the module-level default, for the
 * same reasons the control plane's metrics module gives: the exposition format is fiddly
 * enough to be worth a library, and a shared default registry throws the second time
 * anything is constructed, which makes it untestable.
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export function createRouterMetrics({ deployment = 'unknown', collectDefaults = true } = {}) {
  const registry = new Registry();
  registry.setDefaultLabels({ deployment });
  if (collectDefaults) collectDefaultMetrics({ register: registry, prefix: 'ashml_router_' });

  const requests = new Counter({
    name: 'ashml_router_requests_total',
    help: 'Requests forwarded, by the version that answered and the status it answered with',
    labelNames: ['version', 'code'],
    registers: [registry],
  });

  const duration = new Histogram({
    name: 'ashml_router_request_duration_seconds',
    help: 'Time from the router receiving a request to the version answering it',
    labelNames: ['version'],
    // Inference is tens to hundreds of milliseconds and a cold or thrashing pod is
    // seconds. Buckets that stopped at 1s would put every interesting failure in +Inf.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });

  const failovers = new Counter({
    name: 'ashml_router_failovers_total',
    help: 'Times a version could not be reached and the request was sent to another',
    labelNames: ['version', 'cause'],
    registers: [registry],
  });

  const noTarget = new Counter({
    name: 'ashml_router_no_target_total',
    help: 'Requests refused because no version was both taking traffic and reachable',
    registers: [registry],
  });

  /**
   * How old the routing table is.
   *
   * The one gauge here that is about the router rather than about the traffic, and the
   * one to alert on: a router whose control plane has gone away keeps serving correctly
   * on weights that have stopped being current, and this is the only place that shows.
   */
  const configAge = new Gauge({
    name: 'ashml_router_config_age_seconds',
    help: 'Seconds since the routing table was last refreshed from the control plane',
    registers: [registry],
  });

  /** The split itself, so a dashboard can draw what was asked for beside what happened. */
  const weight = new Gauge({
    name: 'ashml_router_target_weight',
    help: 'The share of traffic each version is configured to take, as a percentage',
    labelNames: ['version'],
    registers: [registry],
  });

  return {
    registry,
    contentType: registry.contentType,

    request(version, code, seconds = null) {
      requests.inc({ version: String(version), code: String(code) });
      if (seconds !== null) duration.observe({ version: String(version) }, seconds);
    },

    failover(version, cause) {
      failovers.inc({ version: String(version), cause });
    },

    noTarget() {
      noTarget.inc();
    },

    /** Called at scrape time, so the age is the age at the scrape rather than at a tick. */
    observeTable(status, targets = []) {
      if (status.age_seconds !== null) configAge.set(status.age_seconds);
      // Reset first: a version dropped from the split would otherwise keep reporting the
      // weight it had when it left, and a dashboard would go on drawing traffic to a
      // version that has not taken any since it was retired.
      weight.reset();
      for (const target of targets) weight.set({ version: String(target.version) }, target.weight);
    },

    render() {
      return registry.metrics();
    },
  };
}
