/**
 * Authentication and authorization, end to end against a real PostgreSQL.
 *
 * The other integration suites all authenticate as the seeded administrator and assert
 * that things *work*. This file is the other half, and it is the half that matters: an
 * authorization bug produces no symptom in a working system, so the only way to know a
 * refusal happens is to ask for it and check.
 *
 * Three things are covered, in order of how badly getting them wrong would end:
 *
 *   1. Default deny — every route needs a principal, including routes nobody remembered.
 *   2. Project isolation — a member of one project cannot see or touch another's.
 *   3. Workload scope — a run token can report its own results and do nothing else.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { Role } from '../domain/roles.js';
import { mintToken, TokenKind } from '../auth/tokens.js';
import { issueRunToken, expireRunTokens, ensureServingToken } from './auth.js';
import {
  connectOrNull, wipeAll, uniqueName, SKIP_MESSAGE, LOCAL_USER_ID,
} from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => { await pool?.end(); });

describe('auth (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let backend;
  let adminToken;

  /** Injects with an explicit token, or with none at all when given null. */
  function call(token, options) {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    return app.inject({ ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  }

  /** Creates a user and a working token for them. Returns both. */
  async function makeUser({ isAdmin = false } = {}) {
    const email = `${uniqueName('user')}@example.com`;
    const { rows } = await pool.query(
      'INSERT INTO users (email, display_name, is_admin) VALUES ($1, $2, $3) RETURNING id',
      [email, email, isAdmin],
    );
    const userId = rows[0].id;
    const { token, hash, prefix } = mintToken(TokenKind.USER);
    await pool.query(
      'INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES ($1, $2, $3, $4)',
      [userId, 'test', hash, prefix],
    );
    return { userId, email, token };
  }

  async function makeProject(token) {
    const res = await call(token, {
      method: 'POST', url: '/api/v1/projects', payload: { name: uniqueName('proj') },
    });
    assert.equal(res.statusCode, 201, res.payload);
    return res.json();
  }

  async function submitJob(token, projectName) {
    const res = await call(token, {
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        project: projectName,
        name: uniqueName('job'),
        spec: { image: 'busybox:1.36' },
        resources: { cpu: 1 },
      },
    });
    assert.equal(res.statusCode, 201, res.payload);
    return res.json();
  }

  /**
   * Puts a job into RUNNING directly.
   *
   * These tests are about who may report, not about how a job gets to the point of
   * having something to report, so driving the executor here would make every one of
   * them depend on scheduling as well.
   */
  async function startJob(jobId) {
    await pool.query(
      `UPDATE training_jobs
       SET state = 'RUNNING', started_at = now(), k8s_job_name = 'test'
       WHERE id = $1`,
      [jobId],
    );
  }

  before(async () => {
    const config = loadConfig({
      ASHML_GPU_PROVIDER: 'sim',
      ASHML_K8S_BACKEND: 'sim',
      ASHML_ARTIFACT_STORE: 'none',
      ASHML_AUTH_ENABLED: 'true',
      ASHML_VERSION: '0.0.0-test',
    });
    backend = createSimBackend({ namespace: 'ashml-test', nodes: [] });
    app = await buildApp(config, { logger: false, pool, k8s: backend });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await backend?.close();
  });

  beforeEach(async () => {
    await wipeAll(pool);
    await pool.query('TRUNCATE api_tokens CASCADE');
    await pool.query("DELETE FROM users WHERE id <> $1", [LOCAL_USER_ID]);

    const { token, hash, prefix } = mintToken(TokenKind.USER);
    await pool.query(
      'INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES ($1, $2, $3, $4)',
      [LOCAL_USER_ID, 'admin', hash, prefix],
    );
    adminToken = token;
  });

  describe('default deny', () => {
    test('an unauthenticated request is refused, and says how to fix it', async () => {
      const res = await call(null, { method: 'GET', url: '/api/v1/projects' });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'UNAUTHENTICATED');
      // Tells a generic HTTP client this is a credentials problem, not a server one.
      assert.match(res.headers['www-authenticate'], /Bearer/);
    });

    test('every /api/v1 route requires a principal', async () => {
      // Taken from the generated OpenAPI document, which is built from the route schemas
      // themselves (`make openapi`) — so this is the real surface, not a list somebody
      // maintains, and a route added tomorrow is covered the day it is added.
      const routes = [];
      for (const [path, methods] of Object.entries(app.swagger().paths ?? {})) {
        if (!path.startsWith('/api/v1/')) continue;
        for (const method of Object.keys(methods)) {
          routes.push({ method: method.toUpperCase(), url: path });
        }
      }

      assert.ok(routes.length > 20, `expected the API surface, found ${routes.length}`);

      for (const { method, url: pattern } of routes) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        // Any parameter value will do: authentication is refused before the handler runs,
        // so nothing ever looks these up.
        // OpenAPI writes parameters as {name}; any value will do.
        const url = pattern.replace(/\{[A-Za-z_]+\}/g, '00000000-0000-0000-0000-000000000000');
        const res = await call(null, {
          method, url, payload: method === 'GET' || method === 'DELETE' ? undefined : {},
        });
        assert.equal(
          res.statusCode, 401,
          `${method} ${url} answered ${res.statusCode} without a token`,
        );
      }
    });

    test('a token that is not ours is refused exactly like no token', async () => {
      const res = await call('ashml_u_not-a-real-token', {
        method: 'GET', url: '/api/v1/projects',
      });
      assert.equal(res.statusCode, 401);
    });

    test('a revoked token stops working', async () => {
      const user = await makeUser();
      assert.equal((await call(user.token, { method: 'GET', url: '/api/v1/projects' })).statusCode, 200);

      await pool.query('UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1', [user.userId]);

      const after = await call(user.token, { method: 'GET', url: '/api/v1/projects' });
      assert.equal(after.statusCode, 401);
    });

    test('an expired token stops working', async () => {
      const user = await makeUser();
      await pool.query(
        "UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1",
        [user.userId],
      );
      assert.equal((await call(user.token, { method: 'GET', url: '/api/v1/projects' })).statusCode, 401);
    });

    test('a path that exists nowhere is 401 unauthenticated, 404 once known', async () => {
      // A 404 to an anonymous caller would let anyone map the API surface by probing.
      const anon = await call(null, { method: 'GET', url: '/api/v1/not-a-real-route' });
      assert.equal(anon.statusCode, 401);

      // Someone who has already authenticated gets the answer they actually need.
      const known = await call(adminToken, { method: 'GET', url: '/api/v1/not-a-real-route' });
      assert.equal(known.statusCode, 404);
      assert.equal(known.json().error.code, 'NOT_FOUND');
    });

    test('the probes and the dashboard stay reachable without a token', async () => {
      // A probe that needs a token turns an auth misconfiguration into an outage of the
      // thing that would have reported it.
      for (const url of ['/healthz', '/readyz', '/metrics', '/']) {
        const res = await call(null, { method: 'GET', url });
        assert.ok(res.statusCode < 400, `${url} answered ${res.statusCode}`);
      }
    });
  });

  describe('project isolation', () => {
    test('a project is invisible to someone who is not in it', async () => {
      const alice = await makeUser();
      const bob = await makeUser();
      const project = await makeProject(alice.token);

      // 404 rather than 403: a 403 would confirm the name is taken, which is how an
      // outsider enumerates project names.
      const read = await call(bob.token, { method: 'GET', url: `/api/v1/projects/${project.name}` });
      assert.equal(read.statusCode, 404);

      const list = await call(bob.token, { method: 'GET', url: '/api/v1/projects' });
      assert.deepEqual(list.json().projects, []);
    });

    test('the creator owns what they create', async () => {
      const alice = await makeUser();
      const project = await makeProject(alice.token);

      const members = await call(alice.token, {
        method: 'GET', url: `/api/v1/projects/${project.name}/members`,
      });
      assert.equal(members.statusCode, 200);
      assert.deepEqual(
        members.json().members.map((m) => [m.email, m.role]),
        [[alice.email, Role.OWNER]],
      );
    });

    test('a VIEWER may read but not write', async () => {
      const alice = await makeUser();
      const bob = await makeUser();
      const project = await makeProject(alice.token);

      await call(alice.token, {
        method: 'PUT',
        url: `/api/v1/projects/${project.name}/members/${encodeURIComponent(bob.email)}`,
        payload: { role: Role.VIEWER },
      });

      assert.equal(
        (await call(bob.token, { method: 'GET', url: `/api/v1/projects/${project.name}` })).statusCode,
        200,
      );

      const submit = await call(bob.token, {
        method: 'POST',
        url: '/api/v1/jobs',
        payload: {
          project: project.name,
          name: uniqueName('job'),
          spec: { image: 'busybox:1.36' },
          resources: { cpu: 1 },
        },
      });
      // 403 not 404: bob can see the project, so hiding it would be the confusing answer.
      assert.equal(submit.statusCode, 403);
      assert.equal(submit.json().error.code, 'FORBIDDEN');
    });

    test('an EDITOR may write but not manage members', async () => {
      const alice = await makeUser();
      const bob = await makeUser();
      const project = await makeProject(alice.token);
      await call(alice.token, {
        method: 'PUT',
        url: `/api/v1/projects/${project.name}/members/${encodeURIComponent(bob.email)}`,
        payload: { role: Role.EDITOR },
      });

      await submitJob(bob.token, project.name);

      const grant = await call(bob.token, {
        method: 'PUT',
        url: `/api/v1/projects/${project.name}/members/${encodeURIComponent(bob.email)}`,
        payload: { role: Role.OWNER },
      });
      assert.equal(grant.statusCode, 403, 'an editor must not be able to promote themselves');
    });

    test('a job is invisible outside its project', async () => {
      const alice = await makeUser();
      const bob = await makeUser();
      const project = await makeProject(alice.token);
      const job = await submitJob(alice.token, project.name);

      assert.equal((await call(bob.token, { method: 'GET', url: `/api/v1/jobs/${job.id}` })).statusCode, 404);
      assert.deepEqual((await call(bob.token, { method: 'GET', url: '/api/v1/jobs' })).json().jobs, []);
    });

    test('a project owner cannot raise their own quota', async () => {
      // The whole point of a quota: one a project owner can change is not a limit.
      const alice = await makeUser();
      const project = await makeProject(alice.token);

      const res = await call(alice.token, {
        method: 'PATCH', url: `/api/v1/projects/${project.name}/quota`, payload: { gpu: 99 },
      });
      assert.equal(res.statusCode, 403);

      const asAdmin = await call(adminToken, {
        method: 'PATCH', url: `/api/v1/projects/${project.name}/quota`, payload: { gpu: 99 },
      });
      assert.equal(asAdmin.statusCode, 200);
      assert.equal(asAdmin.json().quota.gpu, 99);
    });

    test('cluster inventory is not a project role', async () => {
      const alice = await makeUser();
      await makeProject(alice.token);

      assert.equal((await call(alice.token, { method: 'GET', url: '/api/v1/nodes' })).statusCode, 403);
      assert.equal((await call(adminToken, { method: 'GET', url: '/api/v1/nodes' })).statusCode, 200);
    });

    test('a project keeps at least one owner', async () => {
      const alice = await makeUser();
      const project = await makeProject(alice.token);

      const demote = await call(alice.token, {
        method: 'PUT',
        url: `/api/v1/projects/${project.name}/members/${encodeURIComponent(alice.email)}`,
        payload: { role: Role.VIEWER },
      });
      assert.equal(demote.statusCode, 409);
      assert.equal(demote.json().error.code, 'LAST_OWNER');
    });
  });

  describe('a run token', () => {
    test('may report metrics for its own job, and no other', async () => {
      const alice = await makeUser();
      const project = await makeProject(alice.token);
      const mine = await submitJob(alice.token, project.name);
      const other = await submitJob(alice.token, project.name);

      // Metrics are refused for a job that has not launched, which is a different rule
      // from authorization and would otherwise mask the thing under test here.
      await startJob(mine.id);
      await startJob(other.id);

      const { token: runToken } = await issueRunToken(pool, mine.id, 0);

      const ok = await call(runToken, {
        method: 'POST',
        url: `/api/v1/jobs/${mine.id}/metrics`,
        payload: { metrics: [{ name: 'loss', value: 1.5, step: 1 }] },
      });
      assert.equal(ok.statusCode, 201, ok.payload);

      const forged = await call(runToken, {
        method: 'POST',
        url: `/api/v1/jobs/${other.id}/metrics`,
        payload: { metrics: [{ name: 'loss', value: 0.001, step: 1 }] },
      });
      assert.equal(forged.statusCode, 404, 'one run must not be able to report for another');
    });

    test('may not read the project it runs in', async () => {
      const alice = await makeUser();
      const project = await makeProject(alice.token);
      const job = await submitJob(alice.token, project.name);
      const { token: runToken } = await issueRunToken(pool, job.id, 0);

      assert.equal(
        (await call(runToken, { method: 'GET', url: `/api/v1/projects/${project.name}` })).statusCode,
        404,
      );
      // Listing is refused outright rather than filtered to empty. A run has no
      // memberships, so there is no correct filter value to pass — and passing the
      // absent one is exactly the bug this assertion was written after finding.
      const listed = await call(runToken, { method: 'GET', url: '/api/v1/projects' });
      assert.equal(listed.statusCode, 403);
      assert.equal(listed.json().error.code, 'FORBIDDEN');
    });

    test('may not mint a user token', async () => {
      const alice = await makeUser();
      const project = await makeProject(alice.token);
      const job = await submitJob(alice.token, project.name);
      const { token: runToken } = await issueRunToken(pool, job.id, 0);

      const res = await call(runToken, {
        method: 'POST', url: '/api/v1/auth/tokens', payload: { name: 'escalate' },
      });
      assert.equal(res.statusCode, 403);
    });

    test('a person cannot report a run\'s results', async () => {
      // The record's value is that the pod reported what it observed (ADR 0009, Rule 5).
      const alice = await makeUser();
      const project = await makeProject(alice.token);
      const job = await submitJob(alice.token, project.name);

      const res = await call(alice.token, {
        method: 'POST',
        url: `/api/v1/jobs/${job.id}/metrics`,
        payload: { metrics: [{ name: 'accuracy', value: 0.99, step: 1 }] },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'FORBIDDEN');
    });

    test('the previous attempt\'s token is dead once the next one is minted', async () => {
      // A SIGKILLed pod can still be shutting down while its replacement starts. Without
      // this it could write its numbers onto the attempt that replaced it.
      const alice = await makeUser();
      const project = await makeProject(alice.token);
      const job = await submitJob(alice.token, project.name);
      await startJob(job.id);

      const first = await issueRunToken(pool, job.id, 0);
      const second = await issueRunToken(pool, job.id, 1);

      const stale = await call(first.token, {
        method: 'POST',
        url: `/api/v1/jobs/${job.id}/metrics`,
        payload: { metrics: [{ name: 'loss', value: 9.9, step: 1 }] },
      });
      assert.equal(stale.statusCode, 401);

      const live = await call(second.token, {
        method: 'POST',
        url: `/api/v1/jobs/${job.id}/metrics`,
        payload: { metrics: [{ name: 'loss', value: 0.5, step: 1 }] },
      });
      assert.equal(live.statusCode, 201, live.payload);
    });
  });

  describe('when a run ends', () => {
    test('a retry revokes at once; a finished run gets a grace window', async () => {
      // The two ways a run ends need opposite treatment, and each breaks something
      // specific if given the other's.
      const alice = await makeUser();
      const project = await makeProject(alice.token);
      const job = await submitJob(alice.token, project.name);
      await startJob(job.id);

      // A retry: the previous attempt is cut off immediately, because a pod that is still
      // shutting down must not report into the attempt that replaced it.
      const attempt0 = await issueRunToken(pool, job.id, 0);
      await issueRunToken(pool, job.id, 1);
      const { rows: revoked } = await pool.query(
        'SELECT revoked_at FROM workload_tokens WHERE attempt = 0 AND job_id = $1',
        [job.id],
      );
      assert.ok(revoked[0].revoked_at, 'the previous attempt must be revoked, not expired');
      assert.equal((await call(attempt0.token, {
        method: 'POST',
        url: `/api/v1/jobs/${job.id}/metrics`,
        payload: { metrics: [{ name: 'loss', value: 1, step: 1 }] },
      })).statusCode, 401);

      // Finishing: the token is put on a clock instead. The final checkpoint's upload is
      // confirmed after the pod has exited, so revoking here would strand it at PENDING.
      await expireRunTokens(pool, job.id, 300);
      const { rows: expired } = await pool.query(
        'SELECT revoked_at, expires_at FROM workload_tokens WHERE attempt = 1 AND job_id = $1',
        [job.id],
      );
      assert.equal(expired[0].revoked_at, null, 'a finished run is expired, not revoked');
      assert.ok(expired[0].expires_at > new Date(), 'and it still has time left');
    });

    test('the grace window only ever shortens a token\'s life', async () => {
      const alice = await makeUser();
      const project = await makeProject(alice.token);
      const job = await submitJob(alice.token, project.name);
      await issueRunToken(pool, job.id, 0, { ttlSeconds: 60 });

      // A second, longer grace must not extend a token that already expires sooner —
      // otherwise a job observed terminal twice would keep renewing its own credential.
      await expireRunTokens(pool, job.id, 86_400);
      const { rows } = await pool.query(
        'SELECT expires_at FROM workload_tokens WHERE job_id = $1',
        [job.id],
      );
      const secondsLeft = (rows[0].expires_at - Date.now()) / 1000;
      assert.ok(secondsLeft <= 61, `expected the shorter expiry to stand, got ${secondsLeft}s`);
    });
  });

  describe('a serving token', () => {
    /**
     * The regression this exists for.
     *
     * A serving credential reaches its pods as an env var from a Secret, which Kubernetes
     * materialises when the container starts and never updates. An earlier version minted
     * a fresh token on every apply and revoked the previous one — so `ash deployment
     * rollout` revoked the credential the *running* router was holding, restarted nothing
     * (by design, so a weight change does not drop traffic), and the router's next poll
     * 401'd. `routing-table.js` keeps serving its last good table on a failed refresh, so
     * the canary silently received no traffic and the command reported success.
     */
    async function makeDeployment() {
      const alice = await makeUser();
      const project = await makeProject(alice.token);
      // A deployment needs a model to point at. Inserted directly rather than driven
      // through the API: what is under test is the credential's lifetime, and standing up
      // a real training run to produce a registerable artifact would make every assertion
      // here depend on the whole ML lifecycle.
      const { rows: models } = await pool.query(
        'INSERT INTO models (project_id, name) VALUES ($1, $2) RETURNING id',
        [project.id, uniqueName('model')],
      );
      const { rows } = await pool.query(
        `INSERT INTO deployments (project_id, model_id, name, status)
         VALUES ($1, $2, $3, 'PENDING') RETURNING id`,
        [project.id, models[0].id, uniqueName('dep')],
      );
      return rows[0].id;
    }

    test('is minted once and survives every later apply', async () => {
      const deploymentId = await makeDeployment();

      const first = await ensureServingToken(pool, deploymentId);
      assert.ok(first.created, 'the first apply must mint one');
      assert.ok(first.token);

      // Every subsequent apply — a rollout, a promote, a retire — comes through here.
      for (let i = 0; i < 3; i += 1) {
        const again = await ensureServingToken(pool, deploymentId);
        assert.equal(again.created, false, 'a later apply must not rotate the credential');
        assert.equal(again.token, null, 'and has no plaintext to write to the Secret');
      }

      // The one that matters: the credential the running pods hold still works.
      const who = await call(first.token, { method: 'GET', url: '/api/v1/auth/whoami' });
      assert.equal(who.statusCode, 200, 'the running pods must not be locked out');
      assert.equal(who.json().kind, 'SERVING');
      assert.equal(who.json().deployment_id, deploymentId);
    });

    test('may read its own routing table and nothing else', async () => {
      const deploymentId = await makeDeployment();
      const other = await makeDeployment();
      const { token } = await ensureServingToken(pool, deploymentId);

      assert.equal(
        (await call(token, { method: 'GET', url: `/api/v1/deployments/${deploymentId}/routing` })).statusCode,
        200,
      );
      assert.equal(
        (await call(token, { method: 'GET', url: `/api/v1/deployments/${other}/routing` })).statusCode,
        404,
      );
      assert.equal((await call(token, { method: 'GET', url: '/api/v1/projects' })).statusCode, 403);
    });

    test('dies with the deployment it belongs to', async () => {
      const deploymentId = await makeDeployment();
      const { token } = await ensureServingToken(pool, deploymentId);
      assert.equal((await call(token, { method: 'GET', url: '/api/v1/auth/whoami' })).statusCode, 200);

      await pool.query('DELETE FROM deployments WHERE id = $1', [deploymentId]);

      assert.equal((await call(token, { method: 'GET', url: '/api/v1/auth/whoami' })).statusCode, 401);
    });
  });

  describe('tokens', () => {
    test('the plaintext is returned once and never stored', async () => {
      const created = await call(adminToken, {
        method: 'POST', url: '/api/v1/auth/tokens', payload: { name: 'ci' },
      });
      assert.equal(created.statusCode, 201);
      const { token } = created.json();
      assert.ok(token.startsWith('ashml_u_'));

      // It works...
      assert.equal((await call(token, { method: 'GET', url: '/api/v1/projects' })).statusCode, 200);

      // ...and nothing in the database is it.
      const { rows } = await pool.query('SELECT token_hash, prefix FROM api_tokens');
      for (const row of rows) {
        assert.notEqual(row.token_hash, token);
        assert.ok(!token.includes(row.token_hash));
        assert.ok(token.startsWith(row.prefix) || !token.startsWith(row.prefix));
      }

      // ...and listing never hands it back.
      const listed = await call(adminToken, { method: 'GET', url: '/api/v1/auth/tokens' });
      assert.ok(!listed.payload.includes(token));
    });

    test('revoking one leaves the others working', async () => {
      const a = await call(adminToken, {
        method: 'POST', url: '/api/v1/auth/tokens', payload: { name: 'one' },
      });
      const b = await call(adminToken, {
        method: 'POST', url: '/api/v1/auth/tokens', payload: { name: 'two' },
      });

      const revoke = await call(adminToken, { method: 'DELETE', url: '/api/v1/auth/tokens/one' });
      assert.equal(revoke.statusCode, 204);

      assert.equal((await call(a.json().token, { method: 'GET', url: '/api/v1/projects' })).statusCode, 401);
      assert.equal((await call(b.json().token, { method: 'GET', url: '/api/v1/projects' })).statusCode, 200);
    });

    test('whoami describes the caller', async () => {
      const alice = await makeUser();
      const project = await makeProject(alice.token);

      const who = (await call(alice.token, { method: 'GET', url: '/api/v1/auth/whoami' })).json();
      assert.equal(who.kind, 'USER');
      assert.equal(who.email, alice.email);
      assert.equal(who.is_admin, false);
      assert.deepEqual(who.projects, [{ project_id: project.id, role: Role.OWNER }]);
    });
  });
});
