# ashml — the AshML training SDK

The client half of the reporting contract. AshML's runs **push** their own metrics and
checkpoints rather than being scraped ([ADR 0009](../../docs/adr/0009-runs-push-their-own-telemetry.md)),
because only the training loop knows what step a value belongs to. That means a training
script has to say something, and this package exists to make that something small.

```python
import ashml

with ashml.init() as run:
    for step, batch in enumerate(loader):
        loss = train_step(batch)
        run.log_metrics({"loss": loss.item()}, step=step)

    run.log_artifact("checkpoints/final.pt", kind="model")
```

That is the whole API for the common case. `init()` takes its identity from the
environment AshML injects into every training container, so the script above runs
unchanged under the platform.

## Install

```bash
pip install -e sdk/python          # from a checkout
```

**No third-party dependencies.** A training image already carries PyTorch, CUDA and a
dependency graph that took someone a long afternoon to resolve; every pin this package
added would be one that could conflict with theirs. Everything here is standard library.

## What `init()` reads

| Variable | Set by | Meaning |
|---|---|---|
| `ASHML_JOB_ID` | the platform | Which run this is. Required. |
| `ASHML_ENDPOINT` | the platform | Where the control plane is. Required. |
| `ASHML_EXPERIMENT_ID` | the platform | Set when the job was submitted against an experiment |
| `ASHML_RUN_TOKEN` | the platform | The credential this attempt reports with. Scoped to this job and this attempt, minted when the pod launches and revoked when the attempt ends |

AshML sets all four in the container and **protects them from being overwritten** by a
job's own `spec.env` — a job that could shadow `ASHML_JOB_ID` would report its results
onto another run's record.

Outside a job, `init()` still needs an endpoint and a job id passed explicitly — but the
token is a different matter. A run token is minted by the control plane when it launches
a pod, so there is no way to obtain one by hand, and no *person's* token will do either:
reporting a run's own results is the one thing no user account can do, however privileged
(ADR 0013). So a script run outside a job reports nothing against an authenticated control
plane, and `init()` warns rather than failing, because a control plane running with
`ASHML_AUTH_ENABLED=false` accepts the reports anyway and that is the mode the
end-to-end scripts use.

`ASHML_ENDPOINT` only appears if the control plane was configured with
`ASHML_API_ADVERTISE_URL`. If it was not, `init()` says so rather than guessing an
address and failing later with a connection error from inside a pod.

## The rule everything here follows

> **Reporting must never be the reason a training run dies.**

Six hours of GPU time is worth more than a loss curve. So:

- A failed metric flush is retried, then logged and **dropped**. The training loop is
  never told, and the buffer is not regrown — a buffer that grew through an outage would
  eventually take the process with it, which is the exact failure this avoids.
- The count of dropped points is reported at `finish()`. A curve with holes in it looks
  like a training problem until you are told it was a network one.
- **Artifacts are the exception** and always raise. A checkpoint that silently did not
  save is discovered days later, by something trying to resume from it.

Pass `strict=True` to make metric failures raise too. Useful in tests, where a silent
drop is exactly what you want to hear about.

## Metrics

```python
run.log_metrics({"loss": 0.42, "accuracy": 0.91}, step=step, epoch=epoch)
run.log_metric("lr", scheduler.get_last_lr()[0], step=step)
```

Points are **buffered** (200 points, or 10 seconds) so a training loop does not carry a
network round trip, and each point is timestamped **when it was logged**, not when the
batch is sent. A run that buffers for ten seconds and flushes in one request would
otherwise have ten seconds of history collapse onto the moment of the flush.

`epoch` is optional — not every workload has them — and `0` is a real epoch, kept
distinct from absent.

Metrics are append-only server-side: reporting the same step twice records both points.
A run that reports a step twice has done something worth seeing.

## Artifacts

```python
artifact = run.log_artifact("ckpt/epoch-3.pt", kind="checkpoint", step=3000)
print(artifact.status, artifact.verified)   # READY True
```

Three steps, in this order:

1. **Register** — AshML allocates a location and returns a presigned `PUT`.
2. **Upload** — the bytes go straight from this process to object storage. They never
   pass through the control plane.
3. **Confirm** — the SDK reports the size and a SHA-256 it computed while reading, and
   **AshML checks the object is actually there** before marking it `READY`.

If the upload fails the artifact is marked `FAILED` rather than left `PENDING` forever,
so the gap stays visible.

The file is hashed in a separate pass from the upload. Two reads of a large file cost
disk bandwidth, but a hash computed *during* the upload is consumed by it — and an
upload that has to be retried would then have no digest to report.

## Experiments

`init()` stamps the experiment's start and records what the run observed itself running
on; `finish()` stamps the end. Those timestamps come from here and nowhere else: a
container starting is not training starting, and deriving one from the other would record
a number nobody measured.

Framework and hardware are detected from PyTorch if it is importable, and reported
**empty** if it is not. There is no fallback that infers a GPU from an environment
variable: an experiment's hardware record is read later as evidence, and a plausible
guess is the one thing it must never contain (spec Rule 5).

## Tests

```bash
python3 -m unittest discover -s sdk/python/tests -v      # unit, no server needed

# Adds the live suite. The token is not optional: the API is default-deny, and without
# one the live tests fail rather than skip — which is the worse of the two outcomes.
ASHML_ENDPOINT=http://127.0.0.1:8080 ASHML_TOKEN=$(make -s token) \
  python3 -m unittest discover -s sdk/python/tests -v
```

The unit tests run against a real HTTP server on a real socket rather than a patched
`urlopen`: half of what this SDK does is get the HTTP right — the `Content-Length` on a
presigned PUT, the error envelope, the retry on a 503 — and a patched client would agree
with whatever the SDK did. The live suite covers the half a stub cannot, which is whether
the control plane accepts what is sent.
