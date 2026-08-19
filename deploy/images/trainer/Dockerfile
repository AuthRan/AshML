# The smoke workload image (Phase 2), now carrying the training SDK (Phase 4).
#
# Pinned to a digest-able tag rather than `latest`: an image that changes underneath a
# recorded run makes that run unreproducible, which is the guarantee Phase 4 rests on.
#
# Built from the repository root so it can copy the SDK:
#   docker build -t <tag> -f deploy/images/trainer/Dockerfile .
FROM python:3.12-slim

# Training containers must not run as root. Kubernetes will not stop them from doing
# so by default, so the image is where it gets fixed.
RUN useradd --create-home --uid 10001 ashml
USER ashml
WORKDIR /home/ashml

# The SDK is copied rather than pip-installed: it has no dependencies by design, so
# there is nothing for a resolver to do, and a build that needs no network is one that
# cannot fail because an index was slow.
COPY --chown=ashml:ashml sdk/python/ashml ./ashml

COPY --chown=ashml:ashml deploy/images/trainer/train.py .
COPY --chown=ashml:ashml examples/training/sdk_smoke.py .

# Unbuffered output, or `ash job logs` shows nothing until the process exits.
ENV PYTHONUNBUFFERED=1

# The default workload is still the Phase 2 smoke test, which reports nothing and needs
# no control plane. A job that wants the SDK path overrides the command:
#   spec: { command: ["python", "sdk_smoke.py"] }
ENTRYPOINT ["python", "train.py"]
