-- Up Migration
-- AshML control-plane schema, initial revision.
-- Large binaries never live here; artifacts store a URI + digest (ADR 0001).

CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT        NOT NULL UNIQUE,
    display_name TEXT       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    description TEXT        NOT NULL DEFAULT '',
    owner_id    UUID        NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Quotas are enforced at admission, before any Kubernetes object exists (ADR 0003).
CREATE TABLE resource_quotas (
    project_id   UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    gpu_limit    INT    NOT NULL DEFAULT 0,
    cpu_limit    INT    NOT NULL DEFAULT 0,
    memory_bytes BIGINT NOT NULL DEFAULT 0,
    job_limit    INT    NOT NULL DEFAULT 0
);

CREATE TABLE datasets (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE TABLE dataset_versions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id UUID        NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    version    TEXT        NOT NULL,
    uri        TEXT        NOT NULL,
    digest     TEXT        NOT NULL DEFAULT '',
    size_bytes BIGINT      NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, version)
);

-- Everything needed to rerun a training run byte-for-byte (spec §34).
CREATE TABLE experiments (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id         UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name               TEXT        NOT NULL,
    git_commit         TEXT        NOT NULL DEFAULT '',
    image_digest       TEXT        NOT NULL DEFAULT '',
    dataset_version_id UUID        REFERENCES dataset_versions(id),
    hyperparameters    JSONB       NOT NULL DEFAULT '{}',
    random_seed        BIGINT,
    started_at         TIMESTAMPTZ,
    ended_at           TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE compute_nodes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT        NOT NULL UNIQUE,
    cpu_cores     INT         NOT NULL DEFAULT 0,
    memory_bytes  BIGINT      NOT NULL DEFAULT 0,
    ready         BOOLEAN     NOT NULL DEFAULT false,
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Populated by gpu.Provider (ADR 0005). `simulated` must survive to the API response.
CREATE TABLE gpu_devices (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id            UUID        NOT NULL REFERENCES compute_nodes(id) ON DELETE CASCADE,
    provider           TEXT        NOT NULL,
    device_index       INT         NOT NULL,
    uuid               TEXT        NOT NULL UNIQUE,
    model              TEXT        NOT NULL,
    memory_total_bytes BIGINT      NOT NULL DEFAULT 0,
    memory_used_bytes  BIGINT      NOT NULL DEFAULT 0,
    utilization_pct    INT         NOT NULL DEFAULT 0,
    temperature_c      INT         NOT NULL DEFAULT 0,
    power_watts        REAL        NOT NULL DEFAULT 0,
    health             TEXT        NOT NULL DEFAULT 'UNKNOWN',
    simulated          BOOLEAN     NOT NULL DEFAULT false,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (node_id, device_index)
);

CREATE TABLE training_jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    experiment_id UUID        REFERENCES experiments(id),
    name          TEXT        NOT NULL,
    state         TEXT        NOT NULL,
    priority      TEXT        NOT NULL DEFAULT 'MEDIUM',
    spec          JSONB       NOT NULL,

    cpu_request     INT    NOT NULL DEFAULT 0,
    memory_request  BIGINT NOT NULL DEFAULT 0,
    gpu_request     INT    NOT NULL DEFAULT 0,
    gpu_memory_min  BIGINT NOT NULL DEFAULT 0,

    -- Written only by the scheduler.
    scheduled_node_id UUID REFERENCES compute_nodes(id),
    placement_reason  TEXT NOT NULL DEFAULT '',

    k8s_job_name  TEXT   NOT NULL DEFAULT '',
    attempt       INT    NOT NULL DEFAULT 0,
    max_retries   INT    NOT NULL DEFAULT 0,
    failure_reason TEXT  NOT NULL DEFAULT '',

    queued_at     TIMESTAMPTZ,
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Queue drain path: ... WHERE state='QUEUED' ORDER BY priority, queued_at
--                  FOR UPDATE SKIP LOCKED (ADR 0004).
CREATE INDEX idx_training_jobs_queue
    ON training_jobs (state, priority, queued_at)
    WHERE state = 'QUEUED';

CREATE INDEX idx_training_jobs_project ON training_jobs (project_id, created_at DESC);

-- Append-only. Every state change writes a row; nothing mutates in place (spec §47).
CREATE TABLE job_events (
    id         BIGSERIAL PRIMARY KEY,
    job_id     UUID        NOT NULL REFERENCES training_jobs(id) ON DELETE CASCADE,
    event_type TEXT        NOT NULL,
    from_state TEXT,
    to_state   TEXT,
    message    TEXT        NOT NULL DEFAULT '',
    details    JSONB       NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_events_job ON job_events (job_id, id);

CREATE TABLE artifacts (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id     UUID        REFERENCES training_jobs(id) ON DELETE CASCADE,
    kind       TEXT        NOT NULL,
    uri        TEXT        NOT NULL,
    digest     TEXT        NOT NULL DEFAULT '',
    size_bytes BIGINT      NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE models (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE TABLE model_versions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id      UUID        NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    version       INT         NOT NULL,
    experiment_id UUID        REFERENCES experiments(id),
    artifact_id   UUID        REFERENCES artifacts(id),
    status        TEXT        NOT NULL DEFAULT 'CREATED',
    metrics       JSONB       NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (model_id, version)
);

CREATE TABLE deployments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    model_id   UUID        NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    status     TEXT        NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

-- Weighted routing across versions; weights for a deployment should sum to 100.
CREATE TABLE deployment_targets (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id    UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    model_version_id UUID NOT NULL REFERENCES model_versions(id),
    traffic_weight   INT  NOT NULL DEFAULT 100,
    replicas         INT  NOT NULL DEFAULT 1,
    UNIQUE (deployment_id, model_version_id)
);

-- Who did what, when, to which resource, with what result (spec §48).
CREATE TABLE audit_log (
    id         BIGSERIAL PRIMARY KEY,
    actor      TEXT        NOT NULL,
    action     TEXT        NOT NULL,
    resource   TEXT        NOT NULL,
    result     TEXT        NOT NULL,
    details    JSONB       NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS audit_log, deployment_targets, deployments, model_versions, models,
    artifacts, job_events, training_jobs, gpu_devices, compute_nodes, experiments,
    dataset_versions, datasets, resource_quotas, projects, users;
