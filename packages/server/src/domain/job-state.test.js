import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  JobState,
  ALL_STATES,
  isValidState,
  isTerminal,
  nextStates,
  canTransition,
  transition,
  IllegalTransitionError,
} from './job-state.js';

describe('job state machine', () => {
  test('happy path CREATED -> SUCCEEDED', () => {
    const path = [
      JobState.CREATED,
      JobState.QUEUED,
      JobState.SCHEDULING,
      JobState.STARTING,
      JobState.RUNNING,
      JobState.SUCCEEDED,
    ];
    let current = path[0];
    for (const next of path.slice(1)) {
      current = transition(current, next);
    }
    assert.equal(current, JobState.SUCCEEDED);
  });

  test('retry path RUNNING -> FAILED -> RETRYING -> QUEUED (spec §9)', () => {
    let s = transition(JobState.RUNNING, JobState.FAILED);
    s = transition(s, JobState.RETRYING);
    s = transition(s, JobState.QUEUED);
    assert.equal(s, JobState.QUEUED);
  });

  test('cancellation path', () => {
    assert.equal(transition(JobState.RUNNING, JobState.CANCELLING), JobState.CANCELLING);
    assert.equal(transition(JobState.CANCELLING, JobState.CANCELLED), JobState.CANCELLED);
  });

  test('rejects illegal transitions', () => {
    const illegal = [
      [JobState.CREATED, JobState.RUNNING], // must queue and schedule first
      [JobState.SUCCEEDED, JobState.QUEUED], // terminal
      [JobState.CANCELLED, JobState.QUEUED], // terminal
      [JobState.QUEUED, JobState.RUNNING], // must pass through SCHEDULING/STARTING
      [JobState.RUNNING, JobState.QUEUED], // no direct requeue; go via FAILED/RETRYING
      [JobState.CANCELLING, JobState.RUNNING], // cancellation is one-way
    ];
    for (const [from, to] of illegal) {
      assert.throws(
        () => transition(from, to),
        IllegalTransitionError,
        `${from} -> ${to} should be rejected`,
      );
    }
  });

  test('rejected transitions carry a machine-readable code', () => {
    try {
      transition(JobState.SUCCEEDED, JobState.QUEUED);
      assert.fail('expected a throw');
    } catch (err) {
      assert.equal(err.code, 'ILLEGAL_JOB_TRANSITION');
      assert.equal(err.from, JobState.SUCCEEDED);
      assert.equal(err.to, JobState.QUEUED);
    }
  });

  test('rejects unknown states on either side', () => {
    assert.throws(() => transition('BOGUS', JobState.QUEUED), IllegalTransitionError);
    assert.throws(() => transition(JobState.CREATED, 'BOGUS'), IllegalTransitionError);
    assert.equal(isValidState('BOGUS'), false);
  });

  test('SUCCEEDED and CANCELLED are terminal; FAILED is not', () => {
    assert.ok(isTerminal(JobState.SUCCEEDED));
    assert.ok(isTerminal(JobState.CANCELLED));
    // Retry depends on FAILED having an outgoing edge.
    assert.equal(isTerminal(JobState.FAILED), false);
  });

  test('every transition target is itself a declared state', () => {
    for (const state of ALL_STATES) {
      for (const target of nextStates(state)) {
        assert.ok(
          isValidState(target),
          `${state} -> ${target}: target is not a declared state`,
        );
      }
    }
  });

  test('every state is reachable from CREATED', () => {
    const seen = new Set([JobState.CREATED]);
    const queue = [JobState.CREATED];
    while (queue.length > 0) {
      for (const next of nextStates(queue.shift())) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const state of ALL_STATES) {
      assert.ok(seen.has(state), `state ${state} is unreachable from CREATED`);
    }
  });

  test('nextStates returns a copy, not the internal table', () => {
    const first = nextStates(JobState.CREATED);
    first.push('MUTATED');
    assert.equal(canTransition(JobState.CREATED, 'MUTATED'), false);
  });
});
