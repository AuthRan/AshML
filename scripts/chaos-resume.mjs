/**
 * Chaos: kill a training pod mid-run and require the platform to recover by itself.
 *
 *   A job that was killed at step N comes back as a second attempt that starts at
 *   step N — not at step zero — and finishes the work the first attempt did not.
 *
 * This is the proof for the checkpoint half of Phase 5's failure recovery. The retry
 * half (`domain/retry-policy.js`) decides *whether* to run again; the argument it was
 * built on is that a retry has to be able to change the outcome, and resuming from a
 * checkpoint is one of the two things that make it able to. Until something actually
 * consumed `ASHML_RESUME_FROM` that argument was a promise.
 *
 * Unlike `e2e.mjs`, this script does **not** drive the executor. It talks to a control
 * plane that is already running, breaks something with `kubectl`, and then only
 * watches. Hand-cranking `runOnce` would prove that the recovery code works when a test
 * calls it; what needs proving here is that the platform recovers on its own, on its
 * own loop, with nobody in the room.
 *
 * Prerequisites:
 *   make cluster && make image && make db-up && make migrate
 *   a control plane reachable *from a pod* (see the README's two-addresses note):
 *     HOST_IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')
 *     ASHML_API_ADVERTISE_URL=http://$HOST_IP:8080 ASHML_S3_ENDPOINT=http://$HOST_IP:9000 npm start
 *
 * Run: make chaos-resume
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const ENDPOINT = (process.env.ASHML_ENDPOINT ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const NAMESPACE = process.env.ASHML_K8S_NAMESPACE ?? 'ashml-jobs';
const IMAGE = process.env.TRAINER_IMAGE ?? 'ashml/trainer:v1';
const TIMEOUT_MS = Number(process.env.CHAOS_TIMEOUT_MS ?? 240_000);

/** Total steps, and how often the workload checkpoints. */
const STEPS = Number(process.env.CHAOS_STEPS ?? 60);
const CHECKPOINT_EVERY = Number(process.env.CHAOS_CHECKPOINT_EVERY ?? 5);
const STEP_SECONDS = Number(process.env.CHAOS_STEP_SECONDS ?? 0.4);

const suffix = Math.random().toString(36).slice(2, 8);
const project = `chaos-${suffix}`;

// --------------------------------------------------------------------- plumbing

async function api(method, path, body) {
  const response = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (response.status >= 400) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  }
  return payload;
}

/** Asks kubectl directly, so no assertion here rests on AshML's own account of itself. */
async function kubectl(...args) {
  const { stdout } = await exec('kubectl', args);
  return stdout.trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for something to become true, polling. Nothing is driven — the control plane's
 * own executor loop is what moves the job, and this only looks.
 */
async function until(what, predicate, { timeout = TIMEOUT_MS, interval = 1000 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
}

/** The steps a metric was reported at, in the order the API returned them. */
function stepsOf(response, name) {
  const series = (response.series ?? []).find((s) => s.name === name);
  return series ? series.points.map((p) => p.step) : [];
}

// ------------------------------------------------------------------ the story

const notes = [];
function note(line) {
  notes.push(line);
  console.log(`        ${line}`);
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('the control plane is up and can reach the cluster', async () => {
  const version = await api('GET', '/api/v1/version');
  assert.ok(version.version, 'the API must answer before anything else is attempted');

  const nodes = await api('GET', '/api/v1/nodes');
  const ready = nodes.nodes.filter((n) => n.ready).map((n) => n.name).sort();
  const fromKubectl = (await kubectl('get', 'nodes', '-o', 'jsonpath={.items[*].metadata.name}'))
    .split(/\s+/).sort();
  assert.deepEqual(ready, fromKubectl, 'AshML must be placing against the cluster that exists');
});

check('a job is submitted with one retry, and starts running', async () => {
  await api('POST', '/api/v1/projects', { name: project, description: 'chaos: killed pod resumes' });

  const job = await api('POST', '/api/v1/jobs', {
    project,
    name: `chaos-resume-${suffix}`,
    // One retry. The classifier still has to agree the failure is worth retrying — the
    // budget only makes it possible, which is the distinction the policy exists for.
    max_retries: 1,
    resources: { cpu: 1, memory_bytes: 536_870_912 },
    spec: {
      image: IMAGE,
      command: ['python', 'sdk_smoke.py'],
      env: {
        SMOKE_STEPS: String(STEPS),
        SMOKE_CHECKPOINT_EVERY: String(CHECKPOINT_EVERY),
        SMOKE_STEP_SECONDS: String(STEP_SECONDS),
      },
    },
  });
  globalThis.__job = job.id;

  const running = await until('the job to start running', async () => {
    const current = await api('GET', `/api/v1/jobs/${job.id}`);
    if (current.state === 'RUNNING') return current;
    if (['FAILED', 'CANCELLED'].includes(current.state)) {
      throw new Error(`job ${current.state} before the chaos began: ${current.failure_reason}`);
    }
    return null;
  });

  assert.equal(running.attempt, 0, 'the first attempt is attempt 0');
  globalThis.__firstK8sName = running.k8s_job_name;
  note(`attempt 0 running as ${running.k8s_job_name} on ${running.placement?.node_name}`);
});

check('it uploads a confirmed checkpoint before anything is broken', async () => {
  const ready = await until('the first READY checkpoint', async () => {
    const { artifacts } = await api('GET', `/api/v1/jobs/${globalThis.__job}/artifacts?kind=checkpoint`);
    return artifacts.find((a) => a.status === 'READY') ?? null;
  });

  note(`checkpoint ${ready.name} READY at step ${ready.step} (verified=${ready.verified})`);

  // The whole recovery rests on this artifact being real bytes rather than a row that
  // says so, which is what the artifact lifecycle is for. Ask the store, not the record.
  assert.equal(ready.verified, true, 'a resume must not be offered bytes nobody confirmed');
  assert.ok(ready.step > 0, 'a checkpoint at step 0 would make the recovery unfalsifiable');

  // Deliberately not remembered as *the* checkpoint to resume from. The run keeps
  // checkpointing after this, and which one the retry is owed is decided by when the
  // pod dies — a fact this script does not get to know in advance.
});

check('killing the pod mid-run fails the job, and the failure is explained', async () => {
  const before = await api('GET', `/api/v1/jobs/${globalThis.__job}`);

  // Let it get past the checkpoint it will resume from, so the work destroyed by the
  // kill is real work and "resumed at step N" is a claim that can be wrong.
  await sleep(3000);

  const pod = await kubectl(
    'get', 'pods', '-n', NAMESPACE, '-l', `job-name=${before.k8s_job_name}`,
    '-o', 'jsonpath={.items[0].metadata.name}',
  );
  assert.ok(pod, 'there must be a pod to kill');

  // The SDK batches metrics, so the newest step the API knows about lags the step the
  // pod is actually on. That lag is the point of reading it: it is a floor on how much
  // work the kill destroys, not an estimate of it.
  const lastStepBefore = stepsOf(
    await api('GET', `/api/v1/jobs/${globalThis.__job}/metrics?name=loss&limit=20000`), 'loss',
  ).at(-1);
  globalThis.__killedNear = lastStepBefore ?? 'not yet reported';

  note(`killing pod ${pod} (last step reported to the API: ${globalThis.__killedNear})`);
  await kubectl('delete', 'pod', pod, '-n', NAMESPACE, '--grace-period=0', '--force');

  // FAILED, or already past it: the executor requeues and relaunches within one pass,
  // so a job that died on a lost node can be back in flight before this poll looks.
  await until('the job to be observed FAILED', async () => {
    const current = await api('GET', `/api/v1/jobs/${globalThis.__job}`);
    return current.state === 'FAILED' || current.attempt === 1 ? current : null;
  });

  // Recorded, not inferred: the reason a human would read is the one the retry
  // classifier is fed, so the two cannot disagree.
  const events = (await api('GET', `/api/v1/jobs/${globalThis.__job}/events`)).events;
  const failure = events.find((e) => e.to_state === 'FAILED');
  assert.ok(failure, 'the failure must be an event, not just a column');
  note(`observed failure: ${failure.message}`);
  globalThis.__failedAt = failure.created_at;
});

check('the platform decides to retry it, and says why, and offers the checkpoint', async () => {
  const events = await until('a retry decision', async () => {
    const { events: all } = await api('GET', `/api/v1/jobs/${globalThis.__job}/events`);
    return all.some((e) => e.to_state === 'RETRYING' || e.event_type === 'JOB_RETRY_DECLINED')
      ? all
      : null;
  });

  const declined = events.find((e) => e.event_type === 'JOB_RETRY_DECLINED');
  assert.ok(!declined, `the retry was refused: ${declined?.message}`);

  const retrying = events.find((e) => e.to_state === 'RETRYING');
  note(`decision: ${retrying.message}`);
  note(`category: ${retrying.details?.category}`);

  // Which checkpoint was owed is worked out here rather than remembered from earlier:
  // the run went on checkpointing right up to the kill, and the newest one that had
  // been *confirmed* by the time the job failed is the one a resume must be given.
  // Anything older would silently throw away work the platform had already secured.
  const { artifacts } = await api('GET', `/api/v1/jobs/${globalThis.__job}/artifacts?kind=checkpoint`);
  const owed = artifacts
    .filter((a) => a.status === 'READY' && a.created_at <= globalThis.__failedAt)
    .sort((a, b) => b.step - a.step)[0];

  assert.ok(owed, 'there must have been a confirmed checkpoint at the time of the failure');
  assert.equal(
    retrying.details?.resume_artifact_id, owed.id,
    `the retry was offered ${retrying.details?.resume_step} when ${owed.step} was confirmed and available`,
  );
  assert.equal(retrying.details?.resume_step, owed.step);

  globalThis.__checkpoint = owed;
  note(`resuming from ${owed.name} (step ${owed.step}), the newest confirmed at failure time`);
});

check('the second attempt is handed the checkpoint as ASHML_RESUME_FROM', async () => {
  const relaunched = await until('attempt 1 to be launched', async () => {
    const current = await api('GET', `/api/v1/jobs/${globalThis.__job}`);
    return current.attempt === 1 && current.k8s_job_name
      && current.k8s_job_name !== globalThis.__firstK8sName
      && ['STARTING', 'RUNNING', 'SUCCEEDED'].includes(current.state)
      ? current
      : null;
  });

  // The cluster's copy of the environment, not AshML's intention to set it.
  const env = JSON.parse(await kubectl(
    'get', 'job', relaunched.k8s_job_name, '-n', NAMESPACE,
    '-o', 'jsonpath={.spec.template.spec.containers[0].env}',
  ));
  const resume = env.find((e) => e.name === 'ASHML_RESUME_FROM');

  assert.ok(resume, 'the retried pod must be told which checkpoint to resume from');
  assert.equal(resume.value, globalThis.__checkpoint.id);
  note(`attempt 1 ${relaunched.k8s_job_name}: ASHML_RESUME_FROM=${resume.value}`);
});

check('the retried run resumes from the checkpoint instead of starting over', async () => {
  const done = await until('the retried job to finish', async () => {
    const current = await api('GET', `/api/v1/jobs/${globalThis.__job}`);
    return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.state) ? current : null;
  });
  assert.equal(done.state, 'SUCCEEDED', `the retry did not recover: ${done.failure_reason}`);

  const { logs, available } = await api('GET', `/api/v1/jobs/${globalThis.__job}/logs`);
  assert.equal(available, true, 'the retried pod\'s own output must be readable');

  const resumed = logs.match(/resuming from artifact (\S+) at step (\d+)/);
  assert.ok(resumed, `the second attempt did not report resuming:\n${logs.slice(0, 500)}`);
  assert.equal(resumed[1], globalThis.__checkpoint.id);
  assert.equal(Number(resumed[2]), globalThis.__checkpoint.step);
  note(`attempt 1 log: "${resumed[0]}"`);

  // The claim that would be false if this were a restart wearing a resume's clothes.
  assert.ok(
    !/first attempt: starting from step 0/.test(logs),
    'the retried pod started from zero',
  );
});

check('the run covered every step exactly once across the two attempts', async () => {
  const series = await api('GET', `/api/v1/jobs/${globalThis.__job}/metrics?name=loss&limit=20000`);
  const steps = stepsOf(series, 'loss');
  const resumedAt = globalThis.__checkpoint.step;

  // The point of resuming, stated as arithmetic. A restart would repeat every step
  // below the checkpoint; a resume repeats none of them.
  const duplicated = [...new Set(steps.filter((s, i) => steps.indexOf(s) !== i))];
  assert.deepEqual(duplicated, [], `steps were trained twice: ${duplicated}`);

  const missing = [];
  for (let s = 0; s < STEPS; s += 1) {
    if (!steps.includes(s)) missing.push(s);
  }

  // Everything up to the checkpoint survived the kill, because the SDK flushes what it
  // has buffered before uploading a checkpoint. Without that, these points would be
  // lost for good: the resumed attempt starts *after* them, so no attempt ever reports
  // them again and the curve keeps a hole nobody can explain.
  assert.deepEqual(
    missing.filter((s) => s < resumedAt), [],
    'work the checkpoint preserved lost its metrics anyway',
  );
  // And nothing after the resume point is missing: the second attempt really did the
  // remaining work rather than jumping to the end.
  assert.deepEqual(
    missing.filter((s) => s >= resumedAt), [],
    'the resumed attempt left a gap after the checkpoint it resumed from',
  );

  assert.equal(Math.min(...steps), 0, 'the first attempt must have started at step 0');
  assert.equal(Math.max(...steps), STEPS - 1, 'the run must have finished the work it was given');

  note(`${steps.length} of ${STEPS} steps reported, none twice; resumed at step ${resumedAt}`);
  note(`killed with step ${globalThis.__killedNear} the newest the API had been told about`);
});

check('the finished run has the model the second attempt produced', async () => {
  const { artifacts } = await api('GET', `/api/v1/jobs/${globalThis.__job}/artifacts?kind=model`);
  const model = artifacts.find((a) => a.status === 'READY');
  assert.ok(model, 'a run that recovered must still produce its model');
  assert.equal(model.verified, true, 'and it must be bytes the store confirmed');
  note(`model ${model.name} READY at step ${model.step}, verified=${model.verified}`);
});

// ------------------------------------------------------------------- driver

console.log(`\nchaos: killing a training pod mid-run  (job project ${project})\n`);

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
    // Every later check depends on this one having happened, so they are not run —
    // and are not counted as passing either. A chaos run that stops early has proved
    // less than one that finishes, and the tally has to say so.
    break;
  }
}

const notRun = checks.length - passed - failed;
console.log(
  `\n${passed}/${checks.length} chaos checks passed`
  + (notRun ? ` (${notRun} not run: the failure above makes them meaningless)` : ''),
);
if (globalThis.__job) console.log(`job ${globalThis.__job}`);
process.exit(failed === 0 ? 0 : 1);
