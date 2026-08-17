import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseSmiCsv } from './nvidia.js';

// Captured verbatim from the 2x RTX 2080 Ti development host.
const REAL_OUTPUT = `0, GPU-04fc79a1-dd4f-811f-8eb9-d28686f2c221, NVIDIA GeForce RTX 2080 Ti, 11264, 8171, 100, 87, 175.96
1, GPU-74a86b7d-3b7e-e35a-7d9c-a042c4359f9d, NVIDIA GeForce RTX 2080 Ti, 11264, 347, 5, 70, 22.91`;

const MIB = 1024 * 1024;

describe('nvidia-smi CSV parsing', () => {
  test('parses real two-GPU output', () => {
    const devices = parseSmiCsv(REAL_OUTPUT);
    assert.equal(devices.length, 2);

    const [first] = devices;
    assert.equal(first.provider, 'nvidia');
    assert.equal(first.index, 0);
    assert.equal(first.uuid, 'GPU-04fc79a1-dd4f-811f-8eb9-d28686f2c221');
    assert.equal(first.model, 'NVIDIA GeForce RTX 2080 Ti');
    assert.equal(first.memory_total_bytes, 11264 * MIB);
    assert.equal(first.memory_used_bytes, 8171 * MIB);
    assert.equal(first.utilization_pct, 100);
    assert.equal(first.temperature_c, 87);
    assert.equal(first.power_watts, 175.96);
    assert.equal(first.health, 'OK');
  });

  test('real devices are never flagged simulated', () => {
    for (const device of parseSmiCsv(REAL_OUTPUT)) {
      assert.equal(device.simulated, false);
    }
  });

  test('derives free memory', () => {
    const [, second] = parseSmiCsv(REAL_OUTPUT);
    assert.equal(second.memory_free_bytes, (11264 - 347) * MIB);
  });

  test('a card reporting [N/A] memory is marked UNKNOWN, not healthy-with-zero', () => {
    const devices = parseSmiCsv('0, GPU-abc, Some Card, [N/A], [N/A], [N/A], [N/A], [N/A]');
    assert.equal(devices.length, 1);
    assert.equal(devices[0].health, 'UNKNOWN');
    assert.equal(devices[0].memory_total_bytes, 0);
  });

  test('empty output yields no devices', () => {
    assert.deepEqual(parseSmiCsv(''), []);
    assert.deepEqual(parseSmiCsv('\n  \n'), []);
  });

  test('malformed rows fail loudly rather than producing a half-device', () => {
    assert.throws(
      () => parseSmiCsv('0, GPU-abc, Some Card, 11264'),
      /expected 8 columns, got 4/,
    );
  });
});
