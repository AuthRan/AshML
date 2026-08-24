-- Up Migration
-- Phase 10: authentication, authorization and project membership (spec §31, §32).
--
-- Until now every request acted as the seeded local user (migration 1755000100000) and
-- every project was reachable by everybody. This adds the three things §31 asks for that
-- the schema could not previously express: who is calling, what they may do, and which
-- projects it applies to.
--
-- Two kinds of caller exist and they are deliberately separate tables rather than one
-- table with a nullable `user_id`. A person's token and a training pod's token differ in
-- lifetime (months vs. one attempt), in blast radius (every project they belong to vs.
-- one job), and in how they end (revoked by hand vs. revoked automatically when the job
-- finishes). Folding them together would mean every authorization check began by working
-- out which kind it was holding, which is exactly the check that must not be forgotten.

-- Platform administration, as distinct from owning a project.
--
-- Quotas are the reason this exists. A quota a project owner can raise is not a quota,
-- so granting capacity has to sit with somebody other than the person it constrains
-- (spec §31: "Do not allow arbitrary users to submit unrestricted Kubernetes
-- resources"). Node and GPU inventory are here for the same reason: they describe the
-- cluster, not any one project's use of it.
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;

-- The seeded local user keeps working as it always has, now by holding the grants
-- explicitly rather than by there being no grants to hold.
UPDATE users SET is_admin = true WHERE id = '00000000-0000-0000-0000-000000000001';

-- Who may do what, per project (spec §32: logical project isolation).
--
-- Roles are a fixed ladder rather than a permission matrix. Three named tiers cover the
-- distinctions this platform actually makes — look, use, administer — and a matrix would
-- be a configuration surface with no second reader. `domain/roles.js` holds the mapping
-- from role to permission and is where a fourth tier would be argued for.
CREATE TABLE project_members (
    project_id UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('OWNER', 'EDITOR', 'VIEWER')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

-- Answers "which projects may this user see?" — the query behind every list endpoint
-- once listing is scoped to membership.
CREATE INDEX project_members_user_idx ON project_members (user_id);

-- Every existing project keeps an owner: the one already named in `projects.owner_id`.
-- Without this backfill, applying auth would lock every caller out of every project that
-- existed before it, which is a migration that passes and a platform that stops.
INSERT INTO project_members (project_id, user_id, role)
SELECT id, owner_id, 'OWNER' FROM projects
ON CONFLICT DO NOTHING;

-- Long-lived credentials belonging to a person (spec §27: `ash login`).
CREATE TABLE api_tokens (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- What it is for, so a user with six tokens can revoke the right one.
    name         TEXT        NOT NULL,
    -- The token is stored only as a SHA-256 hash. A control-plane database that is
    -- readable — a backup, a dump handed to somebody debugging, a replica — must not be
    -- a list of working credentials. This is also why token creation is the only time
    -- the plaintext is ever returned.
    token_hash   TEXT        NOT NULL UNIQUE,
    -- The first few characters of the plaintext, kept so `ash token list` can show which
    -- token a row is without the hash being reversible. A prefix identifies; it does not
    -- authenticate, and nothing may look a caller up by it.
    prefix       TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Observed, not assumed, in the same spirit as job state: it answers "is this token
    -- still in use?" before somebody decides whether revoking it will break something.
    last_used_at TIMESTAMPTZ,
    -- NULL means no expiry. Expiry is offered rather than imposed because a token that
    -- expires without warning inside a scheduled job is an outage, and this platform has
    -- no way to warn anyone yet.
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    UNIQUE (user_id, name)
);

-- Revocation is a timestamp rather than a DELETE so that `last_used_at` survives it —
-- the question after a leak is when the token was last used, and deleting the row
-- destroys the only evidence.
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id) WHERE revoked_at IS NULL;

-- Credentials belonging to a workload rather than to a person.
--
-- This closes the hole the Phase 4 roadmap named: the metric and artifact ingest paths
-- take writes from inside the cluster and had no authentication at all, so anything that
-- could reach the control plane could report results for any job.
--
-- Two kinds, because the platform runs two kinds of pod and they need different things:
--
--   RUN     — one attempt of one training job. Reports metrics and uploads artifacts for
--             that job and no other.
--   SERVING — one deployment. Exchanges an artifact id for a download at startup, and
--             does not write anything at all.
--
-- One table rather than two because the lifecycle is identical — minted at launch,
-- revoked when the workload ends — and because a single `workload_tokens` lookup is what
-- keeps the authentication path from having to guess which table to try first. The CHECK
-- is what stops the union type from going soft: exactly one owner column, always.
CREATE TABLE workload_tokens (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          TEXT        NOT NULL CHECK (kind IN ('RUN', 'SERVING')),

    job_id        UUID        REFERENCES training_jobs(id) ON DELETE CASCADE,
    -- Which attempt minted it. A retry gets a fresh token and the previous one is
    -- revoked, so a pod that is still shutting down cannot report metrics for the run
    -- that replaced it.
    attempt       INT,

    deployment_id UUID        REFERENCES deployments(id) ON DELETE CASCADE,

    token_hash    TEXT        NOT NULL UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ,

    CONSTRAINT workload_token_owner CHECK (
        (kind = 'RUN'     AND job_id IS NOT NULL AND attempt IS NOT NULL AND deployment_id IS NULL)
     OR (kind = 'SERVING' AND deployment_id IS NOT NULL AND job_id IS NULL AND attempt IS NULL)
    )
);

-- One live token per attempt, and per deployment. Partial unique indexes rather than
-- table constraints because a revoked token stays in the table as evidence, and a plain
-- UNIQUE would then stop the next attempt from minting its own.
CREATE UNIQUE INDEX workload_tokens_run_live_idx
    ON workload_tokens (job_id, attempt) WHERE revoked_at IS NULL AND kind = 'RUN';
CREATE UNIQUE INDEX workload_tokens_serving_live_idx
    ON workload_tokens (deployment_id) WHERE revoked_at IS NULL AND kind = 'SERVING';

CREATE INDEX workload_tokens_job_idx ON workload_tokens (job_id) WHERE revoked_at IS NULL;

-- Down Migration

DROP TABLE IF EXISTS workload_tokens;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS project_members;
ALTER TABLE users DROP COLUMN IF EXISTS is_admin;
