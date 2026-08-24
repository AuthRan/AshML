/**
 * A working token for a script that builds a control plane in-process.
 *
 * The end-to-end scripts are evidence, so they run against the same default-deny server a
 * user gets rather than switching authentication off — a script that proves the platform
 * works with the security removed proves less than it looks like it does. This is the one
 * line that costs.
 *
 * It writes the token straight to the database for the same reason
 * `scripts/issue-token.mjs` does: the first token cannot come from an API that needs one,
 * and these scripts already hold database credentials.
 */

import { mintToken, TokenKind } from '../../packages/server/src/auth/tokens.js';

/** The seeded local administrator (migration 1755000100000). */
const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Mints a token and wraps `app.inject` so every call carries it.
 *
 * Merges headers rather than replacing them, so a script that deliberately sends its own
 * Authorization header — to check a refusal — still overrides this.
 */
export async function authenticate(app, { name = 'e2e' } = {}) {
  const { token, hash, prefix } = mintToken(TokenKind.USER);

  await app.db.query(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, name)
       DO UPDATE SET token_hash = EXCLUDED.token_hash,
                     prefix     = EXCLUDED.prefix,
                     revoked_at = NULL`,
    [LOCAL_USER_ID, name, hash, prefix],
  );

  const raw = app.inject.bind(app);
  app.inject = (options, ...rest) => raw(
    { ...options, headers: { authorization: `Bearer ${token}`, ...(options?.headers ?? {}) } },
    ...rest,
  );

  return token;
}
