/**
 * Chaos: kill the control plane while a job is training, and start it again.
 *
 * What is under test is a claim the architecture makes everywhere and nothing had yet
 * checked: **AshML keeps no state that only exists in its own process.** Job state,
 * placement, attempts, the event log — all of it is in PostgreSQL (ADR 0001), so a
 * control plane that is SIGKILLed mid-run and restarted should pick the job back up
 * rather than lose it, invent it, or start it again.
 *
 * Three separate things get to be true or not:
 *
 *  - **The training survives.** A running pod does not depend on the control plane for
 *    anything, so killing the control plane must not touch it. If it does, AshML is a
 *    single point of failure for work that is already underway.
 *  - **The record survives.** After the restart the job is the same job — same attempt,
 *    same Kubernetes Job, same event history with nothing repeated. A control plane that
 *    re-derives state from the cluster on startup would be tempted to write a second
 *    STARTING, and the event log would stop being a history.
 *  - **The reporting does not kill the run.** The SDK's whole design rule is that a
 *    metric flush that fails must never end a training job (ADR 0009). An outage is
 *    exactly the case it was written for: the run should finish, and say plainly whether
 *    points were lost.
 *
 * Unlike the other two chaos scripts, this one **owns the control plane process**, since
 * killing it is the experiment. It refuses to run if one is already answering, rather
 * than testing a process it cannot kill.
 *
 * Prerequisites: no control plane running, and the environment a pod needs to reach the
 * API and object storage — see the README's two-addresses note.
 *
 *   HOST_IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')
 *   ASHML_API_ADVERTISE_URL=http://$HOST_IP:8080 ASHML_S3_ENDPOINT=http://$HOST_IP:9000 \
 *     make chaos-restart
 *
 * Run: make chaos-restart
 *   export ASHML_TOKEN=$(make -s token)   # the API is default-deny since Phase 10
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';

// kubectl is pinned to one context here rather than following `current-context`: this
// script starts a control plane and asserts against the cluster, and the two must be the
// same cluster. See scripts/lib/kubectl.mjs.
import { kubectl, requireContext, KUBE_CONTEXT } from './lib/kubectl.mjs';
import { withToken, explainIfUnauthorized } from './lib/token.mjs';

const ENDPOINT = (process.env.ASHML_ENDPOINT ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const PORT = Number(new URL(ENDPOINT).port || 8080);
const NAMESPACE = process.env.ASHML_K8S_NAMESPACE ?? 'ashml-jobs';
const IMAGE = process.env.TRAINER_IMAGE ?? 'ashml/trainer:v1';
const TIMEOUT_MS = Number(process.env.CHAOS_TIMEOUT_MS ?? 300_000);
const LOG_FILE = process.env.CHAOS_SERVER_LOG ?? '/tmp/ashml-chaos-restart.log';

/** Long enough that the outage lands mid-run with room on either side. */
const STEPS = Number(process.env.CHAOS_STEPS ?? 90);
const STEP_SECONDS = Number(process.env.CHAOS_STEP_SECONDS ?? 0.5);
const OUTAGE_MS = Number(process.env.CHAOS_OUTAGE_MS ?? 12_000);

const suffix = Math.random().toString(36).slice(2, 8);
const project = `chaos-${suffix}`;

// --------------------------------------------------------------------- plumbing

async function api(method, path, body) {
  const response = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: withToken(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (response.status >= 400) {
    throw new Error(
      `${method} ${path} -> ${response.status}: ${text}${explainIfUnauthorized(response.status)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(what, predicate, { timeout = TIMEOUT_MS, interval = 1000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(interval);
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
}

/** Whether anything is answering as a control plane on the port under test. */
async function isUp() {
  try {
    const response = await fetch(`${ENDPOINT}/healthz`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

let server = null;

async function startControlPlane() {
  const log = createWriteStream(LOG_FILE, { flags: 'a' });
  const child = spawn('node', ['packages/server/src/index.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // The control plane this script starts and the kubectl this script asserts with are
    // pinned to one context together. Left to `current-context`, the two could disagree,
    // and the experiment — kill the control plane, require the record to come back
    // identical — would be reading a different cluster's record than the one it killed.
    env: { ...process.env, ASHML_KUBECONFIG_CONTEXT: KUBE_CONTEXT },
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  server = child;

  await until('the control plane to come up', isUp, { timeout: 30_000, interval: 250 });
  return child;
}

/**
 * SIGKILL, not SIGTERM. A graceful shutdown is a different experiment — it gets to
 * finish what it is doing, and proves nothing about a process that stopped mid-thought.
 */
async function killControlPlane() {
  if (!server) return;
  const exited = once(server, 'exit');
  server.kill('SIGKILL');
  await exited;
  server = null;
  await until('the API to stop answering', async () => !(await isUp()), { timeout: 15_000, interval: 200 });
}

// ------------------------------------------------------------------ the story

function note(line) {
  console.log(`        ${line}`);
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('no control plane is already running, and this one starts', async () => {
  if (await isUp()) {
    throw new Error(
      `something is already serving ${ENDPOINT}. This script kills and restarts the `
      + 'control plane, which it can only do to a process it started — stop the running '
      + 'one first.',
    );
  }

  await startControlPlane();
  const version = await api('GET', '/api/v1/version');
  note(`control plane ${version.version} up on :${PORT} (pid ${server.pid}), log at ${LOG_FILE}`);
});

check('a job is submitted and starts training', async () => {
  await api('POST', '/api/v1/projects', { name: project, description: 'chaos: control plane restart' });

  const job = await api('POST', '/api/v1/jobs', {
    project,
    name: `chaos-restart-${suffix}`,
    resources: { cpu: 1, memory_bytes: 536_870_912 },
    spec: {
      image: IMAGE,
      command: ['python', 'sdk_smoke.py'],
      env: {
        SMOKE_STEPS: String(STEPS),
        SMOKE_STEP_SECONDS: String(STEP_SECONDS),
        // Checkpointing is not what is being tested, and an upload during the outage
        // would confuse "the run survived" with "the run had nothing to say".
        SMOKE_CHECKPOINT_EVERY: '0',
      },
    },
  });
  globalThis.__job = job.id;

  const running = await until('the job to start running', async () => {
    const current = await api('GET', `/api/v1/jobs/${job.id}`);
    if (['FAILED', 'CANCELLED'].includes(current.state)) {
      throw new Error(`job ${current.state} before the chaos began: ${current.failure_reason}`);
    }
    return current.state === 'RUNNING' ? current : null;
  });

  globalThis.__before = running;
  globalThis.__pod = await kubectl(
    'get', 'pods', '-n', NAMESPACE, '-l', `job-name=${running.k8s_job_name}`,
    '-o', 'jsonpath={.items[0].metadata.name}',
  );
  note(`job running as ${running.k8s_job_name}, pod ${globalThis.__pod}`);
});

check('killing the control plane does not touch the training pod', async () => {
  const linesBefore = (await kubectl('logs', globalThis.__pod, '-n', NAMESPACE)).split('\n').length;

  await killControlPlane();
  assert.equal(await isUp(), false, 'the control plane must actually be gone');
  note(`control plane killed; API is not answering`);

  await sleep(OUTAGE_MS);

  // The pod is not merely alive — it is still working. A container that had wedged
  // waiting on the API would also report Running.
  const phase = await kubectl(
    'get', 'pod', globalThis.__pod, '-n', NAMESPACE, '-o', 'jsonpath={.status.phase}',
  );
  assert.equal(phase, 'Running', 'the training pod must not depend on the control plane');

  // The workload's heartbeat, which goes to stdout and does not depend on the control
  // plane being reachable. Metrics would not do here: they are buffered in the process
  // and may never have arrived, so their absence proves nothing about whether the run
  // kept working.
  const linesAfter = (await kubectl('logs', globalThis.__pod, '-n', NAMESPACE)).split('\n').length;
  assert.ok(
    linesAfter > linesBefore + 1,
    `the pod stopped making progress during the outage (${linesBefore} -> ${linesAfter} log lines)`,
  );
  note(`${(OUTAGE_MS / 1000).toFixed(0)}s outage: pod still Running, ${linesAfter - linesBefore} new log lines`);
});

check('the restarted control plane picks the job back up from PostgreSQL', async () => {
  await startControlPlane();

  const after = await api('GET', `/api/v1/jobs/${globalThis.__job}`);
  const before = globalThis.__before;

  // The same job, not a reconstruction of one. Each of these would be a different
  // failure: a lost placement means the scheduler's decision was in memory; a bumped
  // attempt means the restart was read as a failure; a new Kubernetes Job name means
  // it launched the work a second time.
  assert.equal(after.state, 'RUNNING', `the job came back as ${after.state}`);
  assert.equal(after.k8s_job_name, before.k8s_job_name, 'it must not have launched a second Job');
  assert.equal(after.attempt, before.attempt, 'a restart is not a failed attempt');
  assert.equal(after.placement?.node_name, before.placement?.node_name, 'the placement must survive');
  note(`back as ${after.state}, attempt ${after.attempt}, still ${after.k8s_job_name}`);
});

check('the event log gained no duplicate history across the restart', async () => {
  const { events } = await api('GET', `/api/v1/jobs/${globalThis.__job}/events`);
  const path = events.map((e) => e.to_state).filter(Boolean);

  // A control plane that re-derived state from the cluster on startup would write a
  // second STARTING or RUNNING here, and the event log would stop being a history of
  // what happened and become a log of what was noticed.
  assert.deepEqual(
    path, ['CREATED', 'QUEUED', 'SCHEDULING', 'STARTING', 'RUNNING'],
    `the restart added transitions: ${path.join(' -> ')}`,
  );
  note(`event path unchanged: ${path.join(' -> ')}`);
});

check('the run finishes, and says whether the outage cost it any metrics', async () => {
  const done = await until('the job to finish', async () => {
    const current = await api('GET', `/api/v1/jobs/${globalThis.__job}`);
    return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.state) ? current : null;
  });

  // The rule the SDK is built around: reporting must never be the reason a run dies.
  // An unreachable control plane is precisely the case it was written for.
  assert.equal(done.state, 'SUCCEEDED', `the outage killed the run: ${done.failure_reason}`);

  const { logs } = await api('GET', `/api/v1/jobs/${globalThis.__job}/logs`);
  const dropped = logs.match(/(\d+) metric point\(s\) were dropped/);

  // Counted in *points*, not steps. The workload reports three metrics per step, so a
  // flush lost during the outage takes three points per step with it — comparing the
  // SDK's count against a count of missing steps would disagree by a factor of three
  // and look like a bug in whichever of the two you trusted less.
  const { series } = await api('GET', `/api/v1/jobs/${globalThis.__job}/metrics?limit=20000`);
  const missingPoints = series.reduce((total, s) => {
    const steps = new Set(s.points.map((p) => p.step));
    return total + (STEPS - steps.size);
  }, 0);
  const recorded = series.reduce((total, s) => total + s.points.length, 0);

  // Whatever the outage cost, it has to be *said*. A curve with a hole in it looks like
  // a training problem until you know it was a network one, which is why the SDK counts
  // dropped points and reports them at the end rather than failing quietly.
  if (missingPoints) {
    assert.ok(dropped, `${missingPoints} metric points are missing and the run never said so`);
    assert.equal(
      Number(dropped[1]), missingPoints,
      `the run reported ${dropped[1]} dropped points but ${missingPoints} are missing`,
    );
    note(`${missingPoints} metric point(s) lost to the outage, and the run reported exactly that`);
  } else {
    // The SDK's retries are jittered and bounded; a short outage can be ridden out.
    assert.ok(!dropped, `the run reported dropping ${dropped?.[1]} points, but none are missing`);
    note(`no metrics lost: the SDK's retries outlasted a ${(OUTAGE_MS / 1000).toFixed(0)}s outage`);
  }
  note(`${recorded} metric points recorded across ${series.length} series; job ${done.state}`);
});

// ------------------------------------------------------------------- driver

await requireContext();

console.log(`\nchaos: killing the control plane mid-run  (job project ${project})`);
console.log(`  cluster: ${KUBE_CONTEXT}\n`);

let passed = 0;
let failed = 0;
for (const { name, fn } of checks) {
  const started = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    break;
  }
}

// The control plane this script started is this script's to clean up — including when a
// check threw between killing it and starting it again.
if (server) {
  server.kill('SIGTERM');
}

const notRun = checks.length - passed - failed;
console.log(
  `\n${passed}/${checks.length} chaos checks passed`
  + (notRun ? ` (${notRun} not run: the failure above makes them meaningless)` : ''),
);
if (globalThis.__job) console.log(`job ${globalThis.__job}`);
process.exit(failed === 0 ? 0 : 1);
