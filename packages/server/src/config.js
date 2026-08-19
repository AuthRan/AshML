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
