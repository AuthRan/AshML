-- Up Migration

-- The seeded local user. Before Phase 10 every request acted as it, which is what let
-- `projects.owner_id` stay NOT NULL and the audit trail be real rather than nullable.
--
-- Since Phase 10 it is three narrower things: the principal used when
-- ASHML_AUTH_ENABLED=false, the owner backfilled onto projects that predate auth, and who
-- `make token` mints the first token for. The row is still load-bearing — its UUID is
-- referenced by `auth/install.js` and `scripts/lib/auth.mjs` — so only this comment was
-- out of date.
--
-- The UUID is fixed so it is stable across rebuilds and can be referenced in code.
INSERT INTO users (id, email, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'local@ashml.dev', 'Local Developer')
ON CONFLICT (email) DO NOTHING;

-- Down Migration

DELETE FROM users WHERE id = '00000000-0000-0000-0000-000000000001';
