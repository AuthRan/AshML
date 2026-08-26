/**
 * How long a personal API token is allowed to live.
 *
 * Pure, like `quota.js` and for the same reason: this is a rule a user argues with, so it
 * has to be reproducible and it has to show its arithmetic.
 *
 * The gap this closes was recorded in the roadmap as "tokens *can* be given an expiry;
 * nothing requires one" — and the second half is the part that mattered. A ceiling on its
 * own does nothing for the token whose creator never thought about expiry at all, which
 * is every token created by a script, and the ones that end up in a CI secret store and
 * outlive the person who made them. So the policy is two rules and not one: a maximum,
 * *and* a default equal to it. There is no way to mint a personal token with no end.
 *
 * **A request over the ceiling is refused, not quietly shortened.** Clamping looks
 * friendlier and is the worse failure: somebody who asks for a year and is silently given
 * ninety days plans around a year, and finds out when a pipeline that has worked for
 * three months starts returning 401 with no change to explain it. A refusal that names
 * the ceiling costs one retry and no surprises.
 *
 * **Tokens that already exist are not touched.** This governs minting. Applying a new
 * ceiling retroactively would revoke working credentials as a side effect of editing a
 * config file, which is the kind of change that gets a security policy switched off.
 *
 * What this is *not* is rotation. Nothing here replaces a token before it dies; that is
 * `ash token create` followed by `ash token revoke`, and it stays a decision a person
 * makes. What the policy guarantees is that the decision cannot be postponed forever.
 */

/**
 * Ninety days: long enough that rotating is an occasional chore rather than a weekly one,
 * short enough that a token leaked into a log or a shell history stops working inside a
 * quarter. The number is a convention rather than a derivation, and the point is that
 * there *is* one — an unset ceiling is what this exists to remove.
 */
export const DEFAULT_MAX_TTL_DAYS = 90;

/** The refusal, named so a caller can branch on it rather than on the message. */
export const TOKEN_TTL_TOO_LONG = 'TOKEN_TTL_TOO_LONG';

/**
 * Works out when a token being minted now should stop working.
 *
 * @param {object} options
 * @param {number|null} [options.requestedDays] what the caller asked for, if anything
 * @param {number|null} [options.maxDays] the ceiling; null means there is no policy
 * @param {number} [options.now] epoch milliseconds, injected so tests do not race a clock
 * @returns {{allowed: boolean, expiresAt: Date|null, defaulted: boolean,
 *   code?: string, reason?: string}}
 */
export function resolveTokenLifetime({ requestedDays = null, maxDays = null, now = Date.now() } = {}) {
  const at = (days) => new Date(now + days * 86_400_000);

  // No policy configured. The caller's wish is the whole rule, including the wish for a
  // token that never expires — which is the behaviour every token had before this module,
  // and is available by saying so rather than by leaving a variable unset.
  if (maxDays === null) {
    return {
      allowed: true,
      expiresAt: requestedDays === null ? null : at(requestedDays),
      defaulted: false,
    };
  }

  if (requestedDays === null) {
    return { allowed: true, expiresAt: at(maxDays), defaulted: true };
  }

  if (requestedDays > maxDays) {
    return {
      allowed: false,
      expiresAt: null,
      defaulted: false,
      code: TOKEN_TTL_TOO_LONG,
      reason:
        `a token may live at most ${maxDays} day${maxDays === 1 ? '' : 's'} on this `
        + `platform, and ${requestedDays} were asked for. Ask for ${maxDays} or fewer, or `
        + 'raise ASHML_TOKEN_MAX_TTL_DAYS.',
    };
  }

  return { allowed: true, expiresAt: at(requestedDays), defaulted: false };
}
