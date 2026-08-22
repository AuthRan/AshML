-- Up Migration
-- Phase 5: a deployment serves versions, plural (spec §21).

-- `deployment_targets` has carried a `traffic_weight` since Phase 0 and it has never
-- meant anything: a deployment had exactly one target at 100, and one Kubernetes
-- Deployment behind it. Weighted routing needs each version to be independently
-- runnable -- its own pods, its own Service, its own readiness -- because a weight is a
-- share of traffic and traffic can only be split between things that have addresses.
--
-- So the serving state that lived on `deployments` moves down to the target, which is
-- the thing that actually runs. What stays on `deployments` is the deployment's own
-- identity: its name, its address, and what that address currently points at.
ALTER TABLE deployment_targets
    -- The per-version Kubernetes Deployment and Service. Recorded rather than
    -- recomputed from the name, the same argument as `deployments.k8s_name`: if the
    -- naming scheme changes, everything already running must still be findable.
    ADD COLUMN k8s_name       TEXT,

    -- The per-version address. This is what the router forwards to, and it is not the
    -- deployment's address -- callers use the deployment's, which is the whole point of
    -- a deployment having a stable name.
    ADD COLUMN endpoint_url   TEXT,

    -- Observed, in the same vocabulary as the deployment's own status, and observed for
    -- the same reason: a target that AshML believes is serving and which has no ready
    -- pods is how traffic gets weighted onto nothing.
    ADD COLUMN status         TEXT NOT NULL DEFAULT 'PENDING',
    ADD COLUMN ready_replicas INT  NOT NULL DEFAULT 0,
    ADD COLUMN last_error     TEXT,

    ADD COLUMN created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE deployment_targets
    ADD CONSTRAINT deployment_targets_status_check
    CHECK (status IN ('PENDING', 'PROGRESSING', 'READY', 'DEGRADED', 'FAILED', 'STOPPED'));

-- A weight is a whole percentage. The rule that a deployment's weights sum to exactly
-- 100 is not expressible as a row constraint and lives in `domain/routing.js`, which is
-- also where the reason it is never normalised is written down. This only catches the
-- values that could not be part of any valid split.
ALTER TABLE deployment_targets
    ADD CONSTRAINT deployment_targets_weight_check
    CHECK (traffic_weight BETWEEN 0 AND 100);

ALTER TABLE deployments
    -- The version the deployment's own Service currently selects, or NULL when it
    -- selects the router. This is *observed* state -- what the front door points at
    -- right now -- not desired state, which is derivable from the targets. The two are
    -- separate because moving the front door is a step that can be half-done: a router
    -- that has been created but has no ready pod must not be selected yet, or the
    -- deployment stops answering during its own rollout.
    ADD COLUMN serving_version INT,

    -- The router image, stored per deployment for the same reason the model server's is:
    -- upgrading the router must not silently change what an already-running deployment
    -- has in front of it.
    ADD COLUMN router_image    TEXT NOT NULL DEFAULT 'ashml/model-router:v1',

    -- The router's Kubernetes Deployment, NULL until more than one version is taking
    -- traffic and there is therefore something to decide. It has no Service of its own:
    -- the deployment's front Service selects its pods directly, which is what makes
    -- turning routing on a selector change rather than a new address.
    ADD COLUMN router_k8s_name TEXT,

    -- And what the cluster says about it. Observed and recorded, like everything else in
    -- the serving path: the router is the thing every request goes through once there is
    -- a split, and a component AshML cannot report the health of is one an operator finds
    -- out about from the caller.
    ADD COLUMN router_status         TEXT,
    ADD COLUMN router_ready_replicas INT NOT NULL DEFAULT 0;

-- Deployments that already exist keep a truthful record of where their address points,
-- so that nothing downstream reads the new NULL as "it points at the router".
UPDATE deployments d
   SET serving_version = (
       SELECT v.version
         FROM deployment_targets t
         JOIN model_versions v ON v.id = t.model_version_id
        WHERE t.deployment_id = d.id
        ORDER BY v.version
        LIMIT 1)
 WHERE d.k8s_name IS NOT NULL;

-- Their *Kubernetes objects* are not carried across, and cannot be. A deployment created
-- before this migration has one Deployment whose `spec.selector` is
-- `{managed-by, deployment-id}` with no version in it -- and `spec.selector` is immutable,
-- so there is no patch that turns it into a per-version object. Adopting it would mean
-- the front Service going on selecting every version's pods at once, which is a split
-- that ignores its own weights.
--
-- So: recreate them. `ash deployment delete <name>` then `ash model deploy` gives the
-- same address a moment later. This is said here rather than attempted in code because a
-- migration that half-adopted the old objects would leave a deployment that looks managed
-- and is not, which is worse than one that is plainly gone for thirty seconds.

-- Down Migration
ALTER TABLE deployments
    DROP COLUMN IF EXISTS serving_version,
    DROP COLUMN IF EXISTS router_image,
    DROP COLUMN IF EXISTS router_k8s_name,
    DROP COLUMN IF EXISTS router_status,
    DROP COLUMN IF EXISTS router_ready_replicas;
ALTER TABLE deployment_targets DROP CONSTRAINT IF EXISTS deployment_targets_weight_check;
ALTER TABLE deployment_targets DROP CONSTRAINT IF EXISTS deployment_targets_status_check;
ALTER TABLE deployment_targets
    DROP COLUMN IF EXISTS k8s_name,
    DROP COLUMN IF EXISTS endpoint_url,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS ready_replicas,
    DROP COLUMN IF EXISTS last_error,
    DROP COLUMN IF EXISTS created_at,
    DROP COLUMN IF EXISTS updated_at;
