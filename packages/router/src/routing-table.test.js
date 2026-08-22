/**
 * Unit tests for the router's routing table.
 *
 * The behaviour worth protecting here is what happens when the control plane is *not*
 * answering, because that is the case where a wrong decision takes inference down with
 * the control plane — and it is the case nobody exercises by hand.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRoutingTable, FAILOVER_COOLDOWN_MS } from './routing-table.js';

function document(targets, extra = {}) {
  return { deployment: 'resnet-cifar', model: 'resnet18-cifar10', targets, ...extra };
}

/** A fetch that answers with whatever the test queues, and counts the calls. */
function stubFetch(responses) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const next = responses.shift() ?? responses.at(-1);
    if (next instanceof Error) throw next;
    return {
      ok: next.status === undefined || next.status < 400,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  };
  impl.calls = calls;
  return impl;
}

function makeTable(responses, { now = () => 1_000 } = {}) {
  return createRoutingTable({
    endpoint: 'http://control-plane:8080',
    deploymentId: 'dep-1',
    fetchImpl: stubFetch(responses),
    now,
  });
}

describe('fetching the split', () => {
  test('asks the control plane for the deployment it was given, by id', async () => {
    const impl = stubFetch([{ body: document([]) }]);
    const table = createRoutingTable({
      endpoint: 'http://control-plane:8080/',
      deploymentId: 'dep-1',
      fetchImpl: impl,
    });
    await table.refresh();
    // A name can be changed by an operator; an id cannot, and a router asking about a
    // name that has moved is a router that quietly stops working.
    assert.equal(impl.calls[0], 'http://control-plane:8080/api/v1/deployments/dep-1/routing');
  });

  test('hands the weights on in the shape chooseTarget wants', async () => {
    const table = makeTable([{
      body: document([
        { version: 6, weight: 90, url: 'http://v6', ready: true },
        { version: 7, weight: 10, url: 'http://v7', ready: true },
      ]),
    }]);
    await table.refresh();
    assert.deepEqual(table.targets().map((t) => [t.version, t.weight, t.ready]), [
      [6, 90, true],
      [7, 10, true],
    ]);
  });

  test('a version the control plane says is not ready takes no traffic', async () => {
    const table = makeTable([{
      body: document([
        { version: 6, weight: 90, url: 'http://v6', ready: true },
        { version: 7, weight: 10, url: 'http://v7', ready: false },
      ]),
    }]);
    await table.refresh();
    assert.equal(table.targets().find((t) => t.version === 7).ready, false);
  });
});

describe('when the control plane cannot be reached', () => {
  test('the last good split keeps being used', async () => {
    // The point of the whole file. A router that emptied its table here would take every
    // deployment behind it down with a control plane that was merely restarting.
    const table = makeTable([
      { body: document([{ version: 6, weight: 100, url: 'http://v6', ready: true }]) },
      new Error('connect ECONNREFUSED'),
    ]);
    await table.refresh();
    const failed = await table.refresh();

    assert.equal(failed.ok, false);
    assert.deepEqual(table.targets().map((t) => t.version), [6]);
    assert.equal(table.status().loaded, true);
  });

  test('the failure is reported rather than hidden behind a working router', async () => {
    const table = makeTable([
      { body: document([{ version: 6, weight: 100, url: 'http://v6', ready: true }]) },
      new Error('connect ECONNREFUSED'),
    ]);
    await table.refresh();
    await table.refresh();
    assert.match(table.status().last_error, /ECONNREFUSED/);
  });

  test('the age of the split grows, which is the only thing that shows it is stale', async () => {
    let clock = 1_000;
    const table = makeTable(
      [{ body: document([{ version: 6, weight: 100, url: 'http://v6', ready: true }]) },
        new Error('down')],
      { now: () => clock },
    );
    await table.refresh();
    assert.equal(table.status().age_seconds, 0);

    clock += 90_000;
    await table.refresh();
    // Still serving, and now visibly on information a minute and a half old. A split read
    // without its age is a split that might be last week's.
    assert.equal(table.status().age_seconds, 90);
  });

  test('a non-200 is a failure, not a routing table', async () => {
    const table = makeTable([{ status: 503, body: { error: 'starting' } }]);
    const result = await table.refresh();
    assert.equal(result.ok, false);
    assert.equal(table.status().loaded, false);
  });

  test('a document with no targets array is refused rather than routed on', async () => {
    // An answer that parses and means nothing is worse than no answer: it would replace
    // a good table with an empty one and every request would 503.
    const table = makeTable([{ body: { deployment: 'x' } }]);
    assert.equal((await table.refresh()).ok, false);
    assert.equal(table.status().loaded, false);
  });
});

describe("the router's own view of a version", () => {
  test('a version it could not reach is taken out of rotation', async () => {
    let clock = 1_000;
    const table = makeTable(
      [{ body: document([
        { version: 6, weight: 90, url: 'http://v6', ready: true },
        { version: 7, weight: 10, url: 'http://v7', ready: true },
      ]) }],
      { now: () => clock },
    );
    await table.refresh();

    table.markUnreachable(7);
    assert.equal(table.targets().find((t) => t.version === 7).ready, false);

    // And it comes back on its own. The cooldown is shorter than the refresh interval so
    // it can never outlive the problem that caused it — a version that has recovered must
    // not stay out because this router remembers a failure.
    clock += FAILOVER_COOLDOWN_MS + 1;
    assert.equal(table.targets().find((t) => t.version === 7).ready, true);
  });

  test('a version that answered is trusted again immediately', async () => {
    const table = makeTable([{ body: document([
      { version: 6, weight: 100, url: 'http://v6', ready: true },
    ]) }]);
    await table.refresh();
    table.markUnreachable(6);
    table.markReachable(6);
    assert.equal(table.targets()[0].ready, true);
  });
});
