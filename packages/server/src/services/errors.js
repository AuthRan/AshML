/**
 * Service-layer errors, shared by every service.
 *
 * Each carries `code` and `statusCode`, which is all the route layer needs: the error
 * handler in app.js turns any thrown error into the single error envelope of spec §45
 * without the routes having to catch anything.
 */

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
    this.statusCode = 404;
  }
}

export class ConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConflictError';
    this.code = code;
    this.statusCode = 409;
  }
}

/** A request that is well-formed but asks for something incoherent. */
export class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.statusCode = 400;
  }
}

/**
 * 429: the caller is who they say they are and may do this — just not this often.
 *
 * Deliberately not a 403. The difference matters to a client library, which should back
 * off and retry a 429 and must not retry a 403, and it matters to whoever reads the log:
 * one says the credential is wrong, the other says the loop is.
 */
export class RateLimitedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitedError';
    this.code = 'RATE_LIMITED';
    this.statusCode = 429;
  }
}

/** Postgres unique-violation SQLSTATE, the race-safe way to detect a duplicate. */
export const UNIQUE_VIOLATION = '23505';

/**
 * A failure that came back from something AshML called, rather than from AshML.
 *
 * The status is chosen by the caller because there is no single right one: a model
 * server refusing a malformed batch is the requester's 400, a model server with no
 * weights loaded is a 503 about the deployment, and a proxy that could not reach
 * anything is a 502. What they share is that the message was written for the person
 * reading it and is safe to send — hence `expose`, which the error handler honours for
 * statuses it would otherwise mask. Nothing about an upstream's answer is an internal
 * detail of this process.
 */
export class UpstreamError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.statusCode = statusCode;
    this.expose = true;
  }
}
