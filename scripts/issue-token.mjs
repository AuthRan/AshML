#!/usr/bin/env node
/**
 * Issues an API token by writing directly to the database.
 *
 * This exists because of a chicken and egg: `POST /api/v1/auth/tokens` needs a token, so
 * the *first* one cannot come from the API. Something has to be able to mint one out of
 * band, and the question is only what that something should require.
 *
 * The answer here is database credentials. That is a real boundary — whoever has them can
 * already read and change every row this platform owns, so being able to mint a token
 * grants nothing they did not have. The alternative most projects reach for, an
 * `ASHML_BOOTSTRAP_TOKEN` environment variable accepted by the API, is worse in a
 * specific way: it is a credential that works over the network, that tends to be set once
 * and never rotated, and that is invisible in `ash token list` because it is not a row.
 *
 *   node scripts/issue-token.mjs --user local@ashml.dev --name laptop
 *   node scripts/issue-token.mjs --user someone@example.com --create --admin
 *
 * The token is printed on stdout and nothing else is, so it can be piped:
 *
 *   export ASHML_TOKEN=$(node scripts/issue-token.mjs --user local@ashml.dev --name ci)
 */

import { parseArgs } from 'node:util';

import pg from 'pg';

import { mintToken, TokenKind } from '../packages/server/src/auth/tokens.js';
import { loadConfig } from '../packages/server/src/config.js';
import { resolveTokenLifetime } from '../packages/server/src/domain/token-lifetime.js';

const { values } = parseArgs({
  options: {
    user: { type: 'string' },
    name: { type: 'string', default: 'bootstrap' },
    create: { type: 'boolean', default: false },
    admin: { type: 'boolean', default: false },
    'expires-in': { type: 'string' },
    database: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || !values.user) {
  console.error(`usage: node scripts/issue-token.mjs --user <email> [options]

  --user <email>       who the token is for (required)
  --name <name>        what it is for; unique per user   (default: bootstrap)
  --create             create the user if they do not exist
  --admin              with --create, make them a platform administrator
  --expires-in <days>  expire after N days       (default: the platform maximum)
  --database <url>     overrides ASHML_DATABASE_URL

Prints the token on stdout. It is shown once; nothing stores the plaintext.`);
  process.exit(values.help ? 0 : 2);
}

const connectionString = values.database
  ?? process.env.ASHML_DATABASE_URL
  ?? 'postgresql://ashml:ashml@127.0.0.1:5432/ashml';

const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });

try {
  let { rows } = await pool.query('SELECT id, is_admin FROM users WHERE email = $1', [values.user]);

  if (!rows.length) {
    if (!values.create) {
      console.error(
        `no user with email "${values.user}". Pass --create to make one, or check the address.`,
      );
      process.exit(1);
    }
    ({ rows } = await pool.query(
      `INSERT INTO users (email, display_name, is_admin) VALUES ($1, $1, $2)
       RETURNING id, is_admin`,
      [values.user, values.admin],
    ));
    console.error(`created user ${values.user}${values.admin ? ' (platform administrator)' : ''}`);
  } else if (values.admin && !rows[0].is_admin) {
    // Only ever grants, never revokes: taking admin away is not something a token-issuing
    // script should do as a side effect of somebody omitting a flag.
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [rows[0].id]);
    console.error(`${values.user} is now a platform administrator`);
  }

  const userId = rows[0].id;
  const { token, hash, prefix } = mintToken(TokenKind.USER);

  // The same ceiling the API applies, and deliberately so. This script writes straight to
  // the table, so it is the one path that could quietly mint the never-expiring token —
  // and it issues the *first* token on every cluster, which is the one most likely to end
  // up in somebody's shell profile and be forgotten. A bootstrap credential exempt from
  // the platform's own lifetime policy would be the longest-lived token in the system.
  const requested = values['expires-in'] ? Number(values['expires-in']) : null;
  if (requested !== null && (!Number.isInteger(requested) || requested < 1)) {
    console.error(`--expires-in "${values['expires-in']}": want a whole number of days`);
    process.exit(2);
  }
  const lifetime = resolveTokenLifetime({
    requestedDays: requested,
    maxDays: loadConfig().tokenMaxTtlDays,
  });
  if (!lifetime.allowed) {
    console.error(lifetime.reason);
    process.exit(2);
  }
  const { expiresAt } = lifetime;

  await pool.query(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, name) DO UPDATE
       SET token_hash = EXCLUDED.token_hash,
           prefix     = EXCLUDED.prefix,
           expires_at = EXCLUDED.expires_at,
           created_at = now(),
           revoked_at = NULL`,
    [userId, values.name, hash, prefix, expiresAt],
  );

  // Everything explanatory goes to stderr so stdout is exactly the token.
  // The expiry is stated rather than left to be discovered. A token that stops working in
  // ninety days is fine; one that stops working in ninety days without anyone having been
  // told is an outage with no cause anybody can find.
  const until = expiresAt
    ? `It expires ${expiresAt.toISOString().slice(0, 10)}`
      + `${lifetime.defaulted ? ' (the platform maximum; --expires-in sets a shorter one)' : ''}.`
    : 'It does not expire (ASHML_TOKEN_MAX_TTL_DAYS=none).';
  console.error(`token "${values.name}" issued for ${values.user}. It is shown once. ${until}`);
  console.log(token);
} finally {
  await pool.end();
}
