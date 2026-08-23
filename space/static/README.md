---
title: AshML — ResNet-18 / CIFAR-10
emoji: ⚓
colorFrom: blue
colorTo: indigo
sdk: static
pinned: false
license: apache-2.0
short_description: ResNet-18 AshML trained and verified, in-browser
---

# AshML — the model, in your browser

A live demo of [AshML](https://github.com/AuthRan/AshML), a Kubernetes-native ML
platform. The weights here are the exact artifact an AshML training run produced,
registered and promoted to `PRODUCTION` in its model registry, and verified against the
object store before either of those was allowed to happen.

Everything runs client-side with `onnxruntime-web`. Nothing is sent anywhere.

## What this is, precisely

The platform serves this model in the cluster with
[`deploy/images/model-server/serve.py`](https://github.com/AuthRan/AshML/blob/main/deploy/images/model-server/serve.py),
a PyTorch process behind a Kubernetes Service. **A browser cannot run that**, so this page
runs the same *weights* through a different runtime — an ONNX export of the same artifact.

That substitution is only worth anything if it is checked, so it is:
`scripts/export-onnx.py` re-evaluates the torch model and the exported graph over the
**full 10 000-image CIFAR-10 test set** and refuses to write the export unless both
reproduce the accuracy AshML recorded for the artifact. They do — `0.6428` each, agreeing
on **100.00%** of predictions — and the numbers are on the page.

The preprocessing is a faithful port of the one `ash predict` uses: centre-crop, then an
**area average** down to 32×32 — not the browser's default smoothing, which is a
different filter and would quietly shift the answers.

## What this is not

It is not the platform. The scheduler that decides whether a job may run and where, the
executor driving Kubernetes Jobs, artifact verification, the model registry and the
traffic-splitting router all need a cluster, PostgreSQL and an object store. The control
plane API also has no authentication until Phase 10, so it is deliberately not on a public
URL.

- **Source:** https://github.com/AuthRan/AshML
- **Project site:** https://authran.github.io/AshML/

## About the model

ResNet-18 (CIFAR variant: 3×3 stride-1 stem, no max-pool), trained for **one epoch** —
390 steps over all 50 000 training images.

**This is not a CIFAR-10 result.** The architecture reaches ~95% trained the 100–200
epochs the literature uses. One epoch on a CPU is undertrained on purpose: the point being
demonstrated is that the platform carried a real workload end to end, not that the model
is good. Expect roughly two answers in three to be right.
