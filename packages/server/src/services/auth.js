/**
 * Authentication and authorization.
 *
 * Two jobs, kept apart on purpose:
 *
 *   - **authenticate** turns a presented bearer token into a principal, or into nothing.
 *     It is the *only* place a principal is constructed, which is what makes
 *     `domain/roles.js` safe to be a pure decision function that trusts its argument.
 *   - **authorize** asks `domain/roles.js` whether that principal may do something, and
 *     throws the right error if not.
 *
 * Neither decides *what* permission an endpoint needs. The route says that, next to the
 * handler, where it can be read against the thing it protects.
 */

import { withTransaction } from '../db/pool.js';
import * as authRepo from '../repos/auth.js';
import * as projectsRepo from '../repos/projects.js';
import { hashToken, kindOf, TokenKind, mintToken } from '../auth/tokens.js';
import {
  Permission, Role, can, userPrincipal, runPrincipal, servingPrincipal, isRole,
} from '../domain/roles.js';
import { ConflictError, NotFoundError, ValidationError, UNIQUE_VIOLATION } from './errors.js';

/** 401: we do not know who is calling. */
export class UnauthenticatedError extends Error {
  constructor(message = 'authentication required') {
    super(message);
    this.name = 'UnauthenticatedError';
    this.code = 'UNAUTHENTICATED';
    this.statusCode = 401;
  }
}

/** 403: we know who is calling, and they may not. */
export class ForbiddenError extends Error {
  constructor(message = 'not permitted') {
    super(message);
    this.name = 'ForbiddenError';
    this.code = 'FORBIDDEN';
    this.statusCode = 403;
  }
}

/**
 * Resolves a bearer token to a principal, or returns null.
 *
 * Null covers every way a token can fail — absent, malformed, unknown, revoked, expired.
 * They are one outcome deliberately: telling a caller that a token is *expired* rather
 * than *unknown* confirms it was once real, which is a fact worth having if you are
 * working through a list.
 *
 * The kind prefix is checked before the database so a run token presented to a user
 * endpoint costs a string comparison rather than a query.
 */
export async function authenticate(pool, token) {
  const kind = kindOf(token);
  if (!kind) return null;

  const hash = hashToken(token);

  if (kind === TokenKind.WORKLOAD) {
    const row = await authRepo.findWorkloadByTokenHash(pool, hash);
    if (!row) return null;
    return row.kind === 'SERVING'
      ? servingPrincipal({ deploymentId: row.deployment_id, projectId: row.project_id })
      : runPrincipal({
        jobId: row.job_id,
        projectId: row.project_id,
        attempt: row.attempt,
        experimentId: row.experiment_id ?? null,
      });
  }

  const row = await authRepo.findUserByTokenHash(pool, hash);
  if (!row) return null;

  // Fire-and-forget: a failure to record usage must never fail the request it describes.
  authRepo.touchToken(pool, row.token_id).catch(() => {});

  return userPrincipal({
    userId: row.user_id,
    email: row.email,
    isAdmin: row.is_admin,
    memberships: new Map(row.memberships.map((m) => [m.project_id, m.role])),
  });
}

/**
 * Throws unless `principal` may do `permission`.
 *
 * A missing principal is 401 and an insufficient one is 403, because they call for
 * different actions: log in, versus ask for access.
 */
export function authorize(principal, permission, scope = {}) {
  if (!principal) throw new UnauthenticatedError();
  if (!can(principal, permission, scope)) {
    throw new ForbiddenError(`this token may not ${permission}`);
  }
}

/**
 * Resolves a project by name and checks a permission against it, in one step.
 *
 * The two belong together. Doing them separately invites the ordering bug where a
 * handler reports "project not found" for a project it simply may not see — and the
 * difference between 403 and 404 is how an outsider enumerates project names.
 *
 * So: a caller without PROJECT_READ is told 404, whether or not the project exists. A
 * caller who may read it but not write it gets a truthful 403.
 */
export async function resolveProject(pool, principal, name, permission) {
  if (!principal) throw new UnauthenticatedError();

  const project = await projectsRepo.getProjectByName(pool, name);
  const notFound = new NotFoundError(`project "${name}" not found`);

  if (!project) throw notFound;
  if (!can(principal, Permission.PROJECT_READ, { projectId: project.id })) throw notFound;

  authorize(principal, permission, { projectId: project.id });
  return project;
}

/** Creates a user API token and returns the plaintext exactly once. */
export async function createToken(pool, userId, { name, expiresAt = null }) {
  const { token, hash, prefix } = mintToken(TokenKind.USER);
  try {
    const row = await withTransaction(pool, (client) =>
      authRepo.createApiToken(client, { userId, name, tokenHash: hash, prefix, expiresAt }));
    // The one and only time the plaintext leaves this process.
    return { ...row, token };
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ConflictError('TOKEN_EXISTS', `you already have a token named "${name}"`);
    }
    throw err;
  }
}

export async function listTokens(pool, userId) {
  return authRepo.listApiTokens(pool, userId);
}

export async function revokeToken(pool, userId, name) {
  const row = await withTransaction(pool, (client) =>
    authRepo.revokeApiToken(client, userId, name));
  if (!row) throw new NotFoundError(`no live token named "${name}"`);
  return row;
}

/**
 * Mints the token a training pod will use to report its own results.
 *
 * Any previous token for the job is revoked in the same transaction. That is what stops
 * a pod that is still shutting down from reporting into the attempt that replaced it —
 * a failure that would not error, it would just quietly write one run's numbers onto
 * another's.
 */
export async function issueRunToken(pool, jobId, attempt, { ttlSeconds = null } = {}) {
  const { token, hash } = mintToken(TokenKind.WORKLOAD);
  const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null;

  const row = await withTransaction(pool, async (client) => {
    await authRepo.revokeRunTokens(client, jobId);
    return authRepo.createRunToken(client, { jobId, attempt, tokenHash: hash, expiresAt });
  });

  return { ...row, token };
}

/**
 * Revokes every live run token for a job, at once.
 *
 * For a retry, where a still-shutting-down pod must be cut off before its replacement
 * starts. A run that merely finished gets `expireRunTokens` instead — see there.
 */
export async function revokeRunTokens(pool, jobId) {
  return withTransaction(pool, (client) => authRepo.revokeRunTokens(client, jobId));
}

/** Gives a finished run's token a short grace window so an in-flight upload can land. */
export async function expireRunTokens(pool, jobId, graceSeconds) {
  return withTransaction(pool, (client) =>
    authRepo.expireRunTokens(client, jobId, graceSeconds));
}

/**
 * Makes sure a deployment has a working credential, minting one only if it does not.
 *
 * The "only if" is the whole point, and it is not an optimisation.
 *
 * A serving token reaches its pods as an environment variable sourced from a Secret
 * (`secretKeyRef`), which is what keeps the pod template byte-identical across applies so
 * that changing a traffic weight does not restart the pods carrying the traffic. But an
 * env var from a Secret is materialised when the *container starts* and is never updated
 * afterwards. So rotating the Secret does not reach a running pod — while revoking the
 * old token immediately breaks the one it is still holding.
 *
 * An earlier version of this function rotated on every apply, and the two properties
 * combined into a silent failure: `ash deployment rollout` rewrote the Secret, restarted
 * nothing, and revoked the router's credential. The router's next poll 401'd,
 * `routing-table.js` kept serving the last good table rather than failing loudly, and the
 * canary never received a single request. The command reported success.
 *
 * So a deployment gets one credential for its lifetime, revoked when it is deleted. There
 * is no plaintext to return when one already exists — only the hash is stored — and none
 * is needed: the Secret in the cluster already holds it.
 *
 * @returns {Promise<{token: string|null, created: boolean}>} `token` only when created,
 *   in which case the caller must write it to the Secret.
 */
export async function ensureServingToken(pool, deploymentId, { ttlSeconds = null } = {}) {
  return withTransaction(pool, async (client) => {
    if (await authRepo.hasLiveServingToken(client, deploymentId)) {
      return { token: null, created: false };
    }

    const { token, hash } = mintToken(TokenKind.WORKLOAD);
    const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null;

    // Clears any expired row, so the partial unique index has room for the new one.
    await authRepo.revokeServingTokens(client, deploymentId);
    await authRepo.createServingToken(client, { deploymentId, tokenHash: hash, expiresAt });
    return { token, created: true };
  });
}

export async function revokeServingTokens(pool, deploymentId) {
  return withTransaction(pool, (client) => authRepo.revokeServingTokens(client, deploymentId));
}

// ---- membership -----------------------------------------------------------------

export async function listMembers(pool, projectId) {
  return authRepo.listMembers(pool, projectId);
}

export async function setMember(pool, projectId, email, role) {
  if (!isRole(role)) {
    throw new ValidationError('INVALID_ROLE', `role must be one of ${Object.keys(Role).join(', ')}`);
  }

  return withTransaction(pool, async (client) => {
    const user = await authRepo.getUserByEmail(client, email);
    if (!user) throw new NotFoundError(`no user with email "${email}"`);

    // Serialises membership changes for this project. Without it the count below is a
    // read that another transaction can invalidate before this one writes: two owners
    // demoting each other at the same moment each see two owners, each proceed, and the
    // project ends with none — the exact state the check exists to prevent, and one
    // nobody inside the project can undo.
    await authRepo.lockProjectMembership(client, projectId);

    // Demoting the last owner would leave a project nobody can administer — including
    // nobody who can add an owner back. Refused here rather than left to a platform
    // administrator to unpick.
    if (role !== Role.OWNER) {
      const current = await authRepo.listMembers(client, projectId);
      const wasOwner = current.some((m) => m.user_id === user.id && m.role === Role.OWNER);
      if (wasOwner && await authRepo.countOwners(client, projectId) === 1) {
        throw new ConflictError('LAST_OWNER', 'a project must keep at least one owner');
      }
    }

    const member = await authRepo.setMember(client, { projectId, userId: user.id, role });
    return { ...member, email: user.email, display_name: user.display_name };
  });
}

export async function removeMember(pool, projectId, email) {
  return withTransaction(pool, async (client) => {
    const user = await authRepo.getUserByEmail(client, email);
    if (!user) throw new NotFoundError(`no user with email "${email}"`);

    await authRepo.lockProjectMembership(client, projectId);

    const members = await authRepo.listMembers(client, projectId);
    const existing = members.find((m) => m.user_id === user.id);
    if (!existing) throw new NotFoundError(`"${email}" is not a member of this project`);

    if (existing.role === Role.OWNER && await authRepo.countOwners(client, projectId) === 1) {
      throw new ConflictError('LAST_OWNER', 'a project must keep at least one owner');
    }

    await authRepo.removeMember(client, { projectId, userId: user.id });
    return { email: user.email };
  });
}

export async function createUser(pool, { email, displayName, isAdmin = false }) {
  try {
    return await withTransaction(pool, (client) =>
      authRepo.createUser(client, { email, displayName, isAdmin }));
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ConflictError('USER_EXISTS', `a user with email "${email}" already exists`);
    }
    throw err;
  }
}

export async function getUserByEmail(pool, email) {
  return authRepo.getUserByEmail(pool, email);
}
