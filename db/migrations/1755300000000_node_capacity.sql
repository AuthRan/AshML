-- Up Migration
-- Phase 3: separate what the hardware *is* from what the cluster will *grant*.
--
-- `gpu_devices` records what the GPU provider can see: model, memory, health,
-- utilisation. That is telemetry, and it is not the same thing as schedulable capacity.
-- Kubernetes only grants `nvidia.com/gpu` when a device plugin is installed, so a
-- machine can plainly have two GPUs while the cluster advertises none.
--
-- Scheduling against the hardware in that situation places jobs onto GPUs the cluster
-- will never hand over, and the Pod sits Pending forever. So the advertised figure is
-- stored separately and is the one placement uses.
ALTER TABLE compute_nodes
    ADD COLUMN gpu_capacity INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN compute_nodes.gpu_capacity IS
    'GPUs Kubernetes will actually grant (nvidia.com/gpu allocatable). Zero when no '
    'device plugin is installed, regardless of how much silicon the machine has.';

-- Resources on this node already requested by Pods AshML did not create: kube-system
-- daemons, CNI, metrics-server, and anything else sharing the cluster.
--
-- Without this, AshML reads `allocatable` and believes the whole node is its own. It
-- then admits jobs summing to the full node, Kubernetes refuses the last one because
-- the system Pods got there first, and the job sits Pending with AshML insisting it
-- was placed. Subtracting what is already spoken for is what keeps AshML's accounting
-- and Kubernetes' agreeing.
ALTER TABLE compute_nodes
    ADD COLUMN reserved_cpu    INT    NOT NULL DEFAULT 0,
    ADD COLUMN reserved_memory BIGINT NOT NULL DEFAULT 0;

-- Down Migration
ALTER TABLE compute_nodes
    DROP COLUMN IF EXISTS gpu_capacity,
    DROP COLUMN IF EXISTS reserved_cpu,
    DROP COLUMN IF EXISTS reserved_memory;
