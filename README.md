<div align="center">

# AshML

**A Kubernetes-native ML platform — schedule GPU training, track experiments,
verify artifacts, version models, and serve them with real traffic splitting.**

[![CI](https://github.com/AuthRan/AshML/actions/workflows/ci.yml/badge.svg)](https://github.com/AuthRan/AshML/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-22%2B-339933)](package.json)
[![kubernetes](https://img.shields.io/badge/runs%20on-Kubernetes-326ce5)](https://k3d.io)
[![postgres](https://img.shields.io/badge/state-PostgreSQL%2016-336791)](db/migrations)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](#license)

[**▶ Live demo**](https://authran.github.io/AshML/demo/) ·
[**Project site**](https://authran.github.io/AshML/) ·
[**Architecture**](docs/architecture/architecture.md) ·
[**Decisions (15 ADRs)**](docs/adr/) ·
[**Quick start**](#quick-start) ·
[**What is not built**](#known-limitations)

</div>

<div align="center">

| | |
|---|---|
| **Real workload** | ResNet-18 on CIFAR-10 — one full epoch, 390 steps over all 50 000 images, 691 s |
| **Result** | **65.59%** top-1 on the complete 10 000-image test set, independently re-evaluated |
| **Reproducible** | same seed, same image digest → `0.6559` / `0.9687` twice, step for step |
| **Serving** | 1 000 test images at **66.0%** top-1, 8.7 ms per image on CPU |
| **Recovery** | training pod SIGKILLed mid-epoch → resumes weights, optimizer, schedule *and* data order |
| **Scope** | Phases 0–5 complete · 15 ADRs · integration tests on real Postgres + MinIO, and one end-to-end run on a real k3d cluster, in CI |

</div>

---

A miniature internal ML cloud. Register datasets, submit training jobs, schedule them
onto GPU resources, track experiments, version models, deploy inference, and observe all
of it.

**Status: Phases 0–5 complete — this is v1.** The spec's §50 user journey runs start to
finish on the real cluster (`make journey`, nine steps, including a killed pod
recovering); what is deliberately *not* in v1 — Loki, tracing, Alertmanager, autoscaling,
an ingress, and Ashcode — is listed with reasons in
[`docs/roadmap.md`](docs/roadmap.md).

> **On the live demo.** The Space above runs AshML's *own* inference server
> (`deploy/images/model-server/serve.py`, imported rather than reimplemented) against an
> artifact an AshML run produced, and every answer carries the model version and artifact
> id that served it. It is the serving slice of the platform, not the platform: the
> scheduler, the executor and the control-plane API need a Kubernetes cluster, and the
> API now authenticates every request, limits how often each caller may make one, and
> keeps a record of everything it refused (see [Who can do what](#who-can-do-what)) — but
> there is still no identity provider and no Kubernetes RBAC, so it is not something to
> put on a public URL.
> What runs where is spelled out on the [project site](https://authran.github.io/AshML/).
>
> The demo page is on GitHub Pages rather than the Hugging Face Space, because Hugging
> Face serves that Space under `default-src 'none'; sandbox` and a page whose scripts are
> blocked is a demo that silently does nothing. The Space still hosts the 45 MB
> `model.onnx` the page fetches, which keeps a large binary out of this repository.
>
> A browser cannot run `serve.py`, so the page runs the same *weights* through ONNX.
> `make space-onnx` re-evaluates the torch model and the exported graph over the full
> 10 000-image test set and refuses to write the export unless both reproduce what AshML
> recorded — they do, `0.6428` each, agreeing on **100.00%** of predictions.
>
> It serves **its own artifact and its own number** — `resnet18-cifar10` v1 from artifact
> `519cecd1`, one epoch, **64.28%** top-1 — not the 65.59% run described below. Those are
> two separate one-epoch runs and neither is rounded toward the other. `make
> space-verify` re-evaluates the shipped weights over all 10 000 test images inside the
> serving image and has to reproduce `0.6428` / `0.9933`, which is what AshML recorded
> for that artifact; a demo whose weights cannot be tied back to a measured run is
> exactly the thing the rest of this README is built to prevent.

## See it run

Four recordings, all of real runs against the real cluster. The terminal ones are rendered
from the captured output of the command shown, so nothing in them is retyped; the dashboard
one is this machine's Chrome pointed at a live control plane.

### The whole platform, in one command

![make journey](docs/media/journey.gif)

> **What this is.** `make journey` — the spec's §50 user journey, nine steps in order
> against a real k3d cluster: create a project, submit training, watch AshML's own
> scheduler place it, see metrics arrive *while the pod is still running*, register and
> promote what came out, deploy it, ask it for predictions, check the dashboards' series,
> then kill the serving pod and a training worker and require both back. It drives the
> `ash` CLI, not the API, because §50 is written in `ash` commands and the question is
> whether a person can type them.
>
> Step 7 scores **3/8** on real CIFAR-10 test images and the run says so. The journey's
> manifest bounds training with `MAX_STEPS`, so that model is undertrained by
> construction — a demo scoring 8/8 would be hiding it. Step 3 prints the scheduler's
> actual reason next to the spec's "GPU NODE SELECTED", because no GPU reaches a node on
> this host. Step 10 is Ashcode, and the run ends by saying it was **not** run: it is
> post-v1, and a scripted transcript pretending otherwise is what Rule 5 forbids.

### The dashboard, live

![the AshML dashboard](docs/media/dashboard.gif)

> **What this is.** The control plane's own page at `/` — not Grafana — refreshing every
> five seconds while two training jobs actually run. Watch the curve extend, the ages
> tick, and `CPU committed` move as the scheduler admits work.
>
> It shows what the platform *is*: nodes, `GPUs visible: 2` sitting next to
> `GPUs schedulable: 0` because either alone misdescribes this host, jobs with the node
> AshML chose for each, the registered version with **whether its bytes were ever
> confirmed**, and what the deployment's address currently resolves to. It is read-only
> and holds no logic — a browser client of the same API `ash` calls, with a test asserting
> every path it fetches is a route the API really serves.

### Killing a training pod mid-run

![make chaos-resume-resnet](docs/media/chaos-resume.gif)

> **What this is.** `make chaos-resume-resnet` SIGKILLs a ResNet-18 pod in the middle of
> an epoch and then only *watches* — nothing here calls the recovery path, because a
> script that invokes recovery proves only that recovery can be invoked.
>
> What has to survive: the retry is offered the last checkpoint AshML **confirmed in the
> store**, and the resumed attempt restores the weights, the optimizer's moments, the
> learning-rate schedule *and* the data order. The last two are the ones that hide — a
> restarted schedule or a redrawn epoch still trains, still converges, and still looks
> healthy while following a different curve from the one the experiment record claims. The
> schedule is proved by the learning rate across the kill; the data order by comparing
> every logged step against an uninterrupted twin run from the same seed.

### A canary, and the split measured from real traffic

![make e2e-rollout](docs/media/rollout.gif)

> **What this is.** `make e2e-rollout` trains two versions of one model, puts the second
> behind a 10% canary, then 50%, then promotes, rolls back and retires — sending real
> requests through the deployment's own address and counting which version answered.
>
> Each version gets its own pods behind its own Service, and the deployment's address is a
> Service whose *selector* moves, so it keeps one ClusterIP throughout. The tolerance is
> four binomial sigmas derived from the sample size, not a number chosen to fit: asserting
> an exact percentage would be asserting that a random router is not random. Running this
> is what found two defects that no test at the API level could see — a front Service
> pointing one port away from the router, and `ash deployment rollout --version 2` printing
> the client version and exiting 0.

## Contents

- [How it fits together](#how-it-fits-together)
- [The control plane](#the-control-plane)
- [The workload this was built for](#the-workload-this-was-built-for)
- [Serving what was trained](#serving-what-was-trained)
- [Asking it a question](#asking-it-a-question)
- [Splitting traffic between versions](#splitting-traffic-between-versions)
- [Who can do what](#who-can-do-what)
- [Surviving a killed pod](#surviving-a-killed-pod)
- [See it run](#see-it-run) · [Watching it work](#watching-it-work) · [Looking at it](#looking-at-it)
- [The whole thing, in order](#the-whole-thing-in-order)
- [Quick start](#quick-start) · [Layout](#layout) · [Configuration](#configuration) · [Development](#development)
- [Reproducibility](#reproducibility) · [Honesty](#honesty) · [Known limitations](#known-limitations)

## How it fits together

```mermaid
flowchart LR
    CLI["ash CLI"] --> API
    subgraph CP["AshML control plane · Node.js"]
        API["REST API<br/>routes → services → repos"]
        SCHED["Scheduler<br/>quota · placement · why"]
        EXEC["Executor<br/>polls Pod status"]
        API --> SCHED --> EXEC
    end
    EXEC --> K8S["Kubernetes<br/>k3d"]
    K8S --> POD["Training Pod<br/>Python SDK"]
    API --- PG[("PostgreSQL<br/>state · event log<br/>SKIP LOCKED queue")]
    POD -- "metrics, step by step" --> API
    POD -- "presigned upload" --> S3[("Object store<br/>MinIO / S3")]
    API -. "HEAD: did the bytes land?" .-> S3
    S3 --> SRV["Model server<br/>artifact id → weights"]
    ROUTER["Router<br/>weighted split"] --> SRV
    PROM["Prometheus"] -. "scrape /metrics" .-> API
    GRAF["Grafana"] --> PROM
    GRAF -. "training curves, by step" .-> PG
```

Dependencies flow one way: `routes → services → repos → db`, with `domain` — the job
state machine, placement and quota, the differentiating logic — importable from anywhere
and importing nothing.

## The control plane

Projects, datasets, experiments and training jobs are persisted in PostgreSQL with an
append-only event log and a `SKIP LOCKED` queue. Submitted jobs **actually run**: AshML's
own scheduler decides whether a job may run and on which node, the executor creates the
Kubernetes Job there, and job state is driven from observed Pod status through to
`SUCCEEDED`, `FAILED` or `CANCELLED`.

Overfill the cluster and jobs queue rather than over-committing it; `ash job why <id>`
prints every node the scheduler considered and what was wrong with it.

Running jobs **report on themselves**: metrics as they train, checkpoints as they
write them, and what the run actually observed itself running on. `ash job metrics <id>`
shows the curve, `ash job artifacts <id>` shows what it produced.

Checkpoints go straight from the training pod to MinIO over a presigned upload, and
AshML **asks the bucket** whether they arrived before marking one usable: an upload that
never landed is refused, and one stored somewhere AshML cannot check is labelled `NO` in
the CHECKED column rather than passing for a verified checkpoint.

A training script reports through the **Python SDK** (`sdk/python`, no dependencies):

```python
import ashml

with ashml.init() as run:                      # identity comes from the container's env
    for step, batch in enumerate(loader):
        run.log_metrics({"loss": train_step(batch)}, step=step)
    run.log_artifact("checkpoints/final.pt", kind="model")
```

`examples/training/sdk_smoke.py` exercises that whole path in the cluster — it trains
nothing and says so, which is the point: it proves the reporting, not a model.

What a run produces can then be registered and promoted, and the registry holds one
promise: **at most one version of a model is in PRODUCTION**, with promotion displacing
the incumbent in the same transaction. A version can only be registered from a `READY`
artifact — the payoff of everything above, since a registry entry pointing at
unconfirmed bytes just moves the discovery from "the upload failed" to "production
cannot load the model".

```bash
ash model create fraud-detector
ash model register fraud-detector --artifact <artifact-id>   # inherits the run's metrics
ash model promote fraud-detector 1
ash model production fraud-detector                          # what is serving, and is it verified
```

## The workload this was built for

ResNet-18 on CIFAR-10 has now run through all of it — scheduled by AshML, executed in
k3d, reporting its own metrics and checkpoints:

```bash
make resnet-image                                        # fetch + verify CIFAR-10, build, import
ash experiment create resnet18-cifar10-1epoch --project vision \
    --dataset cifar10 --dataset-version v1 --seed 1337
ash job submit examples/training/resnet-cifar.yaml --experiment <id>
```

One full epoch — 390 steps over all 50 000 training images, no `MAX_STEPS` truncation —
in 691 seconds, then **65.59% top-1 on the complete 10 000-image test set**.

That run has been executed twice from the same seed and the same image digest. Both
produced 0.6559 accuracy and 0.9687 loss, matching step by step from the first logged
loss to the last. Recording a seed is only worth doing if it buys
something, and this is the evidence that it does.

**That number is undertrained and is not a CIFAR-10 result.** This architecture reaches
~95% when trained the 100–200 epochs the literature uses; this is one epoch, on a CPU.
It is here to show the platform carried a real workload end to end, and the run says so
itself — in its logs at start and finish, and in the metadata attached to every artifact
it produced, because a checkpoint outlives the log that explained it (spec Rule 5).

The claim was checked rather than trusted: the model artifact was pulled back out of
object storage, loaded into a freshly built architecture, and re-evaluated over the full
test set, reproducing 0.6559 accuracy and 0.9687 loss exactly. `kubectl` confirms the pod
ran on the node the scheduler chose. The dataset is verified against its published
sha256 before it is extracted, and that digest is what `cifar10:v1` pins.

## Serving what was trained

A registered version becomes something that answers requests:

```bash
ash model deploy resnet18-cifar10 --replicas 2   # serves the PRODUCTION version
ash deployment get resnet18-cifar10              # what the cluster reports back
ash predict resnet18-cifar10 --image cat.png     # ask it, from outside the cluster
```

Proven end to end on k3d: the ResNet-18 version above served **1 000 real CIFAR-10 test
images at 66.0% top-1**, 8.7 ms per image on CPU — consistent with the 65.59% recorded
for that artifact over the full test set, which is what shows the served model is the
model that was evaluated.

The inference image is generic. It is handed an **artifact id**, not a URL and not a
baked-in model, and exchanges it for a time-limited download at startup through the same
endpoint the training SDK uses — a presigned URL in the manifest would expire, and a pod
restarting hours later would crash-loop on a dead signature.

## Asking it a question

```bash
make cifar-png                                   # test images as PNGs, labels in the names
ash predict resnet18-cifar10 --image data/cifar-png/test-00001-ship.png
```
```
  test-00001-ship.png: 32x32 truecolour

prediction:  ship
confidence:  81.5%

served by:   resnet18-cifar10 v1 → artifact 7228968a-… (resnet18-cifar)
latency:     269.6 ms in the pod, 284 ms round trip
```

`--image` repeats, so a batch is one call and prints a table.

Those are CIFAR-10 **test** images with their true labels in the filename, so the answer
can be checked rather than admired — and over the first eight of them this model gets six
right, which is roughly what a 65.59% model should look like. A demo that scores 8/8 is
predicting on its own training set.

Every answer carries the version and artifact that produced it. A prediction nobody can
attribute to a model version is how the wrong model serves for a week, and
`ash deployment metadata` closes the loop by asking the pod what it *actually* loaded and
comparing that against what AshML recorded:

```bash
ash deployment metadata resnet18-cifar10
```

The request goes through the Kubernetes API server's proxy, which already routes to
Services and which the control plane already holds credentials for — so a ClusterIP stays
a ClusterIP and nothing new is exposed. **This is not the serving path**, and the code
says so where it would otherwise be misused: real traffic goes to `endpoint_url` from
inside the cluster, because routing inference through the control plane puts every
request on the event loop that runs the scheduler, and makes a control-plane restart an
inference outage.

Decoding the PNG happens in `ash`, not on the server. The model server takes pixels
because it owns the normalisation its weights were trained with, and a second
implementation of that transform on the client's side of the wire is a silent accuracy
loss that no error message would ever point at. So `ash` centre-crops and area-averages
down to 32×32 — and prints what it did, because a confident prediction about a 32×32 crop
of a photograph is still a prediction about a 32×32 crop of a photograph.

`/healthz` answers as soon as the process binds; `/readyz` answers only once the weights
are loaded and a forward pass has run. They are wired to different probes deliberately:
readiness on `/healthz` would route traffic to a pod with no model in it, and liveness on
`/readyz` would kill a pod that is still downloading one — restarting it, and starting
the download over.

Status is observed, never assumed. Creating the objects reports `PROGRESSING`; only the
sync loop reading `readyReplicas` back from the cluster may say `READY`. `DEGRADED` —
was serving, now short of replicas — is kept distinct from `PROGRESSING`, because one
word for both hides an outage inside something that sounds like startup.

## Splitting traffic between versions

A deployment can serve more than one version, and the split is a share of the traffic
rather than a count of pods:

```bash
ash deployment rollout resnet18-cifar10 --version 2 --traffic 10   # canary
ash deployment rollout resnet18-cifar10 --version 2 --traffic 50
ash deployment promote resnet18-cifar10 --version 2                # v1 kept at 0%
ash deployment rollout resnet18-cifar10 --version 1 --traffic 100  # and that is the rollback
```

Each version runs its own pods behind its own Service, and a **router** — a small Fastify
service, `packages/router/` — chooses one per request. The tempting implementation is
replica counts instead: three pods of v1 and one of v2 for 75/25. It needs a hundred pods
for a 99/1 canary, and it makes resizing a version silently change the split, so weight and
replicas are separate columns and something chooses per request.

Weights must sum to exactly 100 and are never normalised. Accepting 100/10 and calling it
91/9 is the friendly-looking option and is precisely how someone ends up with a split they
did not choose. The refusal shows the arithmetic.

The router picks at random by default, which is what makes a canary's error rate mean
anything, and consistently when the caller supplies `X-AshML-Route-Key` — because an A/B
test where the same user is routed to v1, then v2, then v1 is measuring a mixture.

**The deployment's address never moves.** It is a Service whose *selector* moves: onto one
version's pods while one version takes traffic, onto the router's the moment two do. It
keeps its ClusterIP and its DNS name throughout, so nothing holding the address notices —
and the address only ever moves onto something with a ready pod. That is what makes a
version change a blue/green: v2 starts alongside v1, the address moves when v2 answers,
then v1 scales to zero. It costs both versions' capacity for a few seconds and removes the
window in which some requests are answered by one version and some by the other with
nothing recording which. For a model, that window is predictions nobody can attribute.

A router exists only while there is something to decide, and is removed when a promotion
leaves one version taking traffic — with the previous version kept at 0%, so going back is
a weight change and a scale-up rather than an image pull.

Every answer carries `X-AshML-Served-By`, and nothing is added to the response body: a
client parsing a field the router injected would break the moment the deployment dropped
back to one version and the router left the path. `ash predict` reads that header back, so
`served_by` reports the version that actually answered rather than the one AshML expected.

A version that **did not answer** is failed over to another, once. A version that answered
badly is not. Those are one line apart and the difference is the whole value of a canary: a
500 from v2 is the single most important thing a canary produces, and serving that request
from v1 instead would hide exactly the failure it was deployed to find.

If the control plane goes away, the router keeps applying the last split it fetched. It
does not empty its table and it does not fail readiness — either would make a control-plane
restart an outage for every deployment behind a router. What it does instead is say how
stale it is, in `/-/routing` and in `ashml_router_config_age_seconds`, because a wrong
split is bad and an outage is worse, and neither is improved by being silent.

[ADR 0011](docs/adr/0011-a-router-only-when-there-is-a-choice.md) has the rest.

**Proven against real pods**, not against a simulated cluster: `make e2e-rollout` trains two
versions, deploys one, canaries the other at 10% and then 50%, promotes, rolls back, and
retires — measuring the split from live traffic through the deployment's own address. In
the run recorded here a 10% canary took 13.0% of 400 requests and a 50% split took 52.0%,
every response's `X-AshML-Served-By` matched the artifact id the answering pod
independently reported having loaded, and the address kept one ClusterIP through all of it.
The tolerance is four binomial sigmas computed from the sample size rather than a number
chosen to fit, because asserting an exact percentage would be asserting that a random
router is not random.

Running it is what found the two defects below, and neither was reachable from any test
that did not send a real request to a real address:

- **The front Service targeted the model server's port in both of its states.** The moment
  the address moved onto the router, every request through it was refused — by a router
  that was running, ready, and listening one port away. Nothing reported it: the pods were
  ready and AshML said `READY`. It now targets the port by *name*, which both containers
  declare, so the port follows the selector by construction rather than by anyone
  remembering to move it.
- **`ash deployment rollout --version 2` printed `0.1.0` and exited 0.** Commander matched
  the program's own `--version` before the subcommand's, so the rollout never happened and
  the shell saw success — for all three of `rollout`, `promote` and `retire`, which is
  every version-shifting command there is. The program now uses positional options, and
  `packages/cli/src/cli.test.js` runs the real binary to keep it that way.

## Who can do what

The API is **default deny**. Every request needs a bearer token, and every `/api/v1`
route has to declare the permission it needs — checked when the route is *registered*, so
a route that declares nothing makes the server fail to start rather than quietly
answering to anybody. Forgetting is a boot error with the path in the message, which is
the opposite of how this usually goes wrong.

```bash
export ASHML_TOKEN=$(make -s token)   # the first token; written straight to the database
ash login                             # checks it, then stores it per-endpoint
ash whoami
```

Three project roles, and a platform administrator who is not a project role at all:

| | VIEWER | EDITOR | OWNER | platform admin |
|---|:--:|:--:|:--:|:--:|
| Read the project, its jobs, metrics, models | ✓ | ✓ | ✓ | ✓ |
| Submit jobs, register models, deploy | | ✓ | ✓ | ✓ |
| Add and remove members | | | ✓ | ✓ |
| Change a quota, read cluster inventory | | | | ✓ |
| Report a run's own metrics and artifacts | | | | |

```bash
ash member add my-project someone@example.com --role EDITOR
```

Three things in that table are deliberate and worth saying out loud.

**Quotas are not a project permission.** A quota a project owner can raise is not a quota,
so granting capacity sits with somebody other than the person it constrains (spec §31).
Cluster inventory is there for the same reason: it describes the host, not one project's
use of it.

**Nobody can report a run's results.** Not an owner, not an administrator. That row is
empty on purpose: the value of the record is that the *pod* reported what it observed
(ADR 0009), and an endpoint a person can post to is an endpoint where the number might
have been chosen instead of measured. The only thing that can write it is the run itself.

**A project you are not in answers 404, not 403.** A 403 confirms the name is real, which
is how an outsider enumerates projects. If you *can* see the project but not write to it,
you get a truthful 403 — hiding it then would just be confusing.

### What a pod is allowed to be

The other half is that not every caller is a person. A training attempt is handed a **run
token** scoped to that job and that attempt; a deployment is handed a **serving token**
scoped to its own weights and its own routing table. Both are minted at launch and revoked
when the workload ends — and on a retry, the previous attempt's token is revoked *before*
the next one is minted, so a pod that is still shutting down cannot report metrics into
the run that replaced it. That is not a hypothetical failure: it would not error, it would
write one attempt's numbers onto another's.

A run token can report for its own job and fetch artifacts in its own project. It cannot
read the project, list anything, or mint a token. This closes the hole Phase 4 recorded in
the roadmap and never fixed: the metric and artifact ingest paths took writes from inside
the cluster with no authentication at all, so anything that could reach the control plane
could report results for any job.

> **Upgrading an existing cluster: rebuild every image.** Each one talks to the control
> plane, and each one now has to prove who it is:
>
> ```bash
> make image && make resnet-image && make model-server-image && make router-image
> ```
>
> An image built before Phase 10 ignores the `ASHML_RUN_TOKEN` AshML gives it and calls the
> API anonymously. The failures do not look like credential problems, which is the reason
> this is a callout and not a footnote: a model server dies with `HTTP 401 fetching the
> model`, which reads as a control-plane fault, and a training pod crashes with
> `ApiError: authentication required` at its *first artifact upload* — minutes into a run
> that had otherwise been going fine.

### How often you can call

Two budgets, both per minute. Which one a request is counted against depends on whether
it authenticated:

| | keyed by | default | setting |
|---|---|---|---|
| Authenticated | *who* is calling — a person, a run, a deployment | 1200 | `ASHML_RATE_LIMIT_PER_MINUTE` |
| Anonymous | the source address | 600 | `ASHML_RATE_LIMIT_ANON_PER_MINUTE` |

The anonymous one is the one with a reason to exist. Checking a bearer token means
hashing it and asking PostgreSQL, so with nothing in front, a client holding no
credential at all can make the control plane run a query per packet — a database outage
produced entirely by requests that were going to be refused anyway. So that budget is
**peeked at before** authentication runs and **charged after** a 401. The ordering is the
whole mechanism: it is what makes refusing cheaper than attacking.

It is also the number that took the most thought, and it is higher than it looks like it
should be. Every pod in a k3d cluster reaches the control plane from one address, so this
budget is shared by everything behind a NAT or an ingress. A limit low enough to catch "a
handful of 401s is a misconfiguration" would let one misconfigured workload lock out every
healthy pod beside it — which is the [upgrade failure above](#who-can-do-what), made
contagious. Ten a second sits above any real failure loop and three orders of magnitude
below a flood. The ceiling is the point, not the number.

The authenticated budget is a backstop against a runaway loop rather than a throttle. It
is keyed by identity and not by credential, so minting a second token does not mint a
second budget, and it is a token bucket rather than a fixed window, so a caller who has
been quiet may spend a whole minute at once — `make bench` makes about six hundred calls
in a few seconds and fits inside it with room to spare.

A refusal is a `429` carrying `Retry-After` and the `RateLimit-*` headers, and is **not
itself charged**, so a client stuck in a retry loop still recovers on its own rather than
holding itself out. `/healthz`, `/readyz` and `/metrics` are never limited: a throttled
liveness probe is a pod Kubernetes restarts, and throttled metrics blind the monitoring at
the exact moment it is describing the overload.

Two things it does not do, both worth knowing before this is put behind anything:

- **It counts in this process.** Two replicas are two budgets. The fix is a shared counter
  in PostgreSQL, which v1 does not have.
- **It believes the socket, not `X-Forwarded-For`**, unless `ASHML_TRUST_PROXY=true`.
  Behind an ingress that setting is required, or every anonymous caller shares the
  ingress's one bucket; *without* an ingress it must stay off, or every caller picks their
  own bucket by sending a header — which is worse than no limit, because it looks like one.

Why it is shaped this way, including why the anonymous number is higher than it looks
like it should be, is [ADR 0014](docs/adr/0014-two-rate-limits-and-where-each-one-runs.md).

### What it refused, and who it refused

```bash
ash audit summary                  # who has been refused lately, and for what
ash audit denials --since 24       # every refusal, newest first
```

Refusals are recorded **where the decision is made, not where the response is sent**, and
that is the whole design rather than an implementation detail. Remember that a project you
are not a member of answers 404 — so on precisely the refusals an audit exists to surface,
the API says "not found" on purpose. A hook that recorded every 403 would file an outsider
working through your project names as a series of typos.

So each row carries the refusal *and* the status the caller was actually given, and lets
them disagree. `ash audit denials` heads that column TOLD:

```
WHEN                 WHO                PERMISSION    TOLD  REQUEST                     PROJECT
2026-08-25 09:14:02  carol@example.com  PROJECT_READ  404   GET /api/v1/projects/:name  vision
2026-08-25 09:14:03  carol@example.com  PROJECT_READ  404   GET /api/v1/projects/:name  fraud
2026-08-25 09:14:05  carol@example.com  PROJECT_READ  404   GET /api/v1/projects/:name  billing
```

Three things it deliberately does not do:

- **It does not record 401s.** A request with no valid credential has no principal to
  name and no ceiling on how many a stranger can produce, so a row per 401 would be an
  INSERT-per-packet amplifier — the failure the rate limit above exists to prevent, handed
  back through its own audit trail. Those are counted in `ashml_auth_failures_total`.
- **It does not block the request.** Denials are buffered and written in batches. The
  buffer is bounded and overflow is *dropped*, because an audit that grows without limit
  under load is a memory leak that fires exactly when the platform is already in trouble.
  `ashml_audit_dropped_total` says how large the gap is rather than hiding it.
- **It has no foreign keys** — the one thing in that table that reads as an oversight and
  is not. An audit row a `DELETE` elsewhere can erase or anonymise is not an audit row, so
  the subject is copied in as text and the record still reads after the account it names
  has gone.

Reading it is `PLATFORM_ADMIN`, for the reason in
[ADR 0015](docs/adr/0015-audit-the-decision-not-the-response.md): the trail names people
and what they reached for, and a caller who could read their own refusals would have a way
to map the boundary they had just been stopped at.

Full reasoning about the credentials themselves, and an explicit list of what is *not*
built — no identity provider, no Kubernetes RBAC — is in
[ADR 0013](docs/adr/0013-tokens-for-people-and-tokens-for-pods.md) and
[`docs/roadmap.md`](docs/roadmap.md).

## Surviving a killed pod

A job with `max_retries` above zero, whose failure a retry could plausibly survive, comes
back as a second attempt that starts where the first one stopped:

```bash
make chaos-resume          # kills a training pod; asserts the retry resumes from step N
make chaos-resume-resnet   # the same, on ResNet-18: weights, optimizer, schedule, data order
make chaos-serving         # kills the pod behind a live deployment
make chaos-restart         # SIGKILLs the control plane itself, mid-run
```

None of them drives the code it is testing: each breaks something with `kubectl` and then
watches, because a script that calls the recovery path only proves the recovery path can
be called.

Killed at step 13 of 40, resumed from the checkpoint confirmed at step 10, finished, and
registered a verified model. The script does not drive the executor — it breaks something
with `kubectl` and then only watches, because what needs proving is that the platform
recovers on its own loop.

Two things have to hold for that to be worth anything. **A retry has to be able to change
the outcome**, so failures are classified rather than counted: an image that will not pull
does not begin to exist because a second pod asked for it, and a container killed for
exceeding its memory request will exceed the same request again. And **resuming has to be
offered rather than imposed** — the retry is handed the newest confirmed checkpoint as an
artifact id in `ASHML_RESUME_FROM`, and a workload that does not implement resuming
ignores it and starts over. Taking it up is one call:

```python
with ashml.init() as run:
    resume = run.fetch_resume()      # None on a first attempt
    if resume:
        state = torch.load(resume, weights_only=True)
```

**The data order is restored too**, and getting that wrong is the quiet kind of wrong.
A resumed epoch used to run the number of batches it had left, drawn fresh — training
twice on some images and never on others, with a smooth loss curve and a plausible
accuracy as the only evidence. The fix is not to checkpoint the sampler: each epoch's
permutation is *derived* from `(seed, epoch)`, so resuming is slicing that order at the
batch the last attempt reached, and a fresh epoch is the same code path with an offset of
zero. `make chaos-resume-resnet` proves it against a reference run from the same seed that
was never killed — every logged step's `batch_digest` matches, on both sides of the kill.

`chaos-restart` checks the claim the other three rest on: **AshML keeps no state that
exists only in its own process**. Across a 12-second outage the training pod did not
notice, the job came back with the same attempt, Kubernetes Job and placement, and the
event log gained nothing — a control plane that re-derived state from the cluster on
startup would write a second `STARTING`, and the log would stop being a history. The run
finished, having lost 63 metric points and reported exactly 63.

What a resumed ResNet restores is the model, the optimizer's moments *and* the
learning-rate schedule. The third is the one that hides: without it the run trains,
converges and looks healthy while following a different curve from the one its experiment
record claims — so the proof is the learning rate across the kill, `.0059 → .0588 →
.1000 → .0923 → … → .0028`, one OneCycle rather than two. What is **not** restored is the
position in the shuffled training set, and the run says so in its logs and in the caveat
metadata on every artifact it produces.

**Not yet:** GPU jobs cannot run on this host — the machine has two RTX 2080 Tis, but
installing the NVIDIA container toolkit needs root, so no GPU reaches a k3d node and the
cluster advertises `nvidia.com/gpu: 0`. AshML handles this the honest way: such a job is
**queued with an explanation**, never placed onto a GPU the cluster will not grant
(ADR 0008). Preemption is stored but not driven (Phase 5).

## Watching it work

```bash
make observability-images   # pull Prometheus and Grafana, import them into k3d
make observability          # apply the stack, wait for both rollouts
make grafana                # port-forward -> http://127.0.0.1:3000
```

Four dashboards, provisioned from [`deploy/observability/`](deploy/observability/) and
kept in git as JSON: **Cluster & GPU**, **Job pipeline**, **Training curves**, and
**Inference**.

Grafana has **two datasources**, and that is the whole design rather than an
inconvenience. Prometheus scrapes the control plane's `/metrics` — queue depth, replica
counts, pass durations, GPU telemetry, things whose value at a moment is the whole truth
about them. The **training curves come from PostgreSQL**, plotted against the `step`
column the run itself reported, because a loss belongs to a step and a scraper sampling on
a timer would record it against a clock and drop every step in between (ADR 0009,
[ADR 0010](docs/adr/0010-two-datasources-one-story.md)).

Two numbers sit next to each other on the cluster dashboard: `ashml_gpu_visible` (2) and
`ashml_gpu_schedulable` (0). Both are true on this host, and either one alone is a lie
about it.

Measured numbers — API latency, scheduling latency, an inference batch-size sweep, and the
ResNet run's own throughput — are in [`docs/benchmarks.md`](docs/benchmarks.md), produced
by `make bench` rather than typed. There is no GPU figure in it, for the reason above.

## Looking at it

The control plane serves its own dashboard at **`/`** — so `npm start` gives you the API
and a place to watch it at one address, with nothing else to deploy:

```bash
npm start                    # then open http://127.0.0.1:8080/
```

It shows what the platform *is*: nodes and GPUs, jobs by state with the node AshML chose
for each, registered model versions with whether their bytes were ever confirmed, what is
deployed and what its address currently resolves to, and the most recent training curve
plotted against the step the run reported. It refreshes every five seconds and says
**stale** rather than showing an old reading as though it were current.

Two things it deliberately is not. It is **read-only** — writes stay in `ash` and the API
where they are logged and scriptable; a button that promotes a model version is a thing to
design, not to add because a page happened to exist. And it **holds no logic**: it is a
browser client of the same public API `ash` calls, adds no endpoints of its own, and a test
asserts that every path it fetches is one this API actually serves.

For time series — scrape intervals, latency histograms, GPU telemetry over hours — Grafana
is the right tool and the two do not overlap. This is the platform's own state; that is its
behaviour over time.

## The whole thing, in order

The spec's §50 describes one user journey — create a project, submit training, watch it
scheduled, see the metrics arrive, register and deploy what came out, ask it for a
prediction, observe it, then break it. `make journey` runs all nine steps against the real
cluster, in order, as one story:

```bash
make journey                 # ~8 minutes; leaves the deployment up so you can look at it
```

It drives the **`ash` CLI**, not the API, because §50 is written in `ash` commands and the
question it answers is whether a person can type them. That is not a stylistic choice: the
bug where `ash deployment rollout --version 2` printed the client version and exited 0 was
invisible to every HTTP-level test here, and visible immediately to a script that runs the
command.

What one run reports, all of it measured:

```
Step 3   QUEUED -> STARTING -> RUNNING, placed on k3d-ashml-server-0
Step 4   loss at step 10: 5.4429 (while the job is still RUNNING)
Step 5   4 checkpoint(s), model artifact verified, v1 is PRODUCTION
Step 7   3/8 correct on real CIFAR-10 test images
Step 8   41 series across 4 dashboards, all exported
Step 9   DEGRADED 0/1, then the same artifact back; a killed run resumed at step 15
```

Three things it refuses to round up. Step 3's "GPU NODE SELECTED" is printed next to the
scheduler's real reason, because no GPU reaches a node here. Step 7's score is **printed
and not asserted** — the journey's manifest bounds training to `MAX_STEPS`, so the model is
undertrained on purpose and a passing threshold would be one tuned until it passed. And
step 10, Ashcode, is not run: it is post-v1, and the journey ends by saying so rather than
by showing a transcript.

Point it at the full-epoch manifest for the recorded demo:

```bash
JOURNEY_MANIFEST=examples/training/resnet-cifar.yaml make journey
```

See [`docs/roadmap.md`](docs/roadmap.md) for the phase plan and
[`docs/architecture/architecture.md`](docs/architecture/architecture.md) for the design.

## Quick start

Requires Node.js 22+, Docker, and [k3d](https://k3d.io) + kubectl for execution.

```bash
npm install
make db-up           # PostgreSQL + MinIO
make migrate         # apply schema
make cluster         # create the local k3d cluster
make image           # build the smoke workload image and load it into the cluster
make db-test         # a separate database for the tests, which truncate everything
make test

npm start            # start the control plane (API + executor)

export ASHML_TOKEN=$(make -s token)   # the API is default-deny; this is the first token
ash whoami
```

`make e2e` runs the whole path against the real cluster — submit, run, log, fail,
cancel — and cross-checks every assertion with `kubectl`. `make e2e-scheduler` overfills
the cluster and asserts that jobs queue, run only as capacity allows, and land on the
node AshML actually chose. `make e2e-rollout` trains two versions of one model and puts
live traffic through a canary, measuring the split from the responses. `make journey` runs
the spec's whole §50 user journey, all nine steps in order — the closest thing here to the
demo itself.

All of them pin the cluster they talk to (`ASHML_KUBECONFIG_CONTEXT`, the same variable the
control plane takes) rather than following `kubectl`'s `current-context`, which belongs to
whoever last ran `kubectl config use-context`. On a workstation with two clusters that is
the difference between asserting against the cluster under test and asserting against
someone else's.

Then, in another shell:

```bash
alias ash='node packages/cli/src/index.js'

ash project create vision --gpu-quota 2
export ASHML_PROJECT=vision          # saves repeating --project

# Register the data a run will consume. Versions are immutable.
ash dataset create cifar10
ash dataset add-version cifar10 v1 --uri s3://ashml/cifar10/v1 --digest sha256:aa11
ash dataset versions cifar10

# Capture what makes a run reproducible, then submit a job against it.
ash experiment create resnet18-baseline \
  --git-commit "$(git rev-parse --short HEAD)" \
  --dataset cifar10 --dataset-version v1 \
  --seed 1337 --param lr=0.001 --param batch_size=128
ash experiment list

ash job submit examples/training/resnet-cifar.yaml --experiment <experiment-id>
ash job list
ash job get <id>
ash job events <id>      # full audit trail
ash job why <id>         # every node considered, and why it was chosen or rejected
ash job logs <id> -f     # the container's own output, followed until it finishes

# What the run reported about itself while training.
ash job metrics <id>              # latest value and point count per metric
ash job metrics <id> --name loss  # the full series, step by step
ash job artifacts <id>            # checkpoints and models, and whether their bytes exist
ash artifact get <artifact-id>            # including whether AshML verified them itself
ash artifact download <artifact-id> -o model.pt   # straight from object storage

# And rolled up across every run of an experiment, for comparing them.
ash experiment metrics <experiment-id>
ash experiment artifacts <experiment-id> --ready
ash experiment get <experiment-id>   # what was asked for, and what the run observed
ash job cancel <id>      # stops at CANCELLING until the Pod is really gone

# Serve a registered version, and ask it something.
ash model deploy resnet18-cifar10 --replicas 2
ash deployment get resnet18-cifar10       # status the cluster reported, not what was asked for
ash deployment metadata resnet18-cifar10  # what the pod says it actually loaded
ash predict resnet18-cifar10 --image test-00001-ship.png
ash predict resnet18-cifar10 --instances batch.json   # any other architecture's shape

ash deployment rollout resnet18-cifar10 --version 2 --traffic 10   # canary
ash deployment promote resnet18-cifar10 --version 2                # end the rollout
ash deployment retire  resnet18-cifar10 --version 1                # and reclaim its objects

ash node list            # cluster capacity: what is free, what is committed
ash project quota vision --gpu 2 --jobs 4
ash gpu list
```

Every command takes `--json` for scripting.

On a machine without GPUs, or without a cluster, use the simulated backends:

```bash
ASHML_GPU_PROVIDER=sim ASHML_K8S_BACKEND=sim npm start
```

Simulated devices are flagged as such in the API response and the CLI prints a warning;
a job run by the `sim` execution backend records `simulated: true` on its events and its
"logs" say plainly that no container ran. That is deliberate — see "Honesty" below.

## Layout

```
packages/server/src/
  domain/     pure rules — the job state machine, no I/O
  repos/      hand-written SQL, one module per aggregate
  services/   transactions; the only place job state changes
  routes/     HTTP surface and JSON Schema
  gpu/        provider seam: nvidia (real), sim (flagged)
  k8s/        execution seam: kubernetes (real), sim (flagged); manifest translation
  observability/  the Prometheus registry and the scrape-time snapshot collector
  domain/     also placement and quota — pure, and the differentiating logic
  db/         connection pool and transaction helper
packages/cli/      `ash` command-line client
db/migrations/     PostgreSQL schema
api/openapi.yaml   generated from route schemas — do not hand-edit
deploy/local/      docker-compose for Postgres + MinIO, and the CoreDNS host alias
deploy/observability/  Prometheus, Grafana, and the dashboards as JSON
examples/training/ job manifests, including the two `make journey` submits
scripts/           e2e, chaos, benchmarks, and the §50 journey — all of them run for real
docs/              architecture, roadmap, ADRs
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ASHML_PORT` | `8080` | Listen port |
| `ASHML_HOST` | `0.0.0.0` | Listen address |
| `ASHML_LOG_LEVEL` | `info` | pino log level |
| `ASHML_GPU_PROVIDER` | `nvidia` | `nvidia` or `sim` |
| `ASHML_SIM_GPUS` | `2` | Device count for the `sim` provider |
| `ASHML_AUTH_ENABLED` | `true` | Default deny. `false` acts as the seeded local administrator, for `make dev` and the k3d end-to-end scripts — never for a reachable control plane |
| `ASHML_RUN_TOKEN_TTL` | `86400` | Seconds a workload's token stays valid |
| `ASHML_RUN_TOKEN_GRACE` | `300` | Seconds a *finished* run's token keeps working, so the final checkpoint's upload — confirmed after the pod exits — still lands. A retry revokes immediately regardless |
| `ASHML_TOKEN` | — | Read by `ash` when nothing is stored by `ash login` |
| `ASHML_RATE_LIMIT_ENABLED` | `true` | Set false to remove both budgets. Logs a warning on every start |
| `ASHML_RATE_LIMIT_PER_MINUTE` | `1200` | Requests a minute per *authenticated caller* — per person, run or deployment, not per token |
| `ASHML_RATE_LIMIT_ANON_PER_MINUTE` | `600` | Requests a minute per source address for callers with no valid credential — what keeps a token lookup from being an attack. Not lower, because everything behind one NAT shares it |
| `ASHML_RATE_LIMIT_MAX_KEYS` | `10000` | Callers remembered at once, about a megabyte. Past it the least recently seen is forgotten |
| `ASHML_TRUST_PROXY` | `false` | Whether `X-Forwarded-For` decides who is calling. Required behind an ingress, dangerous without one — see [How often you can call](#how-often-you-can-call) |
| `ASHML_AUDIT_BUFFER` | `1000` | Denials held in memory before overflow is dropped. Dropped, not queued: `ashml_audit_dropped_total` counts the gap |
| `ASHML_AUDIT_FLUSH_MS` | `2000` | How often the buffer is written |
| `ASHML_DATABASE_URL` | `postgresql://ashml:ashml@127.0.0.1:5432/ashml` | PostgreSQL connection |
| `ASHML_DB_POOL_MAX` | `10` | Maximum pooled connections |
| `ASHML_K8S_BACKEND` | `kubernetes` | `kubernetes` or `sim` |
| `ASHML_K8S_NAMESPACE` | `ashml-jobs` | Namespace training Jobs are created in |
| `ASHML_KUBECONFIG` | — | Kubeconfig path; unset uses `$KUBECONFIG`, `~/.kube/config`, then in-cluster credentials |
| `ASHML_KUBECONFIG_CONTEXT` | — | Which context in that file. Unset follows `current-context` — see below |
| `ASHML_EXECUTOR_ENABLED` | `true` | Set false for a read-only API replica that runs nothing |
| `ASHML_EXECUTOR_INTERVAL_MS` | `2000` | Status-sync interval; sets the floor on scheduling latency (ADR 0007) |
| `ASHML_DISCOVERY_INTERVAL_MS` | `15000` | How often node and GPU inventory is refreshed |
| `ASHML_ARTIFACT_STORE` | `s3` | `s3` (MinIO or AWS) or `none` — no bucket; artifacts may still be registered against a caller-supplied URI, and complete as unverified |
| `ASHML_S3_BUCKET` | `ashml` | Bucket checkpoints and models are written to |
| `ASHML_S3_ENDPOINT` | `http://127.0.0.1:9000` | The dev MinIO. **Unset it for real AWS**, where the SDK resolves the host itself. Must be reachable *from a training pod* — see below |
| `ASHML_DEPLOYMENT_SYNC_INTERVAL_MS` | `10000` | How often deployment status is read back from the cluster. Slower than the executor: a deployment sits READY for days |
| `ASHML_ROUTING_REFRESH_MS` | `5000` | Set on the **router's** pods, not the control plane's: how often it re-reads the traffic split. A rollout takes effect within one of these |
| `ASHML_API_ADVERTISE_URL` | `http://host.k3d.internal:8080` | What training pods are told to report to, injected as `ASHML_ENDPOINT`. In a cluster, the Service URL |
| `ASHML_S3_REGION` | `us-east-1` | |
| `ASHML_S3_ACCESS_KEY` / `ASHML_S3_SECRET_KEY` | dev MinIO credentials | Unset both to use the SDK credential chain (an IAM role in a cluster) |
| `ASHML_S3_FORCE_PATH_STYLE` | `true` | MinIO serves buckets as a path; set false for AWS |
| `ASHML_S3_PRESIGN_TTL` | `3600` | Seconds an upload or download URL stays valid |
| `ASHML_ENDPOINT` | `http://127.0.0.1:8080` | API endpoint the CLI targets |
| `ASHML_PROJECT` | — | Default project for project-scoped `ash` commands |

`config.js` is the only module that reads the environment.

### Pin the context on a machine with more than one cluster

`current-context` is a *global* setting in a kubeconfig, owned by whoever last ran
`kubectl config use-context`. A control plane started without
`ASHML_KUBECONFIG_CONTEXT` therefore follows it — and can come back from a restart
talking to a different cluster than the one its jobs are running in. Every symptom of
that reads as something else: nodes vanish, running jobs report their Kubernetes Job as
gone, and nothing anywhere says "different cluster".

So the cluster is now named in the line the server logs on startup, pinned or not:

```json
{"msg":"ashml-server ready","k8s_context":"k3d-ashml",
 "k8s_server":"https://127.0.0.1:6550","k8s_context_pinned":true}
```

`k8s_context_pinned: false` means the context came from `current-context` and something
outside this process can change it between restarts. A context that is not in the file
is a startup failure listing the ones that are, rather than a null cluster surfacing
inside an unrelated call later.

### Two addresses that are not the control plane's own

A training pod has to reach two things, and neither is at an address the control plane
can infer from its own bind address (`0.0.0.0` is not somewhere else's route to you):

- **The API**, to report metrics. Set `ASHML_API_ADVERTISE_URL`; it is injected into
  every container as `ASHML_ENDPOINT`. Left unset, the SDK says it was never told where
  to report, which is a much better failure than a connection error from inside a pod.
- **Object storage**, to upload checkpoints. Presigned URLs are fetched **by the
  container**, so `ASHML_S3_ENDPOINT` must resolve there — `127.0.0.1:9000` resolves to
  the pod itself and the upload will hang or refuse.

Running the control plane on the workstation against k3d, both want the host's LAN
address rather than loopback:

```bash
HOST_IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')
ASHML_API_ADVERTISE_URL=http://$HOST_IP:8080 ASHML_S3_ENDPOINT=http://$HOST_IP:9000 npm start
```

Deployed inside the cluster, both are ordinary Service URLs and this note stops applying.

### When `host.k3d.internal` stops resolving

The default advertise URL uses `host.k3d.internal`, which is how anything in k3d reaches
the workstation. k3d installs that name by writing it into CoreDNS' `NodeHosts` entry —
which k3s **owns and rewrites** from the node list whenever the node set changes, so it
disappears on a cluster restart and takes k3d's line with it.

The failure is quiet in the worst way: the pod starts, trains, and reports nothing,
because the SDK cannot resolve the endpoint it was given. Prometheus stops scraping at the
same moment, so the graphs that would have shown it go blank too.

```bash
make cluster-dns-check   # asks a Pod, which is the only place the answer matters
make cluster-dns         # restores it (deploy/local/coredns-host-alias.yaml)
```

## Development

```bash
make db-test          # once: create and migrate the dedicated test database
npm test              # unit tests always; integration tests when that database is up
npm run lint          # eslint
npm run dev           # server with --watch
npm run migrate up    # apply migrations
npm run migrate down  # roll back one migration
npm run openapi       # regenerate api/openapi.yaml after changing routes
```

**CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the lint and the full
suite on every push, with Postgres and MinIO as service containers — so the integration
tests actually *run* there rather than skipping, and the job fails if they skip, because a
skip and a pass look identical in a summary line.

A second job stands up a **real k3d cluster** and runs `make e2e` on it: the Phase 2 exit
criterion, checked against `kubectl` as well as against AshML's own view, so a pass cannot
be produced by the control plane merely believing itself. This file used to say CI could
run nothing that needed Kubernetes, on the grounds that a shared runner is not a realistic
cluster. That is true of some of these scripts and was applied to all of them — and the
cost was that the project's headline claim was verified only when its author remembered
to. What `make e2e` asserts does not depend on the runner resembling anything: a job
submitted through the API becomes a Kubernetes Job, runs a real container, and reaches
SUCCEEDED through observed Pod status.

The rest stay a thing a person runs, now for reasons specific to each rather than one
blanket one. `make e2e-scheduler` is written against the capacity of the development
machine; `make e2e-rollout` measures a traffic split and needs ~2 GB of PyTorch images;
the chaos scripts assert on recovery timing; `make journey` needs all four images and
CIFAR-10.

**Lint rules are chosen to catch defects, not to have opinions.** Every rule in
[`eslint.config.js`](eslint.config.js) can fail on code that looks fine and is wrong, and
none of them can fail on code that is right; formatting stays with the reviewer. The one
that earns its place most is `require-atomic-updates`, which catches a read-modify-write
straddling an `await` — the exact shape of the bug the executor and the deployment sync
loop are written to avoid. It is switched off for `scripts/`, where the drivers are
strictly sequential and it can only report false ones.

Integration tests skip with a visible message when PostgreSQL is unreachable, rather
than passing silently. They run against real Postgres, not a fake — the behaviour that
matters (`SKIP LOCKED`, transaction isolation, unique violations) is exactly what a fake
would get wrong.

**They also delete every row, so they get their own database.** `ASHML_TEST_DATABASE_URL`
(default `…/ashml_test`) is the only thing they will touch; they do not fall back to
`ASHML_DATABASE_URL`, and `truncateAll` refuses outright to wipe a database whose name
does not end in `test`. This is not hypothetical caution — the fallback used to exist,
and a `npm test` run against a configured development database truncated a finished
training run's experiment, metrics, artifacts and registered model version. The artifact
*bytes* survived only because the store half of the same helper already defaulted to a
separate `ashml-test` bucket; the asymmetry between the two is what hid the problem.

The separation has a second benefit: because the suites no longer share a database with
a running control plane, `npm test` no longer needs the server stopped. A live scheduler
polling the same queue used to claim the queue tests' jobs out from under them through
the same `SKIP LOCKED` path, which failed as `Cannot read properties of null`.

## Reproducibility

An experiment is the record of what produced a result: the commit, the image digest,
the dataset **version**, the hyperparameters and the seed (spec §34). Two rules keep
that record trustworthy:

- **Dataset versions are immutable.** Re-registering a version is a `409`, not an
  update, so an experiment pinned to `cifar10:v1` means the same bytes forever.
- **A dataset reference is all-or-nothing.** Naming a dataset without a version is
  rejected rather than stored as null, because a half-pinned run looks reproducible
  without being reproducible. `ash experiment create` warns when a commit or dataset
  is missing.

## Honesty

This project follows a hard rule from its specification: **never fake GPU
functionality, scheduling, distributed training, or performance numbers.**

- Simulated devices carry `simulated: true` through the API and the CLI warns on them.
- `nvidia` is the default provider; `sim` must be opted into explicitly.
- Unimplemented work is marked `[planned: Phase N]` in the docs, not described as done.
- Benchmarks report measured numbers only.

## Known limitations

1. **Single node.** Development runs on one machine with 2× RTX 2080 Ti. Multi-node
   scheduling and node-failure recovery will be demonstrated on simulated k3d nodes and
   labelled as such.
2. **11 GB per GPU.** Workloads are sized to fit. This is a platform project, not a
   frontier-model project.
3. **AshGPU is not integrated.** The provider seam exists; the implementation does not.
4. **Authentication has no identity provider.** Tokens are issued out of band and `ash
   login` stores one — no OIDC, no SSO, no passwords. There is also no Kubernetes RBAC:
   AshML's own service account creates every workload, so a project's pods are isolated by
   AshML's admission checks rather than by the cluster's. Rate limiting exists but counts
   in one process, so two API replicas are two budgets; the audit trail records refusals
   and not successful privileged actions, and nothing prunes it.
   [ADR 0013](docs/adr/0013-tokens-for-people-and-tokens-for-pods.md) lists the rest.

## License

Apache-2.0

---

<div align="center">

Built by [Ashutosh Ranjan](https://github.com/AuthRan) ·
[Live demo](https://authran.github.io/AshML/demo/) ·
[Project site](https://authran.github.io/AshML/) ·
[Architecture](docs/architecture/architecture.md) ·
[Roadmap](docs/roadmap.md)

</div>
