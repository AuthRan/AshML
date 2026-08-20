# The ResNet-18/CIFAR-10 training image (Phase 4).
#
# Kept separate from `deploy/images/trainer` on purpose. That image is 60 MB and every
# end-to-end test pulls it; this one is ~2 GB because it carries PyTorch. Folding the
# two together would make `make e2e` — which does no machine learning at all — wait on a
# torch install.
#
# Built from the repository root so it can copy the SDK, with the dataset supplied as a
# named build context so that 178 MB never enters the repo's context:
#
#   docker build -t ashml/resnet-trainer:v1 \
#     -f deploy/images/resnet-trainer/Dockerfile \
#     --build-context cifar=<dir containing cifar-10-batches-py> .
#
# `make resnet-image` does this, including fetching and checksumming the dataset.
FROM python:3.12-slim

# Training containers must not run as root. Kubernetes will not stop them from doing
# so by default, so the image is where it gets fixed.
RUN useradd --create-home --uid 10001 ashml

# CPU wheels, deliberately. This host has two RTX 2080 Tis but no `nvidia` container
# runtime (ADR 0008), so a CUDA build would be ~3 GB of kernels that cannot be reached
# from inside k3d. The version matches the host's torch so the workload can be checked
# outside the container before it is built into one.
#
# The PyTorch index is primary and PyPI supplemental: torch's own dependencies (numpy,
# pillow, filelock, ...) are not all mirrored on download.pytorch.org.
RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple \
      torch==2.13.0+cpu torchvision==0.28.0+cpu

# The dataset is baked in rather than downloaded at run time, which is what lets
# `download=False` in the workload be a guarantee instead of a hope: a job that fetches
# from the public internet mid-run is one whose data can change underneath a recorded
# experiment. Owned by root and world-readable — the training user only ever reads it.
COPY --from=cifar --chown=root:root cifar-10-batches-py /data/cifar-10-batches-py

USER ashml
WORKDIR /home/ashml

# The SDK is copied rather than pip-installed: it has no dependencies by design, so
# there is nothing for a resolver to do, and a build that needs no network is one that
# cannot fail because an index was slow.
COPY --chown=ashml:ashml sdk/python/ashml ./ashml
COPY --chown=ashml:ashml examples/training/resnet_cifar.py .

# Unbuffered output, or `ash job logs` shows nothing until the process exits.
ENV PYTHONUNBUFFERED=1
ENV DATA_DIR=/data

ENTRYPOINT ["python", "resnet_cifar.py"]
