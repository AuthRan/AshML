/**
 * Unit tests for the AshML job -> Kubernetes Job translation.
 *
 * No cluster and no database: the translation is pure, and these tests exist because
 * a mistake in it produces a Pod that runs the wrong thing, which is far harder to
 * diagnose from the cluster than from here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildJobManifest,
  buildRunSecretManifest,
  runSecretName,
  kubeJobName,
  MANAGED_BY,
  DEFAULT_CLUSTER_POD_CIDR,
  buildProjectNetworkPolicyManifest,
  projectNetworkPolicyName,
} from './manifest.js';

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

  test('tells the container where to report, when configured', () => {
    const env = Object.fromEntries(
      buildJobManifest(makeJob(), { apiUrl: 'http://ashml.ashml.svc:8080' })
        .spec.template.spec.containers[0].env.map((e) => [e.name, e.value]),
    );
    assert.equal(env.ASHML_ENDPOINT, 'http://ashml.ashml.svc:8080');
  });

  test('omits the endpoint rather than guessing one', () => {
    // A wrong endpoint makes every report inside the pod fail with a connection error,
    // which is much harder to diagnose than an SDK saying it was never told where to
    // report. The API binds 0.0.0.0, which is not an address anything else can reach.
    const env = buildJobManifest(makeJob()).spec.template.spec.containers[0].env;
    assert.ok(!env.some((e) => e.name === 'ASHML_ENDPOINT'));
  });

  test('a user env var cannot shadow ASHML_ENDPOINT and redirect the run’s reports', () => {
    const job = makeJob({
      spec: { image: 'busybox', env: { ASHML_ENDPOINT: 'http://attacker.example' } },
    });
    const entries = buildJobManifest(job, { apiUrl: 'http://ashml.ashml.svc:8080' })
      .spec.template.spec.containers[0].env.filter((e) => e.name === 'ASHML_ENDPOINT');

    assert.equal(entries.length, 1, 'a duplicate name would let the last one win');
    assert.equal(entries[0].value, 'http://ashml.ashml.svc:8080');
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

  test('pins the Pod to the node the scheduler chose, via a selector not spec.nodeName', () => {
    const podSpec = buildJobManifest(makeJob(), { nodeName: 'node-1' }).spec.template.spec;

    assert.deepEqual(podSpec.nodeSelector, { 'kubernetes.io/hostname': 'node-1' });
    // spec.nodeName would bypass Kubernetes' own resource checks and the device
    // plugin, so an error in AshML's accounting would over-commit the node silently.
    assert.equal(podSpec.nodeName, undefined);
  });

  test('leaves placement to Kubernetes when no node was chosen', () => {
    const podSpec = buildJobManifest(makeJob()).spec.template.spec;
    assert.equal(podSpec.nodeSelector, undefined);
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

  describe('what the Pod is allowed to be', () => {
    test('no Kubernetes credential is mounted into a training pod', () => {
      // The one that was actually there. Kubernetes mounts a token for its own API into
      // every Pod unless told not to, and AshML's training pods had one at
      // /var/run/secrets/kubernetes.io/serviceaccount that no line of the training path
      // has ever read. What makes it worth removing is not what the default service
      // account can do today — nothing — but that a single future RoleBinding to
      // `default` would hand whatever it gains to every training pod in the namespace.
      const pod = buildJobManifest(makeJob()).spec.template.spec;
      assert.equal(pod.automountServiceAccountToken, false);
    });

    test('the container starts with no capabilities and cannot gain any', () => {
      const container = buildJobManifest(makeJob()).spec.template.spec.containers[0];
      assert.equal(container.securityContext.allowPrivilegeEscalation, false);
      assert.equal(container.securityContext.privileged, false);
      assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
    });

    test('the runtime\'s own syscall filter is applied rather than left off', () => {
      const pod = buildJobManifest(makeJob()).spec.template.spec;
      assert.deepEqual(pod.securityContext.seccompProfile, { type: 'RuntimeDefault' });
    });

    test('runAsNonRoot is deliberately absent, and this is the note saying so', () => {
      // Not an oversight and not a preference. Setting it would refuse every image that
      // does not declare a USER — including `busybox`, which `make e2e` runs — turning a
      // security default into "your job does not start" for images their authors had
      // every right to build that way. Everything else `restricted` asks for is above, so
      // the day every image in use declares a user this is a one-line change. If someone
      // adds it, this test should be deleted with an eye on the e2e suite, not quietly
      // updated.
      const pod = buildJobManifest(makeJob()).spec.template.spec;
      assert.equal(pod.securityContext.runAsNonRoot, undefined);
    });

    test('a job spec cannot reach a dangerous Pod field, because it is never copied', () => {
      // The container is assembled from an allowlist rather than merged from the spec, so
      // this is a property of the shape of the builder rather than of a filter that could
      // be forgotten. The assertion is here so that changing it to a merge fails loudly.
      const manifest = buildJobManifest(makeJob({
        spec: {
          image: 'busybox',
          hostNetwork: true,
          hostPID: true,
          privileged: true,
          volumes: [{ name: 'root', hostPath: { path: '/' } }],
          securityContext: { runAsUser: 0 },
        },
      }));
      const pod = manifest.spec.template.spec;
      assert.equal(pod.hostNetwork, undefined);
      assert.equal(pod.hostPID, undefined);
      assert.equal(pod.volumes, undefined);
      assert.equal(pod.securityContext.runAsUser, undefined);
      assert.equal(pod.containers[0].securityContext.privileged, false);
    });
  });
});

describe('the per-project network policy', () => {
  const policy = (project = 'vision', options = {}) =>
    buildProjectNetworkPolicyManifest(project, options);

  /** The rule that allows a project to reach the world but not the cluster's pods. */
  const worldRule = (manifest) =>
    manifest.spec.egress.find((rule) => rule.to.some((peer) => peer.ipBlock));

  test('is named for the project and selects exactly that project\'s pods', () => {
    const manifest = policy('vision');
    assert.equal(manifest.metadata.name, 'ashml-project-vision');
    assert.equal(manifest.metadata.name, projectNetworkPolicyName('vision'));
    assert.deepEqual(manifest.spec.podSelector, {
      matchLabels: { 'ashml.io/project': 'vision' },
    });
    assert.equal(manifest.metadata.labels['app.kubernetes.io/managed-by'], MANAGED_BY);
  });

  test('two projects produce two policies that cannot collide', () => {
    assert.notEqual(policy('vision').metadata.name, policy('speech').metadata.name);
  });

  test('constrains egress and says nothing about ingress', () => {
    // Naming Ingress here — even with no rules under it — would deny every inbound
    // connection to the project, including the kubelet's readiness probes and the API
    // server's /proxy, which is how `callService` reaches a model server. That failure
    // is invisible on a one-node cluster and intermittent on two, so the assertion is
    // on the absence rather than on the presence of what replaced it.
    const manifest = policy();
    assert.deepEqual(manifest.spec.policyTypes, ['Egress']);
    assert.equal(manifest.spec.ingress, undefined);
  });

  test('allows the project to reach its own pods, on any port', () => {
    const rule = policy('vision').spec.egress.find((r) => r.to.some((peer) => peer.podSelector));
    assert.deepEqual(rule.to[0].podSelector, {
      matchLabels: { 'ashml.io/project': 'vision' },
    });
    // No `ports`: a router talks to model servers on 8081, a training pod might talk to
    // anything, and enumerating that is a list this file would get wrong.
    assert.equal(rule.ports, undefined);
  });

  test('allows DNS, on TCP as well as UDP', () => {
    const rule = policy().spec.egress.find((r) => (
      r.to.some((peer) => peer.namespaceSelector)
    ));
    assert.deepEqual(rule.to[0].namespaceSelector, {
      matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
    });
    // TCP because a large answer falls back to it, and a resolver that works until a
    // response crosses 512 bytes is worse than one that does not work at all.
    assert.deepEqual(rule.ports, [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ]);
  });

  test('allows everything that is not a pod in this cluster', () => {
    // The control plane on the host, the artifact store, a dataset on the internet. This
    // is a boundary between projects, not a firewall around user code.
    const rule = worldRule(policy());
    assert.equal(rule.to[0].ipBlock.cidr, '0.0.0.0/0');
    assert.deepEqual(rule.to[0].ipBlock.except, [DEFAULT_CLUSTER_POD_CIDR]);
  });

  test('excludes the cluster it is actually given, not the default one', () => {
    const rule = worldRule(policy('vision', { clusterPodCidr: '10.244.0.0/16' }));
    assert.deepEqual(rule.to[0].ipBlock.except, ['10.244.0.0/16']);
  });

  test('no rule reaches another project, which is the whole point', () => {
    const manifest = policy('vision');
    const selectors = manifest.spec.egress.flatMap((rule) => (
      rule.to.map((peer) => peer.podSelector?.matchLabels?.['ashml.io/project'] ?? null)
    ));
    assert.ok(selectors.every((project) => project === null || project === 'vision'));
  });

  test('lands in the namespace it is told to', () => {
    assert.equal(policy('vision').metadata.namespace, 'ashml-jobs');
    assert.equal(policy('vision', { namespace: 'other' }).metadata.namespace, 'other');
  });

  test('refuses to build a policy that selects nothing', () => {
    // An empty podSelector matches every pod in the namespace, so a missing project would
    // not produce a useless object — it would produce one that governs all of them.
    assert.throws(() => buildProjectNetworkPolicyManifest(''), /needs a project/);
    assert.throws(() => buildProjectNetworkPolicyManifest(null), /needs a project/);
  });
});

describe('the run token a training pod is handed', () => {
  const SECRET = 'ashml-run-resnet-cifar-3f2b1c4d-0-token';

  test('reaches the container by reference, never as a value in the Job', () => {
    // The property, stated as the thing an attacker would look for: the plaintext must
    // not appear anywhere in the object `kubectl get job -o yaml` returns.
    const manifest = buildJobManifest(makeJob(), { runSecret: SECRET });
    const entry = manifest.spec.template.spec.containers[0].env
      .find((e) => e.name === 'ASHML_RUN_TOKEN');

    assert.deepEqual(entry.valueFrom, { secretKeyRef: { name: SECRET, key: 'token' } });
    assert.equal(entry.value, undefined);
  });

  test('a job launched without one carries no empty credential', () => {
    // Not `ASHML_RUN_TOKEN=""`. An SDK that reads an empty string sends an
    // `Authorization: Bearer` header with nothing after it, which is refused as malformed
    // rather than as missing — and the message a user gets should say the second.
    const env = buildJobManifest(makeJob()).spec.template.spec.containers[0].env;
    assert.equal(env.find((e) => e.name === 'ASHML_RUN_TOKEN'), undefined);
  });

  test('the user cannot supply their own, whichever form it takes', () => {
    const manifest = buildJobManifest(
      makeJob({ spec: { image: 'busybox', env: { ASHML_RUN_TOKEN: 'mine' } } }),
      { runSecret: SECRET },
    );
    const entries = manifest.spec.template.spec.containers[0].env
      .filter((e) => e.name === 'ASHML_RUN_TOKEN');

    assert.equal(entries.length, 1);
    assert.equal(entries[0].value, undefined);
  });

  test('each attempt gets its own Secret, so a retry cannot overwrite one in use', () => {
    assert.notEqual(runSecretName(makeJob({ attempt: 0 })), runSecretName(makeJob({ attempt: 1 })));
  });

  test('the Secret name is a legal DNS-1123 label even for the longest job name', () => {
    const name = runSecretName(makeJob({ name: 'x'.repeat(120) }));
    assert.ok(name.length <= 63, `${name.length} characters is too long`);
    assert.match(name, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  test('the Secret carries the job id, which is what makes cleanup one call', () => {
    const job = makeJob({ attempt: 2 });
    const secret = buildRunSecretManifest(job, 'ash_run_secret');

    assert.equal(secret.metadata.name, runSecretName(job));
    assert.equal(secret.metadata.labels['ashml.io/job-id'], job.id);
    assert.equal(secret.metadata.labels['ashml.io/attempt'], '2');
    assert.equal(secret.stringData.token, 'ash_run_secret');
  });

  test('a Secret with nothing in it is refused rather than created empty', () => {
    // An empty Secret is worse than none: the Pod starts, the SDK reads a blank
    // credential, and the run fails at its first upload rather than at its first second.
    assert.throws(() => buildRunSecretManifest(makeJob(), ''), /needs a token/);
    assert.throws(() => buildRunSecretManifest(makeJob(), null), /needs a token/);
  });
});
