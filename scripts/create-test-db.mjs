#!/usr/bin/env node
/**
 * Creates the dedicated test database, if it does not already exist.
 *
 * The integration suites TRUNCATE every table, so they are not allowed to run against
 * the development database (see `packages/server/src/test-support/db.js`). This makes
 * the database they *are* allowed to destroy a one-command affair, so the safe path is
 * also the easy one.
 *
 *   node scripts/create-test-db.mjs                      # ashml_test on the default host
 *   ASHML_TEST_DATABASE_URL=... node scripts/create-test-db.mjs
 *
 * `CREATE DATABASE` cannot run inside a transaction and has no `IF NOT EXISTS`, so the
 * "already there" case is handled by catching 42P04 rather than by checking first —
 * checking first would still race with a second invocation.
 */

import pg from 'pg';

const { Client } = pg;

const url = new URL(
  process.env.ASHML_TEST_DATABASE_URL ?? 'postgresql://ashml:ashml@127.0.0.1:5432/ashml_test',
);
const database = decodeURIComponent(url.pathname.replace(/^\//, ''));

if (!/(^|[-_])test$/i.test(database)) {
  console.error(
    `refusing to create "${database}": the test database's name must end in "test", `
    + 'because everything in it gets truncated.',
  );
  process.exit(1);
}

// Connect to the server's default database to issue CREATE DATABASE; `postgres` exists
// on every PostgreSQL installation, including the embedded build used locally.
const admin = new URL(url);
admin.pathname = '/postgres';

const client = new Client({ connectionString: admin.toString() });

try {
  await client.connect();
} catch (err) {
  console.error(`cannot reach PostgreSQL at ${admin.host}: ${err.message}`);
  process.exit(1);
}

try {
  // The name is an identifier, not a value, so it cannot be a bound parameter. It is
  // constrained to a test-suffixed name above and quoted here.
  await client.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
  console.log(`created database ${database}`);
} catch (err) {
  if (err.code === '42P04') {
    console.log(`database ${database} already exists`);
  } else {
    console.error(`could not create ${database}: ${err.message}`);
    process.exit(1);
  }
} finally {
  await client.end();
}
