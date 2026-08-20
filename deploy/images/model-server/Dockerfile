# The inference image (Phase 5).
#
# Serves one model version: given an artifact id it fetches a download URL from the
# control plane, loads the weights, and answers /predict. Nothing about the model is
# baked in -- the same image serves any version of any architecture it has code for,
# which is what makes `ash model deploy` a control-plane operation rather than a
# rebuild.
#
#   docker build -t ashml/model-server:v1 -f deploy/images/model-server/Dockerfile .
#
# `make model-server-image` does this and imports it into k3d.
FROM python:3.12-slim

# Inference containers must not run as root, for the same reason training ones must not.
RUN useradd --create-home --uid 10001 ashml

# The same CPU wheels and the same versions as the trainer image, deliberately. Serving
# a model on a different torch build than it was trained on is a difference nothing in
# the pipeline would report, and this layer is identical to the trainer's so the two
# images share it in the local cache instead of pulling torch twice.
RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple \
      torch==2.13.0+cpu torchvision==0.28.0+cpu

USER ashml
WORKDIR /home/ashml

COPY --chown=ashml:ashml deploy/images/model-server/serve.py .

# Unbuffered, or the load-progress and per-request lines only appear when the process
# exits -- which for a server is never.
ENV PYTHONUNBUFFERED=1
ENV ASHML_PORT=8081

EXPOSE 8081

ENTRYPOINT ["python", "serve.py"]
