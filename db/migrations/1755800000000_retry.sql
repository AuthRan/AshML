-- Up Migration
-- Phase 5: recording what was decided about retrying a failed job.

-- `attempt` and `max_retries` have existed since Phase 0 and nothing drove them. Driving
-- them needs one more thing: a record that the decision was *made*.
--
-- Without it the executor has no way to tell "this failed job has not been considered
-- for retry yet" from "this failed job was considered and deliberately left alone", so
-- every pass would reconsider every failed job the platform has ever run — writing an
-- identical "not retrying" event every two seconds, forever.
ALTER TABLE training_jobs
    -- The verdict: RETRY, PERMANENT, EXHAUSTED. Kept after the retry has been issued,
    -- so `ash job get` can say why a job did or did not run again without replaying the
    -- event log.
    ADD COLUMN retry_decision      TEXT,
    ADD COLUMN retry_decided_at    TIMESTAMPTZ,

    -- The artifact the next attempt should resume from, chosen when the retry is issued
    -- rather than when the pod starts. A container that picked its own checkpoint could
    -- pick a different one on each restart, and two attempts of the same job would then
    -- not be describing the same run.
    ADD COLUMN resume_artifact_id  UUID REFERENCES artifacts(id) ON DELETE SET NULL;

-- The executor's read: failed jobs nobody has ruled on yet. Partial, because the
-- overwhelming majority of rows are in some other state and none of them belong here.
CREATE INDEX idx_jobs_awaiting_retry_decision
    ON training_jobs (finished_at)
    WHERE state = 'FAILED' AND retry_decided_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_jobs_awaiting_retry_decision;
ALTER TABLE training_jobs
    DROP COLUMN IF EXISTS retry_decision,
    DROP COLUMN IF EXISTS retry_decided_at,
    DROP COLUMN IF EXISTS resume_artifact_id;
