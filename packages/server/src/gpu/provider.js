/**
 * The single seam through which all GPU knowledge enters AshML.
 *
 * Nothing above this module knows which provider is active. Adding AshGPU later
 * (Phase 8) means writing one module and calling registerProvider — no scheduler,
 * API, or schema changes. See docs/adr/0005-gpu-provider-interface.md.
 *
 * A provider is any object shaped like:
 *   { name: string, discover(): Promise<Device[]> }
 *
 * Device objects use snake_case because they are wire and database shaped — they go
 * straight into API responses and the `gpu_devices` table without a mapping layer.
 */

export const Health = Object.freeze({
  OK: 'OK',
  DEGRADED: 'DEGRADED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * JSON Schema for one device. Fastify uses this to validate and serialize responses,
 * and @fastify/swagger turns it into the OpenAPI component — so this declaration is
 * the single source of truth for the shape (ADR 0006).
 */
export const deviceSchema = {
  $id: 'GpuDevice',
  type: 'object',
  required: [
    'provider', 'index', 'uuid', 'model',
    'memory_total_bytes', 'memory_used_bytes', 'memory_free_bytes',
    'utilization_pct', 'health', 'simulated',
  ],
  properties: {
    provider: { type: 'string', description: 'Provider that discovered this device' },
    index: { type: 'integer', minimum: 0 },
    uuid: { type: 'string' },
    model: { type: 'string' },
    memory_total_bytes: { type: 'integer', minimum: 0 },
    memory_used_bytes: { type: 'integer', minimum: 0 },
    memory_free_bytes: { type: 'integer', minimum: 0 },
    utilization_pct: { type: 'integer', minimum: 0, maximum: 100 },
    temperature_c: { type: 'integer' },
    power_watts: { type: 'number' },
    health: { type: 'string', enum: Object.values(Health) },
    simulated: {
      type: 'boolean',
      description:
        'True when this device is fabricated rather than real hardware. Never hide this: '
        + 'the spec forbids passing simulated telemetry off as real (Rule 5).',
    },
  },
};

/**
 * Normalises a partial device into the full wire shape, deriving free memory.
 * Providers build devices through this so the derived fields cannot drift.
 */
export function makeDevice(fields) {
  const total = fields.memory_total_bytes ?? 0;
  const used = fields.memory_used_bytes ?? 0;
  return {
    provider: fields.provider,
    index: fields.index,
    uuid: fields.uuid,
    model: fields.model,
    memory_total_bytes: total,
    memory_used_bytes: used,
    memory_free_bytes: Math.max(0, total - used),
    utilization_pct: fields.utilization_pct ?? 0,
    temperature_c: fields.temperature_c ?? 0,
    power_watts: fields.power_watts ?? 0,
    health: fields.health ?? Health.UNKNOWN,
    simulated: fields.simulated === true,
  };
}

/** name -> factory. Populated by each provider module at import time. */
const factories = new Map();

/**
 * Makes a provider available to createProvider.
 * @param {string} name
 * @param {(options?: object) => object} factory returns { name, discover() }
 */
export function registerProvider(name, factory) {
  if (factories.has(name)) {
    // Only possible at import time, and always a programming error.
    throw new Error(`gpu: provider registered twice: ${name}`);
  }
  factories.set(name, factory);
}

/** @returns {string[]} registered provider names, sorted. */
export function availableProviders() {
  return [...factories.keys()].sort();
}

/**
 * Constructs the named provider.
 *
 * Options come from config, never from the environment directly — providers must
 * stay testable without mutating process.env.
 *
 * @param {string} name
 * @param {object} [options] provider-specific settings from config
 * @returns {{ name: string, discover: () => Promise<object[]> }}
 */
export function createProvider(name, options = {}) {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(
      `gpu: unknown provider "${name}" (available: ${availableProviders().join(', ') || 'none'})`,
    );
  }
  return factory(options);
}

/** Test seam: drops all registrations. Not used by production code. */
export function _resetProvidersForTest() {
  factories.clear();
}
