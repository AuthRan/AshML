/**
 * What the router believes about a deployment's split, and how it finds out.
 *
 * The table is polled from the control plane rather than baked into the pod's
 * environment, and that is the whole reason a rollout is a control-plane write rather
 * than a redeploy: `ash deployment rollout resnet-cifar --version 7 --traffic 10` changes
 * a row, and the next refresh moves the traffic. Weights in the environment would mean
 * every step of a canary restarted the thing measuring it.
 *
 * ## The control plane going away must not take inference down
 *
 * The last good table is kept and used indefinitely. A router that emptied its table on a
 * failed refresh, or that failed readiness because the control plane was restarting,
 * would be removed from its Service's endpoints and take every deployment behind it down
 * with the control plane — the exact coupling the whole design avoids elsewhere. A stale
 * split is a *wrong* split, which is bad; no split at all is an outage, which is worse.
 *
 * What it does instead is say so. `age_seconds` is on `/-/routing` and in
 * `ashml_router_config_age_seconds`, so a table that has stopped refreshing is visible
 * as a growing number rather than as traffic quietly going to last week's weights.
 *
 * ## Readiness is a hint that expires, not an instruction
 *
 * The control plane's `ready` is an observation up to a sync interval old. It is used to
 * keep traffic off a version whose pods are not up yet — worth having, since the
 * alternative is a failed request per attempt — but never to keep traffic off one that
 * has recovered: the moment the refresh says ready, the version is eligible again.
 *
 * Beside it sits the router's own view, which is better information because the router is
 * the thing making the requests. A connection-level failure puts that version in a short
 * cooldown, shorter than the refresh interval so it can never outlive the problem.
 */

/** How long a version stays out of rotation after this router failed to reach it. */
export const FAILOVER_COOLDOWN_MS = 5_000;

/**
 * Fetches and holds the split for one deployment.
 *
 * @param {object} options
 * @param {string} options.endpoint the control plane's base URL
 * @param {string} options.deploymentId
 * @param {string} [options.token] the deployment's workload credential, from its Secret
 * @param {number} [options.refreshMs]
 * @param {function} [options.fetchImpl] injectable, so the tests are not a web server
 * @param {function} [options.now] injectable, so the tests are not a stopwatch
 */
export function createRoutingTable({
  endpoint,
  deploymentId,
  token = null,
  refreshMs = 5_000,
  timeoutMs = 5_000,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  logger = null,
}) {
  /** The last table the control plane successfully gave us. Null until the first one. */
  let table = null;
  let fetchedAt = null;
  let lastError = null;
  let refreshes = 0;

  /** version -> the time its cooldown ends. */
  const cooldowns = new Map();

  let timer = null;
  let stopped = false;

  const url = `${endpoint.replace(/\/+$/, '')}/api/v1/deployments/${deploymentId}/routing`;

  async function refresh() {
    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
          // Mounted from the deployment's Secret. It carries ROUTING_READ for this
          // deployment and nothing else (server/src/domain/roles.js). Absent when the
          // control plane runs with authentication disabled.
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`the control plane answered ${response.status} for ${url}`);
      }
      const body = await response.json();
      if (!Array.isArray(body.targets)) {
        throw new Error('the routing document has no targets array');
      }

      const previous = table;
      table = body;
      fetchedAt = now();
      lastError = null;
      refreshes += 1;

      if (previous && describeSplit(previous) !== describeSplit(body)) {
        logger?.info?.({
          deployment: body.deployment,
          from: describeSplit(previous),
          to: describeSplit(body),
        }, 'traffic split changed');
      }
      return { ok: true, changed: !previous || describeSplit(previous) !== describeSplit(body) };
    } catch (err) {
      lastError = err.message;
      // Deliberately not clearing `table`. See the note at the top of this file: the
      // last good split is the best thing this router has, and discarding it because the
      // control plane is restarting would turn a control-plane blip into an outage.
      logger?.warn?.({ err: err.message, url }, 'could not refresh the routing table');
      return { ok: false, error: err.message };
    }
  }

  /** `v6=90,v7=10` — enough to tell two splits apart in a log line. */
  function describeSplit(document) {
    return (document.targets ?? [])
      .map((t) => `v${t.version}=${t.weight}`)
      .join(',');
  }

  return {
    /** Fetches once, then keeps fetching. Resolves after the first attempt, good or bad. */
    async start() {
      const first = await refresh();
      const tick = async () => {
        if (stopped) return;
        await refresh();
        if (stopped) return;
        timer = setTimeout(tick, refreshMs);
        timer.unref?.();
      };
      timer = setTimeout(tick, refreshMs);
      timer.unref?.();
      return first;
    },

    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },

    /** Test seam and startup path: refresh now rather than waiting for the interval. */
    refresh,

    /** The document as the control plane last gave it, or null if it never has. */
    document() {
      return table;
    },

    /**
     * The targets, as `chooseTarget` wants them.
     *
     * `ready` folds together the two views described at the top: the control plane's
     * observation, and this router's own recent experience. A version is eligible only
     * if both are content, and either can put it back.
     */
    targets() {
      const at = now();
      return (table?.targets ?? []).map((target) => ({
        version: target.version,
        weight: target.weight,
        url: target.url,
        artifact_id: target.artifact_id,
        ready: target.ready !== false && !((cooldowns.get(target.version) ?? 0) > at),
      }));
    },

    /** Records that this router could not reach a version, and stops sending it traffic. */
    markUnreachable(version) {
      cooldowns.set(version, now() + FAILOVER_COOLDOWN_MS);
    },

    /** Records that a version answered, whatever the answer was. */
    markReachable(version) {
      cooldowns.delete(version);
    },

    /**
     * How the router is doing, for `/-/routing` and for the metrics.
     *
     * `age_seconds` is the number that matters and it is why this is not just the
     * document: a table is only as good as its last refresh, and a router that cannot
     * reach the control plane keeps working while this number grows. Reading a split
     * without reading its age is how last week's weights get believed.
     */
    status() {
      return {
        deployment_id: deploymentId,
        deployment: table?.deployment ?? null,
        model: table?.model ?? null,
        loaded: table !== null,
        age_seconds: fetchedAt === null ? null : (now() - fetchedAt) / 1000,
        refreshes,
        last_error: lastError,
        source: url,
      };
    },
  };
}
