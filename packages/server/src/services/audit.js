/**
 * The authorization audit trail: a record of who was refused what.
 *
 * ## Buffered, and why that is not an optimisation
 *
 * A denial is written by the request that was denied. Doing that inline would mean an
 * INSERT on the path of every refusal — which is to say, on the path a caller controls
 * the rate of. The rate limiter installed in the same phase exists to stop an
 * unauthenticated caller turning packets into database work; an audit that writes a row
 * per refusal would hand the same amplifier back to anyone holding one valid token, which
 * is a strictly easier bar. So denials go into a bounded buffer, flush on a timer in one
 * batch, and never block the response.
 *
 * The buffer is bounded and overflow is *dropped*, not queued. That direction is chosen:
 * an audit that grows without limit under load is a memory leak that fires exactly when
 * the platform is already in trouble, and the honest failure is a gap in the record with
 * a counter saying how large it is (`ashml_audit_dropped_total`). This is the same trade
 * the training SDK makes with metrics, for the same reason — the record is worth a great
 * deal, and never worth the process it is recorded by.
 *
 * ## What is in here, and what is deliberately not
 *
 * Refusals of a **known** principal. A 401 has no principal: what it has is an address
 * and a token prefix, and no ceiling on how many a stranger can produce. Those are
 * counted (`ashml_auth_failures_total`) and logged, not stored — see the migration for
 * the full reasoning.
 *
 * ## Where a denial is detected
 *
 * At the decision, not at the response. `resolveProject` answers **404** when a caller
 * may not see a project, on purpose, so that project names cannot be enumerated — which
 * makes the status code an unreliable narrator about authorization and would make a
 * hook that records "every 403" blind to the probing it exists to catch. So the services
 * that refuse attach a `denial` descriptor to the error they throw (`describeDenial`),
 * and the error handler in `app.js` — the one funnel every error already passes through —
 * turns it into a row.
 */

import { withTransaction } from '../db/pool.js';
import * as auditRepo from '../repos/audit.js';
import { PrincipalKind } from '../domain/roles.js';

/**
 * Attaches the facts of a refusal to the error carrying it.
 *
 * Called at the throw site, where the permission and the project are still known. The
 * error handler adds the request's half — method, route, address, what the caller was
 * actually told — because that is what it can see and the service cannot.
 *
 * @param {Error} err the error about to be thrown
 * @param {object} denial
 * @param {string} denial.permission what was asked for
 * @param {string} [denial.projectId]
 * @param {string} [denial.projectName]
 * @returns {Error} the same error, for `throw describeDenial(err, ...)`
 */
export function describeDenial(err, denial) {
  err.denial = denial;
  return err;
}

/** The subject line of an audit row: who this was, in a form that still reads later. */
function subjectOf(principal) {
  switch (principal?.kind) {
    case PrincipalKind.USER: return principal.email ?? principal.userId;
    case PrincipalKind.RUN: return `run ${principal.jobId} attempt ${principal.attempt}`;
    case PrincipalKind.SERVING: return `deployment ${principal.deploymentId}`;
    default: return 'unknown';
  }
}

/**
 * A buffered writer for `authz_denials`.
 *
 * One per app. `record` is synchronous and never throws; everything that can fail happens
 * in `flush`, off the request.
 */
export class AuditLog {
  #buffer = [];
  #capacity;
  #dropped = 0;
  #pool;
  #logger;
  #metrics;
  #timer = null;
  #flushing = null;

  /**
   * @param {import('pg').Pool} pool
   * @param {object} [options]
   * @param {number} [options.capacity] rows held before overflow is dropped
   * @param {number} [options.intervalMs] how often the buffer is drained
   * @param {object} [options.logger]
   * @param {object} [options.metrics]
   */
  constructor(pool, { capacity = 1000, intervalMs = 2000, logger = null, metrics = null } = {}) {
    this.#pool = pool;
    this.#capacity = capacity;
    this.#logger = logger;
    this.#metrics = metrics;
    this.intervalMs = intervalMs;
  }

  get pending() { return this.#buffer.length; }

  get dropped() { return this.#dropped; }

  /**
   * Buffers one denial. Never throws, never awaits.
   *
   * @param {object} event
   * @param {object} event.principal who was refused
   * @param {object} event.denial from `describeDenial`
   * @param {object} event.request `{ method, route, requestId, remoteAddr }`
   * @param {number} event.status what the caller was told
   */
  record({ principal, denial, request, status }) {
    if (this.#buffer.length >= this.#capacity) {
      this.#dropped += 1;
      this.#metrics?.auditDropped?.inc();
      return;
    }

    this.#buffer.push({
      occurred_at: new Date(),
      principal: principal?.kind ?? 'USER',
      user_id: principal?.userId ?? null,
      job_id: principal?.jobId ?? null,
      deployment_id: principal?.deploymentId ?? null,
      subject: subjectOf(principal),
      permission: denial.permission,
      project_id: denial.projectId ?? null,
      project_name: denial.projectName ?? null,
      method: request.method,
      route: request.route,
      status,
      request_id: request.requestId ?? null,
      remote_addr: request.remoteAddr ?? null,
    });

    this.#metrics?.authzDenials?.inc({ permission: denial.permission, status: String(status) });
  }

  /**
   * Writes everything buffered.
   *
   * A failure puts nothing back. The rows are already gone from the buffer by the time
   * the INSERT runs, and re-queueing them would mean a database that is down converts
   * into a buffer that never drains — the unbounded growth this class exists to avoid,
   * arriving by the retry path instead of the arrival path. They are counted as dropped
   * and the reason is logged, which is the whole of the promise this makes.
   *
   * Concurrent calls share one flush: the timer and `close()` can both fire at once, and
   * two overlapping drains would interleave batches for no benefit.
   */
  async flush() {
    if (this.#flushing) return this.#flushing;
    if (this.#buffer.length === 0) return 0;

    const batch = this.#buffer;
    this.#buffer = [];

    this.#flushing = withTransaction(this.#pool, (client) =>
      auditRepo.insertDenials(client, batch))
      .catch((err) => {
        this.#dropped += batch.length;
        this.#metrics?.auditDropped?.inc(batch.length);
        this.#logger?.error?.(
          { err, dropped: batch.length },
          'could not write the authorization audit trail',
        );
        return 0;
      })
      .finally(() => { this.#flushing = null; });

    return this.#flushing;
  }

  /** Starts the drain timer. `unref` so it never holds the process open. */
  start() {
    if (this.#timer) return this;
    this.#timer = setInterval(() => { this.flush(); }, this.intervalMs);
    this.#timer.unref();
    return this;
  }

  /** Stops the timer and writes what is left. */
  async close() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.flush();
  }
}

// ---- reading it back -------------------------------------------------------------

export async function listDenials(pool, filter) {
  return auditRepo.listDenials(pool, filter);
}

export async function summariseDenials(pool, options) {
  return auditRepo.summariseDenials(pool, options);
}
