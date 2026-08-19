"""The SDK against a **running AshML**, with a real database and a real bucket.

``test_sdk.py`` proves the SDK sends what it means to. This proves the control plane
accepts it — which is the half a stub can never check, because a stub agrees with
whatever the SDK does.

Skips visibly when there is no server, in the same spirit as the JavaScript integration
suites. Point it at one with::

    ASHML_ENDPOINT=http://127.0.0.1:8080 python3 -m unittest discover -s sdk/python/tests

The server must have an artifact store configured, or the upload assertions cannot mean
anything.
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ashml  # noqa: E402
from ashml._client import ApiError, Client  # noqa: E402

ENDPOINT = os.environ.get("ASHML_ENDPOINT", "http://127.0.0.1:8080")


def _server_is_up() -> bool:
    try:
        with urllib.request.urlopen(f"{ENDPOINT}/healthz", timeout=2) as res:
            return res.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


SKIP = None if _server_is_up() else f"no AshML at {ENDPOINT} — start one to include these tests"


@unittest.skipIf(SKIP, SKIP)
class LiveTest(unittest.TestCase):
    """One project, one experiment, one running job, per test."""

    @classmethod
    def setUpClass(cls):
        cls.api = Client(ENDPOINT)
        cls.project = f"sdk-{os.getpid()}-{int(time.time())}"
        cls.api.request("POST", "/api/v1/projects", {"name": cls.project, "gpu_quota": 8})

    def setUp(self):
        self.experiment = self.api.request("POST", "/api/v1/experiments", {
            "project": self.project,
            "name": "sdk-live",
            "random_seed": 1337,
        })
        self.job = self._running_job()

    def _running_job(self) -> dict:
        """Submits a job and waits for the executor to get it to RUNNING.

        Requires the server to be running the `sim` execution backend; against a real
        cluster the image would have to exist and this would take minutes.
        """
        job = self.api.request("POST", "/api/v1/jobs", {
            "project": self.project,
            "name": f"sdk-{int(time.time() * 1000) % 10_000_000}",
            "experiment": self.experiment["id"],
            "spec": {"image": "busybox:1.36", "command": ["sh", "-c", "true"]},
            "resources": {"cpu": 1},
        })

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            current = self.api.request("GET", f"/api/v1/jobs/{job['id']}")
            if current["state"] == "RUNNING":
                return current
            if current["state"] in ("FAILED", "CANCELLED", "SUCCEEDED"):
                self.skipTest(f"the job reached {current['state']} before it could report")
            time.sleep(0.5)

        self.skipTest("the job never reached RUNNING; is the executor enabled?")
        return job  # unreachable

    def run_for(self, job, **options):
        return ashml.init(
            endpoint=ENDPOINT,
            job_id=job["id"],
            experiment_id=self.experiment["id"],
            strict=True,
            **options,
        )

    def test_a_training_loop_reports_a_curve_the_platform_can_read_back(self):
        with self.run_for(self.job, batch_size=5) as run:
            for step in range(10):
                run.log_metrics({"loss": 2.0 - step * 0.1, "accuracy": step * 0.05}, step=step, epoch=step // 5)

        series = self.api.request("GET", f"/api/v1/jobs/{self.job['id']}/metrics")["series"]
        by_name = {s["name"]: s for s in series}

        self.assertEqual(sorted(by_name), ["accuracy", "loss"])
        self.assertEqual([p["step"] for p in by_name["loss"]["points"]], list(range(10)))
        self.assertAlmostEqual(by_name["loss"]["points"][0]["value"], 2.0)
        # Epochs the run reported, not epochs anything inferred.
        self.assertEqual(by_name["loss"]["points"][9]["epoch"], 1)

    def test_the_points_keep_the_order_and_times_the_run_observed(self):
        with self.run_for(self.job, batch_size=100, flush_interval=3600) as run:
            for step in range(3):
                run.log_metrics({"loss": 1.0 / (step + 1)}, step=step)
                time.sleep(0.05)
            # All three leave in one request at finish(), having been observed apart.

        points = self.api.request(
            "GET", f"/api/v1/jobs/{self.job['id']}/metrics?name=loss"
        )["series"][0]["points"]

        stamps = [p["recorded_at"] for p in points]
        self.assertEqual(len(set(stamps)), 3, "a batched flush must not collapse the history")
        self.assertEqual(stamps, sorted(stamps))

    def test_the_summary_reflects_what_was_logged(self):
        with self.run_for(self.job, batch_size=100) as run:
            for step in range(4):
                run.log_metric("loss", 1.0 - step * 0.2, step=step)

        summary = self.api.request("GET", f"/api/v1/jobs/{self.job['id']}/metrics/summary")["metrics"]
        loss = next(m for m in summary if m["name"] == "loss")
        self.assertEqual(loss["count"], 4)
        self.assertEqual(loss["last_step"], 3)
        self.assertAlmostEqual(loss["last_value"], 0.4, places=6)

    def test_a_checkpoint_is_uploaded_and_verified_by_the_platform(self):
        payload = os.urandom(64 * 1024)
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pt") as handle:
            handle.write(payload)
            path = handle.name
        self.addCleanup(os.unlink, path)

        with self.run_for(self.job) as run:
            artifact = run.log_artifact(path, name="epoch-1.pt", kind="checkpoint", step=100)

        self.assertEqual(artifact.status, "READY")
        # The whole point of the round trip: AshML asked the bucket, and the bytes were
        # there. Not "the SDK said the upload worked".
        self.assertTrue(artifact.verified, "the control plane should have verified this upload")
        self.assertEqual(artifact.size_bytes, len(payload))
        self.assertTrue(artifact.digest.startswith("sha256:"))

        fetched = self.api.request("GET", f"/api/v1/artifacts/{artifact.id}/download")
        with urllib.request.urlopen(fetched["url"], timeout=30) as res:
            self.assertEqual(res.read(), payload, "what comes back must be what went up")

    def test_the_experiment_records_the_run_window_and_what_it_observed(self):
        with self.run_for(self.job):
            pass

        experiment = self.api.request("GET", f"/api/v1/experiments/{self.experiment['id']}")
        self.assertIsNotNone(experiment["started_at"])
        self.assertIsNotNone(experiment["ended_at"])
        self.assertEqual(
            experiment["reproducibility"]["observed"]["sdk_version"], ashml.__version__
        )
        # No torch in this environment, so the framework is empty rather than invented.
        self.assertIn("framework", experiment["reproducibility"]["observed"])

    def test_a_job_that_never_ran_is_refused_by_the_server(self):
        queued = self.api.request("POST", "/api/v1/jobs", {
            "project": self.project,
            "name": f"never-{int(time.time() * 1000) % 10_000_000}",
            # More GPUs than any node has, so it stays queued rather than racing us.
            "spec": {"image": "busybox:1.36"},
            "resources": {"cpu": 1, "gpu": 99},
        })

        run = ashml.init(endpoint=ENDPOINT, job_id=queued["id"], report_start=False, strict=True)
        with self.assertRaises(ApiError) as caught:
            run.log_metrics({"loss": 1.0}, step=0)
            run.flush()

        self.assertEqual(caught.exception.code, "JOB_NOT_STARTED")


if __name__ == "__main__":
    unittest.main()
