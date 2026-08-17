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

    databaseUrl: env.ASHML_DATABASE_URL
      ?? 'postgresql://ashml:ashml@127.0.0.1:5432/ashml',
    databasePoolMax: parseCount(env.ASHML_DB_POOL_MAX, 'ASHML_DB_POOL_MAX') ?? 10,

    version: env.ASHML_VERSION ?? '0.1.0-dev',
  };
}

function parseCount(raw, name) {
  if (raw === undefined) return undefined;

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`${name}="${raw}": want a non-negative integer`);
  }
  return value;
}
