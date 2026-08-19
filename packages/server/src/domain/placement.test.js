/**
 * Unit tests for placement.
 *
 * This is the logic the whole platform is built to demonstrate, and it is pure, so it
 * is tested exhaustively rather than sampled. Every rejection path is covered, because
 * a scheduler that refuses a job for the wrong reason is worse than one that refuses it
 * for none — it sends the user to fix the wrong thing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { placeJob, evaluateNode, freeCapacity, Outcome, Reject } from './placement.js';

const GIB = 1024 ** 3;

function gpu(overrides = {}) {
  return { uuid: `GPU-${Math.random()}`, memory_total_bytes: 11 * GIB, health: 'OK', ...overrides };
}

/**
 * A node fixture.
 *
 * `gpu_capacity` defaults to however many devices were given, which is the healthy
 * case: the device plugin is installed and the cluster advertises what the hardware
 * has. Tests that care about the two diverging set it explicitly.
 */
function node(overrides = {}) {
  const base = {
    id: `node-${overrides.name ?? 'a'}`,
    name: 'node-a',
    ready: true,
    cpu_cores: 16,
    memory_bytes: 64 * GIB,
    gpus: [],
    reserved_cpu: 0,
    reserved_memory: 0,
    allocated: { cpu: 0, memory_bytes: 0, gpu: 0 },
    ...overrides,
  };
  return { gpu_capacity: base.gpus.length, ...base };
}

function request(overrides = {}) {
  return { cpu: 1, memory_bytes: 0, gpu: 0, gpu_memory_min_bytes: 0, ...overrides };
}

describe('freeCapacity', () => {
  test('subtracts what AshML has already committed, not what the node reports using', () => {
    const free = freeCapacity(node({
      cpu_cores: 16,
      gpus: [gpu(), gpu()],
      allocated: { cpu: 12, memory_bytes: 8 * GIB, gpu: 1 },
    }));

    assert.equal(free.cpu, 4);
    assert.equal(free.gpu, 1);
    assert.equal(free.memory_bytes, 56 * GIB);
  });

  test('counts only healthy GPUs as capacity', () => {
    const free = freeCapacity(node({ gpus: [gpu(), gpu({ health: 'FAILED' })] }));
    assert.equal(free.gpu, 1);
  });

  test('offers no GPUs when the cluster advertises none, however much hardware there is', () => {
    // The missing-device-plugin case. Scheduling against the hardware here would place
    // jobs onto GPUs Kubernetes will never grant, and the Pod would sit Pending forever.
    const free = freeCapacity(node({ gpus: [gpu(), gpu()], gpu_capacity: 0 }));
    assert.equal(free.gpu, 0);
  });

  test('never offers more GPUs than the cluster advertises', () => {
    const free = freeCapacity(node({ gpus: [gpu(), gpu(), gpu(), gpu()], gpu_capacity: 2 }));
    assert.equal(free.gpu, 2);
  });

  test('trusts the advertised count when no devices have been discovered', () => {
    // A cluster whose GPUs AshML cannot see directly still schedules: Kubernetes
    // granting the device is what actually matters.
    const free = freeCapacity(node({ gpus: [], gpu_capacity: 4 }));
    assert.equal(free.gpu, 4);
  });

  test('subtracts what pods AshML does not own have already requested', () => {
    // Without this AshML admits jobs summing to the whole node, and Kubernetes refuses
    // the last one because kube-system got there first.
    const free = freeCapacity(node({ cpu_cores: 8, reserved_cpu: 2, memory_bytes: 8 * GIB, reserved_memory: 2 * GIB }));
    assert.equal(free.cpu, 6);
    assert.equal(free.memory_bytes, 6 * GIB);
  });
});

describe('evaluateNode', () => {
  test('a ready node with room fits', () => {
    assert.equal(evaluateNode(node(), request()).fits, true);
  });

  test('an unready node is rejected before anything else is considered', () => {
    // Even though it has ample capacity — a NotReady node accepting a Pod is how a job
    // sits Pending indefinitely.
    const result = evaluateNode(node({ ready: false, gpus: [gpu(), gpu()] }), request({ gpu: 1 }));
    assert.equal(result.code, Reject.NOT_READY);
  });

  test('too few free GPUs is rejected, and says how many there were', () => {
    const result = evaluateNode(
      node({ gpus: [gpu(), gpu()], allocated: { cpu: 0, memory_bytes: 0, gpu: 2 } }),
      request({ gpu: 1 }),
    );

    assert.equal(result.fits, false);
    assert.equal(result.code, Reject.GPU_COUNT);
    assert.match(result.reason, /0 of 2 GPU\(s\) free; 1 requested/);
  });

  test('a node whose every GPU is unhealthy says so, rather than reporting no capacity', () => {
    const result = evaluateNode(
      node({ gpus: [gpu({ health: 'FAILED' }), gpu({ health: 'DEGRADED' })] }),
      request({ gpu: 1 }),
    );

    assert.equal(result.code, Reject.GPU_UNHEALTHY);
    assert.match(result.reason, /2 GPU\(s\), none reporting healthy/);
  });

  test('an unpolled GPU is usable — UNKNOWN is not a failure', () => {
    // Devices report UNKNOWN before their first poll; refusing them would idle the
    // cluster every time the server restarts.
    const result = evaluateNode(node({ gpus: [gpu({ health: 'UNKNOWN' })] }), request({ gpu: 1 }));
    assert.equal(result.fits, true);
  });

  test('a GPU too small for the job is rejected, naming the largest device available', () => {
    const result = evaluateNode(
      node({ gpus: [gpu({ memory_total_bytes: 11 * GIB })] }),
      request({ gpu: 1, gpu_memory_min_bytes: 24 * GIB }),
    );

    assert.equal(result.code, Reject.GPU_MEMORY);
    assert.match(result.reason, /largest device is 11\.0 GiB/);
  });

  test('GPU memory is matched on total, not free — free memory is stale by the time a Pod starts', () => {
    const big = gpu({ memory_total_bytes: 24 * GIB, memory_used_bytes: 23 * GIB });
    const result = evaluateNode(node({ gpus: [big] }), request({ gpu: 1, gpu_memory_min_bytes: 16 * GIB }));

    assert.equal(result.fits, true);
  });

  test('big-enough GPUs already committed to other jobs are not offered again', () => {
    const result = evaluateNode(
      node({
        gpus: [gpu({ memory_total_bytes: 24 * GIB }), gpu({ memory_total_bytes: 24 * GIB })],
        allocated: { cpu: 0, memory_bytes: 0, gpu: 1 },
      }),
      request({ gpu: 2, gpu_memory_min_bytes: 16 * GIB }),
    );

    assert.equal(result.fits, false);
  });

  test('GPUs the cluster will not grant are named as such, not reported as "none free"', () => {
    // "0 GPUs free" sends an operator to look for a busy node. The real cause is a
    // missing device plugin, and the message has to say so.
    const result = evaluateNode(
      node({ gpus: [gpu(), gpu()], gpu_capacity: 0 }),
      request({ gpu: 1 }),
    );

    assert.equal(result.code, Reject.GPU_NOT_SCHEDULABLE);
    assert.match(result.reason, /no device plugin is installed/);
  });

  test('a node with no GPUs at all still names the cause, not just "0 free"', () => {
    // Devices are attached to no node when the cluster advertises none, so this is the
    // message a user actually gets on a cluster without a device plugin. "0 of 0 free"
    // would read as a busy node.
    const result = evaluateNode(node({ gpus: [], gpu_capacity: 0 }), request({ gpu: 1 }));

    assert.equal(result.code, Reject.GPU_NOT_SCHEDULABLE);
    assert.match(result.reason, /advertises no GPUs/);
  });

  test('insufficient CPU is rejected with the arithmetic shown', () => {
    const result = evaluateNode(
      node({ cpu_cores: 8, allocated: { cpu: 6, memory_bytes: 0, gpu: 0 } }),
      request({ cpu: 4 }),
    );

    assert.equal(result.code, Reject.CPU);
    assert.match(result.reason, /2 of 8 CPU free; 4 requested/);
  });

  test('insufficient memory is rejected in GiB, which is how a human reads it', () => {
    const result = evaluateNode(
      node({ memory_bytes: 64 * GIB, allocated: { cpu: 0, memory_bytes: 60 * GIB, gpu: 0 } }),
      request({ memory_bytes: 16 * GIB }),
    );

    assert.equal(result.code, Reject.MEMORY);
    assert.match(result.reason, /4\.0 GiB of 64\.0 GiB memory free; 16\.0 GiB requested/);
  });

  test('a job requesting no memory is not blocked by a full node', () => {
    // memory_bytes 0 means "unspecified", not "zero bytes" — the same convention the
    // manifest builder uses when deciding whether to set a request at all.
    const result = evaluateNode(
      node({ allocated: { cpu: 0, memory_bytes: 64 * GIB, gpu: 0 } }),
      request({ memory_bytes: 0 }),
    );

    assert.equal(result.fits, true);
  });
});

describe('placeJob', () => {
  test('says plainly when there are no nodes at all', () => {
    const result = placeJob(request(), []);

    assert.equal(result.outcome, Outcome.NO_CAPACITY);
    assert.equal(result.node, null);
    assert.match(result.reason, /no compute nodes are registered/);
  });

  test('selects the only node that fits', () => {
    const nodes = [
      node({ id: 'n1', name: 'node-1', gpus: [] }),
      node({ id: 'n2', name: 'node-2', gpus: [gpu(), gpu()] }),
    ];

    const result = placeJob(request({ gpu: 2 }), nodes);
    assert.equal(result.outcome, Outcome.SELECTED);
    assert.equal(result.node.name, 'node-2');
  });

  test('packs GPU jobs rather than spreading them, so large requests stay schedulable', () => {
    // Spreading would put this on the 4-GPU node and leave 2 nodes each with 1 free —
    // a state in which no 2-GPU job can ever be placed.
    const nodes = [
      node({ id: 'n1', name: 'node-1', gpus: [gpu(), gpu()] }),
      node({ id: 'n2', name: 'node-2', gpus: [gpu(), gpu(), gpu(), gpu()] }),
    ];

    const result = placeJob(request({ gpu: 2 }), nodes);
    assert.equal(result.node.name, 'node-1', 'the tighter fit must win');
  });

  test('keeps CPU-only jobs off GPU nodes', () => {
    const nodes = [
      node({ id: 'n1', name: 'gpu-node', gpus: [gpu(), gpu()] }),
      node({ id: 'n2', name: 'cpu-node', gpus: [] }),
    ];

    const result = placeJob(request({ cpu: 4 }), nodes);
    assert.equal(result.node.name, 'cpu-node');
    assert.match(result.reason, /CPU-only job kept off GPU nodes/);
  });

  test('is deterministic when nodes are genuinely equivalent', () => {
    const nodes = [
      node({ id: 'n2', name: 'node-b', gpus: [gpu()] }),
      node({ id: 'n1', name: 'node-a', gpus: [gpu()] }),
    ];

    const first = placeJob(request({ gpu: 1 }), nodes);
    const second = placeJob(request({ gpu: 1 }), [...nodes].reverse());

    assert.equal(first.node.name, second.node.name, 'input order must not change the outcome');
    assert.equal(first.node.name, 'node-a');
  });

  test('records a decision for every node considered, not only the winner', () => {
    const nodes = [
      node({ id: 'n1', name: 'node-1', gpus: [gpu()] }),
      node({ id: 'n2', name: 'node-2', gpus: [], ready: false }),
      node({ id: 'n3', name: 'node-3', gpus: [gpu(), gpu()] }),
    ];

    const result = placeJob(request({ gpu: 1 }), nodes);

    assert.equal(result.decisions.length, 3, 'every node evaluated must leave a record');

    // Exactly one winner. node-3 also fits, but it lost the ranking, and recording it
    // as SELECTED too would show two winners for one job.
    const selected = result.decisions.filter((d) => d.outcome === Outcome.SELECTED);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].node_name, 'node-1');

    const viable = result.decisions.filter((d) => d.outcome === Outcome.VIABLE);
    assert.deepEqual(viable.map((d) => d.node_name), ['node-3']);
    assert.match(viable[0].reason, /fits, but node-1 was the better fit/);

    // "Why not the other node" is part of explaining a placement.
    const rejected = result.decisions.filter((d) => d.outcome === Outcome.REJECTED);
    assert.deepEqual(rejected.map((d) => d.node_name), ['node-2']);
    assert.ok(rejected.every((d) => d.reason.length > 0));
  });

  test('a decision carries what was requested and what was free at the time', () => {
    const nodes = [node({ id: 'n1', name: 'node-1', cpu_cores: 8, gpus: [gpu()] })];
    const result = placeJob(request({ cpu: 2, gpu: 1 }), nodes);
    const decision = result.decisions[0];

    assert.equal(decision.details.requested.cpu, 2);
    assert.equal(decision.details.requested.gpu, 1);
    assert.equal(decision.details.free.gpu, 1);
    assert.equal(decision.details.free.cpu, 8);
  });

  test('when nothing fits, the summary counts the blockers by cause', () => {
    const nodes = [
      node({ id: 'n1', name: 'node-1', gpus: [], ready: false }),
      node({ id: 'n2', name: 'node-2', gpus: [gpu()], allocated: { cpu: 0, memory_bytes: 0, gpu: 1 } }),
      node({ id: 'n3', name: 'node-3', gpus: [gpu()], allocated: { cpu: 0, memory_bytes: 0, gpu: 1 } }),
    ];

    const result = placeJob(request({ gpu: 1 }), nodes);

    assert.equal(result.outcome, Outcome.NO_CAPACITY);
    assert.match(result.reason, /2 × INSUFFICIENT_GPUS/);
    assert.match(result.reason, /1 × NODE_NOT_READY/);
    assert.equal(result.decisions.length, 3, 'a failed placement is still fully explained');
  });

  test('the selection reason states what was taken and what is left', () => {
    const nodes = [node({ id: 'n1', name: 'node-1', gpus: [gpu(), gpu(), gpu()] })];
    const result = placeJob(request({ gpu: 2, cpu: 4 }), nodes);

    assert.match(result.reason, /2 of 3 free GPU\(s\), leaving 1/);
    assert.match(result.reason, /4 of 16 free CPU/);
  });
});
