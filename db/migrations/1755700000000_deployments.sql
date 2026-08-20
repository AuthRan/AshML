-- Up Migration
-- Phase 5: what a deployment needs to be a real thing rather than a name.

-- `deployments` was created in Phase 0 as a placeholder: a project, a model, a name and
-- a status. Serving a version needs the rest of it -- which image runs, how big it is,
-- where the Kubernetes objects live, what the cluster currently reports back, and the
-- address a caller can actually reach.
ALTER TABLE deployments
    -- The serving image. Stored per deployment rather than assumed, because upgrading
    -- the inference server must not silently change what an existing deployment runs.
    ADD COLUMN image          TEXT   NOT NULL DEFAULT 'ashml/model-server:v1',

    -- Desired replicas, and what the cluster says it actually has. Keeping both is the
    -- point: a deployment asking for 3 and running 1 is neither healthy nor failed, and
    -- collapsing them into one number is how that state becomes invisible.
    ADD COLUMN replicas       INT    NOT NULL DEFAULT 1,
    ADD COLUMN ready_replicas INT    NOT NULL DEFAULT 0,

    -- Resources, in the same units the training jobs use, so one conversion exists.
    ADD COLUMN cpu            NUMERIC(6, 2) NOT NULL DEFAULT 1,
    ADD COLUMN memory_bytes   BIGINT NOT NULL DEFAULT 2147483648,
    ADD COLUMN gpu            INT    NOT NULL DEFAULT 0,

    -- The Kubernetes objects AshML created, recorded rather than recomputed from the
    -- name. The same argument as `ashml.io/job-id` on training Jobs: if the naming
    -- scheme changes later, everything already deployed must still be findable.
    ADD COLUMN k8s_name       TEXT,
    ADD COLUMN namespace      TEXT,

    -- The in-cluster address. Written when the Service exists, so a null here means
    -- "nothing is listening yet" rather than "we have not got round to filling it in".
    ADD COLUMN endpoint_url   TEXT,

    -- Why a deployment is not serving. Cleared on success, so a stale reason cannot
    -- outlive the problem it described.
    ADD COLUMN last_error     TEXT,

    ADD COLUMN updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();

-- Status is AshML's word for what the cluster shows, not Kubernetes' own:
--   PENDING     accepted, nothing created yet
--   PROGRESSING objects exist, not enough replicas are ready
--   READY       every requested replica is ready
--   DEGRADED    was READY, now short of replicas
--   FAILED      cannot proceed without intervention
--   STOPPED     deliberately scaled to nothing; the row is kept for its history
ALTER TABLE deployments
    ADD CONSTRAINT deployments_status_check
    CHECK (status IN ('PENDING', 'PROGRESSING', 'READY', 'DEGRADED', 'FAILED', 'STOPPED'));

-- A deployment serves versions through `deployment_targets`, which already carries the
-- weight column that weighted routing will need. For now a deployment has exactly one
-- target at weight 100; the router that makes more than one meaningful comes later in
-- Phase 5, and this index is what it will read.
CREATE INDEX idx_deployment_targets_deployment ON deployment_targets (deployment_id);

-- The status loop's read: every deployment that is not at rest.
CREATE INDEX idx_deployments_status ON deployments (status) WHERE status <> 'STOPPED';

-- Down Migration
DROP INDEX IF EXISTS idx_deployments_status;
DROP INDEX IF EXISTS idx_deployment_targets_deployment;
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_status_check;
ALTER TABLE deployments
    DROP COLUMN IF EXISTS image,
    DROP COLUMN IF EXISTS replicas,
    DROP COLUMN IF EXISTS ready_replicas,
    DROP COLUMN IF EXISTS cpu,
    DROP COLUMN IF EXISTS memory_bytes,
    DROP COLUMN IF EXISTS gpu,
    DROP COLUMN IF EXISTS k8s_name,
    DROP COLUMN IF EXISTS namespace,
    DROP COLUMN IF EXISTS endpoint_url,
    DROP COLUMN IF EXISTS last_error,
    DROP COLUMN IF EXISTS updated_at;
