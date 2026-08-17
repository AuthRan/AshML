-- Up Migration

-- Authentication arrives in Phase 10 (spec milestone 14). Until then every request
-- acts as this fixed local user, so `projects.owner_id` can stay NOT NULL and the
-- audit trail is real rather than nullable.
--
-- The UUID is fixed so it is stable across rebuilds and can be referenced in code.
INSERT INTO users (id, email, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'local@ashml.dev', 'Local Developer')
ON CONFLICT (email) DO NOTHING;

-- Down Migration

DELETE FROM users WHERE id = '00000000-0000-0000-0000-000000000001';
