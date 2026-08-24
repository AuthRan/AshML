/**
 * How often a caller may call, and who "a caller" is.
 *
 * It lives next to authentication because both questions are answered from the same
 * thing — the credential presented — and because the tighter of the two limits exists
 * specifically to protect the token lookup. A bearer token is checked by hashing it and
 * asking PostgreSQL; without a limit in front, an anonymous client can make the control
 * plane run a query per packet, which is a database outage caused by requests that were
 * all going to be refused anyway.
 *
 * ## Two limits, because there are two kinds of caller
 *
 * - **identified** — a request that authenticated. Keyed by *who*, not by which token:
 *   a person with five tokens gets one budget, not five. Generous, because the clients
 *   are the CLI, the dashboard, the router and the training SDK, and none of them should
 *   ever meet it. It is a backstop against a loop, not a throttle.
 * - **anonymous** — a request with no valid credential, keyed by source address. This is
 *   the one with a reason to exist, and also the one whose number needed the most care.
 *   It cannot be tight: every pod in a k3d cluster reaches the control plane from a
 *   single address, so this budget is shared by everything behind a NAT or an ingress,
 *   and a limit low enough to catch "a few 401s is a misconfiguration" would let one
 *   misconfigured workload lock out every healthy pod beside it — which is exactly the
 *   Phase 10 upgrade failure the README warns about, made contagious. So it is set where
 *   it bounds the damage instead: ten a second is above any real failure loop and three
 *   orders of magnitude below a flood, and it caps how fast anyone can make this server
 *   query PostgreSQL without a credential.
 *
 * ## Where each one runs, and why it has to be there
 *
 *   1. `onRequest`, *before* the authentication hook — the anonymous budget is **peeked**
 *      at. Exhausted means 429 before a hash is computed or a connection is taken from
 *      the pool. This is the hook whose position is load-bearing: installed after
 *      authentication it would still refuse the caller, having already done the work that
 *      the refusal was supposed to prevent.
 *   2. `preParsing`, after authentication has run — the identified budget is **charged**.
 *      Late enough that the principal exists, early enough that a refused request never
 *      has its body read.
 *   3. `onSend`, on a 401 — the anonymous budget is **charged**. A failed credential is
 *      only known to have failed once authentication has said so, and charging on the way
 *      out is what keeps step 1 a cheap read.
 *
 * Refused requests are not charged (see `RateLimiter.take`), so the block clears on its
 * own even for a client that keeps knocking.
 *
 * ## What is exempt, and what that costs
 *
 * The probe and scrape endpoints. A throttled `/healthz` is a pod Kubernetes restarts,
 * and a throttled `/metrics` blinds the monitoring at the exact moment it is describing
 * an overload — in both cases the limiter would convert a load problem into an outage.
 * The cost is that those three paths can be hammered for free; they hold no state, take
 * no token, and `/metrics` is not routable from outside the cluster.
 *
 * ## What an address means here
 *
 * The socket's, not `X-Forwarded-For`, unless `ASHML_TRUST_PROXY` says a proxy in front
 * rewrites that header on every request. Trusting it without one lets any caller choose
 * their own bucket, which is worse than having no limit because it looks like one. Not
 * trusting it *behind* a proxy puts every anonymous caller in the proxy's single bucket,
 * which is why the setting exists rather than the behaviour being fixed either way.
 */

import { RateLimiter } from '../domain/rate-limit.js';
import { PrincipalKind } from '../domain/roles.js';
import { RateLimitedError } from '../services/errors.js';

/**
 * Paths that are never rate limited.
 *
 * Deliberately not the same list as `PUBLIC_PATHS` in `install.js`, and the difference is
 * the point: `/` and `/docs` are public but are still limited, because they are pages a
 * stranger can ask for repeatedly and neither is needed to keep the pod alive.
 */
const EXEMPT_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * The key an identified caller is counted against.
 *
 * By identity rather than by credential, so that minting another token does not mint
 * another budget. A run is keyed by its job and not by its attempt: a retry is the same
 * work continuing, and a bucket that refills over the minutes between attempts has
 * nothing to gain from resetting.
 */
function principalKey(principal) {
  switch (principal?.kind) {
    case PrincipalKind.USER: return `user:${principal.userId}`;
    case PrincipalKind.RUN: return `run:${principal.jobId}`;
    case PrincipalKind.SERVING: return `serving:${principal.deploymentId}`;
    // No principal: a public page, counted with the anonymous callers it is serving.
    default: return null;
  }
}

/** Writes the IETF `RateLimit-*` fields, which is how a client learns its budget. */
function applyHeaders(reply, decision) {
  reply.header('RateLimit-Limit', String(decision.limit));
  reply.header('RateLimit-Remaining', String(decision.remaining));
  reply.header('RateLimit-Reset', String(decision.resetSeconds));
}

function refuse(reply, decision, scope, metrics) {
  applyHeaders(reply, decision);
  reply.header('Retry-After', String(decision.retryAfterSeconds));
  metrics?.rateLimited?.inc({ scope });
  return new RateLimitedError(
    `rate limit exceeded: ${decision.limit} requests per minute for this ${
      scope === 'anonymous' ? 'address' : 'caller'
    }. Retry in ${decision.retryAfterSeconds}s.`,
  );
}

/**
 * Installs the two limiters on the root instance.
 *
 * Must be called **before** `installAuth`, so that hook 1 above is registered ahead of
 * the authentication hook — Fastify runs same-stage hooks in registration order, so this
 * ordering is the only thing that makes the anonymous limit cheaper than the attack it
 * prevents. Called directly rather than through `app.register`, for the same encapsulation
 * reason `installAuth` is (see its header).
 *
 * @param {import('fastify').FastifyInstance} app the root instance
 * @param {object} options from `config.rateLimit`
 * @param {boolean} [options.enabled]
 * @param {number} [options.identifiedPerMinute]
 * @param {number} [options.anonymousPerMinute]
 * @param {number} [options.maxKeys]
 * @returns {{identified: RateLimiter, anonymous: RateLimiter}|null} null when disabled
 */
export function installRateLimit(app, {
  enabled = true,
  identifiedPerMinute = 1200,
  anonymousPerMinute = 600,
  maxKeys = 10_000,
} = {}) {
  if (!enabled) {
    app.log.warn(
      'ASHML_RATE_LIMIT_ENABLED=false: a valid token may make unlimited requests, and '
      + 'an invalid one may be presented unlimited times.',
    );
    return null;
  }

  const windowMs = 60_000;
  const identified = new RateLimiter({ limit: identifiedPerMinute, windowMs, maxKeys });
  const anonymous = new RateLimiter({ limit: anonymousPerMinute, windowMs, maxKeys });

  app.decorate('rateLimiters', { identified, anonymous });

  // Read off the live maps when Prometheus asks, rather than copied onto the gauge by
  // the sweep — the sweep runs once a window, and a saturated limiter is something you
  // want to see now.
  const keys = app.metrics?.rateLimitKeys;
  if (keys) {
    keys.collect = () => {
      keys.set({ scope: 'identified' }, identified.size);
      keys.set({ scope: 'anonymous' }, anonymous.size);
    };
  }

  function exempt(request) {
    const url = request.routeOptions?.url;
    // An unmatched path has no route and is *not* exempt: probing for endpoints is one
    // of the things the anonymous limit is here to make expensive.
    return url !== undefined && EXEMPT_PATHS.has(url);
  }

  // 1. Before authentication: is this address already out of budget?
  app.addHook('onRequest', async (request, reply) => {
    if (exempt(request)) return;
    const decision = anonymous.peek(`ip:${request.ip}`, Date.now());
    if (!decision.allowed) throw refuse(reply, decision, 'anonymous', app.metrics);
  });

  // 2. After it: charge whoever turned out to be calling.
  app.addHook('preParsing', async (request, reply) => {
    if (exempt(request)) return;

    const key = principalKey(request.principal);
    const [limiter, scope] = key === null
      ? [anonymous, 'anonymous']
      : [identified, 'identified'];

    const decision = limiter.take(key ?? `ip:${request.ip}`, Date.now());
    if (!decision.allowed) throw refuse(reply, decision, scope, app.metrics);
    applyHeaders(reply, decision);
  });

  // 3. On the way out: a credential that failed costs the address that presented it.
  //
  // `onSend` rather than `onResponse`, which is the more obvious place for something
  // that happens after a request. `onResponse` fires from the response's own `finish`
  // event, so whether it has run by the time the *next* request arrives is a race — a
  // client making requests back to back could outrun its own charges. `onSend` is part
  // of the request, so a 401 is always paid for before the caller learns it happened.
  app.addHook('onSend', async (request, reply) => {
    if (reply.statusCode !== 401 || exempt(request)) return;
    anonymous.take(`ip:${request.ip}`, Date.now());
  });

  // Routine cleanup. A bucket that has refilled is worth exactly as much as no bucket at
  // all, so one pass per window keeps the maps proportional to *active* callers rather
  // than to everyone who has ever called. `unref` so this never holds the process open.
  const sweeper = setInterval(() => {
    const now = Date.now();
    identified.sweep(now);
    anonymous.sweep(now);
  }, windowMs);
  sweeper.unref();
  app.addHook('onClose', async () => { clearInterval(sweeper); });

  return { identified, anonymous };
}
