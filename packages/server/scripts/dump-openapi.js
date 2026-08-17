#!/usr/bin/env node
/**
 * Writes api/openapi.yaml from the live route schemas.
 *
 * The spec is generated, never hand-edited — route schemas are the single source of
 * truth (ADR 0006). Run `npm run openapi` after changing any route and commit the
 * result so the API surface is reviewable in diffs.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outputPath = join(repoRoot, 'api', 'openapi.yaml');

// `sim` so this runs on any machine, including CI without a GPU. The provider does
// not affect the generated schema.
const config = loadConfig({ ...process.env, ASHML_GPU_PROVIDER: 'sim' });

const app = await buildApp(config, { logger: false });
await app.ready();

const yaml = app.swagger({ yaml: true });
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, yaml, 'utf8');
await app.close();

console.log(`wrote ${outputPath}`);
