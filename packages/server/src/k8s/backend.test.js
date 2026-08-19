/**
 * Unit tests for the Kubernetes Job status -> AshML observation mapping.
 *
 * The status payloads here are the shapes a real cluster produces. Getting this
 * mapping wrong is how a platform reports success for a run that failed, so the
 * ambiguous combinations are tested explicitly rather than assumed away.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Phase, observationFromJobStatus, registerBackend, createBackend, availableBackends, _resetBackendsForTest } from './backend.js';

describe('observationFromJobStatus', () => {
  test('an empty status is pending, not failed — the Job was only just created', () => {
    assert.equal(observationFromJobStatus({}).phase, Phase.PENDING);
  });

  test('an active pod reads as running', () => {
    assert.equal(observationFromJobStatus({ active: 1 }).phase, Phase.RUNNING);
  });

  test('the Complete condition is success', () => {
    const status = {
      succeeded: 1,
      conditions: [{ type: 'Complete', status: 'True' }],
    };
    assert.equal(observationFromJobStatus(status).phase, Phase.SUCCEEDED);
  });

  test('the Failed condition carries its message through as the reason', () => {
    const status = {
      failed: 1,
      conditions: [{
        type: 'Failed',
        status: 'True',
        reason: 'BackoffLimitExceeded',
        message: 'Job has reached the specified backoff limit',
      }],
    };
    const observation = observationFromJobStatus(status);

    assert.equal(observation.phase, Phase.FAILED);
    assert.equal(observation.reason, 'Job has reached the specified backoff limit');
  });

  test('a false condition is not a true one', () => {
    const status = { active: 1, conditions: [{ type: 'Failed', status: 'False' }] };
    assert.equal(observationFromJobStatus(status).phase, Phase.RUNNING);
  });

  test('a Job with both a succeeded and a failed pod is reported as failed', () => {
    // AshML must never report success for a run that also produced a failure — a
    // partially-succeeded Job is not a result anyone should trust.
    const status = { succeeded: 1, failed: 1 };
    assert.equal(observationFromJobStatus(status).phase, Phase.FAILED);
  });

  test('a pod-level reason is used when the Job status has none of its own', () => {
    const observation = observationFromJobStatus(
      { active: 1 },
      { podReason: 'ImagePullBackOff: repository does not exist' },
    );
    assert.match(observation.reason, /ImagePullBackOff/);
  });

  test('pod counts are passed through for the caller to log', () => {
    const observation = observationFromJobStatus({ active: 2, succeeded: 1, failed: 0 });
    assert.equal(observation.active, 2);
    assert.equal(observation.succeeded, 1);
  });
});

describe('the backend registry', () => {
  test('names an unknown backend and lists what is available instead', () => {
    _resetBackendsForTest();
    registerBackend('probe', () => ({ name: 'probe' }));

    assert.throws(
      () => createBackend('does-not-exist'),
      /unknown backend "does-not-exist" \(available: probe\)/,
    );
    assert.deepEqual(availableBackends(), ['probe']);
  });

  test('refuses to register the same name twice', () => {
    _resetBackendsForTest();
    registerBackend('probe', () => ({ name: 'probe' }));

    // A second registration means two modules claim the same name, and whichever
    // imported last would silently win. Failing at import time is the only way that
    // gets noticed.
    assert.throws(() => registerBackend('probe', () => ({})), /registered twice/);
  });
});
