#!/usr/bin/env node
/**
 * `ash` — the AshML command-line client.
 *
 * The CLI contains no business logic. It calls the public API and renders the
 * result, which is what keeps it honest: anything `ash` can do, the API can do,
 * and Ashcode will later drive the same endpoints (spec §28).
 */

import { readFile } from 'node:fs/promises';

import { Command } from 'commander';
import Table from 'cli-table3';
import { parse as parseYaml } from 'yaml';

const DEFAULT_ENDPOINT = process.env.ASHML_ENDPOINT ?? 'http://127.0.0.1:8080';

/** Calls the control plane, unwrapping the standard error envelope (spec §45). */
async function api(endpoint, path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(new URL(path, endpoint), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`cannot reach AshML at ${endpoint}: ${err.message}`, { cause: err });
  }

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const code = payload?.error?.code ?? `HTTP_${res.status}`;
    const message = payload?.error?.message ?? res.statusText;
    throw new Error(`${code}: ${message}`);
  }
  return payload;
}

function gib(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Compact relative age, e.g. "3m" — job lists are read at a glance. */
function age(isoTimestamp) {
  if (!isoTimestamp) return '-';
  const seconds = Math.max(0, (Date.now() - Date.parse(isoTimestamp)) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function newTable(head) {
  return new Table({ head, style: { head: [], border: [] } });
}

/**
 * Resolves the project for a project-scoped command.
 *
 * Falls back to ASHML_PROJECT so a session working in one project does not have to
 * repeat `-p` on every call.
 */
function requireProject(opts) {
  const project = opts.project ?? process.env.ASHML_PROJECT;
  if (!project) {
    throw new Error('no project given: pass --project <name> or set ASHML_PROJECT');
  }
  return project;
}

/**
 * Collects a repeatable `key=value` flag into an object.
 *
 * Values are coerced to numbers and booleans where they clearly are ones, because
 * hyperparameters are compared across runs and `"0.001"` would not equal `0.001`.
 */
function collectParam(raw, into) {
  const eq = raw.indexOf('=');
  if (eq < 1) {
    throw new Error(`--param "${raw}": want key=value`);
  }
  const key = raw.slice(0, eq);
  const value = raw.slice(eq + 1);

  if (value === 'true' || value === 'false') {
    into[key] = value === 'true';
  } else if (value !== '' && !Number.isNaN(Number(value))) {
    into[key] = Number(value);
  } else {
    into[key] = value;
  }
  return into;
}

/** Renders `value` as JSON when --json was passed; otherwise runs `render`. */
function output(opts, value, render) {
  if (opts.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  render(value);
}

const program = new Command();

program
  .name('ash')
  .description('AshML command-line client')
  .version('0.1.0')
  .option('--endpoint <url>', 'AshML API endpoint', DEFAULT_ENDPOINT);

const endpoint = () => program.opts().endpoint;

// ---------------------------------------------------------------- projects

const project = program.command('project').description('Manage projects');

project
  .command('create <name>')
  .description('Create a project')
  .option('-d, --description <text>', 'project description', '')
  .option('--gpu-quota <n>', 'maximum GPUs', (v) => Number.parseInt(v, 10), 0)
  .option('--cpu-quota <n>', 'maximum CPUs', (v) => Number.parseInt(v, 10), 0)
  .option('--job-quota <n>', 'maximum concurrent jobs', (v) => Number.parseInt(v, 10), 0)
  .option('--json', 'emit raw JSON')
  .action(async (name, opts) => {
    const created = await api(endpoint(), '/api/v1/projects', {
      method: 'POST',
      body: {
        name,
        description: opts.description,
        quota: { gpu: opts.gpuQuota, cpu: opts.cpuQuota, jobs: opts.jobQuota },
      },
    });
    output(opts, created, (p) => console.log(`created project ${p.name} (${p.id})`));
  });

project
  .command('list')
  .description('List projects')
  .option('--json', 'emit raw JSON')
  .action(async (opts) => {
    const body = await api(endpoint(), '/api/v1/projects');
    output(opts, body, ({ projects }) => {
      if (projects.length === 0) {
        console.log('No projects yet. Create one with: ash project create <name>');
        return;
      }
      const table = newTable(['NAME', 'GPU QUOTA', 'CPU QUOTA', 'JOB QUOTA', 'AGE']);
      for (const p of projects) {
        table.push([
          p.name,
          p.quota.gpu || '-',
          p.quota.cpu || '-',
          p.quota.jobs || '-',
          age(p.created_at),
        ]);
      }
      console.log(table.toString());
    });
  });

// -------------------------------------------------------------------- jobs

/** States after which no further output will ever appear, so `--follow` can stop. */
const TERMINAL_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

const job = program.command('job').description('Manage training jobs');

job
  .command('submit <file>')
  .description('Submit a training job from a YAML or JSON file')
  .option('--experiment <id>', 'attribute this run to an experiment, overriding the manifest')
  .option('--json', 'emit raw JSON')
  .action(async (file, opts) => {
    const raw = await readFile(file, 'utf8');
    let manifest;
    try {
      manifest = parseYaml(raw);
    } catch (err) {
      throw new Error(`${file}: ${err.message}`, { cause: err });
    }

    if (opts.experiment) manifest.experiment = opts.experiment;

    const submitted = await api(endpoint(), '/api/v1/jobs', { method: 'POST', body: manifest });
    output(opts, submitted, (j) => {
      console.log(`submitted ${j.name} to project ${j.project}`);
      console.log(`  id:    ${j.id}`);
      console.log(`  state: ${j.state}`);
      if (j.experiment) console.log(`  experiment: ${j.experiment.name} (${j.experiment.id})`);
    });
  });

job
  .command('list')
  .description('List training jobs')
  .option('-p, --project <name>', 'filter by project')
  .option('-s, --state <state>', 'filter by state')
  .option('-l, --limit <n>', 'maximum rows', (v) => Number.parseInt(v, 10), 50)
  .option('--json', 'emit raw JSON')
  .action(async (opts) => {
    const query = new URLSearchParams();
    if (opts.project) query.set('project', opts.project);
    if (opts.state) query.set('state', opts.state.toUpperCase());
    query.set('limit', String(opts.limit));

    const body = await api(endpoint(), `/api/v1/jobs?${query}`);
    output(opts, body, ({ jobs }) => {
      if (jobs.length === 0) {
        console.log('No jobs found.');
        return;
      }
      const table = newTable(['NAME', 'PROJECT', 'STATE', 'PRIO', 'GPU', 'AGE']);
      for (const j of jobs) {
        table.push([
          j.name,
          j.project,
          j.state,
          j.priority,
          j.resources.gpu || '-',
          age(j.created_at),
        ]);
      }
      console.log(table.toString());
    });
  });

job
  .command('get <id>')
  .description('Show a job in detail')
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    const j = await api(endpoint(), `/api/v1/jobs/${id}`);
    output(opts, j, () => {
      console.log(`name:      ${j.name}`);
      console.log(`id:        ${j.id}`);
      console.log(`project:   ${j.project}`);
      console.log(`state:     ${j.state}`);
      console.log(`priority:  ${j.priority}`);
      console.log(`resources: ${j.resources.cpu} CPU, ${gib(j.resources.memory_bytes)} RAM, ${j.resources.gpu} GPU`);
      console.log(`image:     ${j.spec?.image ?? '-'}`);
      if (j.experiment) console.log(`experiment: ${j.experiment.name} (${j.experiment.id})`);
      console.log(`attempt:   ${j.attempt} of ${j.max_retries + 1}`);
      if (j.k8s_job_name) console.log(`k8s job:   ${j.k8s_job_name}`);
      if (j.placement?.reason) console.log(`placement: ${j.placement.reason}`);
      if (j.failure_reason) console.log(`failure:   ${j.failure_reason}`);
      console.log(`created:   ${j.created_at}`);
    });
  });

job
  .command('events <id>')
  .description('Show a job\'s event history')
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    const body = await api(endpoint(), `/api/v1/jobs/${id}/events`);
    output(opts, body, ({ events }) => {
      const table = newTable(['TIME', 'EVENT', 'TRANSITION', 'MESSAGE']);
      for (const e of events) {
        const move = e.from_state ? `${e.from_state} -> ${e.to_state}` : (e.to_state ?? '-');
        table.push([e.created_at, e.event_type, move, e.message || '-']);
      }
      console.log(table.toString());
    });
  });

job
  .command('logs <id>')
  .description('Read a job\'s container logs from the cluster')
  .option('-n, --tail <lines>', 'only the most recent N lines', (v) => Number.parseInt(v, 10))
  .option('-p, --previous', 'read the previous container instance, where a crash left its output')
  .option('-f, --follow', 'poll for new output until the job finishes')
  .option('--interval <ms>', 'how often --follow polls', (v) => Number.parseInt(v, 10), 2000)
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    const query = new URLSearchParams();
    if (opts.tail) query.set('tail', String(opts.tail));
    if (opts.previous) query.set('previous', 'true');
    const path = `/api/v1/jobs/${id}/logs?${query}`;

    if (!opts.follow) {
      const body = await api(endpoint(), path);
      output(opts, body, () => {
        // Say why there is nothing rather than printing nothing, which reads as a
        // job that produced no output when in fact none was ever readable.
        if (!body.available) {
          console.error(`no logs: ${body.reason}`);
          return;
        }
        process.stdout.write(body.logs);
      });
      return;
    }

    // Follow by polling rather than holding a stream open: the control plane's own
    // status loop polls (see services/executor.js), so a stream here would claim a
    // liveness the platform does not actually have. Only the newly appended tail is
    // printed each round.
    let printed = 0;
    for (;;) {
      const body = await api(endpoint(), path);
      if (body.available && body.logs.length > printed) {
        process.stdout.write(body.logs.slice(printed));
        printed = body.logs.length;
      }
      if (TERMINAL_STATES.has(body.state)) {
        if (!body.available) console.error(`no logs: ${body.reason}`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, opts.interval));
    }
  });

job
  .command('cancel <id>')
  .description('Cancel a job')
  .option('-r, --reason <text>', 'why it is being cancelled', 'cancelled by user')
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    const j = await api(endpoint(), `/api/v1/jobs/${id}/cancel`, {
      method: 'POST',
      body: { reason: opts.reason },
    });
    output(opts, j, () => console.log(`job ${j.name} is now ${j.state}`));
  });

// ---------------------------------------------------------------- datasets

const dataset = program.command('dataset').description('Manage datasets and their versions');

const projectOption = ['-p, --project <name>', 'project the dataset belongs to (or $ASHML_PROJECT)'];

dataset
  .command('create <name>')
  .description('Create a dataset')
  .option(...projectOption)
  .option('--json', 'emit raw JSON')
  .action(async (name, opts) => {
    const created = await api(endpoint(), `/api/v1/projects/${requireProject(opts)}/datasets`, {
      method: 'POST',
      body: { name },
    });
    output(opts, created, (d) => console.log(`created dataset ${d.project}/${d.name}`));
  });

dataset
  .command('list')
  .description('List a project\'s datasets')
  .option(...projectOption)
  .option('--json', 'emit raw JSON')
  .action(async (opts) => {
    const body = await api(endpoint(), `/api/v1/projects/${requireProject(opts)}/datasets`);
    output(opts, body, ({ datasets }) => {
      if (datasets.length === 0) {
        console.log('No datasets yet. Create one with: ash dataset create <name>');
        return;
      }
      const table = newTable(['NAME', 'VERSIONS', 'LATEST', 'AGE']);
      for (const d of datasets) {
        table.push([d.name, d.version_count, d.latest_version ?? '-', age(d.created_at)]);
      }
      console.log(table.toString());
    });
  });

dataset
  .command('add-version <dataset> <version>')
  .description('Register a new, immutable version of a dataset')
  .requiredOption('--uri <uri>', 'where the bytes live, e.g. s3://bucket/path')
  .option('--digest <digest>', 'content hash, e.g. sha256:...', '')
  .option('--size-bytes <n>', 'size in bytes', (v) => Number.parseInt(v, 10), 0)
  .option(...projectOption)
  .option('--json', 'emit raw JSON')
  .action(async (datasetName, version, opts) => {
    const created = await api(
      endpoint(),
      `/api/v1/projects/${requireProject(opts)}/datasets/${datasetName}/versions`,
      {
        method: 'POST',
        body: { version, uri: opts.uri, digest: opts.digest, size_bytes: opts.sizeBytes },
      },
    );
    output(opts, created, (v) => console.log(`registered ${v.dataset}:${v.version} -> ${v.uri}`));
  });

dataset
  .command('versions <dataset>')
  .description('List a dataset\'s versions, newest first')
  .option(...projectOption)
  .option('--json', 'emit raw JSON')
  .action(async (datasetName, opts) => {
    const body = await api(
      endpoint(),
      `/api/v1/projects/${requireProject(opts)}/datasets/${datasetName}/versions`,
    );
    output(opts, body, ({ versions }) => {
      if (versions.length === 0) {
        console.log('No versions registered yet.');
        return;
      }
      const table = newTable(['VERSION', 'SIZE', 'DIGEST', 'URI', 'AGE']);
      for (const v of versions) {
        table.push([
          v.version,
          v.size_bytes ? gib(v.size_bytes) : '-',
          v.digest ?? '-',
          v.uri,
          age(v.created_at),
        ]);
      }
      console.log(table.toString());
    });
  });

// ------------------------------------------------------------- experiments

const experiment = program.command('experiment').description('Track experiments and their reproducibility');

experiment
  .command('create <name>')
  .description('Create an experiment')
  .option(...projectOption)
  .option('--git-commit <sha>', 'commit the training code was at')
  .option('--image-digest <digest>', 'image digest; a tag pins nothing')
  .option('--dataset <name>', 'dataset this run consumes')
  .option('--dataset-version <version>', 'which version of it (required with --dataset)')
  .option('--seed <n>', 'random seed', (v) => Number.parseInt(v, 10))
  .option('--param <key=value>', 'hyperparameter, repeatable', collectParam, {})
  .option('--json', 'emit raw JSON')
  .action(async (name, opts) => {
    const created = await api(endpoint(), '/api/v1/experiments', {
      method: 'POST',
      body: {
        project: requireProject(opts),
        name,
        git_commit: opts.gitCommit,
        image_digest: opts.imageDigest,
        dataset: opts.dataset,
        dataset_version: opts.datasetVersion,
        hyperparameters: opts.param,
        random_seed: opts.seed,
      },
    });
    output(opts, created, (e) => {
      console.log(`created experiment ${e.name} (${e.id})`);
      if (!e.reproducibility.git_commit || !e.reproducibility.dataset) {
        // Say it now rather than when someone tries to reproduce the run in six months.
        console.log('  note: this experiment is not fully reproducible —'
          + ` git_commit=${e.reproducibility.git_commit ?? 'unset'},`
          + ` dataset=${e.reproducibility.dataset ? 'pinned' : 'unset'}`);
      }
    });
  });

experiment
  .command('list')
  .description('List experiments, newest first')
  .option(...projectOption)
  .option('-l, --limit <n>', 'maximum rows', (v) => Number.parseInt(v, 10), 50)
  .option('--json', 'emit raw JSON')
  .action(async (opts) => {
    const query = new URLSearchParams();
    const project = opts.project ?? process.env.ASHML_PROJECT;
    if (project) query.set('project', project);
    query.set('limit', String(opts.limit));

    const body = await api(endpoint(), `/api/v1/experiments?${query}`);
    output(opts, body, ({ experiments }) => {
      if (experiments.length === 0) {
        console.log('No experiments found.');
        return;
      }
      const table = newTable(['NAME', 'PROJECT', 'DATASET', 'COMMIT', 'JOBS', 'AGE']);
      for (const e of experiments) {
        const data = e.reproducibility.dataset;
        table.push([
          e.name,
          e.project,
          data ? `${data.name}:${data.version}` : '-',
          e.reproducibility.git_commit?.slice(0, 8) ?? '-',
          e.job_count,
          age(e.created_at),
        ]);
      }
      console.log(table.toString());
    });
  });

experiment
  .command('get <id>')
  .description('Show an experiment in detail')
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    const e = await api(endpoint(), `/api/v1/experiments/${id}`);
    output(opts, e, () => {
      const r = e.reproducibility;
      console.log(`name:      ${e.name}`);
      console.log(`id:        ${e.id}`);
      console.log(`project:   ${e.project}`);
      console.log(`commit:    ${r.git_commit ?? '-'}`);
      console.log(`image:     ${r.image_digest ?? '-'}`);
      console.log(`dataset:   ${r.dataset ? `${r.dataset.name}:${r.dataset.version}` : '-'}`);
      console.log(`seed:      ${r.random_seed ?? '-'}`);
      console.log(`jobs:      ${e.job_count}`);
      console.log(`created:   ${e.created_at}`);

      const params = Object.entries(r.hyperparameters);
      console.log(`hyperparameters:${params.length ? '' : ' -'}`);
      for (const [key, value] of params) {
        console.log(`  ${key}: ${JSON.stringify(value)}`);
      }
    });
  });

// --------------------------------------------------------------------- gpu

const gpu = program.command('gpu').description('Inspect GPU resources');

gpu
  .command('list')
  .description('List GPUs known to the platform')
  .option('--json', 'emit raw JSON')
  .action(async (opts) => {
    const body = await api(endpoint(), '/api/v1/gpus');
    output(opts, body, ({ provider, gpus }) => {
      if (gpus.length === 0) {
        console.log(`No GPUs found (provider: ${provider}).`);
        return;
      }
      const table = newTable(['IDX', 'MODEL', 'MEMORY (used/total)', 'UTIL', 'TEMP', 'HEALTH']);
      for (const g of gpus) {
        table.push([
          g.index,
          g.model,
          `${gib(g.memory_used_bytes)} / ${gib(g.memory_total_bytes)}`,
          `${g.utilization_pct}%`,
          `${g.temperature_c}C`,
          g.health,
        ]);
      }
      console.log(table.toString());

      // Never let fabricated telemetry pass for real (spec Rule 5).
      if (gpus.some((g) => g.simulated)) {
        console.log(`\n  WARNING: provider "${provider}" reports SIMULATED devices.`);
        console.log('  These are not real GPUs. Do not use these numbers as results.');
      }
    });
  });

// ------------------------------------------------------------------ system

program
  .command('version')
  .description('Show client and server versions')
  .action(async () => {
    console.log(`client:  ${program.version()}`);
    try {
      const body = await api(endpoint(), '/api/v1/version');
      console.log(`server:  ${body.version}`);
      console.log(`gpu:     ${body.gpu_provider}`);
    } catch (err) {
      console.log(`server:  unreachable (${err.message})`);
    }
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(`ash: ${err.message}`);
  process.exit(1);
}
