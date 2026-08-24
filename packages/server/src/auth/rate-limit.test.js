import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

/**
 * The limiter as the API actually applies it — which requests are counted against which
 * budget, and which are counted against none.
 *
 * Hermetic, and that is not an accident of convenience: none of these paths reach the
 * database. A request with no bearer token is refused before `authenticate` is called,
 * and with authentication switched off every request is the seeded local administrator
 * without a lookup. So the database URL below points at a closed port, and a test that
 * started needing one would fail rather than quietly depend on whatever was running.
 */

/** @param {object} env overrides on top of the hermetic defaults */
function configure(env = {}) {
  return loadConfig({
    ASHML_GPU_PROVIDER: 'sim',
    ASHML_SIM_GPUS: '1',
    ASHML_VERSION: '0.0.0-test',
    ASHML_DATABASE_URL: 'postgresql://ashml:ashml@127.0.0.1:1/ashml_not_listening',
    ...env,
  });
}

async function build(env) {
  const app = await buildApp(configure(env), { logger: false, collectDefaultMetrics: false });
  await app.ready();
  return app;
}

/** A route that needs a principal, so it exercises the identified budget. */
const GUARDED = '/api/v1/version';

describe('rate limiting', () => {
  describe('an identified caller', () => {
    // Authentication off makes every request the same local administrator, which is the
    // cheapest way to have a *known* principal without a database behind it.
    const env = { ASHML_AUTH_ENABLED: 'false', ASHML_RATE_LIMIT_PER_MINUTE: '5' };

    test('may spend the budget, and is refused after it', async (t) => {
      const app = await build(env);
      t.after(() => app.close());

      for (let i = 0; i < 5; i += 1) {
        const res = await app.inject({ method: 'GET', url: GUARDED });
        assert.equal(res.statusCode, 200, `request ${i + 1} of 5: ${res.payload}`);
      }

      const refused = await app.inject({ method: 'GET', url: GUARDED });
      assert.equal(refused.statusCode, 429);
      assert.equal(refused.json().error.code, 'RATE_LIMITED');
    });

    test('is told its budget on every request, refused or not', async (t) => {
      const app = await build(env);
      t.after(() => app.close());

      const first = await app.inject({ method: 'GET', url: GUARDED });
      assert.equal(first.headers['ratelimit-limit'], '5');
      assert.equal(first.headers['ratelimit-remaining'], '4');
      assert.ok(Number(first.headers['ratelimit-reset']) > 0);
      assert.equal(first.headers['retry-after'], undefined, 'nothing to retry after');

      for (let i = 0; i < 4; i += 1) await app.inject({ method: 'GET', url: GUARDED });

      const refused = await app.inject({ method: 'GET', url: GUARDED });
      assert.equal(refused.headers['ratelimit-remaining'], '0');
      // A refusal a client cannot act on is a refusal it will repeat immediately.
      assert.ok(Number(refused.headers['retry-after']) >= 1);
    });

    test('knocking while blocked does not push the recovery further away', async (t) => {
      const app = await build(env);
      t.after(() => app.close());

      for (let i = 0; i < 5; i += 1) await app.inject({ method: 'GET', url: GUARDED });

      const first = await app.inject({ method: 'GET', url: GUARDED });
      for (let i = 0; i < 20; i += 1) await app.inject({ method: 'GET', url: GUARDED });
      const last = await app.inject({ method: 'GET', url: GUARDED });

      assert.equal(last.statusCode, 429);
      assert.ok(
        Number(last.headers['retry-after']) <= Number(first.headers['retry-after']),
        'a refused request must not be charged, or a retry loop becomes a ban',
      );
    });

    test('counts the refusal in ashml_rate_limited_total', async (t) => {
      const app = await build(env);
      t.after(() => app.close());

      for (let i = 0; i < 6; i += 1) await app.inject({ method: 'GET', url: GUARDED });

      const scrape = await app.inject({ method: 'GET', url: '/metrics' });
      assert.match(scrape.payload, /ashml_rate_limited_total\{[^}]*scope="identified"[^}]*\} 1/);
    });

    test('reports how many callers it is tracking', async (t) => {
      const app = await build(env);
      t.after(() => app.close());

      await app.inject({ method: 'GET', url: GUARDED });
      const scrape = await app.inject({ method: 'GET', url: '/metrics' });
      assert.match(scrape.payload, /ashml_rate_limit_keys\{[^}]*scope="identified"[^}]*\} 1/);
    });
  });

  describe('an anonymous caller', () => {
    const env = { ASHML_RATE_LIMIT_ANON_PER_MINUTE: '3' };

    test('is refused outright once it has spent its 401s', async (t) => {
      const app = await build(env);
      t.after(() => app.close());

      for (let i = 0; i < 3; i += 1) {
        const res = await app.inject({ method: 'GET', url: GUARDED });
        assert.equal(res.statusCode, 401, `attempt ${i + 1} of 3`);
      }

      // The fourth never reaches the authentication hook — which is the entire point,
      // because that hook is what would hash a token and go to the database.
      const refused = await app.inject({ method: 'GET', url: GUARDED });
      assert.equal(refused.statusCode, 429);
      assert.equal(refused.json().error.code, 'RATE_LIMITED');
      assert.match(refused.json().error.message, /address/);
    });

    test('spends its budget on any path, including ones that do not exist', async (t) => {
      const app = await build(env);
      t.after(() => app.close());

      // Probing for endpoints is one of the things this is here to make expensive, so an
      // unmatched path is counted like any other.
      for (let i = 0; i < 3; i += 1) {
        await app.inject({ method: 'GET', url: `/api/v1/no-such-thing-${i}` });
      }
      const refused = await app.inject({ method: 'GET', url: GUARDED });
      assert.equal(refused.statusCode, 429);
    });

    test('is counted per address, not in one pool', async (t) => {
      const app = await build(env);
      t.after(() => app.close());

      for (let i = 0; i < 4; i += 1) {
        await app.inject({ method: 'GET', url: GUARDED, remoteAddress: '10.0.0.1' });
      }
      const other = await app.inject({ method: 'GET', url: GUARDED, remoteAddress: '10.0.0.2' });
      assert.equal(other.statusCode, 401, 'one address exhausting its budget must not block another');
    });

    test('spends it on the public dashboard too', async (t) => {
      const app = await build(env);
      t.after(() => app.close());

      // `/` needs no credential, but a stranger asking for it repeatedly is still a
      // stranger making this server do work.
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 200);
      }
      assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 429);
    });
  });

  describe('the exempt paths', () => {
    test('probes and scrapes answer however hard the caller is being throttled', async (t) => {
      const app = await build({ ASHML_RATE_LIMIT_ANON_PER_MINUTE: '1' });
      t.after(() => app.close());

      await app.inject({ method: 'GET', url: GUARDED });
      assert.equal((await app.inject({ method: 'GET', url: GUARDED })).statusCode, 429);

      // A throttled liveness probe is a pod Kubernetes restarts, and a throttled
      // /metrics blinds the monitoring at the moment it is describing the overload.
      for (let i = 0; i < 10; i += 1) {
        assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
        // 503 here: this suite has no database. What matters is that it is not a 429.
        assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 503);
        assert.equal((await app.inject({ method: 'GET', url: '/metrics' })).statusCode, 200);
      }
    });
  });

  describe('when it is switched off', () => {
    test('nothing is limited and nothing is claimed in the headers', async (t) => {
      const app = await build({
        ASHML_AUTH_ENABLED: 'false',
        ASHML_RATE_LIMIT_ENABLED: 'false',
      });
      t.after(() => app.close());

      for (let i = 0; i < 50; i += 1) {
        const res = await app.inject({ method: 'GET', url: GUARDED });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['ratelimit-limit'], undefined);
      }
      assert.equal(app.hasDecorator('rateLimiters'), false);
    });
  });

  describe('configuration', () => {
    test('a limit of zero is refused rather than read as unlimited', () => {
      // Zero means unlimited for a quota. Taking it that way here would turn a typo into
      // an open door, so it is an error with the switch that does mean it in the message.
      assert.throws(
        () => configure({ ASHML_RATE_LIMIT_PER_MINUTE: '0' }),
        /ASHML_RATE_LIMIT_ENABLED=false/,
      );
    });

    test('forwarded addresses are not believed unless asked for', () => {
      assert.equal(configure().trustProxy, false);
      assert.equal(configure({ ASHML_TRUST_PROXY: 'true' }).trustProxy, true);
    });
  });
});
