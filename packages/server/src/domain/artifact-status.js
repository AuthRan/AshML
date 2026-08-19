/**
 * The lifecycle of an artifact row, and the rule that keeps "registered" from drifting
 * apart from "exists" (spec §16).
 *
 * A checkpoint is two separate things: bytes somewhere object storage can serve, and a
 * row here saying where they are. They cannot be written atomically — the upload is not
 * in our transaction — so one of them is observable before the other. Registering the
 * row first is the order that loses nothing: a PENDING row whose upload never finishes
 * is a visible dead end, whereas bytes uploaded with no row are unfindable garbage.
 *
 * `status` is what stops the visible dead end from being mistaken for a checkpoint.
 * Nothing may resume from, register, or serve an artifact that is not READY.
 *
 * Pure module: no database, no S3, no HTTP.
 */

export const ArtifactStatus = Object.freeze({
  /** The row exists; the bytes are not yet confirmed at `uri`. */
  PENDING: 'PENDING',
  /** The bytes are confirmed present, and the digest and size are the run's own. */
  READY: 'READY',
  /** The upload was abandoned. The row is kept so the gap is visible, not silent. */
  FAILED: 'FAILED',
});

/**
 * A failed upload is terminal rather than returning to PENDING. Retrying an upload
 * produces a *new* artifact: reusing the row would overwrite the digest of whatever
 * partially landed the first time, and the whole point of the digest is that it
 * describes exactly the bytes at that URI.
 */
const TRANSITIONS = Object.freeze({
  [ArtifactStatus.PENDING]: [ArtifactStatus.READY, ArtifactStatus.FAILED],
  [ArtifactStatus.READY]: [],
  [ArtifactStatus.FAILED]: [],
});

export const ALL_STATUSES = Object.freeze(Object.keys(TRANSITIONS));

export function isValidStatus(status) {
  return Object.hasOwn(TRANSITIONS, status);
}

/** @returns {boolean} whether the artifact's bytes may be relied upon. */
export function isUsable(status) {
  return status === ArtifactStatus.READY;
}

export function canTransition(from, to) {
  return isValidStatus(from) && TRANSITIONS[from].includes(to);
}

/**
 * Raised when a caller confirms or fails an artifact that has already settled.
 *
 * Carries `code` and `statusCode` so the route layer needs no catch — app.js turns any
 * thrown error into the single error envelope of spec §45. 409 rather than 400: the
 * request is well-formed and would have succeeded earlier.
 */
export class IllegalArtifactTransitionError extends Error {
  constructor(from, to) {
    super(
      `artifact cannot go ${from} -> ${to}`
      + (isValidStatus(from) && TRANSITIONS[from].length === 0
        ? `; ${from} is final`
        : ''),
    );
    this.name = 'IllegalArtifactTransitionError';
    this.code = 'ILLEGAL_ARTIFACT_TRANSITION';
    this.statusCode = 409;
    this.from = from;
    this.to = to;
  }
}

/** @throws {IllegalArtifactTransitionError} if the transition is not permitted. */
export function transition(from, to) {
  if (!canTransition(from, to)) {
    throw new IllegalArtifactTransitionError(from, to);
  }
  return to;
}
