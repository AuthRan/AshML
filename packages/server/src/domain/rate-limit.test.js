import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter } from './rate-limit.js';

/**
 * The clock is an argument, so every one of these is exact.
 *
 * That is the reason the module is shaped the way it is: a limiter that read the clock
 * itself could only be tested by sleeping, and the properties worth pinning down here —
 * that the budget refills at the rate it claims to, that a blocked caller recovers, that
 * two callers do not share a bucket — are precisely the ones a sleep-based test asserts
 * loosely enough to keep passing after they break.
 */

const MINUTE = 60_000;

describe('RateLimiter', () => {
  test('rejects a limit that would refuse everything', () => {
    assert.throws(() => new RateLimiter({ limit: 0, windowMs: MINUTE }), /positive integer/);
    assert.throws(() => new RateLimiter({ limit: -1, windowMs: MINUTE }), /positive integer/);
    assert.throws(() => new RateLimiter({ limit: 1.5, windowMs: MINUTE }), /positive integer/);
    assert.throws(() => new RateLimiter({ limit: 10, windowMs: 0 }), /positive number of ms/);
    assert.throws(() => new RateLimiter({ limit: 10, windowMs: MINUTE, maxKeys: 0 }), /maxKeys/);
  });

  test('a fresh caller may spend the whole budget at once', () => {
    const limiter = new RateLimiter({ limit: 5, windowMs: MINUTE });
    for (let i = 0; i < 5; i += 1) {
      assert.equal(limiter.take('a', 0).allowed, true, `request ${i + 1} of 5`);
    }
    assert.equal(limiter.take('a', 0).allowed, false);
  });

  test('remaining counts down and never goes below zero', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: MINUTE });
    assert.deepEqual([0, 1, 2, 3].map(() => limiter.take('a', 0).remaining), [2, 1, 0, 0]);
  });

  test('the budget refills continuously, not at a window boundary', () => {
    const limiter = new RateLimiter({ limit: 60, windowMs: MINUTE });
    for (let i = 0; i < 60; i += 1) limiter.take('a', 0);
    assert.equal(limiter.take('a', 0).allowed, false);

    // One request per second is the refill rate, so half a second buys nothing and a
    // whole one buys exactly one request. A fixed window would have bought sixty at the
    // boundary and nothing before it.
    assert.equal(limiter.take('a', 500).allowed, false);
    assert.equal(limiter.take('a', 1000).allowed, true);
    assert.equal(limiter.take('a', 1000).allowed, false);
    assert.equal(limiter.take('a', 11_000).remaining, 9);
  });

  test('the budget never refills past the limit, however long the caller is quiet', () => {
    const limiter = new RateLimiter({ limit: 4, windowMs: MINUTE });
    limiter.take('a', 0);
    // A day later: four, not four plus a day's worth.
    assert.equal(limiter.take('a', 86_400_000).remaining, 3);
  });

  test('a refused request is not charged, so a caller in a retry loop still recovers', () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: MINUTE });
    limiter.take('a', 0);
    limiter.take('a', 0);

    // Knock a hundred times while blocked. Charging refusals would push the recovery
    // out by a hundred requests' worth of refill and turn the limit into a ban.
    for (let i = 0; i < 100; i += 1) assert.equal(limiter.take('a', 1_000).allowed, false);

    // 30 s buys one request at two per minute, measured from the moment of exhaustion.
    assert.equal(limiter.take('a', 30_000).allowed, true);
  });

  test('callers do not share a bucket', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: MINUTE });
    assert.equal(limiter.take('a', 0).allowed, true);
    assert.equal(limiter.take('a', 0).allowed, false);
    assert.equal(limiter.take('b', 0).allowed, true);
  });

  test('peek reports what take would decide, without deciding it', () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: MINUTE });
    assert.equal(limiter.peek('a', 0).allowed, true);
    assert.equal(limiter.peek('a', 0).remaining, 2, 'peeking must not spend anything');
    assert.equal(limiter.size, 0, 'peeking an unknown caller must not remember them');

    limiter.take('a', 0);
    limiter.take('a', 0);
    assert.equal(limiter.peek('a', 0).allowed, false);
    assert.equal(limiter.peek('a', 0).remaining, 0);
  });

  test('retryAfter says when one request becomes affordable, and reset when all do', () => {
    const limiter = new RateLimiter({ limit: 60, windowMs: MINUTE });
    for (let i = 0; i < 60; i += 1) limiter.take('a', 0);

    const blocked = limiter.take('a', 0);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 1, 'one request per second refills in one');
    assert.equal(blocked.resetSeconds, 60, 'the whole budget takes the whole window');

    // Never zero: `Retry-After: 0` tells a client to retry immediately, which is the one
    // instruction that cannot be right in a refusal.
    const tiny = new RateLimiter({ limit: 100_000, windowMs: MINUTE });
    for (let i = 0; i < 100_000; i += 1) tiny.take('a', 0);
    assert.equal(tiny.take('a', 0).retryAfterSeconds, 1);
  });

  test('an allowed request reports no retry delay', () => {
    const limiter = new RateLimiter({ limit: 5, windowMs: MINUTE });
    assert.equal(limiter.take('a', 0).retryAfterSeconds, 0);
  });

  test('a clock that steps backwards withholds refill rather than taking tokens away', () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: MINUTE });
    limiter.take('a', 100_000);
    // NTP corrects the clock backwards by a minute. The caller keeps what they had.
    assert.equal(limiter.take('a', 40_000).remaining, 8);
  });

  test('sweep forgets callers whose budget has refilled, and only those', () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: MINUTE });
    limiter.take('quiet', 0);
    for (let i = 0; i < 10; i += 1) limiter.take('busy', 0);
    assert.equal(limiter.size, 2);

    // Six seconds refills one of ten: enough for `quiet` to be back at the limit and
    // nowhere near enough for `busy`.
    assert.equal(limiter.sweep(6_000), 1);
    assert.equal(limiter.size, 1);
    assert.equal(limiter.peek('busy', 6_000).remaining, 1);

    assert.equal(limiter.sweep(MINUTE), 1);
    assert.equal(limiter.size, 0);
  });

  test('the map stays bounded, evicting the least recently seen caller', () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: MINUTE, maxKeys: 3 });
    for (const key of ['a', 'b', 'c']) limiter.take(key, 0);
    assert.equal(limiter.size, 3);

    // Touching `a` moves it off the front, so `b` is now the oldest and is the one lost.
    limiter.take('a', 0);
    limiter.take('d', 0);
    assert.equal(limiter.size, 3);
    assert.equal(limiter.peek('b', 0).remaining, 2, 'evicted, so back to a full budget');
    assert.equal(limiter.peek('a', 0).remaining, 0, 'still remembered, still spent');
  });

  test('reset forgets everyone', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: MINUTE });
    limiter.take('a', 0);
    assert.equal(limiter.take('a', 0).allowed, false);
    limiter.reset();
    assert.equal(limiter.size, 0);
    assert.equal(limiter.take('a', 0).allowed, true);
  });
});
