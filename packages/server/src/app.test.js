import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

// The sim provider keeps these tests hermetic — they must pass on a machine with
// no GPU, which is exactly what CI is.
//
// The database URL is part of that and was missing: unset, it defaults to the *dev*
// database, so the readiness test below asserted "the database is unreachable" against
// whatever the developer had running. It passed in CI and on a laptop that had not run
// `make db-up`, and failed on one that had — a test whose result depended on something
// it was not testing. Port 1 is closed everywhere, so what it claims is now true
// everywhere, and it never touches a real database to prove it.
const testConfig = loadConfig({
  ASHML_GPU_PROVIDER: 'sim',
  ASHML_SIM_GPUS: '3',
  ASHML_VERSION: '0.0.0-test',
  ASHML_DATABASE_URL: 'postgresql://ashml:ashml@127.0.0.1:1/ashml_not_listening',
  // These are route-shape tests — serialization, the error envelope, what the dashboard
  // fetches — and they run against a database that is deliberately not listening. In this
  // mode every request acts as the seeded local administrator without touching the
  // database, so the routing under test is reachable. Authentication itself is covered by
  // `services/auth.integration.test.js`, against a server with it on.
  ASHML_AUTH_ENABLED: 'false',
});

describe('ashml-server', () => {
  let app;

  before(async () => {
    app = await buildApp(testConfig, { logger: false });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  test('GET /healthz', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  });

  test('GET /readyz reports 503 when the database is unreachable', async () => {
    // This suite runs without a database on purpose. Readiness must fail closed:
    // a 503 tells Kubernetes to stop routing traffic without restarting the pod,
    // whereas /healthz stays 200 because the process itself is fine.
    // The healthy path is covered in jobs.integration.test.js.
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'DATABASE_UNAVAILABLE');
  });

  test('liveness stays healthy even when the database is not', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200);
  });

  test('GET /api/v1/version reports the active provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/version' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { version: '0.0.0-test', gpu_provider: 'sim' });
  });

  test('GET /api/v1/gpus returns the configured device count', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/gpus' });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.provider, 'sim');
    assert.equal(body.gpus.length, 3);
  });

  test('simulated devices survive response serialization', async () => {
    // Fastify strips properties absent from the response schema. If `simulated`
    // were ever dropped from the schema, a demo could silently present fake
    // telemetry as real — which spec Rule 5 forbids. This test guards that.
    const res = await app.inject({ method: 'GET', url: '/api/v1/gpus' });
    for (const gpu of res.json().gpus) {
      assert.equal(gpu.simulated, true, 'sim provider must flag every device');
    }
  });

  test('device responses carry derived free memory', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/gpus' });
    const [gpu] = res.json().gpus;
    assert.equal(gpu.memory_free_bytes, gpu.memory_total_bytes - gpu.memory_used_bytes);
  });

  test('unknown routes use the standard error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    assert.equal(res.statusCode, 404);

    const body = res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.ok(typeof body.error.message === 'string');
  });

  test('GET / serves the dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.payload, /<title>AshML<\/title>/);
    // It must never be cached: a dashboard showing a stale reading as though it were
    // current is worse than one that fails to load.
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  test('the dashboard holds no logic — it only calls the public API', async () => {
    // The rule the CLI already follows (spec §28), asserted rather than trusted, because
    // the tempting shortcut when a page needs something awkward is to compute it in the
    // page. Every path the page fetches must be one this API actually serves.
    const res = await app.inject({ method: 'GET', url: '/' });
    const paths = [...res.payload.matchAll(/(?:get|fetch)\(\s*[`'"]([^`'"$]*\/api\/v1[^`'"]*)/g)]
      .map((m) => m[1].split('?')[0]);
    assert.ok(paths.length > 0, 'the page fetches nothing, so something has gone wrong');

    for (const path of paths) {
      // Only the paths the page writes out whole — the project-scoped ones are built by
      // interpolation and are covered by the model and deployment integration suites.
      if (path.includes('${')) continue;

      // Asked of the app rather than matched against a printed route tree: what matters
      // is that a request to this path is *routed*, not that a string appears somewhere.
      // Without a database most of these fail — the point is that they fail as the API,
      // not as "no such route".
      const probe = await app.inject({ method: 'GET', url: path });
      assert.notEqual(
        probe.json()?.error?.code, 'NOT_FOUND',
        `the dashboard fetches ${path}, which this API does not serve`,
      );
    }
  });

  test('the dashboard stays out of the OpenAPI document', async () => {
    // That document describes the API and is used to generate clients; an HTML page
    // among the resources is noise in every one of them.
    assert.ok(!app.swagger().paths['/'], 'the dashboard should not appear as an API resource');
  });

  test('OpenAPI document is generated from the route schemas', async () => {
    const spec = app.swagger();
    assert.equal(spec.info.title, 'AshML API');
    assert.ok(spec.paths['/api/v1/gpus'], 'gpus route should appear in the spec');
    assert.ok(spec.paths['/healthz'], 'healthz should appear in the spec');
  });
});

describe('provider selection', () => {
  test('an unknown provider fails at startup with the available names', async () => {
    const bad = loadConfig({ ASHML_GPU_PROVIDER: 'does-not-exist' });
    await assert.rejects(
      () => buildApp(bad, { logger: false }),
      /does-not-exist.*available.*nvidia.*sim/s,
    );
  });

  test('nvidia is the default so sim must be opted into explicitly', () => {
    assert.equal(loadConfig({}).gpuProvider, 'nvidia');
  });
});
