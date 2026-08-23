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

// Asks kubectl directly, so no assertion here rests on AshML's own account of itself —
// and pinned to one context rather than following `current-context`, because this script
// deletes a pod. See scripts/lib/kubectl.mjs.
import { kubectl, requireContext, KUBE_CONTEXT } from './lib/kubectl.mjs';

const ENDPOINT = (process.env.ASHML_ENDPOINT ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const NAMESPACE = process.env.ASHML_K8S_NAMESPACE ?? 'ashml-jobs';
const TIMEOUT_MS = Number(process.env.CHAOS_TIMEOUT_MS ?? 300_000);

/**
 * Two workloads, because they prove different halves of the same claim.
 *
 * `smoke` is fast and its state is one integer, so it exercises the *platform* path —
 * artifact offered, fetched, verified, resumed — in about a minute, which is what makes
 * this runnable often enough to catch a regression.
 *
 * `resnet` is the real one. Its checkpoint is a state dict, an optimizer's momentum
 * buffers and a learning-rate schedule, restored strictly into a freshly built
 * architecture, and none of that is exercised by an integer in a JSON file. It takes
 * minutes rather than seconds.
 */
const WORKLOADS = {
  smoke: {
    image: process.env.TRAINER_IMAGE ?? 'ashml/trainer:v1',
    command: ['python', 'sdk_smoke.py'],
    resources: { cpu: 1, memory_bytes: 536_870_912 },
    steps: Number(process.env.CHAOS_STEPS ?? 60),
    checkpointEvery: Number(process.env.CHAOS_CHECKPOINT_EVERY ?? 5),
    logEvery: 1,
    env: (w) => ({
      SMOKE_STEPS: String(w.steps),
      SMOKE_CHECKPOINT_EVERY: String(w.checkpointEvery),
      SMOKE_STEP_SECONDS: String(process.env.CHAOS_STEP_SECONDS ?? 0.4),
    }),
  },
  resnet: {
    image: process.env.RESNET_IMAGE ?? 'ashml/resnet-trainer:v1',
    command: ['python', 'resnet_cifar.py'],
    resources: { cpu: 4, memory_bytes: 4_294_967_296 },
    steps: Number(process.env.CHAOS_STEPS ?? 40),
    checkpointEvery: Number(process.env.CHAOS_CHECKPOINT_EVERY ?? 10),
    logEvery: 5,
    // Its checkpoint carries a OneCycle schedule, so the resumed run's learning rate is
    // checkable evidence about what was restored — see the check that uses this.
    restoresSchedule: true,
    env: (w) => ({
      // Bounded by MAX_STEPS, so this trains nothing worth quoting and says so in its
      // own logs. What is under test is the resume, not the accuracy.
      EPOCHS: '1',
      MAX_STEPS: String(w.steps),
      CHECKPOINT_EVERY: String(w.checkpointEvery),
      MAX_EVAL_BATCHES: '4',
      LOG_EVERY: String(w.logEvery),
      BATCH_SIZE: '128',
      SEED: '1337',
      DATALOADER_WORKERS: '2',
      OMP_NUM_THREADS: '4',
    }),
  },
};

const WORKLOAD = process.env.CHAOS_WORKLOAD ?? 'smoke';
const workload = WORKLOADS[WORKLOAD];
if (!workload) {
  console.error(`unknown CHAOS_WORKLOAD "${WORKLOAD}"; known: ${Object.keys(WORKLOADS).join(', ')}`);
  process.exit(2);
}

const STEPS = workload.steps;
const CHECKPOINT_EVERY = workload.checkpointEvery;

/** The steps this workload is expected to report, given how often it logs. */
const EXPECTED_STEPS = [];
for (let s = 0; s < STEPS; s += workload.logEvery) EXPECTED_STEPS.push(s);

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
    resources: workload.resources,
    spec: {
      image: workload.image,
      command: workload.command,
      env: workload.env(workload),
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

  // Both workloads announce the same fact in their own words; the artifact id is a
  // UUID, and whatever separates it from the step is punctuation neither of them
  // should have to agree on.
  const resumed = logs.match(/resuming from artifact ([0-9a-f-]{36})\D+step (\d+)/);
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

check('no work before the checkpoint was done twice, and none after it was skipped', async () => {
  const series = await api('GET', `/api/v1/jobs/${globalThis.__job}/metrics?name=loss&limit=20000`);
  const steps = stepsOf(series, 'loss');
  const resumedAt = globalThis.__checkpoint.step;
  const twice = (list) => [...new Set(list.filter((s, i) => list.indexOf(s) !== i))];

  // The point of resuming, stated as arithmetic. A restart would repeat every step
  // below the checkpoint. A resume repeats none of them, and this is the assertion that
  // a resume dressed up as a restart would fail.
  const repeatedBefore = twice(steps.filter((s) => s < resumedAt));
  assert.deepEqual(repeatedBefore, [], `work before the checkpoint was redone: ${repeatedBefore}`);

  // Everything up to the checkpoint survived the kill, because the SDK flushes what it
  // has buffered before uploading a checkpoint. Without that these points would be lost
  // for good: the resumed attempt starts after them, so no attempt ever reports them
  // again and the curve keeps a hole nobody can explain.
  const missing = EXPECTED_STEPS.filter((s) => !steps.includes(s));
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
  assert.equal(Math.max(...steps), EXPECTED_STEPS.at(-1), 'the run must have finished its work');

  // Steps *after* the checkpoint may be reported twice, and that is correct rather than
  // tolerated: the work since the last checkpoint is genuinely done again, and metrics
  // are append-only by design (reporting a step twice records both points). What bounds
  // it is the checkpoint interval — which is exactly the thing a resume is for.
  const repeatedAfter = twice(steps.filter((s) => s >= resumedAt));
  assert.ok(
    repeatedAfter.length <= Math.ceil(CHECKPOINT_EVERY / workload.logEvery) + 1,
    `${repeatedAfter.length} steps were redone, more than the ${CHECKPOINT_EVERY}-step `
    + 'checkpoint interval can explain',
  );

  note(`${EXPECTED_STEPS.length} expected steps all reported; resumed at step ${resumedAt}`);
  note(
    repeatedAfter.length
      ? `${repeatedAfter.length} step(s) redone after the checkpoint (${repeatedAfter.join(', ')}), `
        + 'reported twice because they were genuinely trained twice'
      : 'no step was reported twice',
  );
  note(`killed with step ${globalThis.__killedNear} the newest the API had been told about`);
});

check('the learning-rate schedule continued rather than restarting', async () => {
  if (!workload.restoresSchedule) {
    note(`the ${WORKLOAD} workload has no schedule state to carry; nothing to check here`);
    return;
  }

  const series = await api('GET', `/api/v1/jobs/${globalThis.__job}/metrics?name=lr&limit=20000`);
  const points = (series.series ?? []).find((s) => s.name === 'lr')?.points ?? [];
  assert.ok(points.length >= 3, 'the run must have reported its learning rate');

  const byStep = new Map(points.map((p) => [p.step, p.value]));
  const first = points[0];
  const atResume = byStep.get(globalThis.__checkpoint.step);
  assert.ok(atResume !== undefined, 'the resumed attempt must have reported a learning rate');

  // This is the failure that hides. Restoring the weights and the optimizer but not the
  // schedule gives a resumed run that trains, converges and looks entirely healthy —
  // while following a different learning-rate curve from the one the experiment record
  // says it followed. Had the schedule restarted at the resume, this point would repeat
  // the value the cycle began with.
  assert.notEqual(
    atResume.toFixed(6), first.value.toFixed(6),
    `the learning rate at the resume step is the cycle's opening value (${first.value}); `
    + 'the schedule restarted instead of continuing',
  );

  note(`lr across the kill: ${points.map((p) => `${p.step}:${p.value.toFixed(4)}`).join('  ')}`);
  note(`one cycle, not two: it opened at ${first.value.toFixed(5)} and was ${atResume.toFixed(5)} at the resume`);
});

check('the finished run has the model the second attempt produced', async () => {
  const { artifacts } = await api('GET', `/api/v1/jobs/${globalThis.__job}/artifacts?kind=model`);
  const model = artifacts.find((a) => a.status === 'READY');
  assert.ok(model, 'a run that recovered must still produce its model');
  assert.equal(model.verified, true, 'and it must be bytes the store confirmed');
  note(`model ${model.name} READY at step ${model.step}, verified=${model.verified}`);
});

// ------------------------------------------------------------------- driver

await requireContext();

console.log(`\nchaos: killing a training pod mid-run  (job project ${project})`);
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
