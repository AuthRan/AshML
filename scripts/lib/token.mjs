/**
 * The bearer token a script talking to a *running* control plane should send.
 *
 * Distinct from `scripts/lib/auth.mjs`, and the distinction is which side of the network
 * the script is on. Scripts that build a control plane in-process (`e2e.mjs`,
 * `e2e-scheduler.mjs`) hold the database and can mint their own token; scripts that talk
 * over HTTP to a server somebody else started cannot, and must be given one.
 *
 * Absent is not an error here. A control plane running with `ASHML_AUTH_ENABLED=false`
 * accepts these calls without a credential, and refusing to start would make the scripts
 * unusable in exactly the mode they were written for. The 401 that follows against an
 * authenticated server is a better message than anything this could invent — and
 * `explainIfUnauthorized` below turns it into one that says what to do.
 */

const TOKEN = process.env.ASHML_TOKEN ?? null;

/** Merges the Authorization header into whatever the caller already sends. */
export function withToken(headers = {}) {
  return TOKEN ? { ...headers, authorization: `Bearer ${TOKEN}` } : headers;
}

export const hasToken = () => TOKEN !== null;

/**
 * Turns a 401/403 into a sentence that names the fix.
 *
 * Worth the few lines: these scripts are run by hand, often by somebody following a
 * README, and "401" on its own sends them looking at the wrong thing entirely.
 */
export function explainIfUnauthorized(status) {
  if (status !== 401 && status !== 403) return '';
  if (status === 403) {
    return '\n  This token is valid but lacks the permission. `ash whoami` shows what it carries.';
  }
  return TOKEN
    ? '\n  ASHML_TOKEN is set but the control plane rejected it — wrong endpoint, or revoked.'
    : '\n  The API is default-deny. Run: export ASHML_TOKEN=$(make -s token)';
}
