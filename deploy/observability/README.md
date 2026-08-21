# Observability

Prometheus and Grafana on the local k3d cluster, with every dashboard provisioned from
this directory. This is §50 step 8 — *observe* — and the exporter on the control plane's
`/metrics` is only half of it: a metric nobody looks at is a metric nobody has.

```bash
make observability-images     # pull Prometheus and Grafana, import them into k3d
make observability            # apply everything, wait for both rollouts
make grafana                  # port-forward -> http://127.0.0.1:3000
```

If your database is not the one in `deploy/local/docker-compose.yml`:

```bash
make observability GRAFANA_PG_ADDR=host.k3d.internal:55432
```

`make observability-status` prints the pods and asks Prometheus which of its targets are
actually up. `make observability-down` removes everything — **including the metric
history**, because the PersistentVolumeClaim goes with the namespace.

## Two datasources, because there are two kinds of number

This is ADR 0009 made visible, and it is the single most important thing about this
directory.

| | scraped | pushed |
|---|---|---|
| what | queue depth, replica counts, pass durations, GPU telemetry | loss, accuracy, learning rate |
| why | their value *at a moment* is the whole truth about them | they belong to a **step**, and only the training loop knows which |
| where | Prometheus, from `/metrics` | `training_metrics` in PostgreSQL, from the SDK |
| dashboard | Cluster & GPU, Job pipeline, Inference | Training curves |

A scraper sampling training metrics on a timer records *"loss was 1.84 at 14:03:22"* —
the wrong axis — and silently drops every step between two scrapes. So Grafana has a
**PostgreSQL datasource** as well as a Prometheus one, and the training dashboard reads
the step column the run itself reported. Those panels are Grafana **Trend** panels rather
than time series, which is the panel type that exists precisely because the x-axis is a
number that is not time.

## What is deployed

| file | what |
|---|---|
| `00-namespace.yaml` | `ashml-observability`, kept apart from `ashml-jobs` so deleting the workloads never deletes the graphs that explain them |
| `10-prometheus-config.yaml` | scrape config: the control plane, the kubelets' cAdvisor, and Prometheus itself |
| `11-prometheus-rules.yaml` | alert rules — see the honesty note below |
| `12-prometheus.yaml` | RBAC, a PVC, the Deployment and its Service |
| `20-grafana-provisioning.yaml` | the two datasources and the dashboard provider |
| `21-grafana-credentials.yaml` | development credentials, overridable from `make` |
| `22-grafana.yaml` | the Grafana Deployment and Service |
| `dashboards/*.json` | the four dashboards |

Dashboards are `.json` files in git rather than strings embedded in YAML, so they diff,
review and lint like code. `make observability` turns them into a ConfigMap. They are
provisioned with `allowUiUpdates: false`: a panel edited in the browser is overwritten on
the next reload, deliberately, because a panel that exists only in someone's browser is a
panel nobody else has.

## The three things this deployment refuses to pretend

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
every sample it has taken.

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

**Grafana takes a while to paint.** On a cold pod it runs its own sqlite migrations before
answering at all, which is why it has a startup probe; and the first render of a dashboard
here takes ten to twenty seconds before the panels fill in. Nothing is wrong.
