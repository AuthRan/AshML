#!/usr/bin/env node
/**
 * `ash` — the AshML command-line client.
 *
 * The CLI contains no business logic. It calls the public API and renders the
 * result, which is what keeps it honest: anything `ash` can do, the API can do,
 * and Ashcode will later drive the same endpoints (spec §28).
 */

import { readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

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

/**
 * A byte count at whatever scale it happens to be.
 *
 * `gib` is right for node memory, which is always gigabytes. Artifacts are not: a
 * checkpoint may be 300 KB or 30 GB, and rendering the first as "0.0 GiB" tells the
 * reader nothing except that something is probably broken.
 */
function size(bytes) {
  if (!bytes) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
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

/**
 * Metrics are floats of wildly different scales — a loss of 2.31, a learning rate of
 * 3e-05. Fixed decimal places would print the learning rate as 0.00, so significant
 * digits are used and trailing zeros trimmed.
 */
function num(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e7)) return value.toExponential(3);
  return String(Number(value.toPrecision(6)));
}

/**
 * Whether AshML checked the bytes are there, as against the run having said so.
 *
 * Three distinct answers, never collapsed into two: not completed yet, completed and
 * checked, completed but uncheckable (spec Rule 5).
 */
function verifiedLabel(artifact) {
  if (artifact.verified === true) return 'yes';
  if (artifact.verified === false) return 'NO';
  return '-';
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

project
  .command('quota <name>')
  .description('Change a project\'s resource quota (0 means unlimited)')
  .option('--gpu <n>', 'maximum GPUs', (v) => Number.parseInt(v, 10))
  .option('--cpu <n>', 'maximum CPUs', (v) => Number.parseInt(v, 10))
  .option('--jobs <n>', 'maximum concurrent jobs', (v) => Number.parseInt(v, 10))
  .option('--json', 'emit raw JSON')
  .action(async (name, opts) => {
    // Only what the user named is sent, so raising one limit cannot reset another.
    const body = {};
    if (opts.gpu !== undefined) body.gpu = opts.gpu;
    if (opts.cpu !== undefined) body.cpu = opts.cpu;
    if (opts.jobs !== undefined) body.jobs = opts.jobs;

    if (Object.keys(body).length === 0) {
      console.error('nothing to change: pass at least one of --gpu, --cpu, --jobs');
      process.exitCode = 1;
      return;
    }

    const updated = await api(endpoint(), `/api/v1/projects/${name}/quota`, { method: 'PATCH', body });
    output(opts, updated, (p) => {
      console.log(`quota for ${p.name}:`);
      console.log(`  gpu:  ${p.quota.gpu || 'unlimited'}`);
      console.log(`  cpu:  ${p.quota.cpu || 'unlimited'}`);
      console.log(`  jobs: ${p.quota.jobs || 'unlimited'}`);
    });
  });

// ------------------------------------------------------------------- nodes

const nodeCmd = program.command('node').description('Inspect compute nodes and capacity');

nodeCmd
  .command('list')
  .description('List compute nodes, their capacity, and what is committed')
  .option('--json', 'emit raw JSON')
  .action(async (opts) => {
    const body = await api(endpoint(), '/api/v1/nodes');
    output(opts, body, ({ nodes }) => {
      if (nodes.length === 0) {
        console.log('No compute nodes registered. Is the cluster up? Try: make cluster');
        return;
      }

      // "usable" rather than "total": capacity already claimed by pods AshML does not
      // own is not available to it, and showing the raw total would overstate the node.
      const table = newTable(['NAME', 'READY', 'GPU (FREE/USABLE)', 'CPU (FREE/USABLE)', 'JOBS']);
      for (const n of nodes) {
        // GPU total is what the cluster will grant, not how much silicon is present —
        // showing the hardware count would imply capacity that cannot be scheduled.
        table.push([
          n.name,
          n.ready ? 'yes' : 'no',
          `${n.free.gpu}/${n.schedulable_gpus ?? 0}`,
          `${n.free.cpu}/${n.cpu_cores - (n.reserved_cpu ?? 0)}`,
          n.running_jobs ?? 0,
        ]);
      }
      console.log(table.toString());

      // Never let a simulated device pass for real hardware (spec Rule 5).
      const simulated = nodes.flatMap((n) => n.gpus).filter((g) => g.simulated);
      if (simulated.length > 0) {
        console.error(`\nwarning: ${simulated.length} of the GPUs listed are simulated, not real hardware.`);
      }

      // The single most confusing state in the system, said out loud.
      const invisible = nodes.filter((n) => n.gpus.length > 0 && n.gpu_capacity === 0);
      if (invisible.length > 0) {
        console.error(
          'warning: GPUs are present but the cluster advertises none — no device plugin '
          + 'is installed, so GPU jobs cannot be scheduled.',
        );
      }
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
      if (j.placement?.node_name) console.log(`node:      ${j.placement.node_name}`);
      if (j.placement?.reason) console.log(`placement: ${j.placement.reason}`);
      if (!j.placement?.node_name && j.state === 'QUEUED') {
        console.log(`placement: not yet placed — run 'ash job why ${j.id}' for the detail`);
      }
      // Said before the failure line: a job that is waiting has not failed, and the
      // most common question about a STARTING job is why it is still STARTING.
      if (j.pending_reason) console.log(`waiting:   ${j.pending_reason}`);
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
  .command('why <id>')
  .description('Explain why a job was, or was not, scheduled')
  .option('-p, --passes <n>', 'how many scheduling passes to show', (v) => Number.parseInt(v, 10), 3)
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    const body = await api(endpoint(), `/api/v1/jobs/${id}/scheduling?passes=${opts.passes}`);
    output(opts, body, () => {
      console.log(`job ${body.job_id} is ${body.state}`);
      if (body.placement?.node_name) {
        console.log(`placed on ${body.placement.node_name}: ${body.placement.reason}`);
      }

      if (body.passes.length === 0) {
        console.log('\nNo scheduling passes recorded yet — the job has not been claimed from the queue.');
        return;
      }

      for (const pass of body.passes) {
        // A repeated verdict is one line, not one per pass — the scheduler re-evaluates
        // every couple of seconds, so a stuck job would otherwise scroll forever.
        const repeated = pass.repeat_count > 1
          ? ` — same verdict ×${pass.repeat_count}, last at ${pass.last_seen_at}`
          : '';
        console.log(`\n${pass.at} (attempt ${pass.attempt})${repeated}`);
        const table = newTable(['NODE', 'OUTCOME', 'REASON']);
        for (const d of pass.decisions) {
          table.push([d.node_name ?? '-', d.outcome, d.reason]);
        }
        console.log(table.toString());
      }
    });
  });

job
  .command('metrics <id>')
  .description('Show the metrics a run reported')
  .option('--name <metric>', 'print the full series for one metric instead of the summary')
  .option('--since-step <n>', 'with --name, only points after this step', (v) => Number.parseInt(v, 10))
  .option('--limit <n>', 'with --name, cap the points fetched', (v) => Number.parseInt(v, 10), 2000)
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    // Without --name this asks for the summary, which is a few rows however long the
    // run was. Pulling a million points to print a last value would be rude to both ends.
    if (!opts.name) {
      const body = await api(endpoint(), `/api/v1/jobs/${id}/metrics/summary`);
      return output(opts, body, ({ metrics }) => {
        if (metrics.length === 0) {
          console.log('No metrics reported. A run reports its own numbers — see docs/adr/0009.');
          return;
        }
        const table = newTable(['METRIC', 'POINTS', 'STEPS', 'LATEST', 'AGE']);
        for (const m of metrics) {
          table.push([
            m.name,
            m.count,
            `${m.first_step}..${m.last_step}`,
            num(m.last_value),
            m.last_recorded_at ? age(m.last_recorded_at) : '-',
          ]);
        }
        console.log(table.toString());
      });
    }

    const query = new URLSearchParams({ name: opts.name, limit: String(opts.limit) });
    if (opts.sinceStep !== undefined) query.set('since_step', String(opts.sinceStep));
    const body = await api(endpoint(), `/api/v1/jobs/${id}/metrics?${query}`);
    return output(opts, body, ({ series }) => {
      const one = series[0];
      if (!one) {
        console.log(`No metric named "${opts.name}" was reported by this job.`);
        return;
      }
      const table = newTable(['STEP', 'EPOCH', 'VALUE', 'RECORDED']);
      for (const point of one.points) {
        table.push([point.step, point.epoch ?? '-', num(point.value), point.recorded_at]);
      }
      console.log(table.toString());
      console.log(`\n${one.points.length} point(s) of "${one.name}".`);
    });
  });

job
  .command('artifacts <id>')
  .description('List the checkpoints and models a run produced')
  .option('--kind <kind>', 'only artifacts of this kind, e.g. checkpoint')
  .option('--ready', 'only artifacts whose bytes are confirmed to exist')
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    const query = new URLSearchParams();
    if (opts.kind) query.set('kind', opts.kind);
    if (opts.ready) query.set('status', 'READY');

    const body = await api(endpoint(), `/api/v1/jobs/${id}/artifacts?${query}`);
    output(opts, body, ({ artifacts }) => {
      if (artifacts.length === 0) {
        console.log('No artifacts registered for this job.');
        return;
      }
      const table = newTable(['NAME', 'KIND', 'STATUS', 'CHECKED', 'STEP', 'SIZE', 'URI']);
      for (const a of artifacts) {
        table.push([
          a.name,
          a.kind,
          a.status,
          verifiedLabel(a),
          a.step ?? '-',
          size(a.size_bytes),
          a.uri,
        ]);
      }
      console.log(table.toString());

      // Only READY means the bytes are there. Printing a PENDING row like any other
      // would let someone try to resume from a checkpoint that was never written.
      const unusable = artifacts.filter((a) => a.status !== 'READY');
      if (unusable.length > 0) {
        console.log(`\n  NOTE: ${unusable.length} artifact(s) are not READY. Their bytes are`);
        console.log('  not confirmed to exist — do not resume from or serve them.');
      }

      // A different and weaker caveat: READY, but AshML never saw the bytes itself.
      const unchecked = artifacts.filter((a) => a.status === 'READY' && a.verified === false);
      if (unchecked.length > 0) {
        console.log(`\n  NOTE: ${unchecked.length} READY artifact(s) were NOT verified by AshML.`);
        console.log('  They live outside its store, so their size and digest are the run\'s own claim.');
      }
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
      console.log(`started:   ${e.started_at ?? '- (no run has reported)'}`);
      console.log(`ended:     ${e.ended_at ?? '-'}`);

      // The second half of the reproducibility record: what a run observed, as against
      // everything above, which is what it was asked for. Blank until a run reports.
      const obs = r.observed ?? {};
      const hardware = Object.entries(obs.hardware ?? {});
      if (obs.framework || obs.sdk_version || hardware.length > 0) {
        console.log('observed by the run:');
        console.log(`  framework: ${obs.framework || '-'}`);
        console.log(`  sdk:       ${obs.sdk_version || '-'}`);
        for (const [key, value] of hardware) {
          console.log(`  ${key}: ${JSON.stringify(value)}`);
        }
      }

      const params = Object.entries(r.hyperparameters);
      console.log(`hyperparameters:${params.length ? '' : ' -'}`);
      for (const [key, value] of params) {
        console.log(`  ${key}: ${JSON.stringify(value)}`);
      }
    });
  });

experiment
  .command('metrics <id>')
  .description('Compare the metrics of every run of an experiment')
  .option('--name <metric>', 'only this metric')
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    const query = new URLSearchParams();
    if (opts.name) query.set('name', opts.name);

    const body = await api(endpoint(), `/api/v1/experiments/${id}/metrics?${query}`);
    output(opts, body, ({ series }) => {
      if (series.length === 0) {
        console.log('No metrics reported by any run of this experiment.');
        return;
      }
      // One row per run per metric. Runs are never merged: two runs both report from
      // step 0, and a combined curve would be one that never happened.
      const table = newTable(['METRIC', 'RUN', 'POINTS', 'FIRST', 'LATEST']);
      for (const s of series) {
        const first = s.points[0];
        const last = s.points[s.points.length - 1];
        table.push([
          s.name,
          s.job_id.slice(0, 8),
          s.points.length,
          first ? num(first.value) : '-',
          last ? num(last.value) : '-',
        ]);
      }
      console.log(table.toString());
    });
  });

experiment
  .command('artifacts <id>')
  .description('List what every run of an experiment produced')
  .option('--kind <kind>', 'only artifacts of this kind')
  .option('--ready', 'only artifacts whose bytes are confirmed to exist')
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    const query = new URLSearchParams();
    if (opts.kind) query.set('kind', opts.kind);
    if (opts.ready) query.set('status', 'READY');

    const body = await api(endpoint(), `/api/v1/experiments/${id}/artifacts?${query}`);
    output(opts, body, ({ artifacts }) => {
      if (artifacts.length === 0) {
        console.log('No artifacts registered by any run of this experiment.');
        return;
      }
      const table = newTable(['NAME', 'KIND', 'STATUS', 'CHECKED', 'RUN', 'SIZE', 'URI']);
      for (const a of artifacts) {
        table.push([
          a.name,
          a.kind,
          a.status,
          verifiedLabel(a),
          a.job ? a.job.id.slice(0, 8) : '-',
          size(a.size_bytes),
          a.uri,
        ]);
      }
      console.log(table.toString());
    });
  });

// ------------------------------------------------------------------ model

const model = program.command('model').description('The model registry: versions and what is serving');

const modelProjectOption = ['-p, --project <name>', 'project the model belongs to (or $ASHML_PROJECT)'];

/** Renders the versions of one model. Shared by `get` and `versions`. */
function versionTable(versions) {
  const table = newTable(['VER', 'STATUS', 'CHECKED', 'METRICS', 'SIZE', 'AGE']);
  for (const v of versions) {
    const metrics = Object.entries(v.metrics ?? {})
      .map(([key, value]) => `${key}=${typeof value === 'number' ? num(value) : value}`)
      .join(' ') || '-';
    table.push([
      v.version,
      v.status,
      v.artifact ? verifiedLabel(v.artifact) : '-',
      metrics,
      size(v.artifact?.size_bytes ?? 0),
      age(v.created_at),
    ]);
  }
  return table;
}

model
  .command('create <name>')
  .description('Create a model')
  .option(...modelProjectOption)
  .option('--json', 'emit raw JSON')
  .action(async (name, opts) => {
    const created = await api(endpoint(), `/api/v1/projects/${requireProject(opts)}/models`, {
      method: 'POST',
      body: { name },
    });
    output(opts, created, () => console.log(`created model ${created.name} (${created.id})`));
  });

model
  .command('list')
  .description('List a project\'s models')
  .option(...modelProjectOption)
  .option('--json', 'emit raw JSON')
  .action(async (opts) => {
    const body = await api(endpoint(), `/api/v1/projects/${requireProject(opts)}/models`);
    output(opts, body, ({ models }) => {
      if (models.length === 0) {
        console.log('No models registered in this project.');
        return;
      }
      const table = newTable(['NAME', 'VERSIONS', 'LATEST', 'PRODUCTION', 'AGE']);
      for (const m of models) {
        table.push([
          m.name,
          m.version_count,
          m.latest_version ?? '-',
          // The question the registry exists to answer, in its own column.
          m.production_version ?? '-',
          age(m.created_at),
        ]);
      }
      console.log(table.toString());
    });
  });

model
  .command('get <name>')
  .description('Show a model and its versions')
  .option(...modelProjectOption)
  .option('--json', 'emit raw JSON')
  .action(async (name, opts) => {
    const project = requireProject(opts);
    const m = await api(endpoint(), `/api/v1/projects/${project}/models/${name}`);
    const { versions } = await api(endpoint(), `/api/v1/projects/${project}/models/${name}/versions`);

    output(opts, { ...m, versions }, () => {
      console.log(`name:       ${m.name}`);
      console.log(`project:    ${m.project}`);
      console.log(`versions:   ${m.version_count}`);
      console.log(`production: ${m.production_version ?? 'none'}`);
      console.log(`created:    ${m.created_at}`);
      if (versions.length > 0) {
        console.log('');
        console.log(versionTable(versions).toString());
      }
    });
  });

model
  .command('versions <name>')
  .description('List a model\'s versions')
  .option(...modelProjectOption)
  .option('--status <status>', 'only versions in this status')
  .option('--json', 'emit raw JSON')
  .action(async (name, opts) => {
    const query = opts.status ? `?status=${encodeURIComponent(opts.status)}` : '';
    const body = await api(
      endpoint(),
      `/api/v1/projects/${requireProject(opts)}/models/${name}/versions${query}`,
    );
    output(opts, body, ({ versions }) => {
      if (versions.length === 0) {
        console.log('No versions match.');
        return;
      }
      console.log(versionTable(versions).toString());
    });
  });

model
  .command('register <name>')
  .description('Register a new version from an artifact a run produced')
  .requiredOption('--artifact <id>', 'the artifact holding the model bytes; must be READY')
  .option('-d, --description <text>', 'what changed in this version')
  .option(...modelProjectOption)
  .option('--json', 'emit raw JSON')
  .action(async (name, opts) => {
    const body = { artifact_id: opts.artifact };
    if (opts.description) body.description = opts.description;

    const version = await api(
      endpoint(),
      `/api/v1/projects/${requireProject(opts)}/models/${name}/versions`,
      { method: 'POST', body },
    );
    output(opts, version, () => {
      console.log(`registered ${version.model} v${version.version} (${version.status})`);
      console.log(`  artifact: ${version.artifact.uri}`);
      // Registering is not deploying, and the CLI should not let anyone assume it was.
      console.log(`\nNothing is serving it yet. Promote with:`);
      console.log(`  ash model promote ${version.model} ${version.version}`);
    });
  });

/** promote / stage / archive are the same call with the status baked in. */
function statusCommand(verb, status, description) {
  model
    .command(`${verb} <name> <version>`)
    .description(description)
    .option(...modelProjectOption)
    .option('--json', 'emit raw JSON')
    .action(async (name, version, opts) => {
      const result = await api(
        endpoint(),
        `/api/v1/projects/${requireProject(opts)}/models/${name}/versions/${version}/status`,
        { method: 'POST', body: { status } },
      );
      output(opts, result, () => {
        console.log(`${result.version.model} v${result.version.version} is now ${result.version.status}`);
        if (result.displaced) {
          // Never silent: someone promoting at 3am must see what they just took out.
          console.log(
            `  v${result.displaced.version} was displaced from PRODUCTION and is now ${result.displaced.status}`,
          );
        }
      });
    });
}

statusCommand('promote', 'PRODUCTION', 'Make a version the one this model means');
statusCommand('stage', 'STAGING', 'Move a version into staging for evaluation');
statusCommand('archive', 'ARCHIVED', 'Retire a version permanently');

model
  .command('production <name>')
  .description('Show the version this model currently means')
  .option(...modelProjectOption)
  .option('--json', 'emit raw JSON')
  .action(async (name, opts) => {
    const body = await api(endpoint(), `/api/v1/projects/${requireProject(opts)}/models/${name}/production`);
    output(opts, body, ({ version }) => {
      console.log(`${version.model} v${version.version}`);
      console.log(`  artifact:  ${version.artifact.uri}`);
      console.log(`  verified:  ${version.artifact.verified === true ? 'yes' : 'NO'}`);
      console.log(`  promoted:  ${version.promoted_at}`);
      console.log(`  job:       ${version.job_id ?? '-'}`);
      console.log(`  metrics:   ${JSON.stringify(version.metrics)}`);
    });
  });

// --------------------------------------------------------------- artifact

const artifact = program.command('artifact').description('Inspect and fetch run artifacts');

artifact
  .command('get <id>')
  .description('Show an artifact in detail')
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    const a = await api(endpoint(), `/api/v1/artifacts/${id}`);
    output(opts, a, () => {
      console.log(`name:      ${a.name}`);
      console.log(`id:        ${a.id}`);
      console.log(`kind:      ${a.kind}`);
      console.log(`status:    ${a.status}`);
      console.log(`uri:       ${a.uri}`);
      console.log(`digest:    ${a.digest ?? '-'}`);
      console.log(`size:      ${size(a.size_bytes)}`);
      console.log(`step:      ${a.step ?? '-'}`);
      console.log(`job:       ${a.job ? `${a.job.name} (${a.job.id})` : '-'}`);
      console.log(`created:   ${a.created_at}`);

      // Said in words, not just a column: this is the difference between a checkpoint
      // and a claim about one.
      if (a.verified === true) {
        console.log('verified:  yes — AshML found these bytes in its store');
      } else if (a.verified === false) {
        console.log('verified:  NO — outside AshML\'s store; size and digest are the run\'s claim');
        if (a.metadata?.verification_note) {
          console.log(`           (${a.metadata.verification_note})`);
        }
      } else {
        console.log('verified:  - (not completed)');
      }
    });
  });

artifact
  .command('download <id>')
  .description('Get a time-limited URL to fetch an artifact\'s bytes')
  .option('-o, --output <file>', 'write the bytes to this file instead of printing the URL')
  .option('--json', 'emit raw JSON')
  .action(async (id, opts) => {
    const body = await api(endpoint(), `/api/v1/artifacts/${id}/download`);

    if (!opts.output) {
      return output(opts, body, () => {
        console.log(body.url);
        console.log(`\nexpires: ${body.expires_at}`);
      });
    }

    // Streamed to disk rather than buffered: a model checkpoint is exactly the kind of
    // thing that does not fit in memory, and the bytes come from the store directly.
    const res = await fetch(body.url);
    if (!res.ok) {
      throw new Error(`fetching ${body.uri} failed: ${res.status} ${res.statusText}`);
    }
    await pipeline(res.body, createWriteStream(opts.output));
    console.log(`wrote ${opts.output}`);
    return undefined;
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
