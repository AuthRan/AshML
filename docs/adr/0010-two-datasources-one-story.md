# ADR 0010 — The control plane exports its own metrics, and Grafana reads two datasources

**Status:** Accepted · **Date:** 2026-08-21 · **Phase:** 5

## Context

ADR 0009 settled *how numbers arrive*: training metrics are pushed by the run,
infrastructure metrics are scraped. It deferred the other half — what does the scraping,
what stores it, and what draws it — to Phase 5. This is that decision.

Three things had to be chosen, and they interact.

**What the control plane exposes.** AshML is the only process that knows what AshML
decided: how deep the queue is, why a job was refused a node, whether a deployment was
`DEGRADED` or merely `PROGRESSING`. None of that exists in Kubernetes' own metrics,
because none of it is Kubernetes' opinion.

**Where the training curves come from.** Prometheus is the obvious home for "everything
on one dashboard", and there is a well-trodden way to get pushed values into it: the
Prometheus **Pushgateway**. Runs would push there instead of to the API, and Grafana would
have a single datasource.

**How the stack is deployed.** `kube-prometheus-stack` is the default answer — an
operator, a Helm chart, `ServiceMonitor` CRDs, and about forty pods. The alternative is
plain manifests for one Prometheus and one Grafana.

## Decision

**1. The control plane exposes `/metrics`, and gathers it two different ways.**

*Instruments* — HTTP duration, executor pass duration, scheduling latency, prediction
latency, launch and outcome counters — are updated by the code as it runs. *Snapshots* —
jobs by state, queue depth and age, node capacity, deployment replicas, artifacts,
registered versions, GPU telemetry — are collected **at scrape time** from PostgreSQL and
the `GpuProvider`.

**2. Grafana has two datasources. Training curves come from PostgreSQL, not Prometheus.**
No Pushgateway. The training dashboard queries `training_metrics` directly and plots
against the `step` column the run reported, in Grafana **Trend** panels.

> **Three, since Phase 9's log gap was closed.**
> [ADR 0018](0018-logs-that-outlive-the-pod.md) adds Loki, and the third one is not a
> number: it is what the container printed, which used to live only in the Pod and
> therefore only until something deleted it. The split this ADR draws is unchanged —
> scraped, pushed, and now printed.

**3. The stack is plain YAML in `deploy/observability/`, and the dashboards are `.json`
files in git.** No operator, no Helm, no CRDs. `make observability` applies them.

**4. Two things in the Phase 5 plan are deliberately not deployed:** DCGM-exporter and
Alertmanager. Both are named in `deploy/observability/README.md` as absent, and why.

## Rationale

### Snapshots are read from the database, not accumulated in the process

A counter incremented wherever a job changes state would drift from the database the
moment anything else wrote to it — a second replica, a migration, a human with `psql`, a
row deleted by a cascade. A metric that disagrees with `ash job list` is worse than no
metric, because the graph is what gets believed at 3am and the CLI is what gets checked
afterwards.

Reading at scrape time costs seven aggregate queries every fifteen seconds, each one
grouping in PostgreSQL rather than pulling rows out to count them. That cost is exported
too, as `ashml_scrape_collect_duration_seconds`: a scrape that costs more than it reports
is a bug on a platform whose scheduler needs the same event loop.

Counters are still counters, and the two kinds do not overlap. `ashml_job_terminations_total`
must be incremented on the transition rather than derived from the state gauge, because a
job that succeeds and is cleaned up between two scrapes never appears in that gauge at all
— and "how many jobs failed today" must not depend on scrape timing.

### The Pushgateway would have made the step axis unrecoverable

It is the obvious way to unify the datasources and it destroys exactly what ADR 0009 was
protecting. Pushgateway holds the *most recent* value pushed for a label set; Prometheus
then scrapes it on a timer and stamps whatever it finds with the scrape's wall-clock time.
A run reporting step 40 and step 41 four milliseconds apart yields one sample, timestamped
by the scraper. The step is not merely a different axis — it is gone.

Making the step a *label* instead is the standard workaround and is worse: one series per
step, forty thousand series for one ResNet epoch, and Prometheus' own documentation names
this as the thing not to do.

So the values stay where the push already put them. `training_metrics` is long-format,
indexed on `(job_id, name, step)`, and holds exactly the axis the run reported. Grafana's
PostgreSQL datasource reads it. The Trend panel exists precisely for a chart whose x-axis
is a number that is not time, which is what a training curve is.

The two datasources are not a redundancy to be cleaned up later. They are the same
distinction ADR 0009 drew, made visible: one for things whose value at a moment is the
whole truth about them, one for things that belong to a step.

### No operator, for the same reason there is no Redis

`kube-prometheus-stack` would bring an operator, CRDs, node-exporter, kube-state-metrics
and Alertmanager, and would then need to be told to ignore most of them. The thing being
demonstrated here is one Prometheus scraping four targets and one Grafana drawing four
dashboards; wrapping that in a controller adds a layer that has to be understood before
anything can be debugged, and hides the scrape config — which is the part worth reading —
inside a CRD.

Dashboards as `.json` files rather than YAML-embedded strings, provisioned with
`allowUiUpdates: false`: they diff, review and lint like code, and a panel edited in a
browser is overwritten on the next reload. Deliberately. A panel that exists only in
someone's browser is a panel nobody else has.

### Cardinality is a design constraint, not a tuning exercise

Two rules, both of which have a specific failure behind them:

- **HTTP is labelled by route, never by URL.** `/api/v1/jobs/:id` is one series; the URL
  is one series per job.
- **A label may only carry a name that resolved.** Prediction metrics are labelled from
  the deployment row, after the lookup, so a request naming a deployment that does not
  exist mints nothing. `/metrics` is the one endpoint Phase 10 left public — Prometheus
  scrapes it, and a scrape target that needs a token turns an auth misconfiguration into
  an outage of the thing that would have reported it — so it is protected by not being
  routable from outside the cluster rather than by a credential. The routes that *mint*
  these labels are default-deny now, which narrows the vector considerably; an endpoint
  anyone can add series to is still an endpoint anyone can fill the disk with, and this is
  still the one to be careful about.

cAdvisor is filtered to four series for the same reason. Unfiltered it is tens of
thousands, and that is the usual reason a small Prometheus falls over.

### A failing source must not fail the scrape

Each snapshot source is isolated, and a failure increments
`ashml_scrape_errors_total{source=…}` rather than propagating. Answering 500 makes
Prometheus mark the target **down** and drop *everything* — including the metrics that were
still available and would have said what was wrong. A database that has gone away is
exactly when the GPU telemetry and the event-loop lag are worth having.

The cost is that gauges from a failed source are **stale rather than absent**, and nothing
about the graph says so. That counter is the only thing that does, which is why there is an
alert rule on it.

## Consequences

**Prometheus cannot answer "what was the loss at step 300".** By design, and it is a real
limitation: a single PromQL query cannot join infrastructure and training data. Correlating
"the loss curve flattened" with "the node was CPU-starved" means two panels and a human, or
a query against PostgreSQL that has the job's time window in it.

**Grafana holds a database credential.** It connects as a user with read access to the
control-plane database; Grafana's PostgreSQL datasource has no read-only setting, so the
*user* must be the constraint. On the development host it is the same `ashml` user the
control plane uses, which is a local-development compromise and is labelled as one in the
provisioning file rather than left to be discovered.

**The control plane is scraped where it runs.** In development that is the workstation, at
`host.k3d.internal:8080` — the same address training pods are handed as `ASHML_ENDPOINT`,
so there is one thing that has to be true rather than two. It also means the scrape shares
its fate: a control plane being restarted has a gap in its graphs, and the graphs cannot
explain the gap. `chaos-restart` already establishes that nothing else is lost.

**Training metrics never reach Prometheus, and a test enforces it.**
`metrics.integration.test.js` reports a loss and an accuracy through the API and then
asserts that neither the names nor the values appear anywhere in a scrape. The way this
decision would be broken is somebody adding a convenient query, and a test is the only
thing that notices.

**When the control plane moves into the cluster**, the static target becomes a Service
address and nothing else changes. That is the point at which an operator and a
`ServiceMonitor` start to pay for themselves — several control-plane replicas is when
service discovery beats a static target — and revisiting this is cheap, because the
exporter does not know or care what scrapes it.
