/**
 * Measures AshML. Every number this prints was produced by the run that printed it.
 *
 * Spec §37: benchmarks report measured numbers only. So this script exists before
 * `docs/benchmarks.md` does — the document records a run of *this*, with the host it ran
 * on, rather than figures somebody typed. Re-run it and the numbers move; that is the
 * point.
 *
 *   export ASHML_TOKEN=$(make -s token)   # the API is default-deny since Phase 10
 *   make bench                       # everything, against a running control plane
 *   node scripts/bench.mjs --api     # one section
 *   node scripts/bench.mjs --json    # for scripting
 *
 * It talks to the control plane over HTTP rather than building its own app, because what
 * is being measured is what a user gets, including the event loop that is also running a
 * scheduler. It never drives the executor itself: scheduling latency means the latency of
 * the real loop, and a benchmark that calls `runOnce` measures a function call.
 *
 * Three things are deliberately reported alongside the numbers, because without them the
 * numbers are worth nothing:
 *
 *   - **n**, always. A p99 over 20 samples is a maximum wearing a percentile's name.
 *   - **the floor**, where one exists. Scheduling latency cannot be below the executor's
 *     poll interval (ADR 0007), so quoting the measurement without the interval invites
 *     the reader to think it is a queue delay.
 *   - **where it ran**. This host runs the cluster it is measuring, so every network
 *     number here is loopback. That is not what a cluster on a network does.
 */

import os from 'node:os';
import process from 'node:process';
import { withToken, explainIfUnauthorized } from './lib/token.mjs';

const ENDPOINT = process.env.ASHML_ENDPOINT ?? 'http://127.0.0.1:8080';
const PROJECT = process.env.BENCH_PROJECT ?? null;
const DEPLOYMENT = process.env.BENCH_DEPLOYMENT ?? null;
const IMAGE = process.env.TRAINER_IMAGE ?? 'ashml/trainer:v1';
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? 180_000);

const flags = new Set(process.argv.slice(2));
const asJson = flags.has('--json');
const sections = ['api', 'scheduling', 'inference'].filter(
  (name) => flags.has(`--${name}`) || !['api', 'scheduling', 'inference'].some((s) => flags.has(`--${s}`)),
);

// --------------------------------------------------------------- primitives

async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(new URL(path, ENDPOINT), {
    method,
    headers: withToken(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message = payload?.error?.message ?? res.statusText;
    throw new Error(
      `${method} ${path} -> ${res.status}: ${message}${explainIfUnauthorized(res.status)}`,
    );
  }
  return payload;
}

/**
 * Percentiles by nearest-rank, on a copy.
 *
 * Nearest-rank rather than interpolating: every value reported is then a measurement that
 * actually happened, which matters more here than smoothness. With n below 100 an
 * interpolated p99 is arithmetic performed on two samples.
 */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return {
    n: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

const ms = (value) => `${value.toFixed(1)}`;
const sleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

/** Times `fn` `count` times, discarding `warmup` runs first. */
async function timeIt(count, fn, { warmup = 5 } = {}) {
  for (let i = 0; i < warmup; i += 1) await fn();
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const started = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return stats(samples);
}

function table(rows, head) {
  const widths = head.map((column, index) => Math.max(
    column.length, ...rows.map((row) => String(row[index]).length),
  ));
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ');
  console.log(`  ${line(head)}`);
  console.log(`  ${widths.map((width) => '-'.repeat(width)).join('  ')}`);
  for (const row of rows) console.log(`  ${line(row)}`);
}

const report = {};

function section(title) {
  if (!asJson) {
    console.log('');
    console.log(title);
    console.log('='.repeat(title.length));
  }
}

// ------------------------------------------------------------------ context

async function describeHost() {
  const version = await api('/api/v1/version');
  const nodes = await api('/api/v1/nodes');
  const cpus = os.cpus();

  return {
    endpoint: ENDPOINT,
    server_version: version.version,
    gpu_provider: version.gpu_provider,
    host_cpu: cpus[0]?.model?.trim() ?? 'unknown',
    host_cpu_count: cpus.length,
    host_memory_bytes: os.totalmem(),
    // Which is to say: the cluster and the thing measuring it are the same machine, and
    // every latency below crosses loopback rather than a network.
    cluster_nodes: nodes.nodes.filter((node) => node.ready).map((node) => node.name),
    measured_at: new Date().toISOString(),
  };
}

// -------------------------------------------------------------- api latency

async function benchApi(context) {
  section('Control-plane API latency');

  const project = PROJECT ?? context.cluster_project;
  const paths = [
    ['GET /healthz', '/healthz'],
    ['GET /api/v1/version', '/api/v1/version'],
    ['GET /api/v1/nodes', '/api/v1/nodes'],
    ['GET /api/v1/projects', '/api/v1/projects'],
    ['GET /api/v1/jobs?limit=20', '/api/v1/jobs?limit=20'],
    ...(project ? [[`GET …/${project}/deployments`, `/api/v1/projects/${project}/deployments`]] : []),
  ];

  const rows = [];
  const measured = {};
  for (const [label, path] of paths) {
    const result = await timeIt(100, () => api(path));
    measured[path] = result;
    rows.push([label, result.n, ms(result.p50), ms(result.p95), ms(result.p99), ms(result.max)]);
  }

  if (!asJson) {
    table(rows, ['endpoint', 'n', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms']);
    console.log('');
    console.log('  Sequential, one request at a time, over loopback. This is the floor —');
    console.log('  what the control plane costs when nothing is contending for it.');
  }
  report.api = measured;
}

// -------------------------------------------------------- scheduling latency

/**
 * How long a submitted job takes to become a running container.
 *
 * The interesting part is what it is made of, so the two halves are reported separately:
 * the platform's own decision (submitted -> the executor has claimed it and created a
 * Kubernetes Job) and the cluster's (that Job's pod actually running). The first is
 * AshML's to answer for. The second is image pulls and kubelet, and reporting them as one
 * number would let a slow scheduler hide behind containerd.
 */
// No `context` parameter, unlike its two siblings: this benchmark measures the executor's
// own poll cycle and needs nothing from the host description. The runners are called
// uniformly with one, and JavaScript is content to ignore it.
async function benchScheduling() {
  section('Scheduling latency');

  const suffix = Math.random().toString(36).slice(2, 8);
  const project = `bench-${suffix}`;
  await api('/api/v1/projects', { method: 'POST', body: { name: project, description: 'benchmark' } });

  const count = Number(process.env.BENCH_JOBS ?? 5);
  const interval = Number(process.env.ASHML_EXECUTOR_INTERVAL_MS ?? 2000);
  const toStarting = [];
  const toRunning = [];

  for (let i = 0; i < count; i += 1) {
    // Submissions are spaced by a uniform random offset across one poll interval, so the
    // measurement is not phase-locked to the loop. Submitting each job the instant the
    // previous one started running would sample the same point in every cycle and report
    // a distribution that is an artefact of the benchmark's own timing.
    await sleep(Math.random() * interval);

    const submittedAt = Date.now();
    const job = await api('/api/v1/jobs', {
      method: 'POST',
      body: {
        project,
        name: `bench-${suffix}-${i}`,
        spec: { image: IMAGE, env: { STEPS: '1', STEP_SECONDS: '0.1' } },
        resources: { cpu: 1 },
      },
    });

    let starting = null;
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = await api(`/api/v1/jobs/${job.id}`);
      if (starting === null && ['STARTING', 'RUNNING', 'SUCCEEDED', 'FAILED'].includes(current.state)) {
        starting = Date.now() - submittedAt;
      }
      if (['RUNNING', 'SUCCEEDED', 'FAILED'].includes(current.state)) {
        toStarting.push(starting);
        toRunning.push(Date.now() - submittedAt);
        break;
      }
      // 50 ms, well under the executor's own interval, so the sampling adds far less
      // than what is being measured.
      await sleep(50);
    }
    if (toRunning.length !== i + 1) {
      throw new Error(`job ${job.id} did not start within ${TIMEOUT_MS}ms`);
    }
  }

  const startingStats = stats(toStarting);
  const runningStats = stats(toRunning);

  if (!asJson) {
    table([
      ['submitted → Kubernetes Job created', startingStats.n, ms(startingStats.min), ms(startingStats.p50), ms(startingStats.max)],
      ['submitted → container running', runningStats.n, ms(runningStats.min), ms(runningStats.p50), ms(runningStats.max)],
    ], ['interval', 'n', 'min ms', 'p50 ms', 'max ms']);
    console.log('');
    console.log(`  The executor polls every ${interval} ms (ADR 0007) and submissions are spread`);
    console.log('  uniformly across one interval, so the expected median is half of it. The');
    console.log('  first row measures that poll, not a queue. The second adds the kubelet and');
    console.log('  the image, which are not AshML’s to answer for — hence two rows, not one.');
  }
  report.scheduling = {
    project,
    executor_interval_ms: interval,
    to_kubernetes_job_ms: startingStats,
    to_container_running_ms: runningStats,
  };
}

// -------------------------------------------------------- inference latency

/**
 * Latency against a real deployment, swept over batch size.
 *
 * Per-image cost is the number worth having and the one a single-image measurement gets
 * most wrong: there is a fixed cost per request that a batch of one pays in full. Both
 * are reported so the difference is visible rather than averaged into a claim.
 */
async function benchInference(context) {
  section('Inference latency');

  const project = PROJECT ?? context.cluster_project;
  if (!project) {
    console.log('  skipped: set BENCH_PROJECT to a project with a deployment');
    return;
  }

  const { deployments } = await api(`/api/v1/projects/${project}/deployments`);
  const serving = DEPLOYMENT
    ? deployments.find((d) => d.name === DEPLOYMENT)
    : deployments.find((d) => d.status === 'READY');

  if (!serving) {
    console.log(`  skipped: no READY deployment in project "${project}"`);
    return;
  }

  // A fixed grey image. The content does not affect the timing and a constant one keeps
  // the request bodies identical across batch sizes.
  const image = Array.from({ length: 32 }, () => Array.from({ length: 32 }, () => [128, 128, 128]));
  const batches = (process.env.BENCH_BATCHES ?? '1,2,4,8,16,32,64').split(',').map(Number);

  const rows = [];
  const measured = {};
  for (const size of batches) {
    const instances = Array.from({ length: size }, () => image);
    let inPod = 0;
    const result = await timeIt(20, async () => {
      const answer = await api(
        `/api/v1/projects/${project}/deployments/${serving.name}/predict`,
        { method: 'POST', body: { instances } },
      );
      inPod = answer.latency_ms;
    }, { warmup: 3 });

    measured[size] = { ...result, last_pod_latency_ms: inPod };
    rows.push([
      size, result.n, ms(result.p50), ms(result.p95),
      ms(result.p50 / size), (1000 / (result.p50 / size)).toFixed(0), ms(inPod),
    ]);
  }

  if (!asJson) {
    table(rows, ['batch', 'n', 'p50 ms', 'p95 ms', 'ms/image', 'images/s', 'pod ms']);
    console.log('');
    console.log(`  ${serving.model} v${serving.target?.version} on ${serving.replicas} replica(s),`);
    console.log(`  ${serving.cpu} CPU each, no GPU (ADR 0008). "pod ms" is the forward pass as`);
    console.log('  the model server measured it; the difference is the API server proxy and');
    console.log('  this control plane. Sequential: this is latency, not saturation.');
  }
  report.inference = {
    deployment: serving.name,
    model: serving.model,
    version: serving.target?.version ?? null,
    artifact_id: serving.target?.artifact_id ?? null,
    replicas: serving.replicas,
    cpu_per_replica: serving.cpu,
    by_batch_size: measured,
  };
}

// ------------------------------------------------------------------- driver

const context = await describeHost();
context.cluster_project = PROJECT;
report.context = context;

if (!asJson) {
  console.log('AshML benchmarks');
  console.log(`  endpoint:  ${context.endpoint} (server ${context.server_version})`);
  console.log(`  host:      ${context.host_cpu_count}x ${context.host_cpu}`);
  console.log(`  cluster:   ${context.cluster_nodes.join(', ') || 'none ready'}`);
  console.log(`  measured:  ${context.measured_at}`);
  console.log('');
  console.log('  The cluster runs on this machine, so every latency below crosses loopback.');
  console.log('  A cluster on a network does not look like this.');
}

const runners = { api: benchApi, scheduling: benchScheduling, inference: benchInference };
for (const name of sections) {
  await runners[name](context);
}

if (asJson) console.log(JSON.stringify(report, null, 2));
