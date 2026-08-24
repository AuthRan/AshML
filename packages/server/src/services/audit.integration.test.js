/**
 * The authorization audit trail, against a real PostgreSQL.
 *
 * What this suite is really testing is a claim that is easy to make and easy to get
 * wrong: that the trail records the *decision* rather than the response. The API answers
 * 404 for "you may not see this project", on purpose, so an audit built on status codes
 * would file the most security-relevant refusal there is under "not found" and nobody
 * would notice until they went looking for something that was never written down.
 *
 * So the assertions below are mostly about disagreement — that a row exists where the
 * caller was told 404, and that it names the permission they were actually reaching for.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createSimBackend } from '../k8s/sim.js';
import { Role, Permission } from '../domain/roles.js';
import { mintToken, TokenKind } from '../auth/tokens.js';
import { AuditLog } from './audit.js';
import {
  connectOrNull, truncateAll, uniqueName, SKIP_MESSAGE, LOCAL_USER_ID,
} from '../test-support/db.js';

const pool = await connectOrNull();

after(async () => { await pool?.end(); });

describe('authorization audit (integration)', { skip: pool ? false : SKIP_MESSAGE }, () => {
  let app;
  let backend;
  let adminToken;

  function call(token, options) {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    return app.inject({ ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  }

  async function makeUser({ isAdmin = false } = {}) {
    const email = `${uniqueName('user')}@example.com`;
    const { rows } = await pool.query(
      'INSERT INTO users (email, display_name, is_admin) VALUES ($1, $2, $3) RETURNING id',
      [email, email, isAdmin],
    );
    const { token, hash, prefix } = mintToken(TokenKind.USER);
    await pool.query(
      'INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES ($1, $2, $3, $4)',
      [rows[0].id, 'test', hash, prefix],
    );
    return { userId: rows[0].id, email, token };
  }

  async function makeProject(token) {
    const res = await call(token, {
      method: 'POST', url: '/api/v1/projects', payload: { name: uniqueName('proj') },
    });
    assert.equal(res.statusCode, 201, res.payload);
    return res.json();
  }

  /** Denials are buffered, so a test that reads the table has to drain it first. */
  async function denials() {
    await app.audit.flush();
    const { rows } = await pool.query(
      'SELECT * FROM authz_denials ORDER BY occurred_at DESC, id DESC',
    );
    return rows;
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
    // Drain before truncating, not after. The buffer outlives a TRUNCATE — it is in this
    // process, not in the database — so a denial left unflushed by the previous test
    // lands in the next one's table and reads as a row that test produced. That is not a
    // contrived failure; it is how this suite first went wrong.
    await app?.audit.flush();
    await truncateAll(pool);
    await pool.query('TRUNCATE api_tokens CASCADE');
    await pool.query('DELETE FROM users WHERE id <> $1', [LOCAL_USER_ID]);

    const { token, hash, prefix } = mintToken(TokenKind.USER);
    await pool.query(
      'INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES ($1, $2, $3, $4)',
      [LOCAL_USER_ID, 'admin', hash, prefix],
    );
    adminToken = token;
  });

  describe('what gets written', () => {
    test('a truthful 403 is recorded as one', async () => {
      const project = await makeProject(adminToken);
      const viewer = await makeUser();
      const added = await call(adminToken, {
        method: 'PUT',
        url: `/api/v1/projects/${project.name}/members/${encodeURIComponent(viewer.email)}`,
        payload: { role: Role.VIEWER },
      });
      assert.equal(added.statusCode, 200, added.payload);

      const res = await call(viewer.token, {
        method: 'POST',
        url: '/api/v1/jobs',
        payload: {
          project: project.name,
          name: uniqueName('job'),
          spec: { image: 'busybox:1.36' },
          resources: { cpu: 1 },
        },
      });
      assert.equal(res.statusCode, 403);

      const [row] = await denials();
      assert.equal(row.permission, Permission.PROJECT_WRITE);
      assert.equal(row.status, 403);
      assert.equal(row.subject, viewer.email);
      assert.equal(row.user_id, viewer.userId);
      assert.equal(row.project_name, project.name);
      assert.equal(row.principal, 'USER');
    });

    test('a refusal disguised as a 404 is recorded as the refusal it is', async () => {
      // The whole reason this trail is written at the decision. The caller is told the
      // project does not exist, so that its name cannot be enumerated; the record has to
      // say what really happened, and to say what the caller was told as well.
      const project = await makeProject(adminToken);
      const outsider = await makeUser();

      const res = await call(outsider.token, {
        method: 'GET', url: `/api/v1/projects/${project.name}`,
      });
      assert.equal(res.statusCode, 404, 'the caller must not learn the project exists');

      const [row] = await denials();
      assert.equal(row.permission, Permission.PROJECT_READ);
      assert.equal(row.status, 404, 'what the caller was told');
      assert.equal(row.project_name, project.name, 'what was really refused');
      assert.equal(row.subject, outsider.email);
    });

    test('a workload token is recorded by what it is, not as a user', async () => {
      const project = await makeProject(adminToken);
      const job = await call(adminToken, {
        method: 'POST',
        url: '/api/v1/jobs',
        payload: {
          project: project.name,
          name: uniqueName('job'),
          spec: { image: 'busybox:1.36' },
          resources: { cpu: 1 },
        },
      });
      assert.equal(job.statusCode, 201, job.payload);

      const { issueRunToken } = await import('./auth.js');
      const run = await issueRunToken(pool, job.json().id, 1);

      // A run token may report for its own job and nothing else. Listing is the case the
      // `listScope` decorator refuses outright.
      const res = await call(run.token, { method: 'GET', url: '/api/v1/projects' });
      assert.equal(res.statusCode, 403);

      const [row] = await denials();
      assert.equal(row.principal, 'RUN');
      assert.equal(row.job_id, job.json().id);
      assert.equal(row.user_id, null);
      assert.match(row.subject, /^run /);
    });

    test('the request it happened in is recorded, so it can be found in the log', async () => {
      const project = await makeProject(adminToken);
      const outsider = await makeUser();
      const res = await call(outsider.token, {
        method: 'PUT',
        url: `/api/v1/projects/${project.name}/members/${encodeURIComponent(outsider.email)}`,
        payload: { role: Role.OWNER },
      });
      assert.equal(res.statusCode, 404, 'adding yourself to a project you cannot see');

      const [row] = await denials();
      assert.equal(row.method, 'PUT');
      // The route pattern, not the URL — the same rule the request histogram follows, so
      // that one project cannot mint a row shape of its own.
      assert.equal(row.route, '/api/v1/projects/:name/members/:email');
      assert.ok(row.request_id, 'the id pino correlates the request log on');
      assert.ok(row.remote_addr, 'where it came from');
    });
  });

  describe('what deliberately does not get written', () => {
    test('an unauthenticated refusal is counted, not stored', async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await call(null, { method: 'GET', url: '/api/v1/projects' });
        assert.equal(res.statusCode, 401);
      }
      assert.deepEqual(await denials(), [], 'a 401 has no principal to name');

      const scrape = await app.inject({ method: 'GET', url: '/metrics' });
      assert.match(scrape.payload, /ashml_auth_failures_total\{[^}]*reason="no_token"[^}]*\} 3/);
    });

    test('a request that succeeds writes nothing', async () => {
      await makeProject(adminToken);
      await call(adminToken, { method: 'GET', url: '/api/v1/projects' });
      assert.deepEqual(await denials(), []);
    });
  });

  describe('reading it back', () => {
    test('only a platform administrator may', async () => {
      const nobody = await makeUser();
      const res = await call(nobody.token, { method: 'GET', url: '/api/v1/audit/denials' });
      assert.equal(res.statusCode, 403);
    });

    test('the newest denials, and a summary of who is collecting them', async () => {
      const project = await makeProject(adminToken);
      const outsider = await makeUser();
      for (let i = 0; i < 3; i += 1) {
        await call(outsider.token, { method: 'GET', url: `/api/v1/projects/${project.name}` });
      }
      await app.audit.flush();

      const list = await call(adminToken, { method: 'GET', url: '/api/v1/audit/denials' });
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().denials.length, 3);
      assert.ok(list.json().denials.every((d) => d.subject === outsider.email));

      const summary = await call(adminToken, { method: 'GET', url: '/api/v1/audit/summary' });
      assert.equal(summary.statusCode, 200);
      const [caller] = summary.json().callers;
      assert.equal(caller.subject, outsider.email);
      assert.equal(caller.denials, 3);
      assert.deepEqual(caller.permissions, [Permission.PROJECT_READ]);
    });

    test('filters apply in SQL, so the limit applies to matching rows', async () => {
      const project = await makeProject(adminToken);
      const a = await makeUser();
      const b = await makeUser();
      await call(a.token, { method: 'GET', url: `/api/v1/projects/${project.name}` });
      await call(b.token, { method: 'GET', url: `/api/v1/projects/${project.name}` });
      await app.audit.flush();

      const res = await call(adminToken, {
        method: 'GET', url: `/api/v1/audit/denials?user=${a.userId}`,
      });
      assert.equal(res.json().denials.length, 1);
      assert.equal(res.json().denials[0].subject, a.email);
    });
  });

  describe('the buffer', () => {
    test('drops rather than grows when it cannot keep up, and says how much', async () => {
      // The direction that matters. An audit that queues without limit under load is a
      // memory leak that fires exactly when the platform is already in trouble, so the
      // honest failure is a gap in the record with a number attached to it.
      const small = new AuditLog(pool, { capacity: 2 });
      const event = {
        principal: { kind: 'USER', userId: LOCAL_USER_ID, email: 'local@ashml.dev' },
        denial: { permission: Permission.PROJECT_READ },
        status: 403,
        request: { method: 'GET', route: '/api/v1/projects', requestId: null, remoteAddr: null },
      };

      for (let i = 0; i < 5; i += 1) small.record(event);
      assert.equal(small.pending, 2);
      assert.equal(small.dropped, 3);

      assert.equal(await small.flush(), 2);
      assert.equal(small.pending, 0);
      await small.close();
    });

    test('a write that fails loses the batch rather than retrying it for ever', async () => {
      // Re-queueing would turn a database that is down into a buffer that never drains,
      // which is the unbounded growth the capacity above exists to prevent, arriving by
      // the other door.
      const broken = {
        connect: async () => { throw new Error('no connection for you'); },
      };
      const logged = [];
      const audit = new AuditLog(broken, { logger: { error: (o, m) => logged.push(m) } });

      audit.record({
        principal: { kind: 'USER', userId: LOCAL_USER_ID, email: 'local@ashml.dev' },
        denial: { permission: Permission.PROJECT_READ },
        status: 403,
        request: { method: 'GET', route: '/x', requestId: null, remoteAddr: null },
      });

      assert.equal(await audit.flush(), 0);
      assert.equal(audit.pending, 0, 'the batch is gone, not waiting');
      assert.equal(audit.dropped, 1);
      assert.match(logged[0], /audit/);
    });
  });
});
