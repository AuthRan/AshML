"""AshML's inference server: the process a deployed model version runs as.

One deployment serves one model version. The server is handed an artifact id and an
architecture name, fetches a time-limited download URL from the control plane exactly
as the training SDK does for uploads, loads the weights, and only then reports itself
ready.

    ASHML_ENDPOINT=http://ashml:8080 \
    ASHML_ARTIFACT_ID=<uuid> \
    ASHML_MODEL_ARCH=resnet18-cifar \
    python serve.py

Three endpoints, and the distinction between the first two is the whole point:

    GET  /healthz   the process is alive
    GET  /readyz    the weights are loaded and a forward pass has been proven
    GET  /metadata  what is actually loaded here
    POST /predict   {"instances": [[[r,g,b] x32] x32]}  ->  class + confidence

`/healthz` answers as soon as the HTTP server binds. `/readyz` answers 200 only once
the model is in memory and has produced an output, which on a cold start is a good
few seconds later -- long enough that a readiness probe wired to `/healthz` would send
traffic to a process with no weights in it and return 503s that look like the model's
fault. Kubernetes needs both because they answer different questions: restart me, and
route to me.

No third-party HTTP dependency on purpose. Torch is already the large and fragile part
of this image; adding a web framework to serve four routes buys nothing.
"""

import io
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
import torch.nn as nn
import torchvision


def env_int(name, default):
    return int(os.environ.get(name, default))


ENDPOINT = os.environ.get("ASHML_ENDPOINT", "").rstrip("/")
ARTIFACT_ID = os.environ.get("ASHML_ARTIFACT_ID", "")
MODEL_URL = os.environ.get("ASHML_MODEL_URL", "")
ARCH = os.environ.get("ASHML_MODEL_ARCH", "resnet18-cifar")
PORT = env_int("ASHML_PORT", 8081)
TIMEOUT = env_int("ASHML_HTTP_TIMEOUT", 30)

#: Bounds how many forward passes run at once. Torch already uses every thread it was
#: given per pass, so admitting unlimited concurrent requests does not increase
#: throughput -- it multiplies latency and memory while the work queues inside BLAS.
MAX_CONCURRENCY = env_int("ASHML_MAX_CONCURRENCY", 4)

#: Caps a single request. Without it a client can post an arbitrarily large batch and
#: hold a worker for as long as it takes.
MAX_BATCH = env_int("ASHML_MAX_BATCH", 64)

#: Must match what the model was trained with. The source of truth is
#: `examples/training/resnet_cifar.py`; normalising differently at serving time is a
#: silent accuracy loss that no error message would ever point at, so the check is not
#: that these constants look right -- it is that the deployed model reproduces the
#: accuracy recorded for its artifact.
CIFAR10_MEAN = (0.4914, 0.4822, 0.4465)
CIFAR10_STD = (0.2470, 0.2435, 0.2616)

CIFAR10_CLASSES = (
    "airplane", "automobile", "bird", "cat", "deer",
    "dog", "frog", "horse", "ship", "truck",
)


def build_resnet18_cifar() -> nn.Module:
    """The CIFAR variant: 3x3 stride-1 stem, no max-pool.

    Identical to the training script's `build_model`. It has to be: a state_dict is
    weights without structure, so loading one into the wrong architecture either throws
    on a shape mismatch or -- worse, if the shapes happen to line up -- quietly serves
    something that is not the model that was evaluated.
    """
    model = torchvision.models.resnet18(weights=None, num_classes=10)
    model.conv1 = nn.Conv2d(3, 64, kernel_size=3, stride=1, padding=1, bias=False)
    model.maxpool = nn.Identity()
    return model


#: Architectures this server has code for. A model version naming anything else is
#: refused at startup rather than half-loaded: this server can only serve shapes it can
#: reconstruct, and saying so plainly is better than a shape-mismatch traceback.
ARCHITECTURES = {
    "resnet18-cifar": (build_resnet18_cifar, CIFAR10_CLASSES),
}


#: How many times to try loading the model, and how long to wait between tries. The
#: budget is generous because the cost of giving up is a pod that serves nothing until a
#: human notices, and the cost of waiting is a pod that is not ready yet — which is
#: already visible, already excluded from the Service, and already the normal state
#: during a cold start.
LOAD_ATTEMPTS = env_int("ASHML_LOAD_ATTEMPTS", 12)
LOAD_BACKOFF_BASE = float(os.environ.get("ASHML_LOAD_BACKOFF_BASE", "2"))
LOAD_BACKOFF_MAX = float(os.environ.get("ASHML_LOAD_BACKOFF_MAX", "30"))


class _Permanent(Exception):
    """A load failure that asking again cannot fix."""


def _classify(err):
    """Re-raises a fetch failure as `_Permanent` when a retry could not change it.

    4xx is the server saying the request is wrong: the artifact does not exist, or is
    not READY, or this is not a thing that can be downloaded. Repeating it produces the
    same answer. 5xx, 429 and any transport failure are a bad moment, which is the case
    this whole retry exists for.
    """
    if isinstance(err, urllib.error.HTTPError) and 400 <= err.code < 500 and err.code != 429:
        detail = ""
        try:
            detail = f": {json.loads(err.read())['error']['message']}"
        except Exception:  # noqa: BLE001 - the status is the useful part either way
            pass
        return _Permanent(f"HTTP {err.code} fetching the model{detail}")
    return err


class ModelHolder:
    """Holds the model, and the single boolean that readiness actually depends on."""

    def __init__(self):
        self.model = None
        self.classes = ()
        self.ready = False
        self.error = None
        self.loaded_at = None
        self.source_uri = None
        self.gate = threading.Semaphore(MAX_CONCURRENCY)

    def load(self):
        """Loads the model, retrying while the failure is one that might pass.

        Written after a real outage: object storage went down, a pod happened to restart
        into it, the load failed with a connection refused, and the pod stayed not-ready
        for ever afterwards — long after the store came back — because nothing tried
        again. Its liveness probe correctly kept it alive (restarting would have
        reproduced the same failure at the time) and its readiness probe correctly kept
        traffic off it, so the outage was contained and *permanent*.

        So the same distinction the job retry policy makes applies here. A store that
        refused a connection may accept one in ten seconds. A 404, an artifact that is
        not READY, an architecture this server cannot build, a state dict that does not
        fit — none of those change by being asked again, and retrying them just writes
        the same line to the log for ever.
        """
        attempt = 0
        while True:
            attempt += 1
            try:
                self._load_once()
                return
            except _Permanent as err:
                self.error = str(err)
                print(f"[serve] FAILED to load model, and will not retry: {self.error}", flush=True)
                return
            except Exception as err:  # noqa: BLE001 - reported, not swallowed
                self.error = f"{type(err).__name__}: {err}"
                if attempt >= LOAD_ATTEMPTS:
                    print(
                        f"[serve] FAILED to load model after {attempt} attempts: {self.error}",
                        flush=True,
                    )
                    return
                delay = min(LOAD_BACKOFF_MAX, LOAD_BACKOFF_BASE * (2 ** (attempt - 1)))
                print(
                    f"[serve] load attempt {attempt} failed ({self.error}); "
                    f"retrying in {delay:.0f}s",
                    flush=True,
                )
                time.sleep(delay)

    def _load_once(self):
        """One attempt. Raises `_Permanent` for what a second attempt cannot change."""
        if ARCH not in ARCHITECTURES:
            raise _Permanent(
                f"unknown architecture {ARCH!r}; this server can serve: "
                f"{', '.join(sorted(ARCHITECTURES))}"
            )
        factory, classes = ARCHITECTURES[ARCH]

        # Anything raised in here that is not already `_Permanent` — a refused
        # connection, a timeout, a 5xx, a truncated body that torch will not unpickle —
        # is a bad moment rather than a wrong model, and is retried.
        url, uri = resolve_model_url()
        blob = fetch(url)
        payload = torch.load(io.BytesIO(blob), map_location="cpu")
        state = payload.get("model", payload)

        model = factory()
        try:
            # strict=True on purpose: a key that does not fit is a different model, and
            # a server that tolerates it serves a partly-initialised network at full
            # confidence. Permanent, and only this call is: the bytes downloaded fine
            # and describe some other network, which no number of retries will change.
            model.load_state_dict(state, strict=True)
        except (RuntimeError, TypeError, AttributeError) as err:
            raise _Permanent(f"the downloaded weights are not {ARCH}: {err}") from err
        model.eval()

        # Prove a forward pass before claiming readiness. Loading weights is not the
        # same as being able to run them, and the first failure should happen here
        # rather than on a user's request.
        with torch.no_grad():
            model(torch.zeros(1, 3, 32, 32))

        self.model = model
        self.classes = classes
        self.source_uri = uri
        self.loaded_at = time.time()
        self.ready = True
        self.error = None
        print(f"[serve] ready: {ARCH} from {uri}", flush=True)

    @torch.no_grad()
    def predict(self, batch):
        logits = self.model(batch)
        probabilities = torch.softmax(logits, dim=1)
        confidence, index = probabilities.max(dim=1)
        return index.tolist(), confidence.tolist()


HOLDER = ModelHolder()


def resolve_model_url():
    """Where the weights come from.

    A presigned URL may be passed directly, but the normal path asks the control plane
    for one by artifact id. That indirection is deliberate: presigned URLs expire, and a
    pod that restarts six hours after it was created must still be able to fetch its own
    model rather than crash-looping on a dead signature.
    """
    if MODEL_URL:
        return MODEL_URL, MODEL_URL
    if not ENDPOINT or not ARTIFACT_ID:
        raise _Permanent(
            "set ASHML_ENDPOINT and ASHML_ARTIFACT_ID (or ASHML_MODEL_URL): this server "
            "was not told which model to serve"
        )

    request = urllib.request.Request(
        f"{ENDPOINT}/api/v1/artifacts/{ARTIFACT_ID}/download",
        headers={"accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as err:
        raise _classify(err) from err
    return body["url"], body.get("uri", body["url"])


def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
            return response.read()
    except urllib.error.HTTPError as err:
        # Not classified the same way as the control plane's answer: a presigned URL
        # that has expired returns 403, and that *is* worth another attempt, because the
        # next one mints a fresh signature.
        if err.code in (400, 403):
            return _refetch_with_new_signature(err)
        raise _classify(err) from err


def _refetch_with_new_signature(err):
    """One retry with a freshly signed URL, for the case a signature went stale."""
    if MODEL_URL:
        # There is nothing to re-sign: the URL was handed to us directly.
        raise _Permanent(f"HTTP {err.code} fetching the model from the URL given") from err
    print(f"[serve] download refused ({err.code}); asking for a fresh signature", flush=True)
    url, _ = resolve_model_url()
    with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
        return response.read()


def decode_instances(payload):
    """Turns posted pixels into a normalised batch, or raises with a usable message.

    Accepts raw 32x32x3 values in 0..255, which is what an image decodes to anywhere
    else, and applies the training transform here so that callers cannot get the
    normalisation subtly wrong on their side.
    """
    instances = payload.get("instances")
    if not isinstance(instances, list) or not instances:
        raise ValueError("body must be {\"instances\": [ ... ]} with at least one instance")
    if len(instances) > MAX_BATCH:
        raise ValueError(f"batch of {len(instances)} exceeds ASHML_MAX_BATCH={MAX_BATCH}")

    tensor = torch.tensor(instances, dtype=torch.float32)
    if tensor.dim() != 4 or tensor.shape[1:] != (32, 32, 3):
        raise ValueError(
            f"expected each instance to be 32x32x3, got batch shape {tuple(tensor.shape)}"
        )

    tensor = tensor.permute(0, 3, 1, 2) / 255.0
    mean = torch.tensor(CIFAR10_MEAN).view(1, 3, 1, 1)
    std = torch.tensor(CIFAR10_STD).view(1, 3, 1, 1)
    return (tensor - mean) / std


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, body):
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's interface
        if self.path == "/healthz":
            # Alive, which is all this claims. It stays 200 even when the model failed
            # to load, because restarting a process whose model artifact is missing just
            # produces the same failure more often -- readiness is what withholds
            # traffic, and the logs say why.
            self._send(200, {"status": "ok"})
        elif self.path == "/readyz":
            if HOLDER.ready:
                self._send(200, {"status": "ready", "arch": ARCH})
            else:
                self._send(503, {"status": "not-ready", "error": HOLDER.error})
        elif self.path == "/metadata":
            self._send(200, {
                "arch": ARCH,
                "artifact_id": ARTIFACT_ID or None,
                "source_uri": HOLDER.source_uri,
                "ready": HOLDER.ready,
                "error": HOLDER.error,
                "loaded_at": HOLDER.loaded_at,
                "classes": list(HOLDER.classes),
                "max_batch": MAX_BATCH,
                "max_concurrency": MAX_CONCURRENCY,
                "torch": torch.__version__,
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/predict":
            self._send(404, {"error": "not found"})
            return
        if not HOLDER.ready:
            # 503 rather than 500: the model is not loaded, so this is a "try again or
            # route elsewhere", not a request the caller got wrong.
            self._send(503, {"error": "model not loaded", "detail": HOLDER.error})
            return

        try:
            length = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            batch = decode_instances(payload)
        except ValueError as err:
            self._send(400, {"error": str(err)})
            return

        started = time.monotonic()
        with HOLDER.gate:
            indices, confidences = HOLDER.predict(batch)
        elapsed_ms = (time.monotonic() - started) * 1000

        self._send(200, {
            "predictions": [
                {
                    "class_id": index,
                    "class_name": HOLDER.classes[index] if index < len(HOLDER.classes) else None,
                    "confidence": confidence,
                }
                for index, confidence in zip(indices, confidences)
            ],
            "latency_ms": round(elapsed_ms, 2),
            "arch": ARCH,
        })

    def log_message(self, fmt, *args):
        # The default logs to stderr unbuffered per request; keep the format but send it
        # where `ash` reads container logs from.
        print(f"[serve] {self.address_string()} {fmt % args}", flush=True)


def main():
    print(f"[serve] AshML model server: arch={ARCH} artifact={ARTIFACT_ID or '<direct url>'}", flush=True)

    # Loading happens on a background thread so the HTTP server binds immediately. That
    # is what makes the liveness/readiness split meaningful: Kubernetes can see the
    # container is up while it is still pulling several hundred megabytes of weights,
    # instead of counting the download against a liveness probe and killing it.
    threading.Thread(target=HOLDER.load, daemon=True).start()

    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[serve] listening on :{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
