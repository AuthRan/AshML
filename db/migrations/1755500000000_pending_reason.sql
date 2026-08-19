-- Up Migration
-- Why a job that has been launched is not yet running.
--
-- A job sits in STARTING from the moment its Kubernetes Job is created until a Pod is
-- observed running. That gap is normally seconds — an image pull — but it can also be
-- permanent: an unschedulable Pod, an image that does not exist, a node that AshML
-- believes in and the cluster does not.
--
-- Until now those all looked identical from outside: STARTING, no reason, indefinitely.
-- The information exists on the Pod and AshML was already reading it to build failure
-- messages; it just had nowhere to put it while the job had not actually failed. This
-- is that place. It is not `failure_reason`: the job has not failed, and conflating
-- "waiting, here is why" with "failed" would make a retry decision on the wrong signal.
ALTER TABLE training_jobs
    ADD COLUMN pending_reason TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN training_jobs.pending_reason IS
    'Why a launched job is not yet running (image pull, unschedulable, ...). Cleared '
    'once it runs. Distinct from failure_reason, which means the job is over.';

-- Down Migration
ALTER TABLE training_jobs DROP COLUMN IF EXISTS pending_reason;
