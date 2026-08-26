/**
 * Unit tests for the CIDR arithmetic the per-project network policy is checked with.
 *
 * Small enough to look obviously right and worth testing anyway, because the one thing
 * it decides — whether a node's pod range is covered by the configured cluster range —
 * has no symptom when it is wrong. A containment check that answered `true` too easily
 * would mean the startup warning never fires and the isolation is silently partial.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cidrContains, isIpv4Cidr, podCidrsOf } from './cidr.js';

describe('cidrContains', () => {
  test('a k3s node range sits inside the cluster range', () => {
    assert.equal(cidrContains('10.42.0.0/16', '10.42.0.0/24'), true);
    assert.equal(cidrContains('10.42.0.0/16', '10.42.1.0/24'), true);
    assert.equal(cidrContains('10.42.0.0/16', '10.42.255.0/24'), true);
  });

  test('a node outside the configured range is not covered — the case that matters', () => {
    // The failure this exists to catch: a cluster configured with 10.244.0.0/16 (the
    // kubeadm default) while ASHML_CLUSTER_POD_CIDR still says k3s's 10.42.0.0/16. The
    // policy would then treat every pod as external and refuse nothing.
    assert.equal(cidrContains('10.42.0.0/16', '10.244.0.0/24'), false);
  });

  test('a block contains itself', () => {
    assert.equal(cidrContains('10.42.0.0/16', '10.42.0.0/16'), true);
  });

  test('a wider block is never inside a narrower one', () => {
    assert.equal(cidrContains('10.42.0.0/24', '10.42.0.0/16'), false);
  });

  test('0.0.0.0/0 contains everything, including the top half of the address space', () => {
    // The half that a signed 32-bit shift would get wrong.
    assert.equal(cidrContains('0.0.0.0/0', '10.42.0.0/16'), true);
    assert.equal(cidrContains('0.0.0.0/0', '192.168.0.0/16'), true);
    assert.equal(cidrContains('0.0.0.0/0', '255.255.255.255/32'), true);
  });

  test('addresses above 127.x compare correctly against each other', () => {
    assert.equal(cidrContains('192.168.0.0/16', '192.168.7.0/24'), true);
    assert.equal(cidrContains('192.168.0.0/16', '172.16.0.0/24'), false);
    assert.equal(cidrContains('172.16.0.0/12', '172.31.255.0/24'), true);
    assert.equal(cidrContains('172.16.0.0/12', '172.32.0.0/24'), false);
  });

  test('a block that is not on its own boundary still answers about its addresses', () => {
    assert.equal(cidrContains('10.42.3.7/16', '10.42.9.0/24'), true);
  });

  test('an unreadable block is an error rather than a false answer', () => {
    assert.throws(() => cidrContains('10.42.0.0', '10.42.0.0/24'), /IPv4 CIDR block/);
    assert.throws(() => cidrContains('10.42.0.0/16', 'fd00::/48'), /IPv4 CIDR block/);
    assert.throws(() => cidrContains('10.42.0.0/33', '10.42.0.0/24'), /cannot exceed \/32/);
    assert.throws(() => cidrContains('10.42.0.300/16', '10.42.0.0/24'), /cannot exceed 255/);
  });
});

describe('isIpv4Cidr', () => {
  test('accepts what the policy can be written against, and nothing else', () => {
    assert.equal(isIpv4Cidr('10.42.0.0/16'), true);
    assert.equal(isIpv4Cidr('0.0.0.0/0'), true);
    assert.equal(isIpv4Cidr('fd00::/48'), false);
    assert.equal(isIpv4Cidr('10.42.0.0'), false);
    assert.equal(isIpv4Cidr(''), false);
    assert.equal(isIpv4Cidr(null), false);
  });
});

describe('podCidrsOf', () => {
  test('reads the list, and the singular field older clusters set', () => {
    assert.deepEqual(podCidrsOf({ spec: { podCIDRs: ['10.42.1.0/24'] } }), ['10.42.1.0/24']);
    assert.deepEqual(podCidrsOf({ spec: { podCIDR: '10.42.1.0/24' } }), ['10.42.1.0/24']);
  });

  test('a dual-stack node reports both, so both can be judged', () => {
    const node = { spec: { podCIDR: '10.42.1.0/24', podCIDRs: ['10.42.1.0/24', 'fd00::/64'] } };
    assert.deepEqual(podCidrsOf(node), ['10.42.1.0/24', 'fd00::/64']);
  });

  test('a node that has not been assigned a range yet is nothing to check, not a mismatch', () => {
    assert.deepEqual(podCidrsOf({ spec: {} }), []);
    assert.deepEqual(podCidrsOf({}), []);
    assert.deepEqual(podCidrsOf(null), []);
  });
});
