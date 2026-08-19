# The smoke workload image (Phase 2).
#
# Pinned to a digest-able tag rather than `latest`: an image that changes underneath a
# recorded run makes that run unreproducible, which is the guarantee Phase 4 rests on.
FROM python:3.12-slim

# Training containers must not run as root. Kubernetes will not stop them from doing
# so by default, so the image is where it gets fixed.
RUN useradd --create-home --uid 10001 ashml
USER ashml
WORKDIR /home/ashml

COPY --chown=ashml:ashml train.py .

# Unbuffered output, or `ash job logs` shows nothing until the process exits.
ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["python", "train.py"]
