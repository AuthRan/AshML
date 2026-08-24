/**
 * Token buckets: how many requests a caller may make, and what to tell them when they
 * may not.
 *
 * Pure in the same sense as `quota.js` — no database, no request, and no clock. The
 * clock is the interesting one: a limiter that reads `Date.now()` itself can only be
 * tested by sleeping, which makes the tests slow *and* flaky, and the arithmetic that
 * decides a refusal is exactly the arithmetic worth pinning down. So `now` is an
 * argument to every method, the HTTP layer passes `Date.now()`, and the test passes
 * whatever moment it wants to talk about.
 *
 * ## Why a token bucket
 *
 * The obvious alternative, a fixed window, has a failure that shows up immediately in
 * practice: a caller who spends their whole minute at 11:59:59 gets a fresh minute one
 * second later, so the real short-term ceiling is twice the configured one, arriving in
 * a burst at the boundary. A bucket that refills continuously has no boundary to stand
 * on. It costs two numbers per key and one multiply per request.
 *
 * Capacity equals the limit, so a caller who has been quiet may spend a whole minute's
 * budget at once and then proceeds at the sustained rate. That is deliberate: the client
 * this protects against is a loop, and the client it must not break is a script that
 * makes a few hundred calls and stops — `make bench` is precisely that.
 */

/**
 * What a limiter decided, in the shape the response headers need.
 *
 * @typedef {object} Decision
 * @property {boolean} allowed
 * @property {number} limit requests per window
 * @property {number} remaining whole requests left, after this one
 * @property {number} resetSeconds until the budget is fully restored
 * @property {number} retryAfterSeconds until one request is affordable; 0 when allowed
 */

export class RateLimiter {
  #limit;
  #windowMs;
  #maxKeys;
  #perMs;
  /** key -> `{ tokens, at }`. Insertion order is maintained as least-recently-used. */
  #buckets = new Map();

  /**
   * @param {object} options
   * @param {number} options.limit requests allowed per window, and the burst capacity
   * @param {number} options.windowMs how long the window is
   * @param {number} [options.maxKeys] how many distinct callers to remember — see `#store`
   */
  constructor({ limit, windowMs, maxKeys = 10_000 }) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`rate limit must be a positive integer, got ${limit}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`rate limit window must be a positive number of ms, got ${windowMs}`);
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new Error(`maxKeys must be a positive integer, got ${maxKeys}`);
    }

    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#maxKeys = maxKeys;
    this.#perMs = limit / windowMs;
  }

  get limit() { return this.#limit; }

  get windowMs() { return this.#windowMs; }

  /** How many callers are currently remembered. Exported as a gauge. */
  get size() { return this.#buckets.size; }

  /**
   * Spends one request against `key`, if there is one to spend.
   *
   * A refused request still writes the bucket back. It has not been charged — the token
   * count is unchanged — but the refill is banked, so the arithmetic stays the same
   * whether a blocked caller keeps knocking or goes quiet. Charging refusals instead
   * would mean a caller in a retry loop never recovers, which turns a rate limit into a
   * ban nobody chose.
   */
  take(key, now) {
    const available = this.#level(key, now);
    const allowed = available >= 1;
    const left = allowed ? available - 1 : available;
    this.#store(key, left, now);
    return this.#describe(allowed, left);
  }

  /**
   * What `take` would decide, without deciding it.
   *
   * This is what lets the anonymous limiter refuse a request *before* the token lookup
   * it exists to protect: the check is a peek, and the charge happens later, once the
   * credential is known to have been bad.
   */
  peek(key, now) {
    const available = this.#level(key, now);
    return this.#describe(available >= 1, available);
  }

  /**
   * Forgets every caller whose budget has fully refilled.
   *
   * A bucket at the limit holds no information — it is indistinguishable from a caller
   * never seen before — so dropping it forfeits nothing and is the whole of routine
   * cleanup. Called on a timer by the HTTP layer.
   *
   * @returns {number} how many were dropped
   */
  sweep(now) {
    let dropped = 0;
    for (const [key, bucket] of this.#buckets) {
      if (this.#tokensAt(bucket, now) >= this.#limit) {
        this.#buckets.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Forgets everyone. For tests, and for nothing else. */
  reset() {
    this.#buckets.clear();
  }

  #tokensAt(bucket, now) {
    // `now` can be older than `at` if the clock stepped backwards. Clamping the elapsed
    // time at zero means a backwards step withholds refill for a moment rather than
    // subtracting tokens a caller already had.
    const elapsed = Math.max(0, now - bucket.at);
    return Math.min(this.#limit, bucket.tokens + elapsed * this.#perMs);
  }

  #level(key, now) {
    const bucket = this.#buckets.get(key);
    return bucket === undefined ? this.#limit : this.#tokensAt(bucket, now);
  }

  /**
   * Writes a bucket back, keeping the map bounded.
   *
   * Delete-then-set puts the key at the end of the Map's iteration order, which makes
   * the front of that order the least recently used. Overflow therefore evicts in O(1)
   * from the front, and the timed `sweep` keeps the map far from the cap under any
   * normal load.
   *
   * Worth stating plainly, because it is the limitation of any in-process limiter: an
   * attacker who can vary their key faster than `maxKeys` can hold — a botnet, or a
   * proxy header this server was told to trust — evicts their own throttled entries and
   * escapes. What that costs is bounded (each evicted key starts over at the limit, so
   * the ceiling is one burst per eviction), and the fix is a shared counter in Postgres
   * or Redis, which v1 does not have. The default cap is set high enough that ordinary
   * traffic never reaches it.
   */
  #store(key, tokens, now) {
    this.#buckets.delete(key);
    this.#buckets.set(key, { tokens, at: now });

    if (this.#buckets.size > this.#maxKeys) {
      const oldest = this.#buckets.keys().next();
      if (!oldest.done) this.#buckets.delete(oldest.value);
    }
  }

  #describe(allowed, tokens) {
    const missing = this.#limit - tokens;
    return {
      allowed,
      limit: this.#limit,
      // Floored: a caller with 0.9 of a request cannot make one, and reporting "1" would
      // be an invitation to a 429.
      remaining: Math.max(0, Math.floor(tokens)),
      // Seconds until the whole budget is back. Zero only when nothing was spent.
      resetSeconds: Math.ceil(missing / this.#perMs / 1000),
      // Seconds until one request is affordable. At least 1, because `Retry-After: 0`
      // reads to a client as "immediately", which is the one answer that is wrong here.
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((1 - tokens) / this.#perMs / 1000)),
    };
  }
}
