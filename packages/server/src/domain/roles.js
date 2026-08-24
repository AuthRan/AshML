/**
 * Roles, permissions, and what each principal is allowed to do.
 *
 * This module is pure. No database, no request, no clock — given a principal and a
 * permission it always returns the same answer. That is the same rule `placement.js`
 * follows and it is here for a stronger reason: an authorization bug is not visible in
 * the output of a working system. A wrong placement shows up as a job on the wrong node;
 * a wrong grant shows up as nothing at all, until it matters. The only way to know this
 * is right is to be able to enumerate it in a test, so nothing in here may reach for I/O.
 *
 * The route layer never compares roles itself. It names a permission, and this decides.
 */

/** Project roles, weakest first. The order is the ladder — see `atLeast`. */
export const Role = Object.freeze({
  VIEWER: 'VIEWER',
  EDITOR: 'EDITOR',
  OWNER: 'OWNER',
});

const RANK = Object.freeze({ VIEWER: 1, EDITOR: 2, OWNER: 3 });

/**
 * What a caller may be trying to do.
 *
 * Grouped by what they protect rather than by endpoint, because endpoints move and
 * several of them share one question. `PROJECT_WRITE` covers submitting a job,
 * registering a model and creating a deployment: all three spend the project's quota and
 * change what it is running, and a role that may do one may do all three.
 */
export const Permission = Object.freeze({
  /** See a project and everything inside it. */
  PROJECT_READ: 'PROJECT_READ',
  /** Change what a project contains or is running. */
  PROJECT_WRITE: 'PROJECT_WRITE',
  /** Manage the project itself: its members, and deleting it. */
  PROJECT_ADMIN: 'PROJECT_ADMIN',
  /**
   * Grant or change capacity, and read cluster-wide inventory.
   *
   * Never held by a project role, only by a platform administrator. A project owner who
   * could raise their own quota would make quotas advisory, and spec §31's rule against
   * "arbitrary users submitting unrestricted Kubernetes resources" is exactly this.
   */
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  /** Report metrics and upload artifacts for one job. Held only by a run token. */
  RUN_REPORT: 'RUN_REPORT',
  /**
   * Download an artifact's bytes.
   *
   * Separate from PROJECT_READ because the set of principals that need it is different
   * and wider. Three of them do, for three unrelated reasons: a person browsing the
   * project; a *training* pod, which downloads the checkpoint it is resuming from
   * (`make chaos-resume-resnet` is exactly this); and a *serving* pod, which exchanges an
   * artifact id for its own weights at startup. Folding this into PROJECT_READ would mean
   * granting both pod kinds the right to enumerate the project they run in, to obtain the
   * one read they actually need.
   */
  ARTIFACT_FETCH: 'ARTIFACT_FETCH',
  /**
   * Read a deployment's routing table — which versions are up, and at what weights.
   *
   * The router polls this to decide where to send each request, so a serving workload
   * needs it for its own deployment and for nothing else. It is separate from
   * PROJECT_READ for the same reason ARTIFACT_FETCH is: the router should not be able to
   * enumerate the project in order to learn the one table it is there to follow.
   */
  ROUTING_READ: 'ROUTING_READ',
});

/** The lowest project role that carries each permission. Absent means no role does. */
const REQUIRED_ROLE = Object.freeze({
  [Permission.PROJECT_READ]: Role.VIEWER,
  [Permission.PROJECT_WRITE]: Role.EDITOR,
  [Permission.PROJECT_ADMIN]: Role.OWNER,
  // Anyone who may see the project may fetch its artifacts and read its routing.
  [Permission.ARTIFACT_FETCH]: Role.VIEWER,
  [Permission.ROUTING_READ]: Role.VIEWER,
});

export function isRole(value) {
  return Object.hasOwn(RANK, value);
}

/** Does `role` sit at or above `minimum` on the ladder? */
export function atLeast(role, minimum) {
  if (!isRole(role) || !isRole(minimum)) return false;
  return RANK[role] >= RANK[minimum];
}

/**
 * The two kinds of caller.
 *
 * They are distinguished by construction rather than by inspecting fields, so that no
 * check can accidentally treat a run token as a user by finding a `user` property on it.
 */
export const PrincipalKind = Object.freeze({
  USER: 'USER',
  RUN: 'RUN',
  SERVING: 'SERVING',
});

/**
 * A person, authenticated by an API token.
 *
 * `memberships` is a map of project id -> role, resolved at authentication time. It is
 * passed in rather than looked up here because this module does no I/O; the service
 * layer fetches it once per request and hands it over.
 */
export function userPrincipal({ userId, email, isAdmin = false, memberships = new Map() }) {
  return Object.freeze({
    kind: PrincipalKind.USER,
    userId,
    email,
    isAdmin,
    memberships,
  });
}

/** One attempt of one job, authenticated by the run token injected into its pod. */
export function runPrincipal({ jobId, projectId, attempt, experimentId = null }) {
  return Object.freeze({
    kind: PrincipalKind.RUN,
    jobId,
    projectId,
    attempt,
    // The experiment the job belongs to, if any. Carried because reproducibility capture
    // is addressed by experiment id, not job id, and it is still the run reporting.
    experimentId,
  });
}

/**
 * One deployment, authenticated by the token injected into its model-server pods.
 *
 * It writes nothing. Its entire reason to exist is that the inference image is handed an
 * artifact *id* rather than a URL — deliberately, so that a restart six hours later does
 * not crash-loop on an expired presigned signature — and exchanging that id for bytes is
 * a call to the control plane that now has to be authenticated like any other.
 */
export function servingPrincipal({ deploymentId, projectId }) {
  return Object.freeze({
    kind: PrincipalKind.SERVING,
    deploymentId,
    projectId,
  });
}

/** The role a principal holds in a project, or null. */
export function roleIn(principal, projectId) {
  if (principal?.kind !== PrincipalKind.USER) return null;
  return principal.memberships.get(projectId) ?? null;
}

/**
 * May this principal do `permission`, in `projectId` where the permission is scoped to
 * one?
 *
 * The three rules, in the order they are applied:
 *
 *   1. A **run token** may do exactly one thing — report for its own job — and it is the
 *      only principal that may. It gets no read access to the project it belongs to: a
 *      training pod has no reason to enumerate its neighbours, and the blast radius of a
 *      token that leaves the cluster in a log line should be one job's metrics.
 *   2. A **platform administrator** may do anything. Stated once, here, rather than as an
 *      `|| isAdmin` at each call site where it would eventually be forgotten.
 *   3. Otherwise the project role decides, and no role carries PLATFORM_ADMIN.
 *
 * @param {object} principal from `userPrincipal` or `runPrincipal`
 * @param {string} permission one of Permission
 * @param {object} [scope]
 * @param {string} [scope.projectId] required for the project-scoped permissions
 * @param {string} [scope.jobId] identifies the run for RUN_REPORT
 * @param {string} [scope.experimentId] the other way RUN_REPORT can be addressed
 * @param {string} [scope.deploymentId] required for ROUTING_READ
 */
export function can(
  principal,
  permission,
  { projectId = null, jobId = null, experimentId = null, deploymentId = null } = {},
) {
  if (!principal) return false;

  if (principal.kind === PrincipalKind.RUN) {
    // Rule 1. Note this ignores `isAdmin` and memberships entirely — a run principal has
    // neither, and asking about them would imply it could.
    if (permission === Permission.RUN_REPORT) {
      // Addressed either way: `POST /jobs/:id/metrics` names the job, while
      // `POST /experiments/:id/report` names the experiment the job is part of. Both are
      // the same run describing itself; neither lets it describe anybody else.
      if (jobId !== null) return principal.jobId === jobId;
      if (experimentId !== null) {
        return principal.experimentId !== null && principal.experimentId === experimentId;
      }
      return false;
    }
    // A training pod resuming from a checkpoint reads within its own project, and
    // nowhere else.
    if (permission === Permission.ARTIFACT_FETCH) {
      return projectId !== null && principal.projectId === projectId;
    }
    return false;
  }

  if (principal.kind === PrincipalKind.SERVING) {
    // A serving workload reads two things and writes nothing: its own weights, and the
    // routing table of the deployment it belongs to.
    if (permission === Permission.ARTIFACT_FETCH) {
      return projectId !== null && principal.projectId === projectId;
    }
    if (permission === Permission.ROUTING_READ) {
      return deploymentId !== null && principal.deploymentId === deploymentId;
    }
    return false;
  }

  if (principal.kind !== PrincipalKind.USER) return false;

  // A user is never a workload. Spelled out because RUN_REPORT falling through to the
  // role ladder below would otherwise grant it to every EDITOR by omission.
  if (permission === Permission.RUN_REPORT) return false;

  if (principal.isAdmin) return true; // Rule 2.

  if (permission === Permission.PLATFORM_ADMIN) return false; // Rule 3, the exception.

  // `Object.hasOwn`, not a truthiness check on the lookup: `REQUIRED_ROLE['constructor']`
  // and `['toString']` are inherited and truthy, so a plain `if (!required)` would wave
  // them past the guard. They are denied further down by `isRole`, but by accident of a
  // later check rather than by this one — and this is the check that is supposed to mean
  // "an unknown permission is denied, not ignored".
  if (!Object.hasOwn(REQUIRED_ROLE, permission)) return false;
  const required = REQUIRED_ROLE[permission];

  if (projectId === null) return false;
  return atLeast(roleIn(principal, projectId), required);
}
