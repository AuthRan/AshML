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

const job = program.command('job').description('Manage training jobs');

job
  .command('submit <file>')
  .description('Submit a training job from a YAML or JSON file')
  .option('--json', 'emit raw JSON')
  .action(async (file, opts) => {
    const raw = await readFile(file, 'utf8');
    let manifest;
    try {
      manifest = parseYaml(raw);
    } catch (err) {
      throw new Error(`${file}: ${err.message}`, { cause: err });
    }

    const submitted = await api(endpoint(), '/api/v1/jobs', { method: 'POST', body: manifest });
    output(opts, submitted, (j) => {
      console.log(`submitted ${j.name} to project ${j.project}`);
      console.log(`  id:    ${j.id}`);
      console.log(`  state: ${j.state}`);
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
      console.log(`attempt:   ${j.attempt} of ${j.max_retries + 1}`);
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
