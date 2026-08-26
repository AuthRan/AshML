/**
 * Unit tests for the token lifetime policy.
 *
 * Pure arithmetic over two numbers, and worth enumerating anyway: the case that matters
 * is the one where nobody asked for anything, because that is every token a script mints
 * and the reason the policy exists at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTokenLifetime,
  DEFAULT_MAX_TTL_DAYS,
  TOKEN_TTL_TOO_LONG,
} from './token-lifetime.js';

/** A fixed clock, so no test can race a real one. */
const NOW = Date.parse('2026-08-26T00:00:00.000Z');
const daysAfterNow = (expiresAt) => Math.round((expiresAt.getTime() - NOW) / 86_400_000);

describe('token lifetime, with a ceiling configured', () => {
  const resolve = (requestedDays) =>
    resolveTokenLifetime({ requestedDays, maxDays: 90, now: NOW });

  test('a caller who asks for nothing gets the ceiling, not forever', () => {
    // The whole point. "Tokens can be given an expiry; nothing requires one" was the gap,
    // and a maximum on its own does nothing about the token nobody thought about.
    const lifetime = resolve(null);
    assert.equal(lifetime.allowed, true);
    assert.equal(daysAfterNow(lifetime.expiresAt), 90);
    assert.equal(lifetime.defaulted, true);
  });

  test('a shorter request is honoured exactly', () => {
    const lifetime = resolve(7);
    assert.equal(daysAfterNow(lifetime.expiresAt), 7);
    assert.equal(lifetime.defaulted, false);
  });

  test('asking for exactly the ceiling is allowed', () => {
    // The boundary, in the direction where an off-by-one refuses a legitimate request
    // and the message would tell the caller to ask for the number they just asked for.
    const lifetime = resolve(90);
    assert.equal(lifetime.allowed, true);
    assert.equal(daysAfterNow(lifetime.expiresAt), 90);
  });

  test('asking for longer is refused, not quietly shortened', () => {
    // Clamping is the friendlier-looking failure and the worse one: a caller given 90
    // days when they asked for 365 plans around 365 and finds out from a 401 in a
    // pipeline that has worked for three months.
    const lifetime = resolve(365);
    assert.equal(lifetime.allowed, false);
    assert.equal(lifetime.expiresAt, null);
    assert.equal(lifetime.code, TOKEN_TTL_TOO_LONG);
  });

  test('the refusal says the ceiling and how to change it', () => {
    const { reason } = resolve(365);
    assert.match(reason, /90 days/);
    assert.match(reason, /365/);
    assert.match(reason, /ASHML_TOKEN_MAX_TTL_DAYS/);
  });

  test('a one-day ceiling reads as a day rather than as 1 days', () => {
    const { reason } = resolveTokenLifetime({ requestedDays: 2, maxDays: 1, now: NOW });
    assert.match(reason, /at most 1 day\b/);
  });
});

describe('token lifetime, with no ceiling', () => {
  const resolve = (requestedDays) =>
    resolveTokenLifetime({ requestedDays, maxDays: null, now: NOW });

  test('a token with no expiry is possible again, and only by saying so', () => {
    // ASHML_TOKEN_MAX_TTL_DAYS=none. The behaviour every token had before this module,
    // available as something an operator chose rather than as an unset variable.
    const lifetime = resolve(null);
    assert.equal(lifetime.allowed, true);
    assert.equal(lifetime.expiresAt, null);
    assert.equal(lifetime.defaulted, false);
  });

  test('an expiry that is asked for is still honoured', () => {
    assert.equal(daysAfterNow(resolve(30).expiresAt), 30);
  });

  test('nothing is too long when there is no maximum', () => {
    assert.equal(resolve(3650).allowed, true);
  });
});

describe('the default ceiling', () => {
  test('is ninety days, and is what an unconfigured platform applies', () => {
    assert.equal(DEFAULT_MAX_TTL_DAYS, 90);
    const lifetime = resolveTokenLifetime({ maxDays: DEFAULT_MAX_TTL_DAYS, now: NOW });
    assert.equal(daysAfterNow(lifetime.expiresAt), 90);
  });

  test('called with nothing at all, it refuses nothing and expires nothing', () => {
    // The signature's own default is "no policy", so a caller that forgets to pass the
    // ceiling gets the old behaviour rather than an accidental ninety days. Every call
    // site passes it; this pins which way the omission fails.
    const lifetime = resolveTokenLifetime();
    assert.equal(lifetime.allowed, true);
    assert.equal(lifetime.expiresAt, null);
  });
});
