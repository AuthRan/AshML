/**
 * Unit tests for quota admission.
 *
 * A quota refusal is something a user argues with, so these cover the boundary cases
 * exactly: a request that lands precisely on the limit is allowed, one byte past it is
 * not, and an unset limit means unlimited rather than zero.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkQuota, QuotaBreach } from './quota.js';

const GIB = 1024 ** 3;

const unlimited = { gpu_limit: 0, cpu_limit: 0, memory_bytes: 0, job_limit: 0 };
const nothingUsed = { gpu: 0, cpu: 0, memory_bytes: 0, jobs: 0 };

function request(overrides = {}) {
  return { cpu: 1, memory_bytes: 0, gpu: 0, ...overrides };
}

describe('checkQuota', () => {
  test('a project with no quota set is unlimited, not limited to zero', () => {
    // The schema defaults every limit to 0 for a new project. Reading that as "may use
    // nothing" would make every new project unable to run anything at all.
    const result = checkQuota(request({ gpu: 8, cpu: 64 }), unlimited, nothingUsed);
    assert.equal(result.allowed, true);
  });

  test('a request that lands exactly on the limit is allowed', () => {
    const result = checkQuota(
      request({ gpu: 2 }),
      { ...unlimited, gpu_limit: 2 },
      nothingUsed,
    );
    assert.equal(result.allowed, true);
  });

  test('one unit past the limit is refused', () => {
    const result = checkQuota(
      request({ gpu: 3 }),
      { ...unlimited, gpu_limit: 2 },
      nothingUsed,
    );

    assert.equal(result.allowed, false);
    assert.equal(result.code, QuotaBreach.GPU);
  });

  test('usage already in flight counts against the limit', () => {
    const result = checkQuota(
      request({ gpu: 1 }),
      { ...unlimited, gpu_limit: 2 },
      { ...nothingUsed, gpu: 2 },
    );

    assert.equal(result.allowed, false);
    assert.match(result.reason, /2 of 2 GPU\(s\) in use, 1 more requested/);
  });

  test('the concurrent job limit counts the job being admitted', () => {
    const result = checkQuota(
      request(),
      { ...unlimited, job_limit: 2 },
      { ...nothingUsed, jobs: 2 },
    );

    assert.equal(result.allowed, false);
    assert.equal(result.code, QuotaBreach.JOBS);
  });

  test('a job that requests no GPUs is never refused by a GPU quota', () => {
    const result = checkQuota(
      request({ gpu: 0 }),
      { ...unlimited, gpu_limit: 2 },
      { ...nothingUsed, gpu: 2 },
    );
    assert.equal(result.allowed, true);
  });

  test('memory is compared in bytes without losing precision on large values', () => {
    const result = checkQuota(
      request({ memory_bytes: 33 * GIB }),
      { ...unlimited, memory_bytes: 64 * GIB },
      { ...nothingUsed, memory_bytes: 32 * GIB },
    );

    assert.equal(result.allowed, false);
    assert.equal(result.code, QuotaBreach.MEMORY);
  });

  test('the job limit is reported before a resource limit, as the blunter cause', () => {
    // Both are breached. The job count is the one a user can act on immediately.
    const result = checkQuota(
      request({ gpu: 4 }),
      { gpu_limit: 1, cpu_limit: 0, memory_bytes: 0, job_limit: 1 },
      { ...nothingUsed, gpu: 1, jobs: 1 },
    );
    assert.equal(result.code, QuotaBreach.JOBS);
  });

  test('an allowed result records the limits it was checked against', () => {
    const result = checkQuota(
      request({ gpu: 1 }),
      { ...unlimited, gpu_limit: 4 },
      { ...nothingUsed, gpu: 1 },
    );

    assert.equal(result.allowed, true);
    // So that "why was this allowed?" is answerable with what was true at the time.
    assert.equal(result.details.gpu.limit, 4);
    assert.equal(result.details.gpu.in_use, 1);
  });
});
