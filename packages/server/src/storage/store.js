/**
 * The single seam through which all object-storage knowledge enters AshML.
 *
 * Nothing above this module imports `@aws-sdk/client-s3`. The same argument as the GPU
 * provider (ADR 0005) and the execution backend: the artifact service talks to a store
 * object, so its logic can be tested without MinIO running, and swapping MinIO for real
 * S3 — or for nothing at all — is a config change.
 *
 * A store is any object shaped like:
 *
 *   {
 *     name: string,
 *     managed: boolean,
 *     keyFor(parts): string,
 *     uriFor(key): string,
 *     keyFromUri(uri): string | null,
 *     presignPut(key, options): Promise<{ url, expires_at }>,
 *     presignGet(key, options): Promise<{ url, expires_at }>,
 *     head(key): Promise<{ size_bytes, etag } | null>,
 *     ensureBucket(): Promise<void>,
 *     close(): Promise<void>,
 *   }
 *
 * `head` returning null means the object is not there. That is the whole reason this
 * seam has a read method at all: it is what lets `POST /artifacts/{id}/complete` check
 * that the bytes exist instead of taking the uploader's word for it. A store that
 * cannot answer that question honestly must not pretend to (spec Rule 5).
 *
 * `managed` says whether this store owns the URIs it hands out. An unmanaged store
 * (`none`) has no bucket and no credentials: artifacts may still be registered against
 * a URI the caller supplies, but AshML cannot allocate one, cannot presign, and — the
 * part that matters — cannot verify. Completion against an unmanaged store records what
 * the run claimed and says so, rather than implying it was checked.
 */

/** name -> factory. Populated by each store module at import time. */
const factories = new Map();

/**
 * Makes a store available to createStore.
 * @param {string} name
 * @param {(options?: object) => object} factory
 */
export function registerStore(name, factory) {
  if (factories.has(name)) {
    throw new Error(`storage: store registered twice: ${name}`);
  }
  factories.set(name, factory);
}

/** @returns {string[]} registered store names, sorted. */
export function availableStores() {
  return [...factories.keys()].sort();
}

/**
 * Constructs the named store.
 *
 * Options come from config, never from the environment directly, so stores stay
 * testable without mutating process.env.
 */
export function createStore(name, options = {}) {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(
      `storage: unknown store "${name}" (available: ${availableStores().join(', ') || 'none'})`,
    );
  }
  return factory(options);
}

/** Test seam: drops all registrations. Not used by production code. */
export function _resetStoresForTest() {
  factories.clear();
}

/**
 * Builds the object key for an artifact.
 *
 * The layout is `<project>/<job>/<name>`, which makes the bucket browsable by a human
 * with `mc ls` and groups a run's output together. The job id rather than the job name
 * is what separates two runs with the same name — job names are unique only within a
 * project, and a retry reuses them.
 *
 * Every segment is sanitised, because `name` comes from the training script: a run that
 * called its checkpoint `../../etc/passwd` would otherwise choose where it lands.
 * Exported and shared by every store so the rule cannot differ between them.
 */
export function buildKey({ project, jobId, name }) {
  return [project, jobId, name].map(safeSegment).join('/');
}

/**
 * Reduces one path segment to characters that cannot traverse or nest.
 *
 * Slashes and dots are stripped rather than escaped: there is no legitimate reason for
 * a checkpoint name to contain a path, and a segment that survives this is one whose
 * meaning is obvious in a bucket listing.
 */
export function safeSegment(raw) {
  const cleaned = String(raw)
    .replace(/[^A-Za-z0-9._-]/g, '-')   // anything exotic becomes a dash
    .replace(/\.{2,}/g, '.')             // `..` cannot survive in any form
    .replace(/^[.-]+/, '')               // nor a leading dot or dash
    .slice(0, 120);
  return cleaned || 'unnamed';
}
