-- Up Migration
-- Collapse repeated identical scheduling refusals.
--
-- The executor re-evaluates every queued job on each pass. A job that cannot currently
-- be placed — one asking for a GPU on a cluster with no device plugin — is therefore
-- refused for the same reason, by the same nodes, every couple of seconds, forever. At
-- the default interval that is tens of thousands of identical rows a day for a single
-- stuck job, and an audit trail nobody can read is not an audit trail.
--
-- Identical consecutive passes are now folded into the pass that came before, keeping
-- the count and the time it was last seen. That loses nothing: "refused for this reason
-- 900 times between 09:00 and 09:30" is strictly more useful than 900 rows saying it
-- once each, and the moment the reason changes a new pass is recorded as normal.
ALTER TABLE scheduling_decisions
    ADD COLUMN repeat_count INT         NOT NULL DEFAULT 1,
    ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN scheduling_decisions.repeat_count IS
    'How many consecutive passes reached this same verdict. created_at is the first, '
    'last_seen_at the most recent.';

-- Down Migration
ALTER TABLE scheduling_decisions
    DROP COLUMN IF EXISTS repeat_count,
    DROP COLUMN IF EXISTS last_seen_at;
