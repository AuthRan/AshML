/**
 * The lifecycle of a model version (spec §16), and the one invariant the registry
 * exists to hold: **at most one version of a model is in PRODUCTION at a time.**
 *
 * That rule is what makes "the production model" a question with an answer. Without it
 * the registry is a list of files, and every consumer — the router in Phase 5, the
 * person rolling back at 3am — has to invent its own tie-break.
 *
 * Pure module: no database, no HTTP. The uniqueness itself is enforced by the service,
 * which is the only place that can hold a transaction; what lives here is which moves
 * are legal and which of them displace an incumbent.
 */

export const ModelStatus = Object.freeze({
  /** Registered and pointing at real bytes, but nothing is serving it. */
  CREATED: 'CREATED',
  /** Being evaluated. Several versions may sit here at once. */
  STAGING: 'STAGING',
  /** The one version this model currently means. */
  PRODUCTION: 'PRODUCTION',
  /** Retired. Kept, never deleted: a model that served traffic is part of the record. */
  ARCHIVED: 'ARCHIVED',
});

/**
 * Note PRODUCTION -> STAGING exists, and is not the same as archiving.
 *
 * A rollback promotes the previous version, which displaces this one. Forcing that
 * displaced version straight to ARCHIVED would be wrong: it is usually still a
 * candidate, and the operator rolling back at 3am is not in a position to say whether
 * it should be retired forever.
 */
const TRANSITIONS = Object.freeze({
  [ModelStatus.CREATED]: [ModelStatus.STAGING, ModelStatus.PRODUCTION, ModelStatus.ARCHIVED],
  [ModelStatus.STAGING]: [ModelStatus.PRODUCTION, ModelStatus.CREATED, ModelStatus.ARCHIVED],
  [ModelStatus.PRODUCTION]: [ModelStatus.STAGING, ModelStatus.ARCHIVED],

  // Terminal. Un-archiving would let a version that was retired for a reason come back
  // with no record of why; registering it again as a new version is the honest path.
  [ModelStatus.ARCHIVED]: [],
});

export const ALL_STATUSES = Object.freeze(Object.keys(TRANSITIONS));

/** The status a newly registered version starts in. */
export const INITIAL_STATUS = ModelStatus.CREATED;

export function isValidStatus(status) {
  return Object.hasOwn(TRANSITIONS, status);
}

export function isTerminal(status) {
  return isValidStatus(status) && TRANSITIONS[status].length === 0;
}

export function canTransition(from, to) {
  return isValidStatus(from) && TRANSITIONS[from].includes(to);
}

/**
 * Whether moving a version to `status` must displace whatever holds it now.
 *
 * Only PRODUCTION is exclusive. Any number of versions may sit in STAGING at once —
 * that is what evaluating candidates looks like — and CREATED and ARCHIVED are not
 * claims about what is serving anything.
 */
export function isExclusive(status) {
  return status === ModelStatus.PRODUCTION;
}

/**
 * Where an incumbent goes when it is displaced.
 *
 * STAGING rather than ARCHIVED: see the note on the transition table. The version that
 * was in production a minute ago is the single most likely rollback target.
 */
export const DISPLACED_TO = ModelStatus.STAGING;

export class IllegalModelTransitionError extends Error {
  constructor(from, to) {
    super(
      `model version cannot go ${from} -> ${to}`
      + (isTerminal(from) ? `; ${from} is final` : ''),
    );
    this.name = 'IllegalModelTransitionError';
    this.code = 'ILLEGAL_MODEL_TRANSITION';
    this.statusCode = 409;
    this.from = from;
    this.to = to;
  }
}

/** @throws {IllegalModelTransitionError} if the move is not permitted. */
export function transition(from, to) {
  if (!canTransition(from, to)) {
    throw new IllegalModelTransitionError(from, to);
  }
  return to;
}
