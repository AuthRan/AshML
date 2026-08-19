/**
 * Configuration, resolved once from the environment.
 *
 * Every setting is an environment variable so the same image runs unchanged in local
 * dev and in Kubernetes (12-factor). Defaults are chosen for the development host.
 */

export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.ASHML_PORT ?? '8080', 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`ASHML_PORT="${env.ASHML_PORT}": want a port between 1 and 65535`);
  }

  return {
    port,
    host: env.ASHML_HOST ?? '0.0.0.0',
    logLevel: env.ASHML_LOG_LEVEL ?? 'info',

    // Default to real hardware. `sim` must always be opted into explicitly so a demo
    // can never accidentally present fabricated telemetry (spec Rule 5).
    gpuProvider: env.ASHML_GPU_PROVIDER ?? 'nvidia',

    // Passed through to whichever provider is selected. This module is the only
    // place that reads the environment, so providers stay testable.
    gpuProviderOptions: {
      simDeviceCount: parseCount(env.ASHML_SIM_GPUS, 'ASHML_SIM_GPUS'),
    },

    // Kubernetes execution (Phase 2). Like the GPU provider, the real backend is the
    // default and `sim` must be opted into explicitly, so a demo can never quietly
    // present a fabricated run as a real one (spec Rule 5).
    k8sBackend: env.ASHML_K8S_BACKEND ?? 'kubernetes',
    k8sNamespace: env.ASHML_K8S_NAMESPACE ?? 'ashml-jobs',
    // Unset means the standard resolution order: $KUBECONFIG, ~/.kube/config, then
    // the in-cluster service account.
    kubeconfig: env.ASHML_KUBECONFIG ?? null,

    // The executor is what makes jobs actually run. It is disabled only for a server
    // deliberately brought up as a read-only API replica.
    executorEnabled: parseBool(env.ASHML_EXECUTOR_ENABLED, 'ASHML_EXECUTOR_ENABLED', true),
    executorIntervalMs: parseCount(env.ASHML_EXECUTOR_INTERVAL_MS, 'ASHML_EXECUTOR_INTERVAL_MS') ?? 2000,

    // Node inventory changes on the order of minutes and GPU telemetry on the order of
    // seconds; neither is worth a `LIST nodes` and an `nvidia-smi` fork on every job pass.
    discoveryIntervalMs: parseCount(env.ASHML_DISCOVERY_INTERVAL_MS, 'ASHML_DISCOVERY_INTERVAL_MS') ?? 15_000,

    // Artifact storage (Phase 4). `s3` is real and is the default, in the same spirit
    // as the GPU provider and the execution backend; `none` is the honest description of
    // a control plane with no bucket, not a simulation of one.
    artifactStore: env.ASHML_ARTIFACT_STORE ?? 's3',
    artifactStoreOptions: {
      bucket: env.ASHML_S3_BUCKET ?? 'ashml',
      // Defaults match deploy/local/docker-compose.yml, exactly as databaseUrl below
      // defaults to the compose Postgres. Unset the endpoint for real AWS, where the
      // SDK resolves the host and the credential chain by itself.
      endpoint: env.ASHML_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      region: env.ASHML_S3_REGION ?? 'us-east-1',
      accessKeyId: env.ASHML_S3_ACCESS_KEY ?? 'ashml',
      secretAccessKey: env.ASHML_S3_SECRET_KEY ?? 'ashml-dev-secret',
      // MinIO serves buckets as a path; AWS serves them as a subdomain.
      forcePathStyle: parseBool(env.ASHML_S3_FORCE_PATH_STYLE, 'ASHML_S3_FORCE_PATH_STYLE', true),
      // Long enough for a large checkpoint on a slow link, short enough that a URL
      // leaked into a log is not a standing grant.
      presignTtlSeconds: parseCount(env.ASHML_S3_PRESIGN_TTL, 'ASHML_S3_PRESIGN_TTL') ?? 3600,
    },

    databaseUrl: env.ASHML_DATABASE_URL
      ?? 'postgresql://ashml:ashml@127.0.0.1:5432/ashml',
    databasePoolMax: parseCount(env.ASHML_DB_POOL_MAX, 'ASHML_DB_POOL_MAX') ?? 10,

    version: env.ASHML_VERSION ?? '0.1.0-dev',
  };
}

function parseBool(raw, name, fallback) {
  if (raw === undefined) return fallback;

  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name}="${raw}": want a boolean (true/false)`);
}

function parseCount(raw, name) {
  if (raw === undefined) return undefined;

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`${name}="${raw}": want a non-negative integer`);
  }
  return value;
}
