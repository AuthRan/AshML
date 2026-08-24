---
title: AshML — ResNet-18 / CIFAR-10
emoji: ⎈
colorFrom: blue
colorTo: indigo
sdk: gradio
sdk_version: 5.14.0
app_file: app.py
pinned: false
license: apache-2.0
short_description: The serving slice of AshML, a Kubernetes-native ML platform
---

# AshML — the serving slice, live

This Space runs **AshML's own inference server code** —
[`deploy/images/model-server/serve.py`](https://github.com/AuthRan/AshML/blob/main/deploy/images/model-server/serve.py),
the same file the cluster deploys — against the model artifact an AshML training run
produced.

`app.py` imports that file rather than reimplementing it, and starts it through its real
load path: resolve a model URL, fetch the bytes, `load_state_dict(..., strict=True)`, then
prove a forward pass before reporting itself ready. Preprocessing is
`serve.decode_instances` and the forward pass is `serve.HOLDER.predict`, so the
normalisation here is the normalisation the deployed pod uses. That matters more than it
sounds: normalising differently at serving time is a silent accuracy loss that no error
message would ever point at.

## What this is not

It is **not** the platform. AshML's control plane — the REST API, the scheduler that
decides whether a job may run and on which node, the executor that drives Kubernetes Jobs,
the artifact verification, the model registry and the traffic-splitting router — needs a
Kubernetes cluster, PostgreSQL and an object store. The API authenticates every request
now, but it still has no rate limiting and no audit of refusals, so it is deliberately not
something to put behind a public URL.

To run the whole thing: [github.com/AuthRan/AshML](https://github.com/AuthRan/AshML).

## About the model

ResNet-18 (CIFAR variant: 3×3 stride-1 stem, no max-pool) trained for **one epoch** on
CIFAR-10 — 390 steps over all 50 000 training images.

**This is not a CIFAR-10 result.** This architecture reaches ~95% when trained the 100–200
epochs the literature uses. One epoch on a CPU is undertrained on purpose: the point was
that the platform carried a real workload end to end, not that the model is good. Roughly
two predictions in three are right, and the ones it gets wrong are worth looking at.

Images are centre-cropped and area-averaged to 32×32 before the model sees them, exactly
as the `ash predict` client does. A confident prediction about a 32×32 crop of a
photograph is still a prediction about a 32×32 crop of a photograph, so the page says what
it did to your image.

## Files this Space needs

Two files next to `app.py`, neither of them in git:

- `model.pt` — the model artifact from an AshML run (`ash artifact download <id> -o model.pt`)
- `provenance.json` — what produced it, written by `scripts/build-space.mjs`
