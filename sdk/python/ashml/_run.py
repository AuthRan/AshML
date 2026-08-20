"""The Run object: what a training script holds and reports through.

The design rule behind every choice in this file:

    **Reporting must never be the reason a training run dies.**

Six hours of GPU time is worth more than a loss curve. So a metric flush that fails is
retried, then logged and dropped; the training loop is never told. Artifacts are the
exception and are strict by default — a checkpoint that silently did not save is a
worse outcome than a crash, because it is discovered days later when something tries to
resume from it.
"""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from ._client import ApiError, Client

log = logging.getLogger("ashml")

#: How many buffered points force a flush. One HTTP request per metric per step would
#: put a network round trip inside the training loop.
DEFAULT_BATCH_SIZE = 200

#: And how long a partly-filled buffer may sit. Without this, a slow run's first metrics
#: would not be visible until the batch happened to fill, which for a job logging once
#: an epoch could be hours.
DEFAULT_FLUSH_INTERVAL = 10.0

#: How long a checkpoint download may take. Generous where the metric timeout is not:
#: this runs once at startup, on a file that can be tens of gigabytes, and giving up on
#: it costs the whole retry the checkpoint was meant to save.
DEFAULT_DOWNLOAD_TIMEOUT = 900.0


class Artifact:
    """What ``log_artifact`` returns: the record, as the control plane sees it."""

    def __init__(self, payload: dict):
        self._payload = payload

    def __getattr__(self, name):
        try:
            return self._payload[name]
        except KeyError as err:
            raise AttributeError(name) from err

    def __repr__(self):
        return f"<Artifact {self._payload.get('name')!r} {self._payload.get('status')}>"


class Run:
    """One training run, reporting against one AshML job.

    Not usually constructed directly — see :func:`ashml.init`.
    """

    def __init__(
        self,
        client: Client,
        job_id: str,
        *,
        experiment_id: str | None = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        flush_interval: float = DEFAULT_FLUSH_INTERVAL,
        strict: bool = False,
        resume_artifact_id: str | None = None,
        download_timeout: float = DEFAULT_DOWNLOAD_TIMEOUT,
    ):
        self._client = client
        self.job_id = job_id
        self.experiment_id = experiment_id
        self._batch_size = batch_size
        self._flush_interval = flush_interval
        self._strict = strict
        self._resume_artifact_id = resume_artifact_id or None
        self._download_timeout = download_timeout

        self._buffer: list[dict] = []
        # A DataLoader worker or a callback may log from another thread. The lock is
        # around the buffer only; the HTTP call happens outside it, so a slow control
        # plane cannot block the training loop that is trying to append.
        self._lock = threading.Lock()
        self._last_flush = time.monotonic()
        self._dropped = 0
        self._finished = False

    # ---------------------------------------------------------------- metrics

    def log_metric(self, name: str, value: float, *, step: int, epoch: int | None = None) -> None:
        """Records one value. See :meth:`log_metrics` for the batched form."""
        self.log_metrics({name: value}, step=step, epoch=epoch)

    def log_metrics(self, metrics: dict, *, step: int, epoch: int | None = None) -> None:
        """Records several values observed at the same step.

        The timestamp is taken **now**, not when the batch is sent. A run that buffers
        for ten seconds and flushes in one request would otherwise have ten seconds of
        history collapse onto the moment of the flush, and the curve would lose its
        shape. The server stores what is sent here (ADR 0009).
        """
        if self._finished:
            raise RuntimeError("this run has been finished; metrics logged after it are lost")

        observed = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        points = [
            {
                "name": str(name),
                "value": float(value),
                "step": int(step),
                "recorded_at": observed,
                **({"epoch": int(epoch)} if epoch is not None else {}),
            }
            for name, value in metrics.items()
        ]

        with self._lock:
            self._buffer.extend(points)
            due = (
                len(self._buffer) >= self._batch_size
                or time.monotonic() - self._last_flush >= self._flush_interval
            )

        if due:
            self.flush()

    def flush(self) -> int:
        """Sends everything buffered. Returns how many points were written.

        Failures are swallowed unless the run is strict: a metric is telemetry, and
        losing one must not end a training job. What is not swallowed is the fact of
        the loss — dropped points are counted and reported at :meth:`finish`.
        """
        with self._lock:
            batch, self._buffer = self._buffer, []
            self._last_flush = time.monotonic()

        if not batch:
            return 0

        try:
            self._client.request("POST", f"/api/v1/jobs/{self.job_id}/metrics", {"metrics": batch})
            return len(batch)
        except ApiError as err:
            if self._strict:
                raise
            # Deliberately not re-buffered. A control plane that is down stays down for
            # a while, and a buffer that grows without bound during an outage would
            # eventually take the training process with it — which is the exact failure
            # this whole design exists to avoid.
            self._dropped += len(batch)
            log.warning("ashml: dropped %d metric point(s): %s", len(batch), err)
            return 0

    # -------------------------------------------------------------- artifacts

    def log_artifact(
        self,
        path: str,
        *,
        name: str | None = None,
        kind: str = "checkpoint",
        step: int | None = None,
        metadata: dict | None = None,
    ) -> Artifact:
        """Uploads a file and registers it against this run.

        Three steps, in this order: register (the control plane allocates a location and
        hands back a presigned URL), upload, confirm. If the upload fails the artifact is
        marked FAILED rather than left PENDING forever, so the gap is visible.

        Strict regardless of ``strict``: a checkpoint that silently did not save is
        discovered days later, by something trying to resume from it.
        """
        if not os.path.isfile(path):
            raise FileNotFoundError(path)

        # Buffered metrics go out *before* the artifact does, so that a checkpoint and
        # the history of the work it contains cannot be separated by a kill.
        #
        # This is not tidiness. If the pod dies after this point, the retry resumes from
        # this checkpoint and starts reporting at the step after it — so any point still
        # sitting in the buffer describes work that no attempt will ever report again,
        # and the curve keeps a hole in it for ever. Flushing here bounds what an
        # interruption costs the record to the same thing it costs the training: the
        # work since the last checkpoint.
        self.flush()

        artifact_name = name or os.path.basename(path)
        size = os.path.getsize(path)

        body = {"kind": kind, "name": artifact_name}
        if step is not None:
            body["step"] = int(step)
        if metadata:
            body["metadata"] = metadata

        registered = self._client.request("POST", f"/api/v1/jobs/{self.job_id}/artifacts", body)
        artifact = registered["artifact"]
        upload = registered.get("upload")

        if upload is None:
            raise RuntimeError(
                f"AshML did not return an upload URL for {artifact_name}; the control plane "
                "has no artifact store configured, so it cannot accept the bytes"
            )

        try:
            # Hashed in a separate pass rather than while uploading. Two reads of a
            # large file cost disk bandwidth, but a hash computed during the upload is
            # consumed by it — and an upload that has to be retried would then have no
            # digest to report.
            digest = _sha256(path)
            _put_file(upload["url"], path, size)
        except Exception as err:
            self._fail_artifact(artifact["id"], f"upload failed: {err}")
            raise

        confirmed = self._client.request(
            "POST",
            f"/api/v1/artifacts/{artifact['id']}/complete",
            {"digest": f"sha256:{digest}", "size_bytes": size},
        )
        return Artifact(confirmed)

    def _fail_artifact(self, artifact_id: str, reason: str) -> None:
        try:
            self._client.request("POST", f"/api/v1/artifacts/{artifact_id}/fail", {"reason": reason[:500]})
        except ApiError as err:
            # The original failure is the one worth raising; this one only means the
            # record will stay PENDING, which the platform already treats as suspect.
            log.warning("ashml: could not mark artifact %s failed: %s", artifact_id, err)


    # ---------------------------------------------------------------- resuming

    @property
    def resume_artifact_id(self) -> str | None:
        """The checkpoint AshML is offering this attempt, or ``None``.

        Set from ``ASHML_RESUME_FROM``, which the control plane injects **only** on a
        retry that has a confirmed checkpoint to point at. A first attempt never has
        one, so ``None`` is the ordinary case and not an error.
        """
        return self._resume_artifact_id

    def fetch_resume(self, dest: str | None = None) -> str | None:
        """Downloads the checkpoint this attempt should resume from, if there is one.

        Returns a local path, or ``None`` when this is not a resumed attempt — so the
        calling shape is::

            resume = run.fetch_resume()
            if resume:
                state = torch.load(resume)

        What it deliberately does not do is return ``None`` when a checkpoint *was*
        offered and could not be fetched. That would turn a recoverable interruption
        into a run that silently restarts from step zero while its logs, its metric
        steps and its next checkpoint all claim otherwise — the failure is discovered
        much later, in a curve with a discontinuity nobody can explain. A resume that
        was promised and cannot be delivered raises.
        """
        if not self._resume_artifact_id:
            return None
        return self.download_artifact(self._resume_artifact_id, dest)

    def download_artifact(self, artifact_id: str, dest: str | None = None, *, verify: bool = True) -> str:
        """Fetches an artifact's bytes, returning the path they were written to.

        The artifact id is exchanged for a time-limited URL at the moment of the
        download rather than being handed one earlier, for the reason the model server
        does the same: a signature minted when a manifest was written has usually
        expired by the time a pod restarts and tries to use it.

        ``dest`` may be a directory (the artifact's name is used inside it), a file
        path, or ``None`` for a temporary file. The bytes land at ``dest + ".part"``
        and are renamed only once the download is complete and verified, because a
        truncated checkpoint that torch is willing to load is worse than no checkpoint
        at all.

        ``verify`` compares what arrived against the size and digest recorded when the
        artifact was confirmed. Phase 4 deferred digest verification on the *upload*
        side, where reading a 30 GB object back would cost more than it proves; here
        the bytes are being read anyway, so checking them is nearly free and this is
        the moment they matter.
        """
        record = self._client.request("GET", f"/api/v1/artifacts/{artifact_id}")
        signed = self._client.request("GET", f"/api/v1/artifacts/{artifact_id}/download")
        url = signed.get("url")
        if not url:
            raise RuntimeError(
                f"AshML returned no download URL for artifact {artifact_id}; the control "
                "plane has no artifact store configured, so it cannot serve the bytes"
            )

        path = _resolve_dest(dest, record.get("name") or artifact_id)
        partial = f"{path}.part"

        digest = _download(url, partial, timeout=self._download_timeout)
        try:
            if verify:
                _verify(partial, record, digest, artifact_id)
        except Exception:
            os.unlink(partial)
            raise

        os.replace(partial, path)
        return path

    # ------------------------------------------------------------- experiment

    def report_started(self, *, framework: str = "", hardware: dict | None = None) -> None:
        """Stamps the experiment's start and records what this run observed.

        A no-op when the job has no experiment: there is nothing to stamp, and inventing
        an experiment for a bare job would create a record nobody asked for.
        """
        self._report("started", framework=framework, hardware=hardware)

    def finish(self) -> None:
        """Flushes what is buffered and closes the run.

        Called automatically by the context manager. Safe to call twice.
        """
        if self._finished:
            return

        self.flush()
        self._finished = True
        self._report("finished")

        if self._dropped:
            # Said loudly at the end, because a curve with holes in it looks like a
            # training problem until you know it was a network one.
            log.warning(
                "ashml: %d metric point(s) were dropped and are NOT in the run's history",
                self._dropped,
            )

    def _report(self, phase: str, *, framework: str = "", hardware: dict | None = None) -> None:
        if not self.experiment_id:
            return

        body = {"phase": phase}
        if phase == "started":
            body["framework"] = framework
            body["hardware"] = hardware or {}
            body["sdk_version"] = _version()

        try:
            self._client.request("POST", f"/api/v1/experiments/{self.experiment_id}/report", body)
        except ApiError as err:
            if self._strict:
                raise
            log.warning("ashml: could not report run %s: %s", phase, err)

    # --------------------------------------------------------- context manager

    def __enter__(self) -> "Run":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        # Finishes even when the training loop raised. A run that crashed still
        # happened, and the metrics up to the crash are the most interesting ones.
        self.finish()
        return False

    def __repr__(self):
        return f"<ashml.Run job={self.job_id} experiment={self.experiment_id}>"


def _sha256(path: str, chunk: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def _put_file(url: str, path: str, size: int) -> None:
    """Streams a file to a presigned URL.

    The file object is handed to urllib rather than read into memory: a checkpoint is
    exactly the kind of thing that does not fit. ``Content-Length`` must be set
    explicitly, because urllib cannot infer it from a file object and would otherwise
    fall back to chunked encoding, which S3 presigned PUTs reject.
    """
    with open(path, "rb") as handle:
        request = urllib.request.Request(
            url,
            data=handle,
            method="PUT",
            headers={"Content-Length": str(size)},
        )
        with urllib.request.urlopen(request, timeout=600) as res:
            if res.status >= 300:
                raise RuntimeError(f"upload returned HTTP {res.status}")


def _resolve_dest(dest: str | None, name: str) -> str:
    """Where the bytes go: a temporary file, a named file, or a name inside a directory."""
    if dest is None:
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=_suffix(name))
        handle.close()
        return handle.name
    if os.path.isdir(dest):
        return os.path.join(dest, os.path.basename(name))
    return dest


def _suffix(name: str) -> str:
    _, ext = os.path.splitext(name)
    return ext if len(ext) <= 8 else ""


def _download(url: str, path: str, *, timeout: float, chunk: int = 1024 * 1024) -> str:
    """Streams a URL to a file, returning the sha256 of what was written.

    Streamed and hashed in one pass. The file is exactly the thing that does not fit in
    memory, and a second pass over it to hash would double the read for no gain — unlike
    the upload path, where the digest has to survive a retried PUT.
    """
    digest = hashlib.sha256()
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response, open(path, "wb") as out:
            while True:
                block = response.read(chunk)
                if not block:
                    break
                digest.update(block)
                out.write(block)
    except Exception:
        # Nothing downstream should find a half-written file to be tempted by.
        if os.path.exists(path):
            os.unlink(path)
        raise
    return digest.hexdigest()


def _verify(path: str, record: dict, digest: str, artifact_id: str) -> None:
    """Checks what arrived against what the artifact says it is.

    Size first, because a truncated download is the likely failure and its message is
    the more useful one. The digest is compared only when the record has one: an
    artifact registered before digests were recorded, or completed without one, is not
    evidence of corruption and must not be reported as such.
    """
    size = os.path.getsize(path)
    expected_size = record.get("size_bytes")
    if expected_size is not None and int(expected_size) != size:
        raise RuntimeError(
            f"artifact {artifact_id} downloaded as {size} bytes but is recorded as "
            f"{expected_size}; the object is truncated or is not the one recorded"
        )

    expected = (record.get("digest") or "").strip()
    if not expected:
        return

    algorithm, _, value = expected.partition(":")
    if not value or algorithm.lower() != "sha256":
        # Not a failure of the bytes. Saying so plainly beats either ignoring the field
        # or raising as though the checkpoint were corrupt.
        log.warning(
            "ashml: artifact %s records digest %r, which this SDK cannot check; "
            "size was verified, contents were not", artifact_id, expected,
        )
        return

    if value.lower() != digest:
        raise RuntimeError(
            f"artifact {artifact_id} does not match its recorded digest: expected "
            f"sha256:{value}, got sha256:{digest}"
        )


def _version() -> str:
    from . import __version__

    return __version__
