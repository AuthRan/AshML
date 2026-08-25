/**
 * Tests for the guard that decides which database the integration suites may destroy.
 *
 * This is tested because the thing it prevents already happened once: `npm test` with
 * `ASHML_DATABASE_URL` set truncated a development database and took a finished
 * training run's experiment, metrics, artifacts and registered model version with it.
 * A guard nobody exercises is a guard nobody notices has stopped working.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { assertDestroyable, WIPE_ORDER, connectOrNull, wipeAll, SKIP_MESSAGE } from './db.js';

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
      /refusing to wipe/,
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
      /refusing to wipe/,
      `"${value}" should not disarm the guard`,
    );
  }
});

test('an unparsable url is refused rather than assumed safe', () => {
  assert.throws(() => assertDestroyable('not-a-url'), /not a parsable database URL/);
});


/**
 * The wipe list, checked against the database rather than against itself.
 *
 * `wipeAll` used to be `TRUNCATE ... CASCADE`, which needed no list: the database
 * worked out the graph. It is now an ordered `DELETE`, because TRUNCATE rewrites a
 * relation file per table and on a Docker volume that is ~170 ms each — 3.7 s in the
 * `beforeEach` of every integration test, which is most of a seventeen-minute suite that
 * CI runs in a hundred seconds.
 *
 * The list is what that costs, and this is what stops the cost being paid in silence. A
 * table added to the schema and forgotten here would leak rows into the next test — the
 * most confusing kind of failure there is, because it appears in a test that is correct.
 * So the set and the order are both derived from `pg_constraint` and compared, and the
 * wipe is run and checked to have actually emptied everything.
 */
const wipePool = await connectOrNull();

test.after(async () => { await wipePool?.end(); });

describe('the wipe list', { skip: wipePool ? false : SKIP_MESSAGE }, () => {
  /** Foreign keys as the database has them: child, parent, and what a delete does. */
  async function foreignKeys() {
    const { rows } = await wipePool.query(`
      SELECT c.conrelid::regclass::text AS child,
             c.confrelid::regclass::text AS parent,
             c.confdeltype AS on_delete
      FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.connamespace = 'public'::regnamespace`);
    return rows;
  }

  test('covers every table that hangs off a project, and nothing else', async () => {
    const fks = await foreignKeys();

    // Everything reachable *downwards* from projects: the tables a cascade would have
    // taken. Computed rather than listed, so the schema is the source of truth.
    const children = new Map();
    for (const { child, parent } of fks) {
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(child);
    }
    const reachable = new Set(['projects']);
    const queue = ['projects'];
    while (queue.length > 0) {
      for (const child of children.get(queue.pop()) ?? []) {
        if (!reachable.has(child)) { reachable.add(child); queue.push(child); }
      }
    }

    // `users` is reachable from nothing — projects reference it, not the other way — but
    // `api_tokens` and `project_members` hang off it, and only the second hangs off a
    // project too. Node inventory is reachable from nothing here either.
    const listed = new Set(WIPE_ORDER);
    const missing = [...reachable].filter((t) => !listed.has(t));
    assert.deepEqual(missing, [], 'these tables would leak rows into the next test');

    const extra = WIPE_ORDER.filter((t) => !reachable.has(t) && t !== 'authz_denials');
    assert.deepEqual(extra, [], 'these are wiped and nothing said they should be');
  });

  test('lists children before the parents that would refuse to be deleted first', async () => {
    const position = new Map(WIPE_ORDER.map((table, index) => [table, index]));

    for (const { child, parent, on_delete: onDelete } of await foreignKeys()) {
      // 'a' is NO ACTION and 'r' is RESTRICT — the two that refuse rather than follow.
      // For those the order is not a preference, it is the difference between a wipe and
      // a foreign-key violation in every `beforeEach`.
      if (onDelete !== 'a' && onDelete !== 'r') continue;
      if (!position.has(child) || !position.has(parent)) continue;
      assert.ok(
        position.get(child) < position.get(parent),
        `${child} references ${parent} with ON DELETE NO ACTION, so it must be deleted first`,
      );
    }
  });

  test('actually empties every table it names', async () => {
    // The end-to-end version of the two checks above: reasoning about a graph is how a
    // wrong order looks right on paper.
    await wipeAll(wipePool);
    for (const table of WIPE_ORDER) {
      const { rows } = await wipePool.query(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(rows[0].n, 0, `${table} still has rows after a wipe`);
    }
  });

  test('leaves the seeded administrator and the node inventory alone', async () => {
    // Both were untouched by the TRUNCATE this replaced, and several suites depend on it:
    // the seeded user is who the integration tokens belong to, and node inventory is
    // discovered once per suite rather than per test.
    await wipeAll(wipePool);
    const { rows } = await wipePool.query('SELECT count(*)::int AS n FROM users');
    assert.ok(rows[0].n >= 1, 'the seeded local administrator must survive a wipe');
  });
});
