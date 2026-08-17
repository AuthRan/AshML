/**
 * Simulated GPU provider, for CI and for development on machines without GPUs.
 *
 * Every device it returns carries `simulated: true`, which propagates through the
 * API response and into the CLI output. This provider must never be the default
 * (spec Rule 5: do not fake GPU functionality).
 */

import { Health, makeDevice, registerProvider } from './provider.js';

export const PROVIDER_NAME = 'sim';

const DEFAULT_COUNT = 2;
const DEFAULT_MEMORY_BYTES = 16 * 1024 ** 3;

class SimProvider {
  constructor({ count = DEFAULT_COUNT, memoryBytes = DEFAULT_MEMORY_BYTES } = {}) {
    this.count = count;
    this.memoryBytes = memoryBytes;
  }

  get name() {
    return PROVIDER_NAME;
  }

  async discover() {
    return Array.from({ length: this.count }, (_, index) =>
      makeDevice({
        provider: PROVIDER_NAME,
        index,
        uuid: `SIM-${String(index).padStart(8, '0')}`,
        model: 'Simulated GPU',
        memory_total_bytes: this.memoryBytes,
        memory_used_bytes: 0,
        utilization_pct: 0,
        temperature_c: 40,
        power_watts: 50,
        health: Health.OK,
        simulated: true,
      }),
    );
  }
}

registerProvider(PROVIDER_NAME, ({ simDeviceCount } = {}) =>
  new SimProvider({ count: simDeviceCount ?? DEFAULT_COUNT }));

export { SimProvider };
