#!/usr/bin/env node
/**
 * Assemble the Hugging Face Space payload for a registered model version.
 *
 * The Space serves AshML's own `serve.py`, but it has no control plane to ask for a
 * download URL, so the two things that indirection would have provided at runtime have
 * to be resolved once, here, and shipped alongside the weights:
 *
 *   model.pt          the artifact's bytes, fetched through the same presigned-download
 *                     endpoint the model server uses in the cluster
 *   provenance.json   what produced them -- run, experiment, seed, image, measured
 *                     metrics -- so the page can attribute every answer it gives
 *
 * The provenance file is not decoration. A prediction nobody can attribute to a model
 * version is how the wrong model serves for a week, and a demo is exactly where that is
 * least likely to be noticed. So this refuses to write a Space for anything it cannot
 * attribute: a version whose artifact AshML never verified is a `READY` check away from
 * being bytes nobody confirmed, and shipping it would put the platform's own guarantee
 * behind something that never earned it.
 *
 *   node scripts/build-space.mjs --project ashml-demo --model resnet18-cifar10
 */

import { mkdir, writeFile, readdir, copyFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import path from 'node:path';

const ENDPOINT = env.ASHML_ENDPOINT ?? 'http://127.0.0.1:8080';
const ROOT = path.resolve(import.meta.dirname, '..');
const SPACE = path.join(ROOT, 'space');

function arg(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  if (at !== -1 && argv[at + 1]) return argv[at + 1];
  if (fallback !== undefined) return fallback;
  console.error(`build-space: --${name} is required`);
  exit(1);
}

async function api(pathname) {
  const response = await fetch(`${ENDPOINT}${pathname}`, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`GET ${pathname} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const project = arg('project');
const model = arg('model');
const versionWanted = arg('version', '');

console.log(`build-space: ${ENDPOINT} ${project}/${model}`);

// The PRODUCTION version by default, because that is the one the platform says is
// serving; naming a version explicitly is for building a Space for a canary.
const answer = versionWanted
  ? await api(`/api/v1/projects/${project}/models/${model}/versions/${versionWanted}`)
  : await api(`/api/v1/projects/${project}/models/${model}/production`);

// Both routes answer `{ version: {...} }`; neither is flattened, so unwrap rather than
// reading fields off the envelope and getting `undefined` that reads like missing data.
const version = answer.version ?? answer;

const artifactId = version.artifact_id ?? version.artifact?.id;
if (!artifactId) throw new Error(`version ${version.version} has no artifact`);

const artifact = version.artifact ?? (await api(`/api/v1/artifacts/${artifactId}`));
if (artifact.status !== 'READY') {
  throw new Error(
    `artifact ${artifactId} is ${artifact.status}, not READY -- refusing to build a Space ` +
    'around bytes AshML has not confirmed',
  );
}
if (artifact.verified === false) {
  throw new Error(
    `artifact ${artifactId} completed without AshML checking the bucket -- refusing to ` +
    'attribute a demo to an unverified artifact',
  );
}

const { url } = await api(`/api/v1/artifacts/${artifactId}/download`);

await mkdir(SPACE, { recursive: true });

console.log(`build-space: fetching ${artifact.size_bytes ?? '?'} bytes`);
const blob = await fetch(url);
if (!blob.ok) throw new Error(`download -> ${blob.status}`);
await writeFile(path.join(SPACE, 'model.pt'), Buffer.from(await blob.arrayBuffer()));

// `serve.py` is imported by the Space rather than copied by hand: one file, so that the
// thing answering in the Space cannot drift from the thing answering in a Pod.
await copyFile(
  path.join(ROOT, 'deploy/images/model-server/serve.py'),
  path.join(SPACE, 'serve.py'),
);

const job = version.job_id ? await api(`/api/v1/jobs/${version.job_id}`).catch(() => null) : null;
const experiment = version.experiment_id
  ? await api(`/api/v1/experiments/${version.experiment_id}`).catch(() => null)
  : null;

// Taken from the metric series the run itself reported, and named for what it actually
// is. The temptation is to print a total -- "390 steps" -- but nothing here knows that
// number: metrics arrive every LOG_EVERY steps, so the last one logged is 380 out of a
// 390-step epoch, and reporting `max(step) + 1` as the step count would quietly publish
// 381. A field that says `last_logged_step` cannot be misread that way.
const answerMetrics = version.job_id
  ? await api(`/api/v1/jobs/${version.job_id}/metrics?name=loss`).catch(() => null)
  : null;
const points = answerMetrics?.series?.find((s) => s.name === 'loss')?.points ?? [];
const lastLoggedStep = points.length ? Math.max(...points.map((p) => p.step ?? 0)) : null;

const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : '—');
const fixed = (v) => (typeof v === 'number' ? v.toFixed(4) : '—');

const provenance = {
  model,
  version: version.version,
  artifact_id: artifactId,
  artifact_uri: artifact.uri,
  artifact_verified: artifact.verified ?? null,
  job_id: version.job_id ?? null,
  experiment: experiment?.name ?? null,
  // Reproducibility fields live under `reproducibility`, which is the shape the record
  // is stored in rather than a flattened convenience view -- see spec §34.
  seed: experiment?.reproducibility?.random_seed ?? null,
  git_commit: experiment?.reproducibility?.git_commit ?? null,
  dataset: experiment?.reproducibility?.dataset
    ? `${experiment.reproducibility.dataset.name}:${experiment.reproducibility.dataset.version}`
    : null,
  framework: experiment?.reproducibility?.observed?.framework ?? null,
  epochs: job?.spec?.env?.EPOCHS ?? null,
  last_logged_step: lastLoggedStep,
  logged_points: points.length || null,
  image: job?.spec?.image ?? null,
  accuracy: pct(version.metrics?.val_accuracy ?? version.metrics?.accuracy),
  loss: fixed(version.metrics?.val_loss ?? version.metrics?.loss),
  metrics: version.metrics ?? {},
  built_at: new Date().toISOString(),
};

await writeFile(path.join(SPACE, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

// Example images, if `make cifar-png` has been run. Test images, with the true label in
// the filename, so a visitor can check an answer rather than admire it.
const pngs = path.join(ROOT, 'data/cifar-png');
try {
  const names = (await readdir(pngs)).filter((n) => n.endsWith('.png')).sort().slice(0, 12);
  await mkdir(path.join(SPACE, 'examples'), { recursive: true });
  for (const name of names) await copyFile(path.join(pngs, name), path.join(SPACE, 'examples', name));
  console.log(`build-space: ${names.length} example image(s)`);
} catch {
  console.log('build-space: no data/cifar-png -- run `make cifar-png` for example images');
}

console.log(`build-space: ${model} v${version.version} -> space/`);
console.log(`  artifact  ${artifactId} (${artifact.status})`);
console.log(`  accuracy  ${provenance.accuracy}   loss ${provenance.loss}`);
