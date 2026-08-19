/**
 * Job lifecycle states and the rules governing movement between them (spec §9).
 *
 * This module is pure: no database, no Kubernetes, no HTTP. Everything here is
 * synchronous and exhaustively unit-tested, because both the scheduler and the
 * Kubernetes status-sync loop drive transitions, and this transition table is the
 * only thing keeping two writers from corrupting job state.
 */

export const JobState = Object.freeze({
  CREATED: 'CREATED',
  QUEUED: 'QUEUED',
  SCHEDULING: 'SCHEDULING',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING',
  CANCELLING: 'CANCELLING',
  CANCELLED: 'CANCELLED',
});

/**
 * The complete set of legal transitions. Anything absent is rejected.
 *
 * Note FAILED is not terminal — the retry path FAILED -> RETRYING -> QUEUED
 * depends on it. Only SUCCEEDED and CANCELLED admit no outgoing edges.
 */
const TRANSITIONS = Object.freeze({
  [JobState.CREATED]: [JobState.QUEUED, JobState.CANCELLED],
  [JobState.QUEUED]: [JobState.SCHEDULING, JobState.CANCELLING, JobState.FAILED],
  [JobState.SCHEDULING]: [JobState.STARTING, JobState.QUEUED, JobState.CANCELLING, JobState.FAILED],
  [JobState.STARTING]: [JobState.RUNNING, JobState.FAILED, JobState.CANCELLING],
  [JobState.RUNNING]: [JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLING],
  [JobState.FAILED]: [JobState.RETRYING],
  [JobState.RETRYING]: [JobState.QUEUED, JobState.FAILED],
  [JobState.CANCELLING]: [JobState.CANCELLED],

  // Terminal.
  [JobState.SUCCEEDED]: [],
  [JobState.CANCELLED]: [],
});

/** All states this platform knows about. */
export const ALL_STATES = Object.freeze(Object.keys(TRANSITIONS));

/** @returns {boolean} whether `state` is a state this platform knows about. */
export function isValidState(state) {
  return Object.hasOwn(TRANSITIONS, state);
}

/**
 * States in which no workload has been launched yet, so nothing can have run and
 * nothing can have been produced.
 *
 * Used to refuse metrics and artifacts reported against a job that has not started.
 * The rule is deliberately negative — "provably not launched" rather than "definitely
 * running" — because a run legitimately reports *after* it finishes: a training loop
 * that buffers its metrics flushes them at the end, and the final checkpoint is
 * confirmed once the upload completes, which may be after the pod is gone.
 */
const NOT_YET_LAUNCHED = Object.freeze([JobState.CREATED, JobState.QUEUED, JobState.SCHEDULING]);

/** @returns {boolean} whether a workload has been launched for this job. */
export function hasLaunched(state) {
  return isValidState(state) && !NOT_YET_LAUNCHED.includes(state);
}

/** @returns {boolean} whether `state` admits no further transitions. */
export function isTerminal(state) {
  return isValidState(state) && TRANSITIONS[state].length === 0;
}

/** @returns {string[]} the states reachable from `state`. */
export function nextStates(state) {
  return isValidState(state) ? [...TRANSITIONS[state]] : [];
}

/** @returns {boolean} whether `from -> to` is a legal transition. */
export function canTransition(from, to) {
  return isValidState(from) && TRANSITIONS[from].includes(to);
}

/**
 * Raised when a caller attempts an illegal state change. Carries the attempted
 * transition so the API can return a useful error body (spec §45).
 */
export class IllegalTransitionError extends Error {
  constructor(from, to, reason) {
    super(reason ?? `illegal job transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.code = 'ILLEGAL_JOB_TRANSITION';
    this.from = from;
    this.to = to;
  }
}

/**
 * Returns `to` if the transition is legal, otherwise throws IllegalTransitionError.
 *
 * Callers must persist both the new state and a corresponding row in `job_events`
 * in the same transaction — state changes are never silent (spec §47).
 *
 * @param {string} from current state
 * @param {string} to desired state
 * @returns {string} the new state
 */
export function transition(from, to) {
  if (!isValidState(from)) {
    throw new IllegalTransitionError(from, to, `unknown job state "${from}"`);
  }
  if (!isValidState(to)) {
    throw new IllegalTransitionError(from, to, `unknown target job state "${to}"`);
  }
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
  return to;
}
