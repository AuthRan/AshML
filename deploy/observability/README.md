# Observability

Prometheus, Loki and Grafana on the local k3d cluster, with every dashboard provisioned
from this directory. This is §50 step 8 — *observe* — and the exporter on the control
plane's `/metrics` is only half of it: a metric nobody looks at is a metric nobody has.

```bash
make observability-images     # pull all four images, import them into k3d
make observability            # apply everything, wait for every rollout
make grafana                  # port-forward -> http://127.0.0.1:3000
make loki                     # port-forward -> http://127.0.0.1:3100 (no UI; for curl)
```

If your database is not the one in `deploy/local/docker-compose.yml`:

```bash
make observability GRAFANA_PG_ADDR=host.k3d.internal:55432
```

`make observability-status` prints the pods and asks Prometheus which of its targets are
actually up. `make observability-down` removes everything — **including the metric
history**, because the PersistentVolumeClaim goes with the namespace.

## Three datasources, because two of them are not the same kind of number and one is not a number

This is ADR 0009 made visible, and it is the single most important thing about this
directory.

| | scraped | pushed | printed |
|---|---|---|---|
| what | queue depth, replica counts, pass durations, GPU telemetry | loss, accuracy, learning rate | whatever the container wrote |
| why | their value *at a moment* is the whole truth about them | they belong to a **step**, and only the training loop knows which | it is the thing that says *why*, and it outlives nothing by default |
| where | Prometheus, from `/metrics` | `training_metrics` in PostgreSQL, from the SDK | Loki, from Alloy |
| dashboard | Cluster & GPU, Job pipeline, Inference | Training curves | Explore — see below |

A scraper sampling training metrics on a timer records *"loss was 1.84 at 14:03:22"* —
the wrong axis — and silently drops every step between two scrapes. So Grafana has a
**PostgreSQL datasource** as well as a Prometheus one, and the training dashboard reads
the step column the run itself reported. Those panels are Grafana **Trend** panels rather
than time series, which is the panel type that exists precisely because the x-axis is a
number that is not time.

## The logs, and why they are here at all

`ash job logs` reads a Pod through the Kubernetes API, so it answers for exactly as long as
the Pod object exists — until a cancellation deletes it, an eviction replaces it, or
somebody tidies the namespace. AshML keeps a job's *state* forever and its *output* for as
long as Kubernetes felt like it, which is backwards for the runs worth explaining: the
failed attempt whose last lines would say why is the one most likely to have had its pod
removed.

Loki is where the same lines are afterwards. Every AshML pod already carried
`ashml.io/job-id` and `ashml.io/project`, so the query is the identifier you already have:

```logql
{job_id="6993051b-a577-47cf-ad92-3eaf083b68a6"}       # one attempt, whatever became of it
{project="vision", component="training-job"}          # every run in a project
{component="model-server"} |= "HTTP 401"              # what the serving pods complained about
```

`component` is `training-job`, `model-server` or `router`; `attempt`, `pod` and `container`
are there too. Grafana's **Explore** is the UI — there is no log dashboard, because a
dashboard answers a question you knew you had, and this is the datasource you reach for when
you do not.

Two things about it are worth knowing before they surprise you:

**A pod that starts and finishes while Alloy is down leaves nothing behind.** The collector
reads through the Kubernetes API rather than off the node's disk, so there is no file to
catch up from. That buys no hostPath mount on any node and no dependence on the container
runtime's log layout, which is the right trade here and not everywhere (ADR 0018).

**Restarting Alloy does not duplicate anything**, which is less obvious than it sounds,
since it re-reads every existing pod from the beginning each time it starts. Lines carry the
container's own timestamps, so a re-read produces entries identical in stream, timestamp and
content and Loki discards them. Checked rather than assumed: three lines before a restart,
the same pod re-tailed, three lines after.

## What is deployed

| file | what |
|---|---|
| `00-namespace.yaml` | `ashml-observability`, kept apart from `ashml-jobs` so deleting the workloads never deletes the graphs that explain them |
| `10-prometheus-config.yaml` | scrape config: the control plane, the kubelets' cAdvisor, and Prometheus itself |
| `11-prometheus-rules.yaml` | alert rules — see the honesty note below |
| `12-prometheus.yaml` | RBAC, a PVC, the Deployment and its Service |
| `20-grafana-provisioning.yaml` | the three datasources and the dashboard provider |
| `21-grafana-credentials.yaml` | development credentials, overridable from `make` |
| `22-grafana.yaml` | the Grafana Deployment and Service |
| `30-loki.yaml` | Loki's config, a PVC, the Deployment and its Service |
| `31-alloy.yaml` | the collector: a Role in `ashml-jobs`, its config, the Deployment |
| `dashboards/*.json` | the four dashboards |

Dashboards are `.json` files in git rather than strings embedded in YAML, so they diff,
review and lint like code. `make observability` turns them into a ConfigMap. They are
provisioned with `allowUiUpdates: false`: a panel edited in the browser is overwritten on
the next reload, deliberately, because a panel that exists only in someone's browser is a
panel nobody else has.

## The four things this deployment refuses to pretend

**There is no DCGM-exporter.** It is in the Phase 5 plan and it would export nothing here:
no NVIDIA device plugin is installed, so no GPU reaches a node (ADR 0008). The real
telemetry from the two RTX 2080 Tis in this host arrives through the control plane's own
`ashml_gpu_*` series instead, gathered by the `GpuProvider` in the process that can
actually see them. `ashml_gpu_visible` and `ashml_gpu_schedulable` are both on the cluster
dashboard, next to each other, reading 2 and 0 — because either one alone is a lie about
this machine.

**There is no Alertmanager.** The rules in `11-prometheus-rules.yaml` fire into
Prometheus' own Alerts page and page nobody. That is said out loud in the file, because a
rule that looks like an alert and reaches no one is worse than no rule: it gets trusted.
Where it goes and who is on call are decisions this cluster cannot answer.

**Grafana is disposable and Prometheus is not.** Grafana runs on an `emptyDir` — everything
it knows is provisioned from this directory, so its sqlite holds nothing that is not
already in git. Prometheus gets a PersistentVolumeClaim, because it holds the only copy of
every sample it has taken. Loki gets one for the same reason: a log store that loses its
chunks on a pod restart can answer *"what is this pod printing now"*, which is the one
question `kubectl logs` already answers.

**There is no Loki ruler, and the control plane does not know Loki exists.** No alerts on
log content, for the same reason there is no Alertmanager. And `ash job logs` does not fall
back to querying the archive: that would give the control plane a required dependency on a
log store, a client to configure and a new way for a log request to be slow, in exchange for
a fallback path. The API's answer when a pod is gone is that the cluster no longer knows —
which is true, and is what it says. ADR 0018 records it as the obvious next step if the
archive turns out to be what people reach for first.

## Things that bite

**`host.k3d.internal` goes missing.** Prometheus scrapes the control plane on it, and
every training pod is handed it as `ASHML_ENDPOINT`. k3d installs the name by writing it
into CoreDNS' `NodeHosts` entry, which k3s owns and rewrites from the node list whenever
the node set changes — so it disappears on a cluster restart, and the failure is quiet.
`make cluster-dns-check` asks a Pod; `make cluster-dns` restores it. See
`deploy/local/coredns-host-alias.yaml`.

**The control plane is scraped where it runs, which is not in the cluster.** In development
it runs on the workstation, so the target is `host.k3d.internal:8080` — the same address
training pods are given, so there is one thing that has to be true rather than two. A
control plane that moves into the cluster changes that one line to its Service.

**The control plane's own logs are not in Loki.** Alloy reads pods in `ashml-jobs`, and in
development the control plane runs on the workstation — so Loki holds what the *workloads*
printed and not what the platform did. It is the same asymmetry Prometheus has, and it goes
away the day the control plane runs in the cluster.

**Grafana takes a while to paint.** On a cold pod it runs its own sqlite migrations before
answering at all, which is why it has a startup probe; and the first render of a dashboard
here takes ten to twenty seconds before the panels fill in. Nothing is wrong.
