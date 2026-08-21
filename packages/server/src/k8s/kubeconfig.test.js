/**
 * Which cluster the Kubernetes backend talks to.
 *
 * This is a small amount of code protecting against a failure that is very hard to
 * recognise from its symptoms. `current-context` is a *global* setting in a kubeconfig,
 * owned by whoever last ran `kubectl config use-context` — so a control plane restarted
 * on a workstation with more than one cluster can come back pointed at a different one.
 * What an operator then sees is every node gone, running jobs reporting their Kubernetes
 * Job as vanished, and nothing anywhere saying "different cluster".
 *
 * No cluster is contacted here: a kubeconfig is a file, and choosing a context in it is
 * parsing, not connecting.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createKubernetesBackend } from './kubernetes.js';

const KUBECONFIG = `
apiVersion: v1
kind: Config
current-context: other-cluster
clusters:
  - name: ashml-local
    cluster:
      server: https://127.0.0.1:6550
      insecure-skip-tls-verify: true
  - name: something-else
    cluster:
      server: https://127.0.0.1:7777
      insecure-skip-tls-verify: true
contexts:
  - name: ashml
    context: { cluster: ashml-local, user: ashml }
  - name: other-cluster
    context: { cluster: something-else, user: ashml }
users:
  - name: ashml
    user: { token: not-a-real-token }
`;

describe('choosing a cluster from a kubeconfig', () => {
  let dir;
  let file;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ashml-kubeconfig-'));
    file = path.join(dir, 'config');
    await writeFile(file, KUBECONFIG);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('with no context named, current-context wins — and is reported as unpinned', () => {
    // Unpinned is the honest label: this is the setting something outside the process
    // can change between one restart and the next.
    const backend = createKubernetesBackend({ kubeconfig: file });
    const target = backend.describeTarget();

    assert.equal(target.context, 'other-cluster');
    assert.equal(target.server, 'https://127.0.0.1:7777');
    assert.equal(target.pinned, false);
  });

  test('a named context overrides current-context', () => {
    const backend = createKubernetesBackend({ kubeconfig: file, kubeconfigContext: 'ashml' });
    const target = backend.describeTarget();

    assert.equal(target.context, 'ashml');
    assert.equal(target.cluster, 'ashml-local');
    assert.equal(target.server, 'https://127.0.0.1:6550');
    assert.equal(target.pinned, true);
  });

  test('a context that is not there is refused, and the message lists the ones that are', () => {
    // The client accepts any string here, so a typo would otherwise surface much later
    // as a null cluster inside some unrelated call.
    const backend = createKubernetesBackend({ kubeconfig: file, kubeconfigContext: 'ashml-local' });

    assert.throws(() => backend.describeTarget(), (err) => {
      // 'ashml-local' is a *cluster* here, not a context — the likeliest typo of the two.
      assert.match(err.message, /ASHML_KUBECONFIG_CONTEXT="ashml-local"/);
      assert.match(err.message, /ashml, other-cluster/);
      return true;
    });
  });

  test('connecting is lazy, so constructing a backend never reads a file', () => {
    // buildApp decorates a backend unconditionally, including on machines with no
    // kubeconfig at all. Constructing must stay pure for that to be safe.
    assert.doesNotThrow(() => createKubernetesBackend({
      kubeconfig: '/nonexistent/kubeconfig',
      kubeconfigContext: 'whatever',
    }));
  });
});
