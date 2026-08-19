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

/** Postgres unique-violation SQLSTATE, the race-safe way to detect a duplicate. */
export const UNIQUE_VIOLATION = '23505';
