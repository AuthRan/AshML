"""AshML's training SDK: the client half of the reporting contract.

A run reports its own metrics and checkpoints rather than being scraped (ADR 0009),
which means a training script has to say something. This package exists to make that
"something" as close to one line as it can be::

    import ashml

    with ashml.init() as run:
        for step, batch in enumerate(loader):
            loss = train_step(batch)
            run.log_metrics({"loss": loss.item()}, step=step)
        run.log_artifact("checkpoints/final.pt", kind="model")

``init()`` takes its identity from the environment AshML injects into every training
container — ``ASHML_ENDPOINT``, ``ASHML_JOB_ID``, ``ASHML_EXPERIMENT_ID`` and
``ASHML_RUN_TOKEN`` — so the same script runs unchanged under the platform. The first
three can be set by hand to run outside a job; the token cannot, because the control plane
mints it when it launches a pod and reporting a run's results is the one thing no person's
credential may do (ADR 0013).

A retried job is additionally offered the checkpoint it can resume from, and a workload
that wants to take up the offer asks for it::

    with ashml.init() as run:
        resume = run.fetch_resume()      # None on a first attempt
        if resume:
            model.load_state_dict(torch.load(resume)["model"])

Asking is the whole interface: a workload that never calls it starts from the beginning,
which is what makes resuming an addition to the contract rather than a change to it.

No third-party dependencies, on purpose: a training image is a fragile enough
dependency graph already.
"""

from __future__ import annotations

import os
import warnings

from ._client import ApiError, Client
from ._run import Artifact, Run

__version__ = "0.1.0"

__all__ = ["init", "Run", "Artifact", "ApiError", "detect_hardware", "detect_framework", "__version__"]


def init(
    *,
    endpoint: str | None = None,
    job_id: str | None = None,
    experiment_id: str | None = None,
    resume_artifact_id: str | None = None,
    token: str | None = None,
    report_start: bool = True,
    strict: bool = False,
    timeout: float = 10.0,
    **run_options,
) -> Run:
    """Starts reporting for the current job.

    Every argument defaults to the environment AshML sets in the container, so under the
    platform this is called with no arguments at all. Passing them explicitly is for
    running the same script outside a job.

    :param resume_artifact_id: the checkpoint this attempt should resume from. AshML
        sets ``ASHML_RESUME_FROM`` on a retry that has a confirmed one to offer, and
        leaves it unset otherwise, so a workload asks with :meth:`Run.fetch_resume`
        rather than being told. See :meth:`Run.fetch_resume` for why a promised resume
        that cannot be fetched raises instead of quietly starting over.
    :param token: the credential this attempt reports with. AshML injects it as
        ``ASHML_RUN_TOKEN`` and it is scoped to this job and this attempt, so it can
        report these results and nothing else. Pass it explicitly only when running the
        script outside a job.
    :param report_start: also stamps the experiment's start and records the framework
        and hardware this run observed. Turn it off for a script that attaches to an
        already-running experiment.
    :param strict: raise instead of logging when reporting fails. The default is false
        because losing a metric must not lose a training run; set it true in tests,
        where a silent drop is exactly what you want to hear about.

    :raises RuntimeError: if there is no job id or no endpoint. Guessing either would
        mean reporting into the void, or worse, onto another run's record.
    """
    endpoint = endpoint or os.environ.get("ASHML_ENDPOINT")
    job_id = job_id or os.environ.get("ASHML_JOB_ID")
    experiment_id = experiment_id or os.environ.get("ASHML_EXPERIMENT_ID") or None
    resume_artifact_id = resume_artifact_id or os.environ.get("ASHML_RESUME_FROM") or None
    token = token or os.environ.get("ASHML_RUN_TOKEN") or None

    if not job_id:
        raise RuntimeError(
            "ashml.init(): no job id. Inside a training job AshML sets ASHML_JOB_ID; "
            "outside one, pass job_id= explicitly."
        )
    if not endpoint:
        raise RuntimeError(
            "ashml.init(): no endpoint. AshML sets ASHML_ENDPOINT in the container when "
            "the control plane is configured with an advertised URL "
            "(ASHML_API_ADVERTISE_URL); outside a job, pass endpoint= explicitly."
        )
    if not token:
        # Not fatal, and deliberately so. A control plane running with
        # ASHML_AUTH_ENABLED=false injects no token and accepts the reports anyway, and
        # that is the mode the k3d end-to-end scripts use. Against an authenticated
        # control plane every report will fail with 401 — which is the right outcome, and
        # this warning is what connects it to its cause rather than leaving somebody
        # reading a stack of 401s from inside a pod.
        warnings.warn(
            "ashml.init(): no ASHML_RUN_TOKEN in the environment. Reports will be "
            "rejected unless the control plane is running with authentication "
            "disabled.",
            RuntimeWarning,
            stacklevel=2,
        )

    run = Run(
        Client(endpoint, timeout=timeout, token=token),
        job_id,
        experiment_id=experiment_id,
        resume_artifact_id=resume_artifact_id,
        strict=strict,
        **run_options,
    )

    if report_start:
        run.report_started(framework=detect_framework(), hardware=detect_hardware())

    return run


def detect_framework() -> str:
    """``"pytorch 2.4.1"``, or an empty string if there is nothing to detect.

    Empty rather than a guess: an experiment record saying the run used a framework it
    did not is worse than one saying nothing (spec Rule 5).
    """
    try:
        import torch
    except ImportError:
        return ""
    return f"pytorch {torch.__version__}"


def detect_hardware() -> dict:
    """What this process can actually see of the machine it landed on.

    Reports only what the framework tells it. There is no fallback that infers a GPU
    from an environment variable or a device file — an experiment's hardware record is
    read later as evidence, and a plausible guess is the one thing it must never contain.
    """
    try:
        import torch
    except ImportError:
        return {}

    if not torch.cuda.is_available():
        return {"gpus": 0, "cuda": None}

    devices = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]
    return {
        "gpus": len(devices),
        "devices": devices,
        "cuda": torch.version.cuda,
        "torch": torch.__version__,
    }
