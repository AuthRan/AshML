/**
 * Authorization is enumerated rather than sampled.
 *
 * An authorization bug produces no symptom in a working system — nobody notices the
 * request that should have been refused and was not. So these tests walk the whole
 * cross-product of principal and permission rather than checking the cases that came to
 * mind, and the table below is the specification: if a cell is wrong, the test is wrong,
 * and that is a thing a reviewer can check by reading.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  Role, Permission, PrincipalKind, atLeast, isRole, roleIn,
  userPrincipal, runPrincipal, servingPrincipal, can,
} from './roles.js';

const PROJECT = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000002';
const JOB = 'cccccccc-0000-0000-0000-000000000003';

function member(role, { isAdmin = false, projectId = PROJECT } = {}) {
  return userPrincipal({
    userId: 'u1',
    email: 'u1@example.com',
    isAdmin,
    memberships: new Map(role ? [[projectId, role]] : []),
  });
}

describe('the role ladder', () => {
  test('ranks weakest to strongest', () => {
    assert.ok(atLeast(Role.OWNER, Role.VIEWER));
    assert.ok(atLeast(Role.EDITOR, Role.VIEWER));
    assert.ok(atLeast(Role.VIEWER, Role.VIEWER));
    assert.ok(!atLeast(Role.VIEWER, Role.EDITOR));
    assert.ok(!atLeast(Role.EDITOR, Role.OWNER));
  });

  test('a value that is not a role never satisfies anything', () => {
    // Guards the failure mode where a typo'd or attacker-supplied role string is
    // compared numerically and quietly wins.
    assert.ok(!atLeast('ADMIN', Role.VIEWER));
    assert.ok(!atLeast('owner', Role.VIEWER));
    assert.ok(!atLeast(null, Role.VIEWER));
    assert.ok(!atLeast(undefined, Role.VIEWER));
    assert.ok(!isRole('ADMIN'));
    assert.ok(!isRole(''));
  });
});

describe('what each project role may do', () => {
  // The table is the specification. Rows are roles, columns are permissions.
  const EXPECTED = {
    VIEWER: { PROJECT_READ: true, PROJECT_WRITE: false, PROJECT_ADMIN: false, PLATFORM_ADMIN: false, RUN_REPORT: false, ARTIFACT_FETCH: true, ROUTING_READ: true },
    EDITOR: { PROJECT_READ: true, PROJECT_WRITE: true, PROJECT_ADMIN: false, PLATFORM_ADMIN: false, RUN_REPORT: false, ARTIFACT_FETCH: true, ROUTING_READ: true },
    OWNER: { PROJECT_READ: true, PROJECT_WRITE: true, PROJECT_ADMIN: true, PLATFORM_ADMIN: false, RUN_REPORT: false, ARTIFACT_FETCH: true, ROUTING_READ: true },
  };

  for (const [role, row] of Object.entries(EXPECTED)) {
    for (const [permission, allowed] of Object.entries(row)) {
      test(`${role} ${allowed ? 'may' : 'may not'} ${permission}`, () => {
        const principal = member(role);
        assert.equal(
          can(principal, Permission[permission], { projectId: PROJECT, jobId: JOB }),
          allowed,
        );
      });
    }
  }

  test('every permission appears in the table', () => {
    // Stops a permission being added without a decision being made about each role.
    const covered = Object.keys(EXPECTED.OWNER).sort();
    assert.deepEqual(covered, Object.keys(Permission).sort());
  });
});

describe('project isolation', () => {
  test('a role in one project grants nothing in another', () => {
    const owner = member(Role.OWNER, { projectId: PROJECT });
    assert.ok(can(owner, Permission.PROJECT_READ, { projectId: PROJECT }));
    assert.ok(!can(owner, Permission.PROJECT_READ, { projectId: OTHER }));
    assert.ok(!can(owner, Permission.PROJECT_WRITE, { projectId: OTHER }));
  });

  test('a non-member may do nothing at all', () => {
    const stranger = member(null);
    for (const permission of Object.values(Permission)) {
      assert.ok(!can(stranger, permission, { projectId: PROJECT, jobId: JOB }), permission);
    }
  });

  test('a project-scoped permission with no project named is refused', () => {
    // The failure mode this guards is a route that forgets to pass the scope: without
    // this, `can(owner, PROJECT_WRITE)` would fall through to a lookup of `undefined`
    // and the answer would depend on Map semantics rather than on a decision.
    const owner = member(Role.OWNER);
    assert.ok(!can(owner, Permission.PROJECT_READ));
    assert.ok(!can(owner, Permission.PROJECT_WRITE, {}));
  });

  test('roleIn reports the role held, and null elsewhere', () => {
    const editor = member(Role.EDITOR);
    assert.equal(roleIn(editor, PROJECT), Role.EDITOR);
    assert.equal(roleIn(editor, OTHER), null);
  });
});

describe('the platform administrator', () => {
  test('may do everything a project role may, in any project', () => {
    const admin = member(null, { isAdmin: true });
    assert.ok(can(admin, Permission.PROJECT_READ, { projectId: OTHER }));
    assert.ok(can(admin, Permission.PROJECT_WRITE, { projectId: OTHER }));
    assert.ok(can(admin, Permission.PROJECT_ADMIN, { projectId: OTHER }));
    assert.ok(can(admin, Permission.PLATFORM_ADMIN));
  });

  test('is still not a run', () => {
    // The one thing admin does not imply. A person holding RUN_REPORT could forge a
    // training run's own results, which is the one write the platform must be able to
    // attribute to a pod rather than to a human (spec Rule 5).
    const admin = member(Role.OWNER, { isAdmin: true });
    assert.ok(!can(admin, Permission.RUN_REPORT, { projectId: PROJECT, jobId: JOB }));
  });

  test('no project role carries PLATFORM_ADMIN', () => {
    // A project owner who could raise their own quota would make quotas advisory.
    for (const role of Object.values(Role)) {
      assert.ok(!can(member(role), Permission.PLATFORM_ADMIN, { projectId: PROJECT }));
    }
  });
});

describe('a run token', () => {
  const run = runPrincipal({ jobId: JOB, projectId: PROJECT, attempt: 0 });

  test('may report for its own job', () => {
    assert.ok(can(run, Permission.RUN_REPORT, { jobId: JOB }));
  });

  test('may report against the experiment its job belongs to', () => {
    // `POST /experiments/:id/report` names the experiment, not the job, and it is still
    // the run describing itself.
    const inExperiment = runPrincipal({
      jobId: JOB, projectId: PROJECT, attempt: 0, experimentId: 'e1',
    });
    assert.ok(can(inExperiment, Permission.RUN_REPORT, { experimentId: 'e1' }));
    assert.ok(!can(inExperiment, Permission.RUN_REPORT, { experimentId: 'e2' }));
  });

  test('a run with no experiment cannot report against one', () => {
    // `experimentId` is null on both sides here; without the explicit null check that
    // would compare equal and grant every experiment in the platform.
    assert.ok(!can(run, Permission.RUN_REPORT, { experimentId: null }));
    assert.ok(!can(run, Permission.RUN_REPORT, { experimentId: 'e1' }));
  });

  test('may not report for any other job', () => {
    assert.ok(!can(run, Permission.RUN_REPORT, { jobId: OTHER }));
    // The check must not pass by omission when the caller forgets the scope.
    assert.ok(!can(run, Permission.RUN_REPORT, {}));
  });

  test('may fetch artifacts inside its own project, to resume from a checkpoint', () => {
    assert.ok(can(run, Permission.ARTIFACT_FETCH, { projectId: PROJECT }));
    assert.ok(!can(run, Permission.ARTIFACT_FETCH, { projectId: OTHER }));
    assert.ok(!can(run, Permission.ARTIFACT_FETCH, {}));
  });

  test('may do nothing else, including reading its own project', () => {
    for (const permission of Object.values(Permission)) {
      if (permission === Permission.RUN_REPORT) continue;
      if (permission === Permission.ARTIFACT_FETCH) continue;
      assert.ok(!can(run, permission, {
        projectId: PROJECT, jobId: JOB, deploymentId: 'd1',
      }), permission);
    }
  });

  test('carries neither memberships nor admin', () => {
    assert.equal(run.kind, PrincipalKind.RUN);
    assert.equal(roleIn(run, PROJECT), null);
    assert.equal(run.isAdmin, undefined);
  });
});

describe('a serving token', () => {
  const serving = servingPrincipal({ deploymentId: 'd1', projectId: PROJECT });

  test('may fetch its own weights', () => {
    assert.ok(can(serving, Permission.ARTIFACT_FETCH, { projectId: PROJECT }));
  });

  test('may not fetch another project\'s', () => {
    assert.ok(!can(serving, Permission.ARTIFACT_FETCH, { projectId: OTHER }));
    assert.ok(!can(serving, Permission.ARTIFACT_FETCH, {}));
  });

  test('may follow its own deployment\'s routing table, and no other', () => {
    assert.ok(can(serving, Permission.ROUTING_READ, { deploymentId: 'd1' }));
    assert.ok(!can(serving, Permission.ROUTING_READ, { deploymentId: 'd2' }));
    assert.ok(!can(serving, Permission.ROUTING_READ, {}));
  });

  test('writes nothing, anywhere', () => {
    for (const permission of Object.values(Permission)) {
      if (permission === Permission.ARTIFACT_FETCH) continue;
      if (permission === Permission.ROUTING_READ) continue;
      assert.ok(!can(serving, permission, {
        projectId: PROJECT, jobId: JOB, deploymentId: 'd1',
      }), permission);
    }
  });

  test('is not a run, so it cannot report results', () => {
    // A serving pod that could report metrics could write numbers onto a training run
    // that had already finished.
    assert.ok(!can(serving, Permission.RUN_REPORT, { jobId: JOB }));
  });
});

describe('absent and malformed principals', () => {
  test('no principal may do anything', () => {
    for (const permission of Object.values(Permission)) {
      assert.ok(!can(null, permission, { projectId: PROJECT, jobId: JOB }), permission);
      assert.ok(!can(undefined, permission, { projectId: PROJECT, jobId: JOB }), permission);
    }
  });

  test('an unrecognised principal kind may do nothing', () => {
    const service = { kind: 'SERVICE', isAdmin: true, memberships: new Map([[PROJECT, Role.OWNER]]) };
    for (const permission of Object.values(Permission)) {
      assert.ok(!can(service, permission, { projectId: PROJECT, jobId: JOB }), permission);
    }
  });

  test('`can` trusts the shape it is handed, which is why only one module builds one', () => {
    // Worth asserting explicitly rather than leaving implied. A plain object with
    // kind: 'USER' and isAdmin: true is granted everything — `can` is a decision
    // function, not a validator, and it has no way to know where its argument came from.
    // The protection is that `services/auth.js` is the only thing that constructs a
    // principal, and it does so only from a token it has just verified. If a principal
    // is ever built anywhere else, this test is the one that explains the consequence.
    const forged = { kind: PrincipalKind.USER, isAdmin: true, memberships: new Map() };
    assert.equal(can(forged, Permission.PLATFORM_ADMIN), true);
  });

  test('an unknown permission is denied rather than ignored', () => {
    const owner = member(Role.OWNER);
    assert.ok(!can(owner, 'PROJECT_DELETE_EVERYTHING', { projectId: PROJECT }));
  });
});
