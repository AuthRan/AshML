/**
 * The request-level half of authentication: who is calling, and may they.
 *
 * **Default deny.** The hook below runs on every request, and a route that has not said
 * it is public needs a principal. That direction is the whole point: the alternative,
 * where a route is open until somebody remembers to protect it, fails silently and in
 * the dangerous direction every time a route is added. Here, forgetting produces a 401
 * on the new endpoint — visible immediately, and never a leak.
 *
 * Authentication (who) is global. Authorization (what) is not, and cannot be: only the
 * handler knows which project a request is about. Routes state that next to the thing
 * they protect, with `app.requireProject` or `app.requirePermission`.
 */

import { parseBearer } from './tokens.js';
import {
  authenticate, authorize, resolveProject, UnauthenticatedError, ForbiddenError,
} from '../services/auth.js';
import { NotFoundError } from '../services/errors.js';
import { describeDenial } from '../services/audit.js';
import { Permission, PrincipalKind, userPrincipal, can } from '../domain/roles.js';
import * as authRepo from '../repos/auth.js';

/** The seeded local user (migration 1755000100000), used only when auth is disabled. */
const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Routes that answer before anyone is known.
 *
 * Kept to the smallest set that has to work without credentials, and each one is here for
 * a stated reason rather than for convenience:
 *
 *   - `/healthz`, `/readyz` — Kubernetes probes. A probe that needs a token is a pod that
 *     fails to start when the token is wrong, which turns an auth misconfiguration into
 *     an outage of the thing that would have told you about it.
 *   - `/metrics` — scraped by Prometheus, and protected by not being routable from
 *     outside the cluster. Stated in the roadmap rather than pretended otherwise.
 *   - `/docs`, `/docs/*` — the OpenAPI page. It describes the shape of the API, which is
 *     public information; it grants nothing.
 *   - `/` — the dashboard HTML. The *page* is public, the data it fetches is not: it
 *     holds no state of its own and every API call it makes carries the viewer's token.
 */
const PUBLIC_PATHS = new Set(['/healthz', '/readyz', '/metrics', '/', '/docs']);

function isPublic(request) {
  // A route's own declaration wins, so that an endpoint's openness is visible next to
  // the endpoint rather than only in the list above.
  if (request.routeOptions?.config?.public) return true;

  const url = request.routeOptions?.url;
  // No matched route: a path that exists nowhere. Treated as non-public, so an
  // unauthenticated caller gets 401 rather than 404 — which is deliberate, because a 404
  // here would let anyone map the API surface by probing. An authenticated caller who
  // simply typed the path wrong still gets the 404 they need.
  if (!url) return false;
  if (PUBLIC_PATHS.has(url)) return true;
  return url.startsWith('/docs/');
}

/**
 * Installs authentication on the root instance.
 *
 * Called directly rather than through `app.register`, and so without `fastify-plugin`.
 * A Fastify plugin gets its own encapsulation context, so decorators added inside one are
 * invisible to sibling plugins — which is exactly what the routes are. `fastify-plugin`
 * exists to opt out of that, and pulling in a dependency to undo behaviour we can simply
 * not invoke would not survive spec §44. Decorating the root before the route plugins are
 * registered gives them the decorators by inheritance, which is what we want anyway.
 *
 * @param {import('fastify').FastifyInstance} app the root instance
 * @param {object} options
 * @param {boolean} options.enabled false acts as the seeded local administrator
 */
export async function installAuth(app, { enabled = true } = {}) {
  /**
   * The principal used when authentication is switched off.
   *
   * Built once, at startup, and built as a *real* principal from the seeded local
   * administrator rather than as a bypass flag threaded through the checks. Every
   * authorization check below therefore runs exactly as it does in production — the only
   * difference is that everyone is the same administrator. A bypass that skipped the
   * checks would mean this mode exercised a different code path from the one that ships,
   * and the end-to-end scripts that run in it would stop being evidence about it.
   *
   * No memberships and no database query. `can` short-circuits on `isAdmin` before it
   * ever looks at the map, so loading it would be work whose result is never read — and
   * it would make building an app require a reachable database, which several unit tests
   * deliberately do not have.
   */
  const localPrincipal = enabled ? null : userPrincipal({
    userId: LOCAL_USER_ID,
    email: 'local@ashml.dev',
    isAdmin: true,
  });

  if (!enabled) {
    app.log.warn(
      'ASHML_AUTH_ENABLED=false: every request acts as the seeded local administrator. '
      + 'This is for local development and the k3d end-to-end scripts. Do not run a '
      + 'reachable control plane this way.',
    );
  }

  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (request, reply) => {
    if (isPublic(request)) return;

    if (!enabled) {
      request.principal = localPrincipal;
      return;
    }

    const token = parseBearer(request.headers.authorization);
    const principal = token ? await authenticate(app.db, token) : null;

    if (!principal) {
      // Counted, not audited. There is no principal to name and no ceiling on how many a
      // stranger can produce, so a row per 401 would be an INSERT-per-packet amplifier —
      // the failure `auth/rate-limit.js` exists to prevent, handed back through its own
      // audit trail. The reason label separates "sent nothing" from "sent something
      // wrong", which is the only distinction a rate can usefully carry.
      app.metrics?.authFailures?.inc({ reason: token ? 'invalid_token' : 'no_token' });

      // WWW-Authenticate is what tells a generic HTTP client that this is a credentials
      // problem it could fix, rather than a 401 the server made up.
      reply.header('WWW-Authenticate', 'Bearer realm="ashml"');
      throw new UnauthenticatedError(
        token ? 'this token is not valid' : 'authentication required: send a bearer token',
      );
    }

    // eslint-disable-next-line require-atomic-updates -- as above: `request` belongs to this invocation alone.
    request.principal = principal;
  });

  /**
   * Every `/api/v1` route must say what it takes to call it.
   *
   * Checked when the route is registered, so a route that says nothing is a server that
   * does not start — not an endpoint that quietly answers to anybody. This is the same
   * default-deny idea as the hook above, moved to the one moment where the mistake is
   * cheap to fix: `npm start` fails with the path in the message.
   *
   * Four ways to satisfy it, in descending order of how much the declaration tells you:
   *
   *   - `permission` — the declarative one, handled entirely by the preHandler below.
   *   - `authorization: 'handler'` — the escape hatch for routes whose project is not in
   *     the URL. Anything addressed by an opaque id has to load the entity before there
   *     is a project to check against, so the handler does it, and this is the promise
   *     that it does.
   *   - `authenticatedOnly` — any principal will do, and there is nothing further to
   *     check. Written out rather than left as a bare `permission`-less route so that
   *     "no permission needed" is a decision somebody made, not one they forgot.
   *   - `public` — answers before anyone is known. Also exempts the route from the
   *     authentication hook, so this is the only declaration that opens anything.
   */
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/v1/')) return;
    const config = route.config ?? {};
    if (config.permission
      || config.authorization === 'handler'
      || config.authenticatedOnly
      || config.public) return;
    throw new Error(
      `route ${route.method} ${route.url} declares no authorization. Add `
      + "`config: { permission: Permission.X }` to its options, or "
      + "`config: { authorization: 'handler' }` if the handler resolves the project "
      + 'itself from an id. See auth/install.js.',
    );
  });

  app.decorateRequest('project', null);

  /**
   * Applies whatever the route declared.
   *
   * A `:name` parameter is a project name by convention throughout this API, so a route
   * that declares a permission and has one is resolved and checked here, and the handler
   * gets the project on `request.project` rather than fetching it a second time.
   */
  app.addHook('preHandler', async (request) => {
    const permission = request.routeOptions?.config?.permission;
    if (!permission) return;

    const projectName = request.params?.name;
    if (projectName === undefined) {
      authorize(request.principal, permission);
      return;
    }
    const project = await resolveProject(app.db, request.principal, projectName, permission);
    // eslint-disable-next-line require-atomic-updates -- as above.
    request.project = project;
  });

  /**
   * The membership filter for a list endpoint: null for "everything", a user id
   * otherwise.
   *
   * This exists because the obvious inline version is wrong in a way that does not look
   * wrong. `request.principal.isAdmin ? null : request.principal.userId` reads correctly
   * for a person and silently opens the endpoint for a workload: a run principal has
   * neither field, so `isAdmin` is undefined, `userId` is undefined, and a repo that
   * treats an absent filter as "no filter" then returns every row in the platform. That
   * is not a hypothetical — it is what `GET /api/v1/projects` did until the run-token
   * test in `auth.integration.test.js` caught it.
   *
   * So the workload case is refused outright rather than filtered. A training pod has no
   * reason to enumerate anything, and there is no correct value to pass.
   */
  app.decorate('listScope', (request) => {
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();
    if (principal.kind !== PrincipalKind.USER) {
      // Audited like any other refusal. PROJECT_READ is the honest name for what a list
      // endpoint is: enumerating a project's contents is reading it, and a workload that
      // tried is worth a row whether it was a bug in an image or something worse.
      throw describeDenial(
        new ForbiddenError('a workload token may not list resources'),
        { permission: Permission.PROJECT_READ },
      );
    }
    return principal.isAdmin ? null : principal.userId;
  });

  /** Throws unless the caller holds `permission`. For permissions with no project. */
  app.decorate('requirePermission', (request, permission, scope = {}) => {
    authorize(request.principal, permission, scope);
  });

  /**
   * Resolves `:name` to a project the caller may see, and checks `permission` on it.
   *
   * Returns the project so the handler does not fetch it twice.
   */
  app.decorate('requireProject', async (request, name, permission) =>
    resolveProject(app.db, request.principal, name, permission));

  /** Convenience for the common read case. */
  app.decorate('readableProject', async (request, name) =>
    resolveProject(app.db, request.principal, name, Permission.PROJECT_READ));

  /**
   * Authorization for a route addressed by an opaque id.
   *
   * The entity is located, its project resolved, and the permission checked against that
   * — the same three steps `requireProject` does, with a lookup in front. An id that
   * matches nothing and an id the caller may not see produce the same NotFoundError, so
   * that ids cannot be probed for existence.
   *
   * @returns {Promise<{projectId: string, jobId: string|null, experimentId: string|null}>}
   */
  function requireEntity(lookup, noun) {
    return async (request, id, permission) => {
      if (!request.principal) throw new UnauthenticatedError();

      const scope = await lookup(app.db, id);
      const notFound = new NotFoundError(`${noun} "${id}" not found`);
      if (!scope) throw notFound;

      // Read first, so that a caller with no access to the project is told 404 rather
      // than 403 — which would confirm the id names something real. A workload token has
      // no project read, so the second clause is what lets a run past this gate to be
      // judged on the permission it actually holds.
      if (!can(request.principal, Permission.PROJECT_READ, scope)
        && !can(request.principal, permission, scope)) {
        // Another refusal that answers 404, and so another one the audit trail can only
        // learn about here. `permission` rather than PROJECT_READ, because that is what
        // the caller was reaching for; the 404 they receive is recorded beside it.
        throw describeDenial(notFound, { permission, projectId: scope.projectId ?? null });
      }

      authorize(request.principal, permission, scope);
      return scope;
    };
  }

  app.decorate('requireJob', requireEntity(authRepo.scopeOfJob, 'job'));
  app.decorate('requireExperiment', requireEntity(authRepo.scopeOfExperiment, 'experiment'));
  app.decorate('requireArtifact', requireEntity(authRepo.scopeOfArtifact, 'artifact'));
  app.decorate('requireDeployment', requireEntity(authRepo.scopeOfDeployment, 'deployment'));
}
