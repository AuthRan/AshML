#!/usr/bin/env node
/**
 * Migration runner.
 *
 * node-pg-migrate reads DATABASE_URL, but every other part of AshML is configured
 * through ASHML_* variables and `config.js` is the only module allowed to read the
 * environment. This wrapper bridges the two, so `npm run migrate up` works with the
 * same configuration — and the same default — as `npm start`.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadConfig } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../db/migrations');
const config = loadConfig();

const result = spawnSync(
  'node-pg-migrate',
  ['-m', migrationsDir, '-j', 'sql', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    // node-pg-migrate's own variable wins if the caller set it deliberately.
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? config.databaseUrl },
  },
);

if (result.error) {
  console.error(`migrate: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
