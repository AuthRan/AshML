import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

// The sim provider keeps these tests hermetic — they must pass on a machine with
// no GPU, which is exactly what CI is.
const testConfig = loadConfig({
  ASHML_GPU_PROVIDER: 'sim',
  ASHML_SIM_GPUS: '3',
  ASHML_VERSION: '0.0.0-test',
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
