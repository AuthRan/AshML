/**
 * The artifact status machine is small, so it is tested exhaustively rather than by
 * example: every status pair is enumerated and checked against the one rule that
 * matters — nothing reaches READY except from PENDING, and nothing leaves READY.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ArtifactStatus,
  ALL_STATUSES,
  isValidStatus,
  isUsable,
  canTransition,
  transition,
  IllegalArtifactTransitionError,
} from './artifact-status.js';

describe('artifact status', () => {
  test('an upload can be confirmed or abandoned', () => {
    assert.ok(canTransition(ArtifactStatus.PENDING, ArtifactStatus.READY));
    assert.ok(canTransition(ArtifactStatus.PENDING, ArtifactStatus.FAILED));
  });

  test('settled statuses are final', () => {
    for (const from of [ArtifactStatus.READY, ArtifactStatus.FAILED]) {
      for (const to of ALL_STATUSES) {
        assert.equal(canTransition(from, to), false, `${from} -> ${to} must be refused`);
      }
    }
  });

  test('READY is reachable only from PENDING', () => {
    const sources = ALL_STATUSES.filter((from) => canTransition(from, ArtifactStatus.READY));
    assert.deepEqual(sources, [ArtifactStatus.PENDING]);
  });

  test('only READY may be relied upon', () => {
    assert.ok(isUsable(ArtifactStatus.READY));
    assert.equal(isUsable(ArtifactStatus.PENDING), false);
    assert.equal(isUsable(ArtifactStatus.FAILED), false);
  });

  test('an unknown status transitions nowhere', () => {
    assert.equal(isValidStatus('UPLOADED'), false);
    assert.equal(canTransition('UPLOADED', ArtifactStatus.READY), false);
  });

  test('transition returns the target on success', () => {
    assert.equal(
      transition(ArtifactStatus.PENDING, ArtifactStatus.READY),
      ArtifactStatus.READY,
    );
  });

  test('a refused transition carries a 409 and says what was attempted', () => {
    assert.throws(
      () => transition(ArtifactStatus.READY, ArtifactStatus.FAILED),
      (err) => {
        assert.ok(err instanceof IllegalArtifactTransitionError);
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'ILLEGAL_ARTIFACT_TRANSITION');
        assert.equal(err.from, ArtifactStatus.READY);
        assert.equal(err.to, ArtifactStatus.FAILED);
        // The message must name the reason, not just the pair: a caller retrying a
        // confirm needs to know the artifact already settled.
        assert.match(err.message, /READY is final/);
        return true;
      },
    );
  });
});
