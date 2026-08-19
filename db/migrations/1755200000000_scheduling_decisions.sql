-- Up Migration
-- Phase 3: the scheduler must be able to explain itself.
--
-- `training_jobs.placement_reason` holds the one-line summary a user sees. This table
-- holds the working: every node the scheduler considered for an attempt, and why it
-- was chosen or rejected. Without it "your job is still queued" is unanswerable, which
-- is the single most common question a cluster user has (spec §12, §47).

CREATE TABLE scheduling_decisions (
    id          BIGSERIAL   PRIMARY KEY,
    job_id      UUID        NOT NULL REFERENCES training_jobs(id) ON DELETE CASCADE,
    attempt     INT         NOT NULL DEFAULT 0,

    -- The pass this decision belongs to. One scheduling attempt evaluates several
    -- nodes and writes a row per node, so the rows of one pass are read together.
    pass_id     UUID        NOT NULL,

    -- Null when the decision is about the job as a whole rather than a node — an
    -- admission refused by quota never reaches node evaluation.
    node_id     UUID        REFERENCES compute_nodes(id) ON DELETE SET NULL,
    node_name   TEXT        NOT NULL DEFAULT '',

    outcome     TEXT        NOT NULL,   -- SELECTED | VIABLE | REJECTED | NO_CAPACITY | QUOTA_EXCEEDED
    reason      TEXT        NOT NULL,

    -- What the scheduler believed at the time: free capacity, what the job asked for.
    -- Kept as JSON because it is evidence for a human, not something to query on, and
    -- because the shape will grow as the scheduler learns to consider more.
    details     JSONB       NOT NULL DEFAULT '{}',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The dominant read is "explain this job's scheduling", newest pass first.
CREATE INDEX idx_scheduling_decisions_job ON scheduling_decisions (job_id, id DESC);

-- Note there is deliberately no allocation ledger table. What a node currently holds is
-- derived from `training_jobs` (scheduled_node_id plus the resource columns, filtered to
-- the states that occupy capacity). A second table tracking the same fact would be one
-- more thing to keep in step, and the failure mode of a stale ledger — capacity the
-- scheduler believes is taken but is not, or worse, is not but is — is exactly the bug
-- the ledger would have been introduced to prevent.

-- Down Migration
DROP TABLE IF EXISTS scheduling_decisions;
