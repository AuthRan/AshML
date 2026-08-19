/**
 * Training metrics — the ingest side of Phase 4.
 *
 * Metrics are **pushed** by the training process rather than scraped from it
 * (ADR 0009). The run is the only thing that knows what step it is on, so it is also
 * the only thing that can label a value correctly.
 *
 * This service owns two rules the ingest path must not lose:
 *
 * 1. Metrics are attributed to a job that has actually been launched. A loss curve for
 *    a job still sitting in the queue describes nothing that happened.
 * 2. The experiment id is copied from the job here, never taken from the request. A run
 *    that could name its own experiment could attach its numbers to someone else's
 *    record, and comparing runs is the entire purpose of the experiment view.
 */

import { withTransaction } from '../db/pool.js';
import { hasLaunched } from '../domain/job-state.js';
import * as metricsRepo from '../repos/metrics.js';
import * as jobsRepo from '../repos/jobs.js';
import * as experimentsRepo from '../repos/experiments.js';
import { ConflictError, NotFoundError } from './errors.js';

/**
 * Appends a batch of metrics to a job's history.
 *
 * Metrics are append-only: re-reporting a step adds a second point rather than
 * replacing the first. A run that reports the same step twice has done something worth
 * seeing, and silently overwriting would hide it.
 *
 * @param {Array<{name, value, step, epoch?, recorded_at?}>} metrics as received
 * @returns {Promise<{written: number, job_id: string, experiment_id: string|null}>}
 */
export async function recordMetrics(pool, jobId, metrics) {
  return withTransaction(pool, async (client) => {
    const job = await jobsRepo.getJobById(client, jobId);
    if (!job) {
      throw new NotFoundError(`job ${jobId} not found`);
    }

    // 409 rather than 400: the request is well-formed, and the identical call will
    // succeed once the job is launched.
    if (!hasLaunched(job.state)) {
      throw new ConflictError(
        'JOB_NOT_STARTED',
        `job ${jobId} is ${job.state}; no workload has run to produce metrics`,
      );
    }

    const experimentId = job.experiment?.id ?? null;

    const written = await metricsRepo.insertMetrics(client, {
      jobId,
      experimentId,
      metrics: metrics.map((m) => ({
        name: m.name,
        value: m.value,
        step: m.step,
        epoch: m.epoch ?? null,
        // Absent means "now" — a run that does not timestamp its own metrics is taken
        // to be reporting them as it produces them.
        recordedAt: m.recorded_at ?? null,
      })),
    });

    return { written, job_id: jobId, experiment_id: experimentId };
  });
}

/** Every recorded series for one job, grouped by metric name. */
export async function getJobMetrics(pool, jobId, { name = null, sinceStep = null, limit = 2000 } = {}) {
  await assertJobExists(pool, jobId);
  const rows = await metricsRepo.listJobMetrics(pool, jobId, { name, sinceStep, limit });
  return { job_id: jobId, series: metricsRepo.toSeries(rows) };
}

/** Per-metric totals and latest value, without transferring the series. */
export async function getJobMetricSummary(pool, jobId) {
  await assertJobExists(pool, jobId);
  return { job_id: jobId, metrics: await metricsRepo.summariseJobMetrics(pool, jobId) };
}

/**
 * Every series across every job of one experiment.
 *
 * Series are keyed by metric *and* job, because two runs of the same experiment both
 * report `loss` from step 0 and merging them would produce a curve that never existed.
 */
export async function getExperimentMetrics(pool, experimentId, { name = null, limit = 2000 } = {}) {
  const experiment = await experimentsRepo.getExperimentById(pool, experimentId);
  if (!experiment) {
    throw new NotFoundError(`experiment ${experimentId} not found`);
  }

  const rows = await metricsRepo.listExperimentMetrics(pool, experimentId, { name, limit });
  return {
    experiment_id: experimentId,
    series: metricsRepo.toSeries(rows, {
      keyOf: (row) => `${row.name} ${row.job_id}`,
      extra: (row) => ({ job_id: row.job_id }),
    }),
  };
}

async function assertJobExists(pool, jobId) {
  const job = await jobsRepo.getJobById(pool, jobId);
  if (!job) {
    throw new NotFoundError(`job ${jobId} not found`);
  }
  return job;
}
