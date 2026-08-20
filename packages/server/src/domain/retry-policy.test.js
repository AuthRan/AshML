/**
 * Unit tests for the retry policy.
 *
 * These are worth more than most: the cost of getting this wrong is asymmetric in both
 * directions. Retrying something unretryable spends a GPU for the length of a training
 * run to reproduce a failure exactly, `max_retries` times over. Refusing to retry
 * something that would have recovered turns a self-healing platform into one that needs
 * a human at 3am.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFailure, decideRetry, RetryDecision } from './retry-policy.js';

function failedJob(overrides = {}) {
  return {
    state: 'FAILED',
    attempt: 0,
    max_retries: 2,
    failure_reason: 'container exited 1 (Error)',
    ...overrides,
  };
}

describe('classifying a failure', () => {
  test('an image that cannot be pulled is permanent', () => {
    for (const reason of [
      'ImagePullBackOff: Back-off pulling image "ashml/nope:v9"',
      'ErrImagePull',
      'InvalidImageName',
    ]) {
      const result = classifyFailure(reason);
      assert.equal(result.retryable, false, reason);
      assert.equal(result.category, 'image');
    }
  });

  test('being killed for memory is permanent, because the request would not change', () => {
    assert.equal(classifyFailure('container exited 137 (OOMKilled)').retryable, false);
    assert.equal(classifyFailure('OOMKilled').category, 'out_of_memory');
  });

  test('a bad container spec is permanent', () => {
    assert.equal(classifyFailure('CreateContainerConfigError: secret not found').retryable, false);
  });

  test('eviction is retryable: somewhere else may have room', () => {
    const result = classifyFailure('Evicted: The node was low on resource: ephemeral-storage');
    assert.equal(result.retryable, true);
    assert.equal(result.category, 'evicted');
  });

  test('a workload that vanished is retryable, because nothing was learned', () => {
    const result = classifyFailure(
      'kubernetes Job ashml-x-1 disappeared before reporting a result',
    );
    assert.equal(result.retryable, true);
    assert.equal(result.category, 'workload_missing');
  });

  test('being unschedulable is retryable: capacity is the most transient thing there is', () => {
    assert.equal(classifyFailure('Unschedulable: 0/2 nodes are available').retryable, true);
  });

  test('an unrecognised failure is retryable by default', () => {
    // The operator asked for retries by setting max_retries above zero. Guessing
    // "permanent" for a reason we do not recognise would silently disable that.
    const result = classifyFailure('container exited 1 (Error)');
    assert.equal(result.retryable, true);
    assert.equal(result.category, 'unknown');
  });

  test('an empty or missing reason does not throw', () => {
    for (const reason of ['', null, undefined]) {
      assert.equal(classifyFailure(reason).retryable, true);
    }
  });
});

describe('deciding whether to retry', () => {
  test('a retryable failure inside budget retries', () => {
    const decision = decideRetry(failedJob());
    assert.equal(decision.decision, RetryDecision.RETRY);
    assert.match(decision.message, /attempt 1 of 2/);
  });

  test('a job that has used its budget is EXHAUSTED', () => {
    const decision = decideRetry(failedJob({ attempt: 2, max_retries: 2 }));
    assert.equal(decision.decision, RetryDecision.EXHAUSTED);
    assert.match(decision.message, /all 2 retries/);
  });

  test('max_retries 0 says so, rather than talking about used-up retries', () => {
    const decision = decideRetry(failedJob({ max_retries: 0 }));
    assert.equal(decision.decision, RetryDecision.EXHAUSTED);
    assert.match(decision.message, /max_retries 0/);
  });

  test('a permanent failure is refused even with retries left', () => {
    const decision = decideRetry(failedJob({
      failure_reason: 'ImagePullBackOff: Back-off pulling image',
      attempt: 0,
      max_retries: 5,
    }));
    assert.equal(decision.decision, RetryDecision.PERMANENT);
    assert.equal(decision.remaining, 5, 'the budget is untouched; it simply does not apply');
  });

  test('a permanent failure with no budget reports permanence, not exhaustion', () => {
    // Order matters here. Telling someone their retries are exhausted, when the failure
    // would never be retried at any budget, sends them to raise max_retries and watch
    // the identical failure happen again.
    const decision = decideRetry(failedJob({
      failure_reason: 'OOMKilled',
      attempt: 0,
      max_retries: 0,
    }));
    assert.equal(decision.decision, RetryDecision.PERMANENT);
    assert.match(decision.message, /memory/);
  });

  test('a job that is not FAILED is not a retry candidate', () => {
    for (const state of ['RUNNING', 'SUCCEEDED', 'CANCELLED', 'QUEUED']) {
      const decision = decideRetry(failedJob({ state }));
      assert.equal(decision.decision, RetryDecision.NOT_APPLICABLE, state);
    }
  });

  test('a cancelled job is never retried, however much budget it had', () => {
    const decision = decideRetry(failedJob({ state: 'CANCELLED', max_retries: 10 }));
    assert.equal(decision.decision, RetryDecision.NOT_APPLICABLE);
  });

  test('the message says whether the retry resumes or starts over', () => {
    const fresh = decideRetry(failedJob(), { canResume: false });
    assert.match(fresh.message, /no confirmed checkpoint/);

    const resumed = decideRetry(failedJob(), { canResume: true });
    assert.match(resumed.message, /resuming from the last confirmed checkpoint/);
  });

  test('a checkpoint does not make a permanent failure retryable', () => {
    // Resuming from epoch 4 into an image that still does not exist is the same failure
    // one step later.
    const decision = decideRetry(
      failedJob({ failure_reason: 'ErrImagePull', max_retries: 3 }),
      { canResume: true },
    );
    assert.equal(decision.decision, RetryDecision.PERMANENT);
  });

  test('a job missing attempt or max_retries is treated as having neither', () => {
    const decision = decideRetry({ state: 'FAILED', failure_reason: 'boom' });
    assert.equal(decision.decision, RetryDecision.EXHAUSTED);
    assert.equal(decision.attempt, 0);
  });
});
