/**
 * Unit tests for weighted version routing.
 *
 * This module is imported by both the control plane and the router image, so these tests
 * cover the one definition of what a weight means. `random` is injected everywhere, so
 * nothing here is statistical — a routing test that passes 99 times in 100 is a routing
 * test that fails in CI for reasons nobody can reproduce.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateWeights, applyRollout, chooseTarget, hashKey, needsRouter, TOTAL_WEIGHT,
} from './routing.js';

const t = (version, weight, ready = true) => ({ version, weight, ready });

describe('validating weights', () => {
  test('a full split is accepted', () => {
    assert.deepEqual(validateWeights([t(6, 90), t(7, 10)]), { ok: true });
  });

  test('weights that do not sum to 100 are refused, and the message shows the arithmetic', () => {
    // The friendlier option is to normalise, and it is how an operator gets a split they
    // did not ask for: set v7 to 10 meaning 90/10, forget to lower v6 from 100, and get
    // 91/9 with nothing complaining.
    const result = validateWeights([t(6, 100), t(7, 10)]);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WEIGHTS_MUST_SUM_TO_100');
    assert.match(result.message, /sum to 110/);
    assert.match(result.message, /v6=100, v7=10/);
  });

  test('a version cannot appear twice', () => {
    const result = validateWeights([t(7, 50), t(7, 50)]);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DUPLICATE_VERSION');
  });

  test('a weight outside 0..100 is refused before anything is stored', () => {
    assert.equal(validateWeights([t(7, 101)]).code, 'INVALID_WEIGHT');
    assert.equal(validateWeights([t(7, -1)]).code, 'INVALID_WEIGHT');
    assert.equal(validateWeights([t(7, 33.5)]).code, 'INVALID_WEIGHT');
  });

  test('an empty target list is refused', () => {
    assert.equal(validateWeights([]).code, 'NO_TARGETS');
  });

  test('a zero weight is legal, and every weight at zero is not', () => {
    // Zero is how a version is taken out of rotation while its pods and its history are
    // kept; all-zero would mean nothing answers, which is not a rollout, it is an outage.
    assert.deepEqual(validateWeights([t(6, 100), t(7, 0)]), { ok: true });
    assert.equal(validateWeights([t(6, 0), t(7, 0)]).code, 'WEIGHTS_MUST_SUM_TO_100');
  });
});

describe('applying one rollout', () => {
  test('the spec\'s sequence: 10, then 50, then all of it', () => {
    // §21's worked example, which is the thing this arithmetic exists to make behave.
    let weights = [t(6, 100)];

    weights = applyRollout(weights, 7, 10);
    assert.deepEqual(weights, [{ version: 6, weight: 90 }, { version: 7, weight: 10 }]);

    weights = applyRollout(weights, 7, 50);
    assert.deepEqual(weights, [{ version: 6, weight: 50 }, { version: 7, weight: 50 }]);

    weights = applyRollout(weights, 7, 100);
    assert.deepEqual(weights, [{ version: 6, weight: 0 }, { version: 7, weight: 100 }]);
  });

  test('the remainder is taken in proportion, not from whichever is largest', () => {
    // With three versions in play there is no "the previous one", and a rule that took
    // it all from the biggest would move traffic the operator never mentioned.
    const weights = applyRollout([t(5, 60), t(6, 40)], 7, 20);
    assert.deepEqual(weights, [
      { version: 5, weight: 48 }, { version: 6, weight: 32 }, { version: 7, weight: 20 },
    ]);
    assert.equal(weights.reduce((s, w) => s + w.weight, 0), TOTAL_WEIGHT);
  });

  test('rounding never leaks: a sequence of awkward splits still totals 100', () => {
    let weights = [t(1, 34), t(2, 33), t(3, 33)];
    for (const share of [7, 13, 29, 1, 99, 50]) {
      weights = applyRollout(weights, 4, share);
      assert.equal(
        weights.reduce((sum, w) => sum + w.weight, 0), TOTAL_WEIGHT,
        `after rolling v4 to ${share}: ${JSON.stringify(weights)}`,
      );
    }
  });

  test('rolling out onto versions that are all at zero spreads the rest evenly', () => {
    const weights = applyRollout([t(5, 0), t(6, 0), t(7, 100)], 7, 40);
    assert.deepEqual(weights, [
      { version: 5, weight: 30 }, { version: 6, weight: 30 }, { version: 7, weight: 40 },
    ]);
  });

  test('the first version to be rolled out takes all of it', () => {
    assert.deepEqual(applyRollout([], 7, 10), [{ version: 7, weight: 100 }]);
  });
});

describe('choosing a target', () => {
  test('the boundaries of a 90/10 split fall where the arithmetic says', () => {
    const targets = [t(6, 90), t(7, 10)];
    const at = (r) => chooseTarget(targets, { random: () => r }).target.version;

    assert.equal(at(0), 6);
    assert.equal(at(0.899), 6);
    assert.equal(at(0.9), 7);
    assert.equal(at(0.999), 7);
  });

  test('a version at weight zero never answers', () => {
    // The failure this prevents is the one §21 exists for: a version deliberately taken
    // out of rotation quietly serving a request anyway.
    const targets = [t(6, 100), t(7, 0)];
    for (const r of [0, 0.25, 0.5, 0.75, 0.9999]) {
      assert.equal(chooseTarget(targets, { random: () => r }).target.version, 6);
    }
  });

  test('an unready target is skipped and its share is not renormalised', () => {
    // The weights stay what the operator asked for. A canary whose only pod is restarting
    // must not silently become the whole of the traffic on the way back up — its share
    // goes to whoever is ready, exactly as a Service does when an endpoint drops out.
    const targets = [t(6, 90, true), t(7, 10, false)];
    const chosen = chooseTarget(targets, { random: () => 0.99 });
    assert.equal(chosen.target.version, 6);
    assert.equal(chosen.reason, 'only-ready', 'the caller must be able to tell this apart');
  });

  test('nothing ready is null, not a fallback onto a retired version', () => {
    const targets = [t(6, 90, false), t(7, 10, false)];
    assert.equal(chooseTarget(targets), null);
  });

  test('a single target says so, rather than claiming it was chosen', () => {
    assert.equal(chooseTarget([t(7, 100)], { random: () => 0.5 }).reason, 'sole-target');
  });

  test('a route key is sticky across calls, whatever the randomness does', () => {
    // The A/B case. Without this, the same user is routed to v6 then v7 then v6 and every
    // per-user metric is measuring a mixture.
    const targets = [t(6, 50), t(7, 50)];
    const first = chooseTarget(targets, { key: 'user-8813', random: () => 0 });
    const second = chooseTarget(targets, { key: 'user-8813', random: () => 0.999 });

    assert.equal(first.target.version, second.target.version);
    assert.equal(first.reason, 'sticky');
  });

  test('sticky keys still respect the split', () => {
    // Not a statistical assertion about the hash — a check that keys land on both sides
    // in roughly the stated proportion, which is what a sticky router has to do to be a
    // router at all rather than a constant.
    const targets = [t(6, 90), t(7, 10)];
    const counts = { 6: 0, 7: 0 };
    for (let i = 0; i < 4000; i += 1) {
      counts[chooseTarget(targets, { key: `user-${i}` }).target.version] += 1;
    }
    const canaryShare = counts[7] / 4000;
    assert.ok(
      canaryShare > 0.05 && canaryShare < 0.16,
      `a 10% canary took ${(canaryShare * 100).toFixed(1)}% of 4000 keys`,
    );
  });

  test('the same key can move when readiness moves, and not otherwise', () => {
    const key = 'session-42';
    const healthy = [t(6, 50), t(7, 50)];
    const stable = chooseTarget(healthy, { key }).target.version;

    assert.equal(chooseTarget(healthy, { key }).target.version, stable);
    assert.equal(chooseTarget(healthy, { key }).target.version, stable);

    const degraded = [t(6, 50, false), t(7, 50, true)];
    assert.equal(chooseTarget(degraded, { key }).target.version, 7);
  });
});

describe('the hash', () => {
  test('is stable, because two implementations of it would break stickiness', () => {
    // The control plane and the router both compute this. A key landing on v7 in one and
    // v6 in the other would make stickiness silently untrue, so the values are pinned.
    assert.equal(hashKey(''), 0x811c9dc5);
    assert.equal(hashKey('a'), 0xe40c292c);
    assert.equal(hashKey('foobar'), 0xbf9cf968);
  });

  test('is an unsigned 32-bit integer for anything it is given', () => {
    for (const key of ['', 'x', 'user-1', '🙂', 'a'.repeat(500)]) {
      const hash = hashKey(key);
      assert.ok(Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff, `${key} -> ${hash}`);
    }
  });
});

describe('whether a router is needed', () => {
  test('one version does not need one; two do', () => {
    assert.equal(needsRouter([t(7, 100)]), false);
    assert.equal(needsRouter([t(6, 90), t(7, 10)]), true);
  });

  test('a version kept at zero for a rollback does not need one', () => {
    // The state after every finished rollout. Counting targets rather than traffic would
    // leave a router — a hop and two pods — in front of a decision with one answer,
    // permanently, because someone kept the previous version available to go back to.
    assert.equal(needsRouter([t(6, 0), t(7, 100)]), false);
    assert.equal(needsRouter([t(5, 0), t(6, 0), t(7, 100)]), false);
  });

  test('a version coming back off zero needs one again', () => {
    assert.equal(needsRouter([t(6, 20), t(7, 80)]), true);
  });
});
