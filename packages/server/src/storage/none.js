/**
 * No managed artifact storage.
 *
 * This is not a simulation and does not pretend to be one (spec Rule 5). It is the
 * honest description of a control plane with no bucket configured: artifacts may still
 * be registered against a URI the caller already has — a NFS path, a bucket AshML knows
 * nothing about — and the lifecycle still works, because `PENDING -> READY` is a claim
 * the run makes about its own upload.
 *
 * What is missing is everything that needs a bucket:
 *
 * - AshML cannot allocate a URI, so `uri` becomes required at registration.
 * - There is no presigned upload, so the run arranges its own.
 * - **Completion cannot be verified.** This is the part that must not be papered over.
 *   With a real store, READY means AshML asked the bucket and the bytes were there.
 *   Here it means the run said so. The API reports which of those two happened rather
 *   than letting them look alike.
 */

import { registerStore, buildKey } from './store.js';

export function createNoneStore() {
  return {
    name: 'none',
    managed: false,
    bucket: null,

    keyFor: buildKey,

    /** Nothing here owns a URI scheme, so there is nothing to build or to recognise. */
    uriFor() {
      return null;
    },

    keyFromUri() {
      return null;
    },

    async presignPut() {
      throw new Error('storage: no artifact store is configured (ASHML_ARTIFACT_STORE=none)');
    },

    async presignGet() {
      throw new Error('storage: no artifact store is configured (ASHML_ARTIFACT_STORE=none)');
    },

    /**
     * Cannot answer the question, and says so by throwing rather than returning null.
     *
     * Returning null would mean "checked, and the object is not there", which would fail
     * every completion. Returning a fake size would be worse. Callers must ask `managed`
     * first and skip verification deliberately, which is the only honest option.
     */
    async head() {
      throw new Error('storage: cannot verify an artifact without a configured store');
    },

    async ensureBucket() {
      // Nothing to ensure.
    },

    async close() {
      // Nothing to close.
    },
  };
}

registerStore('none', createNoneStore);
