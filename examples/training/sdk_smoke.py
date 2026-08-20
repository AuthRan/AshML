"""Exercises AshML's reporting contract end to end. **This trains nothing.**

The numbers below are a decaying exponential with noise. They are not a model, not a
result, and must never be presented as one (spec Rule 5) — the point is to prove that a
job can report metrics and a checkpoint back to the control plane and have them arrive
attributed to the right run, and that a killed pod's retry resumes from the last
confirmed checkpoint instead of starting over. The real workload is ResNet-18 on
CIFAR-10.

Run it under the platform:

    ash job submit examples/training/sdk-smoke.yaml

or against a control plane from the shell:

    ASHML_ENDPOINT=http://127.0.0.1:8080 ASHML_JOB_ID=<id> python3 examples/training/sdk_smoke.py
"""

import json
import math
import os
import random
import tempfile
import time

import ashml

STEPS = int(os.environ.get("SMOKE_STEPS", "40"))
STEPS_PER_EPOCH = 10
STEP_SECONDS = float(os.environ.get("SMOKE_STEP_SECONDS", "0.05"))

#: Checkpoint every N steps rather than only at epoch boundaries. What a killed pod
#: costs is the work since its last checkpoint, so this is the knob the chaos test turns
#: down to make an interruption cheap and the recovery quick to observe.
CHECKPOINT_EVERY = int(os.environ.get("SMOKE_CHECKPOINT_EVERY", str(STEPS_PER_EPOCH)))

#: A heartbeat, so progress is visible from `ash job logs` and not only from metrics.
#: The distinction matters when the control plane is unreachable: metrics are buffered
#: in the process and may never arrive, while stdout keeps going regardless — which is
#: what makes it evidence that a run survived an outage rather than wedged in one.
LOG_EVERY = int(os.environ.get("SMOKE_LOG_EVERY", "5"))


def main() -> None:
    with ashml.init() as run:
        print(f"reporting to job {run.job_id} (experiment {run.experiment_id or 'none'})")

        # On a first attempt this is None and the run starts at zero. On a retry AshML
        # offers the newest confirmed checkpoint, and taking it up is what makes the
        # second attempt a continuation rather than a repetition.
        start_step = _resume(run)

        for step in range(start_step, STEPS):
            # Synthetic. Nothing here has seen data.
            fake_loss = 2.4 * math.exp(-step / 12) + random.uniform(-0.02, 0.02)
            fake_accuracy = 0.1 + 0.85 * (1 - math.exp(-step / 10))

            run.log_metrics(
                {"loss": fake_loss, "accuracy": fake_accuracy, "lr": 0.001 * (0.97**step)},
                step=step,
                epoch=step // STEPS_PER_EPOCH,
            )

            if LOG_EVERY and step % LOG_EVERY == 0:
                print(f"  step {step}/{STEPS} loss {fake_loss:.4f}", flush=True)

            time.sleep(STEP_SECONDS)

            # Where a real run would checkpoint, so this is where the upload path gets
            # exercised — and, since the checkpoint records the step, where a killed pod
            # gets something to come back to.
            #
            # Taken *after* the step's work, and recording the step to resume at rather
            # than the one just finished. A checkpoint whose number means "I was partway
            # through this" makes the resumed run repeat a step, which shows up as two
            # points at the same step in a curve that is supposed to be a history.
            completed = step + 1
            if CHECKPOINT_EVERY and completed % CHECKPOINT_EVERY == 0 and completed < STEPS:
                artifact = _write_and_log(run, completed)
                print(f"  step {step}: uploaded {artifact.name} (verified={artifact.verified})")

        final = _write_and_log(run, STEPS, kind="model", name="final.pt")
        print(f"done: {final.name} is {final.status}, verified={final.verified}")


def _resume(run):
    """Continues from the offered checkpoint, or starts at zero. Returns the first step.

    The checkpoint carries the step it was taken at, which is the entire state this
    workload has. A real one carries weights and optimizer moments too — see
    `examples/training/resnet_cifar.py` — but the platform contract being proved here is
    the same one: an artifact id arrives in the environment, the bytes are fetched and
    verified, and the run picks up where the last confirmed checkpoint left it.
    """
    checkpoint = run.fetch_resume()
    if checkpoint is None:
        print("first attempt: starting from step 0")
        return 0

    try:
        with open(checkpoint) as handle:
            state = json.load(handle)
    finally:
        os.unlink(checkpoint)

    step = int(state["step"])
    print(f"resuming from artifact {run.resume_artifact_id} at step {step} of {STEPS}")
    return step


def _write_and_log(run, step, *, kind="checkpoint", name=None):
    """Writes a small file standing in for a checkpoint, and registers it."""
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".pt") as handle:
        # A real checkpoint is state_dict bytes. This is the step plus 64 KB of nothing,
        # and is labelled as such in its own metadata so it cannot be mistaken later.
        # The step is the part that matters: a checkpoint that cannot say where the run
        # had got to is not one a retry can resume from.
        json.dump({
            "step": step,
            "synthetic": True,
            "note": "smoke test payload, not a trained model",
            "padding": os.urandom(32 * 1024).hex(),
        }, handle)
        path = handle.name

    try:
        return run.log_artifact(
            path,
            name=name or f"step-{step}.pt",
            kind=kind,
            step=step,
            metadata={"synthetic": True, "step": step, "note": "smoke test payload, not a trained model"},
        )
    finally:
        os.unlink(path)


if __name__ == "__main__":
    main()
