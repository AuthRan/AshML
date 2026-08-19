-- Up Migration
-- Phase 4: training metrics, and the reproducibility fields a run reports about itself.

-- Metrics arrive from inside the training container, many times a run.
--
-- Stored long (one row per name/value) rather than wide (a column per metric): the set
-- of metrics is chosen by the training script, not by this schema, and a wide table
-- would need a migration every time someone logged a new one.
CREATE TABLE training_metrics (
    id            BIGSERIAL   PRIMARY KEY,
    job_id        UUID        NOT NULL REFERENCES training_jobs(id) ON DELETE CASCADE,
    experiment_id UUID        REFERENCES experiments(id) ON DELETE SET NULL,

    -- `step` is the training step; `epoch` is optional because not every workload has
    -- epochs. Both are reported by the run, never inferred here.
    step          INT         NOT NULL,
    epoch         INT,

    name          TEXT        NOT NULL,
    value         DOUBLE PRECISION NOT NULL,

    -- When the training process observed it, not when the API received it. A run that
    -- buffers metrics and flushes them in a batch would otherwise have its whole
    -- history collapse onto the moment of the flush.
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The dominant read is "this metric over the course of this run".
CREATE INDEX idx_training_metrics_series ON training_metrics (job_id, name, step);

-- And "everything about this experiment", for comparing runs.
CREATE INDEX idx_training_metrics_experiment ON training_metrics (experiment_id, name, step)
    WHERE experiment_id IS NOT NULL;

-- A run reports what it actually did, which is not always what was requested.
--
-- `experiments` already carries what was *asked for* — the pinned dataset version, the
-- hyperparameters, the seed. These columns carry what the run *observed*: the image it
-- actually ran, the hardware it actually got. A reproducibility record built only from
-- intent is a wish; one built only from observation cannot be re-requested. Both halves
-- are needed (spec §34).
ALTER TABLE experiments
    ADD COLUMN framework      TEXT NOT NULL DEFAULT '',
    ADD COLUMN hardware       JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN sdk_version    TEXT NOT NULL DEFAULT '';

-- Artifacts gain the fields a checkpoint needs to be found and trusted again.
ALTER TABLE artifacts
    ADD COLUMN experiment_id UUID REFERENCES experiments(id) ON DELETE SET NULL,
    ADD COLUMN name          TEXT NOT NULL DEFAULT '',
    ADD COLUMN step          INT,
    ADD COLUMN metadata      JSONB NOT NULL DEFAULT '{}',
    -- PENDING until the upload is confirmed. An artifact row written before the bytes
    -- land would otherwise point at a URI that holds nothing, and "the checkpoint is
    -- registered" would stop meaning "the checkpoint exists".
    ADD COLUMN status        TEXT NOT NULL DEFAULT 'READY';

CREATE INDEX idx_artifacts_job ON artifacts (job_id, created_at);

-- Model versions gain the lifecycle the registry needs (spec §16).
ALTER TABLE model_versions
    ADD COLUMN description TEXT NOT NULL DEFAULT '',
    ADD COLUMN promoted_at TIMESTAMPTZ,
    ADD COLUMN job_id      UUID REFERENCES training_jobs(id) ON DELETE SET NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_artifacts_job;
ALTER TABLE model_versions
    DROP COLUMN IF EXISTS description,
    DROP COLUMN IF EXISTS promoted_at,
    DROP COLUMN IF EXISTS job_id;
ALTER TABLE artifacts
    DROP COLUMN IF EXISTS experiment_id,
    DROP COLUMN IF EXISTS name,
    DROP COLUMN IF EXISTS step,
    DROP COLUMN IF EXISTS metadata,
    DROP COLUMN IF EXISTS status;
ALTER TABLE experiments
    DROP COLUMN IF EXISTS framework,
    DROP COLUMN IF EXISTS hardware,
    DROP COLUMN IF EXISTS sdk_version;
DROP TABLE IF EXISTS training_metrics;
