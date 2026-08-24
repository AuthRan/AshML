-- Up Migration
-- Phase 10: a record of the requests that were refused (spec §31).
--
-- Job state changes have been audited since Phase 1 (`job_events`), which covers what the
-- platform *did*. This covers what it *declined to do*, which until now left no trace at
-- all: `api_tokens.last_used_at` was the whole trail, and it is deliberately coarse — it
-- records that a credential was presented, never what it was refused.
--
-- ## Why this is written where the decision is made, not where the response is sent
--
-- The obvious implementation is a hook that records every 403. It would miss the refusals
-- that matter most. A caller who asks about a project they are not a member of is told
-- **404**, on purpose: a 403 would confirm the name is real, which is how an outsider
-- enumerates projects (see `resolveProject`). So the API's own status codes are a
-- deliberately unreliable narrator about authorization, and an audit built on them would
-- record "not found" for exactly the probing it exists to surface. Each row therefore
-- carries both the decision and the status the caller was actually given, and the two are
-- allowed to disagree.
--
-- ## Why only refusals of a *known* caller
--
-- A 401 has no principal. What it has is an address and a token prefix, and there is no
-- ceiling on how many of them a stranger can produce — so recording them here would hand
-- anyone on the network an INSERT-per-packet amplifier, which is the failure the rate
-- limiter in the same phase exists to prevent, reintroduced through its own audit trail.
-- Unauthenticated refusals are counted (`ashml_auth_failures_total`) and logged instead.
-- An audit row should be worth reading; "somebody unknown presented an invalid token" is
-- a rate, not a record.
CREATE TABLE authz_denials (
    id            BIGSERIAL   PRIMARY KEY,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Which kind of caller, by construction rather than by inspecting which id is set.
    principal     TEXT        NOT NULL CHECK (principal IN ('USER', 'RUN', 'SERVING')),

    -- Who, by id *and* by name.
    --
    -- No foreign keys, and that is the point rather than an oversight. Every other id in
    -- this schema cascades or nulls when its subject is deleted; an audit row that a
    -- DELETE can erase or anonymise is not an audit row. `subject` is copied in at the
    -- time — an email, a job id, a deployment id — so the record still reads after the
    -- thing it names has gone.
    user_id       UUID,
    job_id        UUID,
    deployment_id UUID,
    subject       TEXT        NOT NULL,

    -- What they were refused, and where.
    permission    TEXT        NOT NULL,
    project_id    UUID,
    project_name  TEXT,

    -- The request it happened in, so a denial can be joined to the log line that
    -- describes it (`request_id` is the same one `pino` correlates on).
    method        TEXT        NOT NULL,
    route         TEXT        NOT NULL,
    -- What the caller was told. 403 for a truthful refusal, 404 where telling the truth
    -- would have leaked the existence of the thing being protected.
    status        SMALLINT    NOT NULL,
    request_id    UUID,
    remote_addr   INET
);

-- The two questions asked of an audit log: "what happened lately" and "what has this
-- account been trying". Both want the newest rows first.
CREATE INDEX authz_denials_recent_idx ON authz_denials (occurred_at DESC);
CREATE INDEX authz_denials_user_idx ON authz_denials (user_id, occurred_at DESC)
    WHERE user_id IS NOT NULL;

-- Down Migration
DROP TABLE authz_denials;
