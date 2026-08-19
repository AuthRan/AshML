/**
 * The model lifecycle, tested exhaustively rather than by example: it is small, and the
 * rule it encodes — that PRODUCTION is exclusive — is one the rest of the platform will
 * be built on top of.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelStatus,
  ALL_STATUSES,
  INITIAL_STATUS,
  DISPLACED_TO,
  isValidStatus,
  isTerminal,
  isExclusive,
  canTransition,
  transition,
  IllegalModelTransitionError,
} from './model-status.js';

describe('model version lifecycle', () => {
  test('a new version starts registered, not serving', () => {
    // Registering is not promoting. A version that went straight to PRODUCTION on
    // registration would make every successful training run a deploy.
    assert.equal(INITIAL_STATUS, ModelStatus.CREATED);
    assert.equal(isExclusive(INITIAL_STATUS), false);
  });

  test('only PRODUCTION is exclusive', () => {
    // Any number of versions may be evaluated at once; exactly one can be what the
    // model means.
    assert.ok(isExclusive(ModelStatus.PRODUCTION));
    for (const status of ALL_STATUSES.filter((s) => s !== ModelStatus.PRODUCTION)) {
      assert.equal(isExclusive(status), false, `${status} must not be exclusive`);
    }
  });

  test('a version can be promoted from anywhere it is still alive', () => {
    assert.ok(canTransition(ModelStatus.CREATED, ModelStatus.PRODUCTION));
    assert.ok(canTransition(ModelStatus.STAGING, ModelStatus.PRODUCTION));
  });

  test('a displaced production version lands somewhere it can be rolled back from', () => {
    // Not ARCHIVED: the version that was in production a minute ago is the single most
    // likely rollback target, and the operator doing it at 3am has not decided to
    // retire it forever.
    assert.equal(DISPLACED_TO, ModelStatus.STAGING);
    assert.ok(canTransition(ModelStatus.PRODUCTION, ModelStatus.STAGING));
    assert.ok(canTransition(ModelStatus.STAGING, ModelStatus.PRODUCTION));
  });

  test('archiving is available from every live status', () => {
    for (const status of [ModelStatus.CREATED, ModelStatus.STAGING, ModelStatus.PRODUCTION]) {
      assert.ok(canTransition(status, ModelStatus.ARCHIVED), `${status} must be retirable`);
    }
  });

  test('ARCHIVED is final', () => {
    assert.ok(isTerminal(ModelStatus.ARCHIVED));
    for (const to of ALL_STATUSES) {
      assert.equal(
        canTransition(ModelStatus.ARCHIVED, to), false,
        `un-archiving to ${to} would resurrect a version retired for a reason`,
      );
    }
  });

  test('nothing transitions to itself', () => {
    // A no-op promotion should be caught rather than silently restamping promoted_at.
    for (const status of ALL_STATUSES) {
      assert.equal(canTransition(status, status), false, `${status} -> ${status}`);
    }
  });

  test('an unknown status transitions nowhere', () => {
    assert.equal(isValidStatus('DEPLOYED'), false);
    assert.equal(canTransition('DEPLOYED', ModelStatus.PRODUCTION), false);
    assert.equal(canTransition(ModelStatus.CREATED, 'DEPLOYED'), false);
  });

  test('a refused transition carries a 409 and explains itself', () => {
    assert.throws(
      () => transition(ModelStatus.ARCHIVED, ModelStatus.PRODUCTION),
      (err) => {
        assert.ok(err instanceof IllegalModelTransitionError);
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'ILLEGAL_MODEL_TRANSITION');
        assert.match(err.message, /ARCHIVED is final/);
        return true;
      },
    );
  });

  test('transition returns the target on success', () => {
    assert.equal(
      transition(ModelStatus.STAGING, ModelStatus.PRODUCTION),
      ModelStatus.PRODUCTION,
    );
  });
});
