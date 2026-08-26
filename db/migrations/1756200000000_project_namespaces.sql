-- Up Migration
-- Phase 10: the namespace a workload was created in, recorded rather than assumed.
--
-- Until now every project's pods shared one namespace — the one named by
-- `ASHML_K8S_NAMESPACE` — so the executor could observe and delete a Job by reading that
-- one setting at the moment it needed it. A namespace per project ends that: the
-- namespace a Job was created in is a fact about *that Job*, decided when it launched,
-- and a process that recomputes it later gets the answer for the world as it is now.
--
-- The two differ in exactly the cases that matter. A cluster upgraded mid-flight has
-- running Jobs in the shared namespace and new ones in per-project namespaces. A project
-- renamed after its Jobs were created would have its namespace recomputed to a name
-- nothing was ever created under. In both, a recomputed namespace means `observeJob`
-- returns null for a Pod that is running — which the executor is required to read as
-- "the workload is gone", so a healthy run would be failed and its GPU released while it
-- still holds it.
--
-- Nullable on purpose, and it is the migration. A null means "created before this
-- column existed", which is precisely the shared namespace, so the read path is
-- `job.namespace ?? backend.namespace` and every Job already running keeps working
-- without a backfill that would have to guess. This is the same shape `deployments`
-- has carried since Phase 5 (`k8s_name`, `namespace`) and for the same reason, stated
-- there as: if the naming scheme changes later, everything already deployed must still
-- be findable.
ALTER TABLE training_jobs
    ADD COLUMN namespace TEXT;

-- Down Migration
ALTER TABLE training_jobs
    DROP COLUMN IF EXISTS namespace;
