/**
 * Tests for the guard that decides which database the integration suites may destroy.
 *
 * This is tested because the thing it prevents already happened once: `npm test` with
 * `ASHML_DATABASE_URL` set truncated a development database and took a finished
 * training run's experiment, metrics, artifacts and registered model version with it.
 * A guard nobody exercises is a guard nobody notices has stopped working.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertDestroyable } from './db.js';

const ORIGINAL = process.env.ASHML_TEST_DATABASE_ALLOW_DESTRUCTIVE;

test.afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ASHML_TEST_DATABASE_ALLOW_DESTRUCTIVE;
  else process.env.ASHML_TEST_DATABASE_ALLOW_DESTRUCTIVE = ORIGINAL;
});

test('a database named for testing may be wiped', () => {
  for (const name of ['ashml_test', 'ashml-test', 'test', 'TEST', 'ci_test']) {
    assert.doesNotThrow(
      () => assertDestroyable(`postgresql://u:p@127.0.0.1:5432/${name}`),
      `${name} should be destroyable`,
    );
  }
});

test('a database not named for testing is refused', () => {
  for (const name of ['ashml', 'production', 'ashml_dev', 'testing', 'test_ashml']) {
    assert.throws(
      () => assertDestroyable(`postgresql://u:p@127.0.0.1:5432/${name}`),
      /refusing to TRUNCATE/,
      `${name} should be refused`,
    );
  }
});

test('the refusal names the database and how to proceed', () => {
  assert.throws(
    () => assertDestroyable('postgresql://u:p@127.0.0.1:5432/ashml'),
    (err) => {
      // The operator has to be able to tell *which* database was refused; "a database"
      // sends them to check the wrong one.
      assert.match(err.message, /"ashml"/);
      assert.match(err.message, /ASHML_TEST_DATABASE_URL/);
      assert.match(err.message, /ASHML_TEST_DATABASE_ALLOW_DESTRUCTIVE/);
      return true;
    },
  );
});

test('the override allows a differently-named database', () => {
  process.env.ASHML_TEST_DATABASE_ALLOW_DESTRUCTIVE = 'true';
  assert.doesNotThrow(() => assertDestroyable('postgresql://u:p@127.0.0.1:5432/ephemeral-ci-42'));
});

test('only the exact string "true" overrides', () => {
  // Anything else — "1", "yes", an accidental empty string — must not disarm a guard
  // whose whole job is to fail closed.
  for (const value of ['1', 'yes', 'TRUE', '']) {
    process.env.ASHML_TEST_DATABASE_ALLOW_DESTRUCTIVE = value;
    assert.throws(
      () => assertDestroyable('postgresql://u:p@127.0.0.1:5432/ashml'),
      /refusing to TRUNCATE/,
      `"${value}" should not disarm the guard`,
    );
  }
});

test('an unparsable url is refused rather than assumed safe', () => {
  assert.throws(() => assertDestroyable('not-a-url'), /not a parsable database URL/);
});
