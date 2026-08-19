"""
A smoke-test training workload.

This is deliberately not machine learning. Its job is to prove that the platform can
build an image, schedule it, run it, stream its output, observe its exit, and record
the result — the Phase 2 exit criteria. The real ResNet-18/CIFAR-10 workload arrives
in Phase 4, when there is artifact storage and a metrics SDK for it to report to.

Calling this "training" in a demo would be exactly the kind of overclaim spec Rule 5
forbids, so it says what it is on every line it prints.
"""

import os
import sys
import time

def env(name, default=""):
    return os.environ.get(name, default)

def main():
    steps = int(env("STEPS", "10"))
    delay = float(env("STEP_SECONDS", "0.5"))
    # Lets the end-to-end test drive a failing run without a second image.
    fail_at = int(env("FAIL_AT_STEP", "0"))

    print("[smoke] AshML smoke workload — this is not a real training run", flush=True)
    print(f"[smoke] job_id={env('ASHML_JOB_ID', '<unset>')}", flush=True)
    print(f"[smoke] job_name={env('ASHML_JOB_NAME', '<unset>')}", flush=True)
    print(f"[smoke] project={env('ASHML_PROJECT', '<unset>')}", flush=True)
    print(f"[smoke] experiment={env('ASHML_EXPERIMENT_ID', '<none>')}", flush=True)
    print(f"[smoke] attempt={env('ASHML_ATTEMPT', '0')}", flush=True)

    # Reported so a GPU-requesting job visibly proves whether it actually got one.
    visible = env("NVIDIA_VISIBLE_DEVICES", "<unset>")
    print(f"[smoke] NVIDIA_VISIBLE_DEVICES={visible}", flush=True)

    for step in range(1, steps + 1):
        if fail_at and step == fail_at:
            print(f"[smoke] failing deliberately at step {step} (FAIL_AT_STEP)", flush=True)
            sys.exit(3)
        # A stand-in for work: enough to be measurable, not enough to matter. It
        # depends on the step so the output differs line to line — identical numbers
        # on every line make a working run indistinguishable from a stubbed one.
        total = sum((i + step) * i for i in range(200_000))
        print(f"[smoke] step {step}/{steps} checksum={total % 100_000}", flush=True)
        time.sleep(delay)

    print("[smoke] done", flush=True)

if __name__ == "__main__":
    main()
