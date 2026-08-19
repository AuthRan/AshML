"""Unit tests for the SDK, against a stub control plane.

The stub is a real HTTP server on a real socket, not a monkeypatched ``urlopen``:
half of what this SDK does is get the HTTP right — the Content-Length on a presigned
PUT, the error envelope, the retry on a 503 — and a patched client would agree with
whatever the SDK did.

The other half, whether the control plane accepts what is sent, is
``test_live.py``, which needs a running AshML.

    python3 -m unittest discover -s sdk/python/tests -v
"""

from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
import threading
import unittest
import unittest.mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ashml  # noqa: E402
from ashml._client import ApiError, Client  # noqa: E402


class StubHandler(BaseHTTPRequestHandler):
    """Records every request and replies from a scripted queue."""

    def do_POST(self):  # noqa: N802 - the BaseHTTPRequestHandler interface
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length) if length else b""
        self.server.requests.append({
            "path": self.path,
            "method": "POST",
            "body": json.loads(raw) if raw else None,
            "headers": dict(self.headers),
        })
        self._reply()

    def do_PUT(self):  # noqa: N802
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length) if length else b""
        self.server.requests.append({
            "path": self.path,
            "method": "PUT",
            "bytes": raw,
            "headers": dict(self.headers),
        })
        self._reply()

    def _reply(self):
        status, payload = self.server.script.pop(0) if self.server.script else (200, {})
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # the test output is the assertions, not an access log


class StubServer:
    def __enter__(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
        self.server.requests = []
        self.server.script = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
        return False

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    @property
    def requests(self):
        return self.server.requests

    def script(self, *responses):
        self.server.script = list(responses)


JOB = "11111111-2222-3333-4444-555555555555"
EXPERIMENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class InitTest(unittest.TestCase):
    def test_reads_identity_from_the_environment(self):
        with StubServer() as stub:
            env = {
                "ASHML_ENDPOINT": stub.url,
                "ASHML_JOB_ID": JOB,
                "ASHML_EXPERIMENT_ID": EXPERIMENT,
            }
            with unittest.mock.patch.dict(os.environ, env, clear=True):
                run = ashml.init(report_start=False)

            self.assertEqual(run.job_id, JOB)
            self.assertEqual(run.experiment_id, EXPERIMENT)

    def test_refuses_to_guess_a_job_id(self):
        # Reporting into the void is the good outcome here; the bad one is reporting
        # onto another run's record.
        with unittest.mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "no job id"):
                ashml.init()

    def test_refuses_to_guess_an_endpoint(self):
        with unittest.mock.patch.dict(os.environ, {"ASHML_JOB_ID": JOB}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "no endpoint"):
                ashml.init()

    def test_a_job_without_an_experiment_is_not_given_one(self):
        with StubServer() as stub:
            env = {"ASHML_ENDPOINT": stub.url, "ASHML_JOB_ID": JOB, "ASHML_EXPERIMENT_ID": ""}
            with unittest.mock.patch.dict(os.environ, env, clear=True):
                run = ashml.init(report_start=True)

            self.assertIsNone(run.experiment_id)
            # No report call was made: there is no experiment to stamp, and inventing
            # one would create a record nobody asked for.
            self.assertEqual([r["path"] for r in stub.requests], [])

    def test_reports_the_start_when_there_is_an_experiment(self):
        with StubServer() as stub:
            stub.script((200, {}))
            env = {"ASHML_ENDPOINT": stub.url, "ASHML_JOB_ID": JOB, "ASHML_EXPERIMENT_ID": EXPERIMENT}
            with unittest.mock.patch.dict(os.environ, env, clear=True):
                ashml.init()

            self.assertEqual(stub.requests[0]["path"], f"/api/v1/experiments/{EXPERIMENT}/report")
            body = stub.requests[0]["body"]
            self.assertEqual(body["phase"], "started")
            self.assertEqual(body["sdk_version"], ashml.__version__)


class MetricsTest(unittest.TestCase):
    def run_against(self, stub, **options):
        # retries=0: these tests are about what the Run does with a failure, not about
        # the client's backoff (ClientTest covers that). Retrying here would only make
        # the suite sleep through the jitter.
        return ashml.Run(Client(stub.url, retries=0), JOB, **options)

    def test_metrics_are_buffered_until_the_batch_fills(self):
        with StubServer() as stub:
            stub.script(*[(201, {"written": 3})] * 5)
            run = self.run_against(stub, batch_size=3, flush_interval=3600)

            run.log_metrics({"loss": 1.0}, step=0)
            run.log_metrics({"loss": 0.9}, step=1)
            # One request per metric per step would put a network round trip inside the
            # training loop.
            self.assertEqual(len(stub.requests), 0)

            run.log_metrics({"loss": 0.8}, step=2)
            self.assertEqual(len(stub.requests), 1)
            self.assertEqual(len(stub.requests[0]["body"]["metrics"]), 3)

    def test_each_point_carries_when_it_was_observed(self):
        with StubServer() as stub:
            stub.script((201, {"written": 2}))
            run = self.run_against(stub, batch_size=100, flush_interval=3600)

            run.log_metrics({"loss": 1.0}, step=0)
            run.log_metrics({"loss": 0.5}, step=1)
            run.flush()

            points = stub.requests[0]["body"]["metrics"]
            # Both were sent in one request, but they were not observed at one instant.
            # Timestamping at flush time would collapse the history onto the flush.
            self.assertEqual(len(points), 2)
            self.assertNotEqual(points[0]["recorded_at"], points[1]["recorded_at"])
            for point in points:
                self.assertTrue(point["recorded_at"].endswith("Z"), point["recorded_at"])

    def test_epoch_is_sent_only_when_given(self):
        with StubServer() as stub:
            stub.script((201, {}), (201, {}))
            run = self.run_against(stub, batch_size=1)

            run.log_metrics({"loss": 1.0}, step=0)
            self.assertNotIn("epoch", stub.requests[0]["body"]["metrics"][0])

            run.log_metrics({"loss": 1.0}, step=1, epoch=0)
            # Not every workload has epochs, and 0 is a real epoch — it must not be
            # confused with "absent".
            self.assertEqual(stub.requests[1]["body"]["metrics"][0]["epoch"], 0)

    def test_a_failed_flush_does_not_kill_the_training_loop(self):
        with StubServer() as stub:
            stub.script(*[(500, {})] * 10)
            run = self.run_against(stub, batch_size=1)

            with self.assertLogs("ashml", level=logging.WARNING) as logged:
                run.log_metrics({"loss": 1.0}, step=0)  # must not raise

            self.assertIn("dropped 1 metric point", "\n".join(logged.output))

    def test_a_strict_run_raises_instead(self):
        with StubServer() as stub:
            stub.script(*[(500, {})] * 10)
            run = self.run_against(stub, batch_size=1, strict=True)

            with self.assertRaises(ApiError):
                run.log_metrics({"loss": 1.0}, step=0)

    def test_dropped_points_are_reported_at_the_end(self):
        with StubServer() as stub:
            stub.script(*[(500, {})] * 20)
            run = self.run_against(stub, batch_size=1)
            run.log_metrics({"loss": 1.0}, step=0)

            with self.assertLogs("ashml", level=logging.WARNING) as logged:
                run.finish()

            # A curve with holes in it looks like a training problem until you are told
            # it was a network one.
            self.assertIn("are NOT in the run's history", "\n".join(logged.output))

    def test_a_buffer_is_not_regrown_during_an_outage(self):
        with StubServer() as stub:
            stub.script(*[(500, {})] * 40)
            run = self.run_against(stub, batch_size=1)
            with self.assertLogs("ashml", level=logging.WARNING):
                for step in range(5):
                    run.log_metrics({"loss": 1.0}, step=step)

            # Re-buffering failed points would grow without bound while the control
            # plane is down and eventually take the training process with it.
            self.assertEqual(run._buffer, [])

    def test_the_context_manager_finishes_even_when_training_raises(self):
        with StubServer() as stub:
            stub.script((201, {}), (200, {}))
            with self.assertRaises(ZeroDivisionError):
                with ashml.Run(Client(stub.url, retries=0), JOB, batch_size=100, flush_interval=3600) as run:
                    run.log_metrics({"loss": 1.0}, step=0)
                    raise ZeroDivisionError("the training loop blew up")

            # The metrics up to the crash are the interesting ones.
            self.assertEqual(stub.requests[0]["path"], f"/api/v1/jobs/{JOB}/metrics")

    def test_logging_after_finish_is_an_error_not_a_silent_loss(self):
        with StubServer() as stub:
            stub.script((200, {}))
            run = self.run_against(stub)
            run.finish()

            with self.assertRaisesRegex(RuntimeError, "finished"):
                run.log_metrics({"loss": 1.0}, step=0)


class ArtifactTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pt")
        self.tmp.write(b"pretend these are weights")
        self.tmp.close()
        self.addCleanup(os.unlink, self.tmp.name)

    def test_register_upload_confirm(self):
        with StubServer() as stub:
            artifact = {"id": "art-1", "name": "final.pt", "status": "PENDING"}
            stub.script(
                (201, {"artifact": artifact, "upload": {"method": "PUT", "url": None}}),
                (200, {}),                                   # the upload itself
                (200, {**artifact, "status": "READY", "verified": True}),
            )
            # The stub is its own upload target, so the presigned URL points back at it.
            stub.server.script[0][1]["upload"]["url"] = f"{stub.url}/upload-here"

            run = ashml.Run(Client(stub.url, retries=0), JOB)
            result = run.log_artifact(self.tmp.name, name="final.pt", kind="model", step=42)

            paths = [r["path"] for r in stub.requests]
            self.assertEqual(paths, [f"/api/v1/jobs/{JOB}/artifacts", "/upload-here", "/api/v1/artifacts/art-1/complete"])

            # Registration says what is coming, not that it has arrived.
            self.assertEqual(stub.requests[0]["body"]["kind"], "model")
            self.assertEqual(stub.requests[0]["body"]["step"], 42)

            # The bytes go to the presigned URL, with a length: urllib would otherwise
            # use chunked encoding, which presigned PUTs reject.
            self.assertEqual(stub.requests[1]["bytes"], b"pretend these are weights")
            self.assertEqual(stub.requests[1]["headers"]["Content-Length"], "25")

            # And the confirmation carries what was actually written.
            confirm = stub.requests[2]["body"]
            self.assertEqual(confirm["size_bytes"], 25)
            self.assertTrue(confirm["digest"].startswith("sha256:"))
            self.assertEqual(result.status, "READY")

    def test_the_name_defaults_to_the_filename(self):
        with StubServer() as stub:
            stub.script(
                (201, {"artifact": {"id": "a"}, "upload": {"url": f"{stub.url}/u", "method": "PUT"}}),
                (200, {}),
                (200, {"id": "a", "status": "READY"}),
            )
            ashml.Run(Client(stub.url, retries=0), JOB).log_artifact(self.tmp.name)
            self.assertEqual(stub.requests[0]["body"]["name"], os.path.basename(self.tmp.name))

    def test_a_failed_upload_marks_the_artifact_rather_than_leaving_it_pending(self):
        with StubServer() as stub:
            stub.script(
                (201, {"artifact": {"id": "art-2"}, "upload": {"url": f"{stub.url}/u", "method": "PUT"}}),
                (500, {}),                                    # the upload fails
                (200, {}),                                    # ... /fail
            )
            run = ashml.Run(Client(stub.url, retries=0), JOB)

            with self.assertRaises(Exception):
                run.log_artifact(self.tmp.name)

            # A PENDING row that nothing will ever settle is invisible rot; FAILED is a
            # fact about the run.
            self.assertEqual(stub.requests[-1]["path"], "/api/v1/artifacts/art-2/fail")

    def test_artifacts_are_strict_even_when_the_run_is_not(self):
        with StubServer() as stub:
            stub.script(*[(500, {})] * 10)
            run = ashml.Run(Client(stub.url, retries=0), JOB, strict=False)

            # A checkpoint that silently did not save is discovered days later, by
            # something trying to resume from it.
            with self.assertRaises(ApiError):
                run.log_artifact(self.tmp.name)

    def test_a_missing_file_fails_before_anything_is_registered(self):
        with StubServer() as stub:
            run = ashml.Run(Client(stub.url, retries=0), JOB)
            with self.assertRaises(FileNotFoundError):
                run.log_artifact("/no/such/checkpoint.pt")
            self.assertEqual(stub.requests, [])

    def test_a_control_plane_with_no_store_says_so_clearly(self):
        with StubServer() as stub:
            stub.script((201, {"artifact": {"id": "a"}, "upload": None}))
            run = ashml.Run(Client(stub.url, retries=0), JOB)

            with self.assertRaisesRegex(RuntimeError, "no artifact store configured"):
                run.log_artifact(self.tmp.name)


class ClientTest(unittest.TestCase):
    def test_a_server_error_is_retried(self):
        with StubServer() as stub:
            stub.script((503, {}), (503, {}), (201, {"written": 1}))
            result = Client(stub.url, retries=3).request("POST", "/x", {"a": 1})

            self.assertEqual(result, {"written": 1})
            self.assertEqual(len(stub.requests), 3, "the first two failures should be retried")

    def test_a_client_error_is_not_retried(self):
        with StubServer() as stub:
            stub.script((409, {"error": {"code": "JOB_NOT_STARTED", "message": "job is QUEUED"}}))

            with self.assertRaises(ApiError) as caught:
                Client(stub.url, retries=3).request("POST", "/x", {})

            # Repeating a request the server has said is wrong wastes the training
            # loop's time and hides the problem.
            self.assertEqual(len(stub.requests), 1)
            self.assertEqual(caught.exception.status, 409)
            self.assertEqual(caught.exception.code, "JOB_NOT_STARTED")
            self.assertIn("job is QUEUED", str(caught.exception))

    def test_an_unreachable_control_plane_is_a_transport_error(self):
        # Port 1 is reliably closed; no server is started here on purpose.
        with self.assertRaises(ApiError) as caught:
            Client("http://127.0.0.1:1", retries=0).request("GET", "/healthz")
        self.assertIsNone(caught.exception.code)
        self.assertTrue(caught.exception.retryable)


class DetectionTest(unittest.TestCase):
    def test_no_framework_is_reported_as_nothing_rather_than_guessed(self):
        # This environment has no torch. An experiment record naming a framework the run
        # did not use is worse than one saying nothing (spec Rule 5).
        if "torch" in sys.modules:
            self.skipTest("torch is installed here; this asserts the absent case")
        self.assertEqual(ashml.detect_framework(), "")
        self.assertEqual(ashml.detect_hardware(), {})


if __name__ == "__main__":

    unittest.main()
