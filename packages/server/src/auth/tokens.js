/**
 * Minting and hashing bearer tokens.
 *
 * Pure apart from the CSPRNG, so the hashing half is exhaustively testable and the
 * random half has one call site.
 *
 * **Tokens are looked up by hash, never compared.** That is worth stating because the
 * usual advice for comparing secrets is `timingSafeEqual`, and following it here would be
 * a sign the design is wrong: it implies fetching a candidate row and then checking it,
 * which means something else selected that row — a user id, a prefix — and that selector
 * is now the real credential. Hashing the presented token and using the hash as the
 * primary lookup key removes the comparison entirely. The index does constant work per
 * probe and there is no branch to time.
 *
 * SHA-256 rather than bcrypt/argon2, deliberately. Those exist to make *low-entropy*
 * secrets expensive to guess; these tokens are 256 bits from `randomBytes`, so there is
 * nothing to brute-force and the only thing a slow KDF would buy is a slow hash on the
 * hot path of every authenticated request.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * How a token announces what it is.
 *
 * Distinct prefixes are not decoration. They let a leaked string be identified on sight
 * — in a log, a pasted traceback, a public commit — and they let the server reject a run
 * token presented to a human endpoint before it has touched the database.
 */
export const TokenKind = Object.freeze({
  USER: { prefix: 'ashml_u_', label: 'user' },
  /**
   * A pod's own credential — a training attempt or a model server.
   *
   * One prefix for both because the distinction is not the holder's business: what the
   * token may do is decided from the row it resolves to, and a pod has no reason to be
   * able to tell from the string whether it is a RUN or a SERVING credential.
   */
  WORKLOAD: { prefix: 'ashml_w_', label: 'workload' },
});

/** 32 bytes = 256 bits. base64url so the token is copy-pasteable and shell-safe. */
const ENTROPY_BYTES = 32;

/** How much of the plaintext is kept in the clear, for display only. */
const DISPLAY_PREFIX_LENGTH = 12;

/**
 * Creates a new token.
 *
 * The plaintext is returned exactly once, to the caller that minted it. Nothing stores
 * it: `hash` is what goes in the database, and there is no path back.
 *
 * @param {object} kind one of TokenKind
 * @returns {{token: string, hash: string, prefix: string}}
 */
export function mintToken(kind) {
  const token = kind.prefix + randomBytes(ENTROPY_BYTES).toString('base64url');
  return { token, hash: hashToken(token), prefix: token.slice(0, DISPLAY_PREFIX_LENGTH) };
}

/** The stored form of a token. */
export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Pulls a bearer token out of an Authorization header.
 *
 * Returns null for anything that is not exactly one `Bearer <token>` — a missing header,
 * a different scheme, an empty value. Callers treat null as unauthenticated rather than
 * as an error, because "no credentials" and "bad credentials" are the same 401 and
 * distinguishing them in the response tells an attacker which half to fix.
 */
export function parseBearer(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Which kind a presented token claims to be, by its prefix. Null if it claims nothing. */
export function kindOf(token) {
  if (typeof token !== 'string') return null;
  for (const kind of Object.values(TokenKind)) {
    if (token.startsWith(kind.prefix)) return kind;
  }
  return null;
}
