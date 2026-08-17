/**
 * Real NVIDIA GPU discovery via the nvidia-smi binary.
 *
 * Shelling out is adequate at our discovery frequency (seconds). Node has no
 * first-class NVML binding; if this ever shows up in a profile the answer is to read
 * from DCGM-exporter, which Phase 5 deploys anyway — but measure first (spec §59).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Health, makeDevice, registerProvider } from './provider.js';

const execFileAsync = promisify(execFile);

export const PROVIDER_NAME = 'nvidia';

/** Must stay in sync with the positional parsing in parseSmiCsv. */
const QUERY_FIELDS = [
  'index',
  'uuid',
  'name',
  'memory.total',
  'memory.used',
  'utilization.gpu',
  'temperature.gpu',
  'power.draw',
];

const MIB = 1024 * 1024;

/**
 * Parses `nvidia-smi --format=csv,noheader,nounits` output.
 *
 * Memory is reported in MiB, power in watts. Fields a card does not support come
 * back as `[N/A]`; we keep the device but do not pretend the value is zero-and-fine.
 *
 * Exported for testing against captured real output.
 */
export function parseSmiCsv(stdout) {
  const devices = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const cols = trimmed.split(',').map((c) => c.trim());
    if (cols.length !== QUERY_FIELDS.length) {
      throw new Error(
        `nvidia-smi: expected ${QUERY_FIELDS.length} columns, got ${cols.length}: "${trimmed}"`,
      );
    }

    const [index, uuid, model, memTotal, memUsed, util, temp, power] = cols;

    // `[N/A]` and anything else unparseable becomes null, not 0 — the difference
    // matters when deciding whether a device is schedulable.
    const int = (v) => {
      const n = Number.parseInt(v, 10);
      return Number.isNaN(n) ? null : n;
    };
    const float = (v) => {
      const n = Number.parseFloat(v);
      return Number.isNaN(n) ? null : n;
    };

    const memTotalMib = int(memTotal);

    devices.push(
      makeDevice({
        provider: PROVIDER_NAME,
        index: int(index) ?? 0,
        uuid,
        model,
        memory_total_bytes: (memTotalMib ?? 0) * MIB,
        memory_used_bytes: (int(memUsed) ?? 0) * MIB,
        utilization_pct: int(util) ?? 0,
        temperature_c: int(temp) ?? 0,
        power_watts: float(power) ?? 0,
        // A card that will not report its own memory is not one the scheduler
        // should place GPU-memory-constrained work onto.
        health: memTotalMib === null ? Health.UNKNOWN : Health.OK,
        simulated: false,
      }),
    );
  }

  return devices;
}

class NvidiaProvider {
  get name() {
    return PROVIDER_NAME;
  }

  async discover({ timeoutMs = 10_000 } = {}) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(
        'nvidia-smi',
        [`--query-gpu=${QUERY_FIELDS.join(',')}`, '--format=csv,noheader,nounits'],
        { timeout: timeoutMs },
      ));
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(
          'nvidia-smi not found. Install the NVIDIA driver, or run with '
          + 'ASHML_GPU_PROVIDER=sim for a machine without GPUs.',
          { cause: err },
        );
      }
      const detail = (err.stderr ?? '').trim();
      throw new Error(`nvidia-smi failed${detail ? `: ${detail}` : ''}`, { cause: err });
    }

    return parseSmiCsv(stdout);
  }
}

registerProvider(PROVIDER_NAME, () => new NvidiaProvider());
