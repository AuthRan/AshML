/**
 * Key construction is pure, and it is the only thing standing between a training
 * script's choice of filename and the layout of the bucket. It is tested here rather
 * than only through MinIO, because these cases must hold on a machine with no store.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildKey, safeSegment, availableStores, createStore } from './store.js';

describe('artifact keys', () => {
  test('a key groups a run’s output under its project and job', () => {
    assert.equal(
      buildKey({ project: 'vision', jobId: 'abc-123', name: 'epoch-1.pt' }),
      'vision/abc-123/epoch-1.pt',
    );
  });

  test('a name cannot climb out of the run’s prefix', () => {
    const key = buildKey({ project: 'vision', jobId: 'abc-123', name: '../../etc/passwd' });
    assert.ok(!key.includes('..'), key);
    assert.ok(key.startsWith('vision/abc-123/'), key);
    // Three segments, always: whatever the run called it is one of them.
    assert.equal(key.split('/').length, 3);
  });

  test('an absolute path is not one', () => {
    const key = buildKey({ project: 'vision', jobId: 'j', name: '/etc/shadow' });
    assert.ok(key.startsWith('vision/j/'), key);
    assert.equal(key.split('/').length, 3);
  });

  test('ordinary names survive intact', () => {
    // Sanitising must not mangle the common case, or every bucket listing becomes
    // unreadable to the person who has to find a checkpoint in it.
    for (const name of ['epoch-1.pt', 'model_final.safetensors', 'ckpt.00042.bin']) {
      assert.equal(safeSegment(name), name);
    }
  });

  test('a name that sanitises to nothing still produces a key', () => {
    // `...` reduces to empty. A key with an empty segment would be a different object
    // path than intended, so it becomes a placeholder rather than vanishing.
    assert.equal(safeSegment('...'), 'unnamed');
    assert.equal(safeSegment(''), 'unnamed');
  });

  test('a very long name is truncated rather than rejected', () => {
    // Refusing the upload after the run has trained for six hours would be the worse
    // failure. S3 caps a key at 1024 bytes; three of these still fit.
    assert.equal(safeSegment('x'.repeat(500)).length, 120);
  });

  test('exotic characters become dashes, not path separators', () => {
    assert.equal(safeSegment('my ckpt @ step 5'), 'my-ckpt---step-5');
    assert.ok(!safeSegment('a/b/c').includes('/'));
  });
});

describe('the store registry', () => {
  test('both stores are registered by importing them', async () => {
    await import('./s3.js');
    await import('./none.js');
    assert.deepEqual(availableStores(), ['none', 's3']);
  });

  test('an unknown store names the ones that exist', () => {
    assert.throws(
      () => createStore('gcs'),
      (err) => {
        // The error a misconfigured deployment sees; it must say what to set it to.
        assert.match(err.message, /unknown store "gcs"/);
        assert.match(err.message, /none, s3/);
        return true;
      },
    );
  });

  test('the s3 store refuses to exist without a bucket', async () => {
    const { createS3Store } = await import('./s3.js');
    // Failing at construction rather than at the first upload means a bad config is
    // found when the server starts, not six hours into a training run.
    assert.throws(() => createS3Store({}), /needs a bucket/);
  });

  test('the none store is honest about what it cannot do', async () => {
    const { createNoneStore } = await import('./none.js');
    const store = createNoneStore();

    assert.equal(store.managed, false);
    assert.equal(store.uriFor('anything'), null);
    await assert.rejects(() => store.presignPut('k'), /no artifact store is configured/);
    // head() throws rather than returning null: "cannot check" must not be reported as
    // "checked, and it is not there", which would fail every completion instead.
    await assert.rejects(() => store.head('k'), /cannot verify/);
  });
});
