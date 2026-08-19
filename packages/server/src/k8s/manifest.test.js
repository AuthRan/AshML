/**
 * Unit tests for the AshML job -> Kubernetes Job translation.
 *
 * No cluster and no database: the translation is pure, and these tests exist because
 * a mistake in it produces a Pod that runs the wrong thing, which is far harder to
 * diagnose from the cluster than from here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildJobManifest, kubeJobName, MANAGED_BY } from './manifest.js';

/** A job shaped exactly as the repo returns one. */
function makeJob(overrides = {}) {
  return {
    id: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    name: 'resnet-cifar',
    project: 'vision',
    state: 'SCHEDULING',
    priority: 'MEDIUM',
    attempt: 0,
    max_retries: 0,
    experiment: null,
    resources: { cpu: 8, memory_bytes: 34359738368, gpu: 1, gpu_memory_min_bytes: 8589934592 },
    spec: { image: 'ash/ml-pytorch:v1', command: ['python', 'train.py'], args: ['--epochs=50'] },
    ...overrides,
  };
}

describe('kubeJobName', () => {
  test('is derived from the job id, so it is stable across retries of a launch', () => {
    const job = makeJob();
    assert.equal(kubeJobName(job), kubeJobName({ ...job, state: 'STARTING' }));
    assert.match(kubeJobName(job), /^ashml-resnet-cifar-3f2b1c4d-0$/);
  });

  test('distinguishes attempts, so a retry cannot collide with what it replaces', () => {
    assert.notEqual(kubeJobName(makeJob({ attempt: 0 })), kubeJobName(makeJob({ attempt: 1 })));
  });

  test('stays within the 63-character limit Kubernetes imposes on names', () => {
    const name = kubeJobName(makeJob({ name: 'a'.repeat(63), attempt: 10 }));
    assert.ok(name.length <= 63, `name was ${name.length} characters: ${name}`);
  });

  test('never ends in a dash, which truncation could otherwise produce', () => {
    // Truncating this name lands exactly on a dash if nothing trims it.
    const stem = `${'a'.repeat(47)}-suffix`;
    const name = kubeJobName(makeJob({ name: stem }));
    assert.doesNotMatch(name, /-{2,}/);
    assert.match(name, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, `not a valid DNS-1123 label: ${name}`);
  });

  test('two different jobs with the same human name get different Kubernetes names', () => {
    const a = kubeJobName(makeJob({ id: '11111111-2222-3333-4444-555555555555' }));
    const b = kubeJobName(makeJob({ id: '66666666-7777-8888-9999-000000000000' }));
    assert.notEqual(a, b);
  });
});

describe('buildJobManifest', () => {
  test('carries image, command and args through unchanged', () => {
    const manifest = buildJobManifest(makeJob());
    const container = manifest.spec.template.spec.containers[0];

    assert.equal(container.image, 'ash/ml-pytorch:v1');
    assert.deepEqual(container.command, ['python', 'train.py']);
    assert.deepEqual(container.args, ['--epochs=50']);
  });

  test('omits command and args entirely when the spec does not set them', () => {
    // An empty array would override the image's ENTRYPOINT with nothing and the
    // container would fail to start, so absence has to stay absence.
    const manifest = buildJobManifest(makeJob({ spec: { image: 'busybox' } }));
    const container = manifest.spec.template.spec.containers[0];

    assert.ok(!('command' in container));
    assert.ok(!('args' in container));
  });

  test('requests GPUs as a limit, because Kubernetes requires that for extended resources', () => {
    const manifest = buildJobManifest(makeJob());
    const { resources } = manifest.spec.template.spec.containers[0];

    assert.equal(resources.limits['nvidia.com/gpu'], '1');
    assert.equal(resources.requests['nvidia.com/gpu'], '1');
  });

  test('asks for no GPU at all when none was requested', () => {
    const job = makeJob({ resources: { cpu: 2, memory_bytes: 0, gpu: 0, gpu_memory_min_bytes: 0 } });
    const { resources } = buildJobManifest(job).spec.template.spec.containers[0];

    assert.equal(resources.limits, undefined);
    assert.equal(resources.requests.cpu, '2');
    // A zero memory request means "unset", not "zero bytes".
    assert.ok(!('memory' in resources.requests));
  });

  test('does not put gpu_memory_min_bytes in resources — Kubernetes cannot express it', () => {
    const manifest = buildJobManifest(makeJob());
    const { resources } = manifest.spec.template.spec.containers[0];

    assert.equal(JSON.stringify(resources).includes('8589934592'), false);
    // It is preserved as a placement constraint for the Phase 3 scheduler instead.
    assert.equal(manifest.metadata.annotations['ashml.io/gpu-memory-min-bytes'], '8589934592');
  });

  test('sets backoffLimit 0 so Kubernetes cannot retry behind the state machine', () => {
    const manifest = buildJobManifest(makeJob({ max_retries: 5 }));

    assert.equal(manifest.spec.backoffLimit, 0);
    assert.equal(manifest.spec.template.spec.restartPolicy, 'Never');
  });

  test('labels the Job with its AshML job id, which is how status sync finds it', () => {
    const manifest = buildJobManifest(makeJob());

    assert.equal(manifest.metadata.labels['ashml.io/job-id'], makeJob().id);
    assert.equal(manifest.metadata.labels['app.kubernetes.io/managed-by'], MANAGED_BY);
    // The Pod carries them too, so a Pod can be traced back without its Job.
    assert.equal(manifest.spec.template.metadata.labels['ashml.io/job-id'], makeJob().id);
  });

  test('injects the ASHML_* identity a training script reports results against', () => {
    const job = makeJob({ experiment: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'sweep' } });
    const env = Object.fromEntries(
      buildJobManifest(job).spec.template.spec.containers[0].env.map((e) => [e.name, e.value]),
    );

    assert.equal(env.ASHML_JOB_ID, job.id);
    assert.equal(env.ASHML_PROJECT, 'vision');
    assert.equal(env.ASHML_EXPERIMENT_ID, job.experiment.id);
  });

  test('does not invent an experiment id for a job that has no experiment', () => {
    const env = buildJobManifest(makeJob()).spec.template.spec.containers[0].env;
    assert.ok(!env.some((e) => e.name === 'ASHML_EXPERIMENT_ID'));
  });

  test('a user env var cannot shadow ASHML_JOB_ID and misattribute the run', () => {
    const job = makeJob({
      spec: { image: 'busybox', env: { ASHML_JOB_ID: 'someone-elses-job', DATASET: 'cifar10' } },
    });
    const env = buildJobManifest(job).spec.template.spec.containers[0].env;
    const jobIdEntries = env.filter((e) => e.name === 'ASHML_JOB_ID');

    assert.equal(jobIdEntries.length, 1, 'a duplicate name would let the last one win');
    assert.equal(jobIdEntries[0].value, job.id);
    // The user's own variables still arrive.
    assert.equal(env.find((e) => e.name === 'DATASET').value, 'cifar10');
  });

  test('places the Job in the namespace it is given', () => {
    const manifest = buildJobManifest(makeJob(), { namespace: 'ashml-prod' });
    assert.equal(manifest.metadata.namespace, 'ashml-prod');
  });

  test('refuses a job with no image rather than creating a Job that cannot start', () => {
    assert.throws(
      () => buildJobManifest(makeJob({ spec: { command: ['python'] } })),
      /spec\.image is required/,
    );
  });
});
