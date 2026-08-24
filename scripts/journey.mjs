/**
 * The §50 Core User Journey, run start to finish.
 *
 * This is the Phase 5 exit criterion and the thing the spec calls "the final demo". Every
 * piece of it already had a proof — `make e2e` for execution, `make e2e-scheduler` for
 * placement, `make e2e-rollout` for routing, three chaos scripts for recovery — and
 * nothing ran the nine steps as one story, against one project, in order. A platform
 * whose parts each work is not the same claim as a platform someone can use end to end,
 * and the gap between those two claims is where a demo falls over.
 *
 * **It drives the CLI, not the API.** Every other script here talks HTTP, deliberately,
 * so that what is under test is the platform rather than the client. This one is the
 * opposite on purpose: §50 is written entirely in `ash` commands, so the journey is what
 * a person types. That is not a stylistic choice — the commit before last fixed
 * `ash deployment rollout --version 2` printing the client version and exiting 0, which
 * every HTTP-level test in this repo was structurally unable to see.
 *
 * What it will not claim:
 *
 *  - **Step 3 says "GPU NODE SELECTED".** No GPU reaches a node on this host (ADR 0008),
 *    so the scheduler chose on CPU and the decision record says exactly that. The journey
 *    prints the reason rather than quietly reading the step as satisfied.
 *  - **Step 8 says "Dashboard displays".** A script cannot assert a rendered panel. It
 *    asserts the thing underneath — that every series those panels read is present and
 *    has moved during this journey — and names what it is not checking.
 *  - **Step 10 is Ashcode**, which is post-v1 (roadmap Phase 9). It is not run and not
 *    faked; the journey ends by saying so.
 *  - The model is deliberately undertrained (see the manifest). Step 7 prints what it
 *    predicted next to the true labels instead of asserting an accuracy it has not
 *    earned.
 *
 * Prerequisites, all real:
 *   make cluster && make resnet-image && make model-server-image && make cifar-png
 *   make db-up && make migrate
 *   a control plane running and reachable *from a pod* — see the README's two addresses:
 *     HOST_IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')
 *     ASHML_API_ADVERTISE_URL=http://$HOST_IP:8080 ASHML_S3_ENDPOINT=http://$HOST_IP:9000 npm start
 *   and a token, because the API is default-deny since Phase 10:
 *     export ASHML_TOKEN=$(make -s token)
 *   The `ash` invocations below inherit it from the environment. The *pods* are handed
 *   their own credentials by the control plane and need nothing here.
 *
 * Run: make journey
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Pinned to one context rather than following `current-context`, because step 9 deletes
// pods. See scripts/lib/kubectl.mjs.
import { kubectl, requireContext, KUBE_CONTEXT } from './lib/kubectl.mjs';

const exec = promisify(execFile);

const ENDPOINT = (process.env.ASHML_ENDPOINT ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const NAMESPACE = process.env.ASHML_K8S_NAMESPACE ?? 'ashml-jobs';
const CLI = fileURLToPath(new URL('../packages/cli/src/index.js', import.meta.url));
const MANIFEST = process.env.JOURNEY_MANIFEST ?? 'examples/training/resnet-cifar-journey.yaml';
const RETRY_MANIFEST = process.env.JOURNEY_RETRY_MANIFEST ?? 'examples/training/sdk-smoke-retry.yaml';
const PNG_DIR = process.env.JOURNEY_PNG_DIR ?? 'data/cifar-png';
const IMAGES = Number(process.env.JOURNEY_IMAGES ?? 8);
const TIMEOUT_MS = Number(process.env.JOURNEY_TIMEOUT_MS ?? 1_200_000);

const suffix = Math.random().toString(36).slice(2, 8);
const project = `vision-${suffix}`;
const MODEL = 'resnet18-cifar10';

// --------------------------------------------------------------------- plumbing

/**
 * Runs `ash`, exactly as the spec writes it.
 *
 * `--json` is appended by `ashJson`, never by this: a command whose human output throws
 * would still pass a test that only ever asked for JSON, and the human output is the
 * demo.
 */
async function ash(...args) {
  const { stdout, stderr } = await exec('node', [CLI, ...args], {
    env: { ...process.env, ASHML_ENDPOINT: ENDPOINT, ASHML_PROJECT: project },
    maxBuffer: 32 * 1024 * 1024,
  });
  return `${stdout}${stderr}`;
}

async function ashJson(...args) {
  const out = await ash(...args, '--json');
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`\`ash ${args.join(' ')} --json\` did not print JSON: ${out.slice(0, 400)}`);
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(what, predicate, { timeout = TIMEOUT_MS, interval = 2000 } = {}) {
  const deadline = Date.now() + timeout;
  let reason = null;
  const because = (why) => { reason = why; };

  while (Date.now() < deadline) {
    const result = await predicate(because);
    if (result) return result;
    await sleep(interval);
  }
  throw new Error(
    `timed out after ${(timeout / 1000).toFixed(0)}s waiting for ${what}`
    + (reason ? `: ${reason}` : ''),
  );
}

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/**
 * Watches a job to a terminal state, recording every distinct state it passed through.
 *
 * The path is the assertion in step 3, not just the destination: a job that appears as
 * RUNNING having never been observed SCHEDULING would mean the states are being written
 * after the fact rather than driven, and the event log would be a summary rather than a
 * history.
 */
async function watchJob(id, { onState } = {}) {
  const seen = [];
  const job = await until(`job ${id} to finish`, async (because) => {
    const current = await ashJson('job', 'get', id);
    if (seen.at(-1) !== current.state) {
      seen.push(current.state);
      onState?.(current.state, current);
    }
    if (!TERMINAL.includes(current.state)) {
      because(`still ${current.state}`);
      return null;
    }
    return current;
  }, { interval: 1500 });
  return { job, states: seen };
}

/** The control plane's own /metrics, parsed just enough to look a series up. */
async function scrape() {
  const response = await fetch(`${ENDPOINT}/metrics`);
  assert.equal(response.status, 200, 'the control plane does not expose /metrics');
  const text = await response.text();

  const samples = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[\d.eE+]+|NaN)$/.exec(line.trim());
    if (!match) continue;
    const [, name, labels = '', value] = match;
    const list = samples.get(name) ?? [];
    list.push({ labels, value: Number(value) });
    samples.set(name, list);
  }
  return {
    raw: text,
    has: (name) => samples.has(name),
    sum: (name) => (samples.get(name) ?? []).reduce((total, s) => total + s.value, 0),
    all: (name) => samples.get(name) ?? [],
  };
}

/** The label CIFAR-10 test images carry in their filename: `test-00007-frog.png`. */
const trueLabel = (file) => file.replace(/\.png$/, '').split('-').slice(2).join('-');

function line(text = '') {
  console.log(text ? `      ${text}` : '');
}

// ------------------------------------------------------------------- the journey

const steps = [];
const step = (number, title, fn) => steps.push({ number, title, fn });

step(1, 'Create project', async () => {
  await ash('project', 'create', project, '--gpu-quota', '2');

  const { projects } = await ashJson('project', 'list');
  const created = projects.find((p) => p.name === project);
  assert.ok(created, `\`ash project list\` does not show ${project}`);
  line(`${project} created`);
});

step(2, 'Submit training', async () => {
  // §34's reproducibility capture, which is what makes step 5's artifact worth anything:
  // the version is immutable and the experiment pins it by id, so "which data was this
  // trained on" has an answer that cannot drift.
  await ash('dataset', 'create', 'cifar10');
  await ash('dataset', 'add-version', 'cifar10', 'v1',
    '--uri', 's3://ashml/cifar10/v1', '--digest', 'sha256:aa11');

  const experiment = await ashJson('experiment', 'create', `journey-${suffix}`,
    '--dataset', 'cifar10', '--dataset-version', 'v1',
    '--seed', '1337', '--git-commit', (await exec('git', ['rev-parse', '--short', 'HEAD'])).stdout.trim());

  // Pinned by *id*, not by name: a version's bytes are immutable, so an experiment that
  // records the id can still answer "which data was this trained on" after someone adds
  // a v2 — which is the guarantee everything downstream of step 5 rests on.
  const pinned = experiment.reproducibility?.dataset;
  assert.equal(pinned?.version, 'v1', 'the experiment did not pin a dataset version');
  assert.ok(pinned.version_id, 'the experiment pinned a version name but not the version itself');

  // `--project` overrides the manifest's own `project:`, so the journey runs in an
  // isolated project and the example file stays the example file.
  const job = await ashJson('job', 'submit', MANIFEST,
    '--experiment', experiment.id, '--project', project);
  assert.equal(job.state, 'QUEUED', `a submitted job should be QUEUED, not ${job.state}`);

  globalThis.__job = job.id;
  globalThis.__experiment = experiment.id;
  line(`${MANIFEST} submitted as ${job.id}`);
  line(`pinned to cifar10:${pinned.version} (${pinned.version_id.slice(0, 8)}), `
    + `seed ${experiment.reproducibility.random_seed}, `
    + `commit ${experiment.reproducibility.git_commit ?? '-'}`);
});

step(3, 'Scheduler processes the job', async () => {
  // QUEUED -> SCHEDULING -> node selected -> Kubernetes Job created, and the claim is
  // that AshML did the choosing (ADR 0003). Kubernetes placing the Pod and AshML
  // recording where it landed would look identical from the job row alone, so the node
  // AshML *chose* is compared against the node the Pod is *on*, asked of the cluster.
  // The states are recorded as they are *seen*, not assembled afterwards from the
  // destination. §50 draws step 3 as a path — QUEUED, SCHEDULING, node selected, Job
  // created — and a platform that wrote those rows after the fact would be
  // indistinguishable from one that drove them if the path were reconstructed at the end.
  // A fast transition can still fall between two polls, so what is asserted is that the
  // states seen are in the state machine's order, not that every one of them was caught.
  const seen = [];
  const running = await until('the job to start running', async (because) => {
    const job = await ashJson('job', 'get', globalThis.__job);
    if (seen.at(-1) !== job.state) seen.push(job.state);
    if (job.state === 'FAILED') throw new Error(`the job failed before it ran: ${job.failure_reason}`);
    if (job.state !== 'RUNNING') {
      because(`still ${job.state}`);
      return null;
    }
    return job;
  }, { interval: 750 });

  const ORDER = ['QUEUED', 'SCHEDULING', 'STARTING', 'RUNNING'];
  const ranks = seen.map((state) => ORDER.indexOf(state));
  assert.ok(ranks.every((r) => r >= 0), `the job passed through a state step 3 does not know: ${seen.join(' -> ')}`);
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks,
    `the job's states did not advance in order: ${seen.join(' -> ')}`);

  assert.ok(running.placement?.node_name, 'the job ran without AshML recording a placement');
  assert.ok(running.k8s_job_name, 'the job is RUNNING with no Kubernetes Job recorded');

  const node = await kubectl(
    'get', 'pods', '-n', NAMESPACE, '-l', `job-name=${running.k8s_job_name}`,
    '-o', 'jsonpath={.items[0].spec.nodeName}',
  );
  assert.equal(
    node, running.placement.node_name,
    'the Pod is on a different node from the one AshML chose — Kubernetes is placing, not AshML',
  );

  const { passes } = await ashJson('job', 'why', globalThis.__job);
  const [pass] = passes;
  assert.ok(pass, 'the scheduler recorded no decision for a job it placed');
  assert.ok(pass.decisions.length > 0, 'the decision record names no nodes');
  const chosen = pass.decisions.find((d) => d.node_name === running.placement.node_name);
  assert.ok(chosen, `the decision record does not mention ${running.placement.node_name}`);

  globalThis.__states = seen;
  line(`observed: ${seen.join(' -> ')}`);
  line(`placed on ${running.placement.node_name}; Kubernetes Job ${running.k8s_job_name}`);
  line(`why: ${chosen.reason}`);
  // The spec's step 3 says "GPU NODE SELECTED". Said plainly rather than glossed.
  const gpus = (await ashJson('gpu', 'list')).gpus ?? [];
  line(`(the spec says GPU NODE SELECTED. This host has ${gpus.length} GPU(s) and no `
    + 'device plugin, so no GPU reaches a node — ADR 0008 — and the choice above was made '
    + 'on CPU. The scheduler path is identical either way.)');
});

step(4, 'Training runs, and reports its own metrics', async () => {
  // "Metrics appear in the monitoring system" — and appear *while it is running*, which
  // is the whole point of the push contract (ADR 0009). Waiting until the job finished
  // and then reading the series would pass on a platform that only ever collected them
  // at the end.
  const arrived = await until('metrics to arrive from the running pod', async (because) => {
    const job = await ashJson('job', 'get', globalThis.__job);
    if (TERMINAL.includes(job.state)) {
      throw new Error(
        `the run reached ${job.state} before any metric was reported. Nothing pushed, or `
        + 'the pod could not reach ASHML_API_ADVERTISE_URL — see the README\'s two addresses.',
      );
    }
    const { metrics } = await ashJson('job', 'metrics', globalThis.__job);
    const loss = metrics.find((m) => m.name === 'loss');
    if (!loss || loss.count < 2) {
      because(`${metrics.length} metric(s) so far, job is ${job.state}`);
      return null;
    }
    return { loss, metrics };
  }, { interval: 3000 });

  assert.ok(arrived.loss.last_step > arrived.loss.first_step, 'the loss series does not advance');

  // Read back as a series, ordered by the step the *run* reported rather than by arrival
  // time. That is ADR 0009's whole claim: a loss belongs to a step, and two points four
  // milliseconds apart are two points.
  const { series } = await ashJson('job', 'metrics', globalThis.__job, '--name', 'loss');
  const points = series.find((m) => m.name === 'loss')?.points ?? [];
  assert.ok(points.length > 1, 'the loss series came back with nothing in it');
  const order = points.map((point) => point.step);
  assert.deepEqual(
    [...order].sort((a, b) => a - b), order,
    'the loss series is not ordered by the step the run reported',
  );

  line(`${arrived.metrics.map((m) => m.name).join(', ')} arriving from the pod`);
  line(`loss at step ${arrived.loss.last_step}: ${arrived.loss.last_value.toFixed(4)} `
    + '(while the job is still RUNNING — the run pushes, nothing polls it)');
});

step(5, 'Training completes: checkpoint, artifact storage, model registry', async () => {
  const { job, states } = await watchJob(globalThis.__job);
  assert.equal(job.state, 'SUCCEEDED', `the run ended ${job.state}: ${job.failure_reason ?? ''}`);

  const path = [...globalThis.__states, ...states];
  line(`state path: ${[...new Set(path)].join(' -> ')}`);

  const { artifacts } = await ashJson('job', 'artifacts', globalThis.__job);
  const checkpoints = artifacts.filter((a) => a.kind === 'checkpoint');
  const model = artifacts.find((a) => a.kind === 'model');

  assert.ok(checkpoints.length > 0, 'the run wrote no checkpoint');
  assert.ok(model, 'the run produced no model artifact');
  assert.equal(model.status, 'READY', `the model artifact is ${model.status}, not READY`);
  // The Phase 4 promise: READY means AshML asked the bucket, not that an upload was
  // started. A registry entry pointing at unconfirmed bytes only moves the discovery
  // from "the upload failed" to "production cannot load the model".
  assert.equal(model.metadata?.verified ?? model.verified, true,
    'the model artifact is READY but was never confirmed to exist in the store');

  await ash('model', 'create', MODEL);
  const registered = await ashJson('model', 'register', MODEL, '--artifact', model.id);
  await ash('model', 'promote', MODEL, String(registered.version));

  const production = await ashJson('model', 'production', MODEL);
  assert.equal(production.version.version, registered.version, 'promotion did not take');
  assert.equal(production.version.status, 'PRODUCTION');
  assert.equal(production.version.artifact.verified, true,
    'the production version points at bytes nobody confirmed');
  // The run's own numbers came with it, rather than being retyped by whoever registered.
  assert.ok(production.version.metrics?.val_accuracy !== undefined,
    'the registered version carries none of the run’s metrics');

  globalThis.__version = registered.version;
  globalThis.__artifact = model.id;
  line(`${checkpoints.length} checkpoint(s), model artifact ${model.id.slice(0, 8)} (verified)`);
  line(`${MODEL} v${registered.version} is PRODUCTION, val_accuracy `
    + `${production.version.metrics.val_accuracy.toFixed(4)}`);
  for (const caveat of model.metadata?.caveats ?? []) line(`caveat: ${caveat}`);
});

step(6, 'Deploy the model', async () => {
  await ash('model', 'deploy', MODEL);

  const deployment = await until('the deployment to become READY', async (because) => {
    const d = await ashJson('deployment', 'get', MODEL);
    if (d.status !== 'READY') {
      because(`${d.status}, ${d.ready_replicas}/${d.replicas} ready`
        + `${d.last_error ? ` (${d.last_error})` : ''}`);
      return null;
    }
    return d;
  }, { interval: 3000 });

  assert.equal(deployment.serving_version, globalThis.__version,
    'the deployment is serving a different version from the one promoted');

  // Asked of the cluster: AshML calling itself READY is the claim under test.
  const ready = await kubectl(
    'get', 'deploy', `${deployment.k8s_name}-v${globalThis.__version}`, '-n', NAMESPACE,
    '-o', 'jsonpath={.status.readyReplicas}',
  );
  assert.equal(Number(ready), deployment.ready_replicas,
    'AshML and the cluster disagree about how many replicas are serving');

  globalThis.__deployment = deployment;
  line(`${deployment.name} serving v${deployment.serving_version} at ${deployment.endpoint_url}`);
});

step(7, 'Inference', async () => {
  const files = (await readdir(PNG_DIR)).filter((f) => f.endsWith('.png')).sort().slice(0, IMAGES);
  assert.ok(files.length > 0,
    `no PNGs in ${PNG_DIR} — run \`make cifar-png\`, which writes CIFAR-10 *test* images `
    + 'with their true label in the filename so a prediction can be checked.');

  const answer = await ashJson(
    'predict', MODEL,
    ...files.flatMap((f) => ['--image', `${PNG_DIR}/${f}`]),
  );

  assert.equal(answer.predictions.length, files.length, 'not every image was answered');
  for (const p of answer.predictions) {
    assert.ok(p.class_name, 'a prediction came back with no class');
    assert.ok(p.confidence >= 0 && p.confidence <= 1, `confidence ${p.confidence} is not a probability`);
  }

  // Provenance, which is the part that must not be optional: a prediction nobody can
  // attribute to a version is how the wrong model serves for a week.
  assert.ok(answer.served_by, 'the prediction says nothing about what produced it');
  assert.equal(answer.served_by.version, globalThis.__version,
    'the answer is attributed to a version other than the one deployed');
  assert.equal(answer.served_by.artifact_id, globalThis.__artifact,
    'the pod answered from a different artifact than the registered version points at');

  // What the pod says it loaded, against what AshML recorded. They agree in every normal
  // case; the point is the case where they do not.
  const metadata = await ashJson('deployment', 'metadata', MODEL);
  assert.notEqual(metadata.matches_record, false,
    'the pod is not serving the artifact AshML recorded for this deployment: '
    + `pod says ${metadata.reported?.artifact_id}, registry says ${metadata.artifact_id}`);

  const correct = answer.predictions.filter(
    (p, i) => p.class_name === trueLabel(files[i]),
  ).length;

  line(`${files.length} real CIFAR-10 test images, served by v${answer.served_by.version}`);
  for (const [i, p] of answer.predictions.entries()) {
    const truth = trueLabel(files[i]);
    line(`  ${truth.padEnd(11)} -> ${p.class_name.padEnd(11)} `
      + `${(p.confidence * 100).toFixed(1)}%  ${p.class_name === truth ? 'ok' : 'wrong'}`);
  }
  // Printed, not asserted. The manifest bounds the run to MAX_STEPS, so this model is
  // undertrained by construction and a threshold here would be a threshold tuned until it
  // passed. What is asserted above is that the answers are real, attributed, and came
  // from the bytes the registry names.
  line(`${correct}/${files.length} correct — see the manifest: this run is truncated on `
    + 'purpose, and a demo scoring 8/8 would be hiding that');
});

step(8, 'Observe', async () => {
  // A script cannot assert a rendered panel, so it asserts the thing underneath: every
  // series the dashboards actually query is exported, and the ones this journey should
  // have moved have moved.
  //
  // The list is *read out of the dashboards* rather than written here. A hand-kept list
  // drifts in the direction that hides the problem — someone renames a metric, updates
  // the exporter and the list, and the panel that still asks for the old name goes on
  // rendering "No data" with nobody's test failing. `allowUiUpdates: false` means these
  // JSON files are the dashboards, so they are the right thing to ask.
  const dashboards = 'deploy/observability/dashboards';
  const files = (await readdir(dashboards)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, `no dashboards in ${dashboards}`);

  const queried = new Set();
  const panels = new Map();
  for (const file of files) {
    const text = await readFile(`${dashboards}/${file}`, 'utf8');
    for (const [, name] of text.matchAll(/\b(ashml_[a-z0-9_]+)\b/g)) {
      queried.add(name);
      panels.set(name, file.replace(/\.json$/, ''));
    }
  }

  const metrics = await scrape();
  // A histogram is exported as `_bucket`/`_sum`/`_count`; a panel querying the family
  // name is querying something that exists.
  const exported = (name) => metrics.has(name)
    || ['_count', '_sum', '_bucket', '_total'].some((s) => metrics.has(`${name}${s}`))
    || metrics.has(name.replace(/_(count|sum|bucket)$/, ''));

  const missing = [...queried].filter((name) => !exported(name)).sort();
  assert.deepEqual(missing, [],
    'the dashboards query series the control plane does not export, so those panels render '
    + `"No data" forever: ${missing.map((m) => `${m} (${panels.get(m)})`).join(', ')}`);

  // Exported is not the same as observed. Four instruments were once declared and never
  // updated, and scraped as permanent zeros — which reads as *answered* rather than as
  // missing. These four moved during this journey, so a zero here is a real regression.
  const moved = [
    ['ashml_jobs', 'a job ran'],
    ['ashml_deployment_replicas_ready', 'a model is serving'],
    ['ashml_prediction_duration_seconds_count', 'step 7 made predictions through this control plane'],
    ['ashml_prediction_instances_total', 'step 7 sent images'],
  ];
  for (const [name, why] of moved) {
    assert.ok(metrics.sum(name) > 0, `${why}, and ${name} is zero`);
  }

  // The training curve is deliberately *not* here (ADR 0010). A loss belongs to the step
  // the run reported it at, and a Pushgateway keeps only the latest value per label set
  // stamped with the scraper's clock — two steps four milliseconds apart become one
  // sample at the wrong time. Grafana reads the curve from PostgreSQL instead, which is
  // the same series step 4 read back through the API.
  const { metrics: series } = await ashJson('job', 'metrics', globalThis.__job);
  const loss = series.find((m) => m.name === 'loss');
  assert.ok(loss && loss.count > 1, 'the training curve is not readable from the control plane');
  assert.ok(![...queried].some((name) => /training|loss/.test(name)),
    'a training curve is being scraped from Prometheus — ADR 0010 is about why that '
    + 'destroys it');

  const visible = metrics.sum('ashml_gpu_visible');
  const schedulable = metrics.sum('ashml_gpu_schedulable');
  line(`${queried.size} series across ${files.length} dashboards, all exported`);
  line(`jobs ${metrics.sum('ashml_jobs')}, replicas ready `
    + `${metrics.sum('ashml_deployment_replicas_ready')}, predictions `
    + `${metrics.sum('ashml_prediction_duration_seconds_count')} over `
    + `${metrics.sum('ashml_prediction_instances_total')} instances`);
  line(`GPUs visible ${visible}, schedulable ${schedulable} — both true on this host, and `
    + 'either one alone is a lie about it (ADR 0008)');
  line(`training curve: ${loss.count} loss points, read from PostgreSQL by step, not scraped`);

  // Whether the stack is deployed is a different question from whether the data exists,
  // and the journey should not fail for an optional `make observability`.
  const prometheus = await kubectl(
    'get', 'pods', '-n', 'ashml-observability', '-o', 'jsonpath={.items[*].metadata.name}',
  ).catch(() => '');
  line(prometheus
    ? `Prometheus and Grafana are deployed (${prometheus.split(/\s+/).length} pods); `
      + '`make grafana` renders these series. Not asserted: the panels themselves.'
    : 'Prometheus and Grafana are not deployed here — `make observability` applies the '
      + 'stack that reads the series above. Not asserted: the panels themselves.');
});

step(9, 'Failure: kill the inference pod, then a training worker', async () => {
  // 9a. Kubernetes replaces the pod. AshML must not — a Deployment already does this and
  // a control plane racing it would fight it — but it must *notice*, and it must come
  // back as the same model rather than as whatever is newest.
  const deployment = globalThis.__deployment;

  /**
   * The pod currently *running* for this version.
   *
   * Filtered on phase because for a few seconds after the kill there are two pods
   * matching these labels — the one shutting down and its replacement — and `.items[0]`
   * has no defined order between them. Reading the terminating one back as "the
   * replacement" would make the assertion below pass while proving nothing.
   */
  const servingPod = () => kubectl(
    'get', 'pods', '-n', NAMESPACE,
    '-l', `ashml.io/model-version=${globalThis.__version},ashml.io/deployment-id=${deployment.id}`,
    '--field-selector', 'status.phase=Running',
    '-o', 'jsonpath={.items[0].metadata.name}',
  );

  const before = await servingPod();
  assert.ok(before, 'no serving pod to kill');

  // `--force --grace-period=0`, which is what makes this a kill rather than a rolling
  // replacement. A graceful delete gives the pod its termination grace period, during
  // which it is still Ready and still in the Service's endpoints — so the ReplicaSet's
  // replacement can become ready before the original leaves, `readyReplicas` never
  // reaches zero, and the outage being demonstrated never happens. The assertion below
  // would then wait for a DEGRADED that was true for no observable instant.
  await kubectl('delete', 'pod', before, '-n', NAMESPACE, '--grace-period=0', '--force');
  line(`killed serving pod ${before}`);

  const noticed = await until('AshML to notice the pod is gone', async (because) => {
    const d = await ashJson('deployment', 'get', MODEL);
    if (d.status === 'READY' && d.ready_replicas === d.replicas) {
      because('still reporting READY — the sync loop has not observed the gap yet');
      return null;
    }
    return d;
  }, { timeout: 120_000, interval: 2000 });

  // DEGRADED rather than PROGRESSING: "was serving and is now short of replicas" and "has
  // not started serving yet" are different events, and one word for both hides an outage
  // inside something that sounds like startup.
  assert.equal(noticed.status, 'DEGRADED',
    `a deployment that lost its only replica reported ${noticed.status}`);
  line(`AshML reports ${noticed.status} ${noticed.ready_replicas}/${noticed.replicas}`
    + `${noticed.last_error ? `: ${noticed.last_error}` : ''}`);

  const recovered = await until('Kubernetes to replace it and AshML to agree', async (because) => {
    const d = await ashJson('deployment', 'get', MODEL);
    if (d.status !== 'READY') {
      because(`${d.status} ${d.ready_replicas}/${d.replicas}`);
      return null;
    }
    return d;
  }, { timeout: 300_000, interval: 3000 });

  const after = await servingPod();
  assert.notEqual(after, before, 'the same pod came back — nothing was actually killed');
  assert.equal(recovered.serving_version, globalThis.__version, 'it came back serving a different version');

  const again = await ashJson('predict', MODEL, '--image', `${PNG_DIR}/${
    (await readdir(PNG_DIR)).filter((f) => f.endsWith('.png')).sort()[0]}`);
  assert.equal(again.served_by.artifact_id, globalThis.__artifact,
    'the replacement pod is serving different bytes — the artifact-id indirection did not hold');
  line(`replaced by ${after}, READY again, same artifact ${globalThis.__artifact.slice(0, 8)}`);

  // 9b. Kill a training worker. "AshML should recover/reschedule where supported" — and
  // where it is supported is exactly where a checkpoint exists to resume from, which is
  // why the retry is offered one rather than restarted from step zero.
  //
  // The smoke workload, not ResNet: this is the journey demonstrating that recovery
  // happens, in under a minute. `make chaos-resume-resnet` is the deep version, on the
  // real workload, asserting that weights, optimizer *and* learning-rate schedule survive.
  const retryJob = await ashJson('job', 'submit', RETRY_MANIFEST, '--project', project);
  assert.equal(retryJob.max_retries, 1,
    `${RETRY_MANIFEST} must allow a retry, or killing its pod is the end of the story`);
  line(`submitted ${retryJob.name} (${retryJob.id.slice(0, 8)}) to be killed mid-run`);

  // Killed only once it has something to come back to. Killing before the first
  // checkpoint is confirmed would demonstrate a restart, which is a different and much
  // weaker claim than a resume — and AshML will not offer bytes it has not confirmed.
  const checkpointed = await until('the run to confirm a checkpoint in the store', async (because) => {
    const current = await ashJson('job', 'get', retryJob.id);
    if (TERMINAL.includes(current.state)) {
      throw new Error(`the run reached ${current.state} before it could be killed`);
    }
    const { artifacts } = await ashJson('job', 'artifacts', retryJob.id);
    const ready = artifacts.filter((a) => a.status === 'READY' && a.step != null);
    if (ready.length < 2) {
      because(`${ready.length} confirmed checkpoint(s), job is ${current.state}`);
      return null;
    }
    return { job: current, at: Math.max(...ready.map((a) => a.step)) };
  }, { timeout: 300_000, interval: 2000 });

  const victim = await kubectl(
    'get', 'pods', '-n', NAMESPACE, '-l', `job-name=${checkpointed.job.k8s_job_name}`,
    '-o', 'jsonpath={.items[0].metadata.name}',
  );
  await kubectl('delete', 'pod', victim, '-n', NAMESPACE, '--wait=false', '--grace-period=0', '--force');
  line(`killed training pod ${victim} with a checkpoint confirmed at step ${checkpointed.at}`);

  // AshML's own loop has to notice and act. Nothing here calls the retry path — a script
  // that invokes recovery proves only that recovery can be invoked.
  const retried = await until('AshML to bring the run back as a second attempt', async (because) => {
    const current = await ashJson('job', 'get', retryJob.id);
    if (current.state === 'FAILED') {
      throw new Error(`the run was not retried: ${current.failure_reason}`);
    }
    if (current.attempt < 1) {
      because(`still attempt ${current.attempt}, state ${current.state}`);
      return null;
    }
    if (!current.k8s_job_name?.endsWith('-1')) {
      because(`attempt ${current.attempt} has no Kubernetes Job of its own yet`);
      return null;
    }
    return current;
  }, { timeout: 300_000, interval: 2000 });

  // What the second attempt was actually *handed*, asked of the cluster rather than of
  // AshML. An artifact id, not a URL: the download is signed when the container asks, so
  // a pod that starts six hours later does not crash-loop on a dead signature.
  const resumeFrom = await until('the retry pod to be created with a checkpoint offered', async (because) => {
    const env = await kubectl(
      'get', 'pods', '-n', NAMESPACE, '-l', `job-name=${retried.k8s_job_name}`,
      '-o', 'jsonpath={.items[0].spec.containers[0].env[?(@.name=="ASHML_RESUME_FROM")].value}',
    ).catch(() => '');
    if (!env) {
      because('the retry pod does not exist yet, or was handed no checkpoint');
      return null;
    }
    return env;
  }, { timeout: 120_000, interval: 2000 });

  const { artifacts: offered } = await ashJson('job', 'artifacts', retryJob.id);
  const resumed = offered.find((a) => a.id === resumeFrom);
  assert.ok(resumed, `the retry was offered ${resumeFrom}, which is not one of this run's artifacts`);
  assert.equal(resumed.status, 'READY',
    'the retry was offered a checkpoint whose bytes were never confirmed');
  line(`attempt 1 running as ${retried.k8s_job_name}, offered checkpoint at step ${resumed.step}`);

  const { job: finished } = await watchJob(retryJob.id);
  assert.equal(finished.state, 'SUCCEEDED',
    `the resumed attempt ended ${finished.state}: ${finished.failure_reason ?? ''}`);
  assert.equal(finished.attempt, 1, 'the run finished on an attempt other than the retry');

  // It *resumed*, rather than starting again — which is the whole claim, and is not
  // implied by any of the above. A retry that ignored the checkpoint would also come back
  // as attempt 1 with its own Job and also reach SUCCEEDED, having silently redone the
  // work. The workload says which step it took up from, so that is what is read: its own
  // account, out of the logs of the pod that did it.
  const logs = await ash('job', 'logs', retryJob.id);
  const resumeLine = logs.split('\n').find((l) => l.includes('resuming from artifact'));
  assert.ok(
    resumeLine,
    'the resumed attempt never said it resumed — it started over from step zero, which '
    + 'reaches SUCCEEDED just the same and quietly redoes every step the first attempt did',
  );
  const at = Number(/at step (\d+)/.exec(resumeLine)?.[1]);
  assert.ok(at >= resumed.step,
    `the run resumed at step ${at}, before the checkpoint at step ${resumed.step} it was offered`);

  line(`resumed and finished: ${finished.state} on attempt ${finished.attempt}`);
  line(`the run's own words: ${resumeLine.trim()}`);
  line('(the deep version of this is `make chaos-resume-resnet`: weights, optimizer and '
    + 'learning-rate schedule across a kill, on the real workload)');
});

// ------------------------------------------------------------------- driver

await requireContext();

console.log('\nAshML — the §50 Core User Journey, run start to finish');
console.log(`  cluster: ${KUBE_CONTEXT}   project: ${project}\n`);

// The journey is one story, so a failed step ends it: every later step would be about a
// deployment that does not exist, and nine failures for one cause bury the cause.
let passed = 0;
let failed = 0;
for (const { number, title, fn } of steps) {
  const started = Date.now();
  console.log(`Step ${number} — ${title}`);
  try {
    await fn();
    passed += 1;
    console.log(`  ok    (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${err.message}\n`);
    break;
  }
}

// `passed`, not `steps.length - failed`: the steps after a failure did not run, and
// counting them as anything but "not reached" is the kind of rounding-up this whole
// script exists to make impossible.
console.log(`${passed}/${steps.length} steps completed`);

if (failed === 0) {
  // Step 10 is Ashcode, and it is not run because it does not exist. Saying that here,
  // at the end of a run that just passed nine steps, is the point: this is the moment a
  // demo is most tempting to round up.
  console.log('');
  console.log('Step 10 — Ashcode: not run. Asking "why is this job slow" or "deploy the');
  console.log('  latest model with 10% traffic" in natural language is roadmap Phase 9, and');
  console.log('  post-v1. Both operations exist and are reachable — `ash job why <id>` and');
  console.log('  `ash deployment rollout <name> --version N --traffic 10` — but nothing');
  console.log('  translates a sentence into them, and a scripted transcript pretending');
  console.log('  otherwise is exactly what Rule 5 forbids.');
  console.log('');
  console.log(`Left running: project ${project}, its deployment, and the pods behind it.`);
  console.log(`  ash deployment delete ${MODEL} --project ${project}   # when you are done looking`);
}

process.exit(failed === 0 ? 0 : 1);
