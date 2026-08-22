/**
 * Unit tests for the router's request path.
 *
 * The transport is injected, so nothing here needs a pod, and `random` is injected, so
 * nothing here is statistical: a routing test that passes 99 times in 100 fails in CI for
 * reasons nobody can reproduce.
 *
 * The distinction these tests exist for is between a version that **did not answer** and
 * a version that **answered badly**. Failing the first over to another version is
 * resilience; failing the second over is hiding a broken canary behind a healthy
 * incumbent, which makes the canary worthless — and the two are one line apart in the
 * implementation.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter, ROUTE_KEY_HEADER } from './app.js';

/** A routing table with no control plane behind it. */
function fakeTable(targets, { deployment = 'resnet-cifar', loaded = true, age = 0 } = {}) {
  const down = new Set();
  return {
    targets: () => targets.map((t) => ({ ...t, ready: t.ready !== false && !down.has(t.version) })),
    status: () => ({
      deployment, deployment_id: 'dep-1', model: 'm', loaded, age_seconds: age, refreshes: 1,
      last_error: null, source: 'http://cp/api/v1/deployments/dep-1/routing',
    }),
    markUnreachable: (v) => down.add(v),
    markReachable: (v) => down.delete(v),
    _down: down,
  };
}

const apps = [];
function build(table, options = {}) {
  const app = createRouter({ table, logger: false, random: () => 0, ...options });
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop().close();
});

/** Records which version each request reached, and answers however the test says. */
function recordingForward(answer = () => ({ status: 200, headers: {}, body: Buffer.from('{}') })) {
  const seen = [];
  const forward = async (target, request) => {
    seen.push({ version: target.version, url: target.url, path: request.url });
    const result = answer(target, request);
    if (result instanceof Error) throw result;
    return result;
  };
  forward.seen = seen;
  return forward;
}

describe('choosing a version', () => {
  test('a single version takes everything and says so', async () => {
    const forward = recordingForward();
    const app = build(fakeTable([{ version: 6, weight: 100, url: 'http://v6' }]), { forward });

    const res = await app.inject({ method: 'POST', url: '/predict', payload: { a: 1 } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(forward.seen.map((s) => s.version), [6]);
    assert.equal(res.headers['x-ashml-served-by'], 'v6');
    assert.equal(res.headers['x-ashml-route-reason'], 'sole-target');
  });

  test('the weights decide, and the answer names the version that produced it', async () => {
    // random() = 0 lands in the first bucket; the point is not which one it picked but
    // that the response can be attributed at all. A split whose outputs cannot be
    // attributed is two models answering and no way to compare them.
    const forward = recordingForward();
    const app = build(
      fakeTable([
        { version: 6, weight: 90, url: 'http://v6' },
        { version: 7, weight: 10, url: 'http://v7' },
      ]),
      { forward },
    );

    const res = await app.inject({ method: 'POST', url: '/predict', payload: {} });
    assert.equal(res.headers['x-ashml-served-by'], 'v6');
    assert.equal(res.headers['x-ashml-route-reason'], 'weighted');
    assert.equal(res.headers['x-ashml-deployment'], 'resnet-cifar');
  });

  test('a route key lands on the same version every time', async () => {
    const forward = recordingForward();
    const app = build(
      fakeTable([
        { version: 6, weight: 50, url: 'http://v6' },
        { version: 7, weight: 50, url: 'http://v7' },
      ]),
      // A random that would pick differently every time, to prove it is not consulted.
      { forward, random: () => Math.random() },
    );

    const versions = new Set();
    for (let i = 0; i < 8; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/predict',
        headers: { [ROUTE_KEY_HEADER]: 'user-42' },
        payload: {},
      });
      assert.equal(res.headers['x-ashml-route-reason'], 'sticky');
      versions.add(res.headers['x-ashml-served-by']);
    }
    // An A/B test where a user is routed to v6 then v7 then v6 measures a mixture, and
    // every per-user metric it produces is meaningless.
    assert.equal(versions.size, 1, `one key reached ${[...versions].join(' and ')}`);
  });

  test('a version at weight 0 never answers, even when it is the only one running', async () => {
    // Weight 0 is an operator retiring a version. Serving from it because nothing else
    // is available is the exact failure §21 exists to prevent.
    const forward = recordingForward();
    const app = build(
      fakeTable([
        { version: 6, weight: 0, url: 'http://v6' },
        { version: 7, weight: 100, url: 'http://v7', ready: false },
      ]),
      { forward },
    );

    const res = await app.inject({ method: 'POST', url: '/predict', payload: {} });
    assert.equal(res.statusCode, 503);
    assert.equal(forward.seen.length, 0);
    assert.match(res.json().detail, /v6 \(weight 0/);
  });
});

describe('a version that does not answer', () => {
  test('the request fails over to one that does, and the header says so', async () => {
    const forward = recordingForward((target) => (
      target.version === 6
        ? new Error('connect ECONNREFUSED 10.0.0.1:80')
        : { status: 200, headers: {}, body: Buffer.from('{"ok":true}') }
    ));
    const app = build(
      fakeTable([
        { version: 6, weight: 90, url: 'http://v6' },
        { version: 7, weight: 10, url: 'http://v7' },
      ]),
      { forward },
    );

    const res = await app.inject({ method: 'POST', url: '/predict', payload: {} });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(forward.seen.map((s) => s.version), [6, 7]);
    assert.equal(res.headers['x-ashml-served-by'], 'v7');
    // Not "weighted": the weights did not send this request here, a failure did, and
    // calling it weighted would misattribute it in every count built from the header.
    assert.equal(res.headers['x-ashml-route-reason'], 'failover');
  });

  test('the version that could not be reached stops being chosen', async () => {
    const table = fakeTable([
      { version: 6, weight: 90, url: 'http://v6' },
      { version: 7, weight: 10, url: 'http://v7' },
    ]);
    const forward = recordingForward((target) => (
      target.version === 6
        ? new Error('connect ECONNREFUSED')
        : { status: 200, headers: {}, body: Buffer.from('{}') }
    ));
    const app = build(table, { forward });

    await app.inject({ method: 'POST', url: '/predict', payload: {} });
    assert.ok(table._down.has(6), 'the router trusts what it just experienced');

    forward.seen.length = 0;
    await app.inject({ method: 'POST', url: '/predict', payload: {} });
    assert.deepEqual(forward.seen.map((s) => s.version), [7], 'no second wasted attempt');
  });

  test('nothing reachable is a 502 that names what was tried', async () => {
    const forward = recordingForward(() => new Error('connect ECONNREFUSED'));
    const app = build(
      fakeTable([
        { version: 6, weight: 50, url: 'http://v6' },
        { version: 7, weight: 50, url: 'http://v7' },
      ]),
      { forward },
    );

    const res = await app.inject({ method: 'POST', url: '/predict', payload: {} });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json().attempted, ['v6', 'v7']);
    // At most one failover: a deployment where everything is down should say so quickly
    // rather than walking the list through a connection timeout each.
    assert.equal(forward.seen.length, 2);
  });
});

describe('a version that answers badly', () => {
  test('a 500 from the model is returned as it stands, attributed to that version', async () => {
    // Retrying this on the incumbent is what makes a canary pointless: the errors the
    // canary exists to find would be served successfully by v6 and never counted.
    const forward = recordingForward((target) => (
      target.version === 7
        ? { status: 500, headers: {}, body: Buffer.from('{"error":"shape mismatch"}') }
        : { status: 200, headers: {}, body: Buffer.from('{}') }
    ));
    const app = build(
      fakeTable([
        { version: 6, weight: 0, url: 'http://v6' },
        { version: 7, weight: 100, url: 'http://v7' },
      ]),
      { forward },
    );

    const res = await app.inject({ method: 'POST', url: '/predict', payload: {} });
    assert.equal(res.statusCode, 500);
    assert.equal(res.headers['x-ashml-served-by'], 'v7');
    assert.deepEqual(forward.seen.map((s) => s.version), [7], 'an error response is an answer');
    assert.equal(res.json().error, 'shape mismatch');
  });

  test('a 400 is the caller\'s, and is not retried anywhere', async () => {
    const forward = recordingForward(() => ({
      status: 400, headers: {}, body: Buffer.from('{"error":"batch must be a list"}'),
    }));
    const app = build(
      fakeTable([
        { version: 6, weight: 90, url: 'http://v6' },
        { version: 7, weight: 10, url: 'http://v7' },
      ]),
      { forward },
    );

    const res = await app.inject({ method: 'POST', url: '/predict', payload: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(forward.seen.length, 1);
  });
});

describe('what the router does not do', () => {
  test('it does not touch the body', async () => {
    // A client parsing a field the router added would break the moment the deployment
    // dropped back to one version and the router left the path.
    const body = JSON.stringify({ predictions: [3], probabilities: [[0.1]] });
    const forward = recordingForward(() => ({
      status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(body),
    }));
    const app = build(fakeTable([{ version: 6, weight: 100, url: 'http://v6' }]), { forward });

    const res = await app.inject({ method: 'POST', url: '/predict', payload: {} });
    assert.equal(res.payload, body);
  });

  test('it forwards the path and method it was given', async () => {
    const forward = recordingForward();
    const app = build(fakeTable([{ version: 6, weight: 100, url: 'http://v6' }]), { forward });
    await app.inject({ method: 'GET', url: '/metadata' });
    assert.equal(forward.seen[0].path, '/metadata');
  });
});

describe('the router\'s own endpoints', () => {
  test('healthz answers without consulting the routing table', async () => {
    const app = build({
      targets: () => { throw new Error('the routing table must not be consulted'); },
      status: () => { throw new Error('the routing table must not be consulted'); },
      markUnreachable() {}, markReachable() {},
    });
    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  });

  test('readyz refuses while there is no split to apply', async () => {
    const app = build(fakeTable([], { loaded: false }));
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(res.statusCode, 503);
    assert.match(res.json().reason, /no routing table/);
  });

  test('readyz stays up on a stale split rather than taking inference down', async () => {
    // A router that failed readiness because the control plane was restarting would be
    // pulled out of its Service's endpoints, and the deployment behind it would stop
    // answering — a control plane's availability becoming inference's availability.
    const app = build(fakeTable([{ version: 6, weight: 100, url: 'http://v6' }], { age: 600 }));
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().age_seconds, 600);
  });

  test('readyz refuses when nothing is both taking traffic and reachable', async () => {
    const app = build(fakeTable([{ version: 6, weight: 100, url: 'http://v6', ready: false }]));
    assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 503);
  });

  test('/-/routing shows the split and how old it is', async () => {
    const app = build(fakeTable([
      { version: 6, weight: 90, url: 'http://v6' },
      { version: 7, weight: 10, url: 'http://v7' },
    ], { age: 3 }));
    const body = (await app.inject({ method: 'GET', url: '/-/routing' })).json();
    assert.equal(body.age_seconds, 3);
    assert.deepEqual(body.targets.map((t) => t.weight), [90, 10]);
  });
});
