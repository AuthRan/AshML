/**
 * S3-compatible artifact storage. Real, not simulated — this talks to MinIO locally and
 * to S3 unchanged in a cluster.
 *
 * This is the only module in the codebase that imports the AWS SDK.
 *
 * Uploads are **presigned**, so checkpoint bytes go straight from the training pod to
 * object storage and never through the control plane. A 2 GB checkpoint proxied through
 * a Fastify handler would occupy an event loop that has a scheduler and a status-sync
 * loop to run, and would put the API's memory limit in the path of every model size.
 */

import { Readable } from 'node:stream';
import {
  S3Client,
  HeadObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { registerStore, buildKey } from './store.js';

/**
 * @param {object} options from config.artifactStoreOptions
 * @param {string} options.bucket
 * @param {string} [options.endpoint] unset for real AWS; set for MinIO
 * @param {boolean} [options.forcePathStyle] MinIO needs it; AWS does not
 * @param {number} [options.presignTtlSeconds]
 */
export function createS3Store({
  bucket,
  endpoint = null,
  region = 'us-east-1',
  accessKeyId = null,
  secretAccessKey = null,
  forcePathStyle = true,
  presignTtlSeconds = 3600,
} = {}) {
  if (!bucket) {
    throw new Error('storage: the s3 store needs a bucket (ASHML_S3_BUCKET)');
  }

  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle } : {}),
    // Explicit credentials only when both are given; otherwise fall back to the SDK's
    // own chain, which is what picks up an IAM role in a real cluster.
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });

  let bucketEnsured = null;

  return {
    name: 's3',
    managed: true,
    bucket,

    keyFor: buildKey,

    /**
     * `s3://bucket/key` regardless of endpoint.
     *
     * The URI is what gets stored and shown, so it must not embed a host: MinIO's
     * address in dev is not the address the same artifact has in a cluster, and a
     * stored `http://127.0.0.1:9000/...` would be a URI that stops resolving the moment
     * anything moves. The endpoint belongs to the client, not to the artifact.
     */
    uriFor(key) {
      return `s3://${bucket}/${key}`;
    },

    /** The inverse, and null for a URI this store does not own. */
    keyFromUri(uri) {
      const prefix = `s3://${bucket}/`;
      return typeof uri === 'string' && uri.startsWith(prefix)
        ? uri.slice(prefix.length)
        : null;
    },

    async presignPut(key, { ttlSeconds = presignTtlSeconds } = {}) {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: ttlSeconds },
      );
      return { url, expires_at: expiryFrom(ttlSeconds) };
    },

    async presignGet(key, { ttlSeconds = presignTtlSeconds } = {}) {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: ttlSeconds },
      );
      return { url, expires_at: expiryFrom(ttlSeconds) };
    },

    /**
     * What the store actually holds at `key`, or null if it holds nothing.
     *
     * This is the call that makes READY mean something. A missing object is a null
     * return, not a throw: "the upload never landed" is an ordinary answer to this
     * question, not an error. Anything else — credentials, a network fault — throws,
     * because failing to *check* is not the same as checking and finding nothing.
     */
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          size_bytes: Number(res.ContentLength ?? 0),
          etag: (res.ETag ?? '').replaceAll('"', ''),
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    /**
     * Creates the bucket if it is missing, once per process.
     *
     * Lazy and memoised rather than done at boot: a control plane whose artifact store
     * is temporarily unreachable should still serve every endpoint that does not touch
     * it, which is most of them.
     */
    async ensureBucket() {
      bucketEnsured ??= (async () => {
        try {
          await client.send(new HeadBucketCommand({ Bucket: bucket }));
        } catch (err) {
          if (!isNotFound(err)) throw err;
          try {
            await client.send(new CreateBucketCommand({ Bucket: bucket }));
          } catch (createErr) {
            // Another process won the race. That is success, not failure.
            if (!alreadyOwned(createErr)) throw createErr;
          }
        }
      })();

      try {
        await bucketEnsured;
      } catch (err) {
        // Do not cache a failure: the next request should retry rather than inherit a
        // rejection from a transient outage minutes ago.
        bucketEnsured = null;
        throw err;
      }
    },

    /** Used by tests and by the smoke script; the upload path itself is presigned. */
    async put(key, body) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body instanceof Readable ? body : Buffer.from(body),
      }));
    },

    async close() {
      client.destroy();
    },
  };
}

function expiryFrom(ttlSeconds) {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

/** S3 reports a missing key or bucket several ways depending on the operation. */
function isNotFound(err) {
  const status = err?.$metadata?.httpStatusCode;
  return status === 404
    || err?.name === 'NotFound'
    || err?.name === 'NoSuchKey'
    || err?.name === 'NoSuchBucket';
}

function alreadyOwned(err) {
  return err?.name === 'BucketAlreadyOwnedByYou' || err?.name === 'BucketAlreadyExists';
}

registerStore('s3', createS3Store);
