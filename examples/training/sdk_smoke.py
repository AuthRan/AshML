"""Exercises AshML's reporting contract end to end. **This trains nothing.**

The numbers below are a decaying exponential with noise. They are not a model, not a
result, and must never be presented as one (spec Rule 5) — the point is to prove that a
job can report metrics and a checkpoint back to the control plane and have them arrive
attributed to the right run. The real workload is ResNet-18 on CIFAR-10.

Run it under the platform:

    ash job submit examples/training/sdk-smoke.yaml

or against a control plane from the shell:

    ASHML_ENDPOINT=http://127.0.0.1:8080 ASHML_JOB_ID=<id> python3 examples/training/sdk_smoke.py
"""

import math
import os
import random
import tempfile
import time

import ashml

STEPS = int(os.environ.get("SMOKE_STEPS", "40"))
STEPS_PER_EPOCH = 10


def main() -> None:
    with ashml.init() as run:
        print(f"reporting to job {run.job_id} (experiment {run.experiment_id or 'none'})")

        for step in range(STEPS):
            # Synthetic. Nothing here has seen data.
            fake_loss = 2.4 * math.exp(-step / 12) + random.uniform(-0.02, 0.02)
            fake_accuracy = 0.1 + 0.85 * (1 - math.exp(-step / 10))

            run.log_metrics(
                {"loss": fake_loss, "accuracy": fake_accuracy, "lr": 0.001 * (0.97**step)},
                step=step,
                epoch=step // STEPS_PER_EPOCH,
            )

            # An epoch boundary is where a real run would checkpoint, so this is where
            # the upload path gets exercised.
            if step > 0 and step % STEPS_PER_EPOCH == 0:
                artifact = _write_and_log(run, step)
                print(f"  step {step}: uploaded {artifact.name} (verified={artifact.verified})")

            time.sleep(0.05)

        final = _write_and_log(run, STEPS, kind="model", name="final.pt")
        print(f"done: {final.name} is {final.status}, verified={final.verified}")


def _write_and_log(run, step, *, kind="checkpoint", name=None):
    """Writes a small file standing in for a checkpoint, and registers it."""
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pt") as handle:
        # A real checkpoint is state_dict bytes. This is 64 KB of nothing, and is
        # labelled as such in the artifact's metadata so it cannot be mistaken later.
        handle.write(os.urandom(64 * 1024))
        path = handle.name

    try:
        return run.log_artifact(
            path,
            name=name or f"epoch-{step // STEPS_PER_EPOCH}.pt",
            kind=kind,
            step=step,
            metadata={"synthetic": True, "note": "smoke test payload, not a trained model"},
        )
    finally:
        os.unlink(path)


if __name__ == "__main__":
    main()
