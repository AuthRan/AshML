# AshML developer commands.
#
# Everything here is reproducible from a clean checkout: `make cluster` twice in a row
# is not an error, and no target depends on state left behind by a previous one.

SHELL := /bin/bash

CLUSTER      ?= ashml
K3S_IMAGE    ?= rancher/k3s:v1.35.5-k3s1
API_PORT     ?= 6550
AGENTS       ?= 1
TRAINER_IMAGE ?= ashml/trainer:v1
RESNET_IMAGE ?= ashml/resnet-trainer:v1
DATA_DIR     ?= data
PNG_COUNT    ?= 10
SERVER_IMAGE ?= ashml/model-server:v1
ROUTER_IMAGE ?= ashml/model-router:v1
TEST_DATABASE_URL ?= postgresql://ashml:ashml@127.0.0.1:5432/ashml_test
NAMESPACE    ?= ashml-jobs

# Pins the context on every target that talks to the cluster. `current-context` is a
# global setting belonging to whoever last ran `kubectl config use-context`, and on a
# workstation with more than one cluster that is how an apply lands somewhere else
# entirely -- the same reason the control plane takes ASHML_KUBECONFIG_CONTEXT.
KCTL := kubectl --context k3d-$(CLUSTER)

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ------------------------------------------------------------------ cluster

.PHONY: cluster
cluster: ## Create the local k3d cluster (idempotent)
	@if k3d cluster list $(CLUSTER) >/dev/null 2>&1; then \
		echo "cluster '$(CLUSTER)' already exists; starting it if stopped"; \
		k3d cluster start $(CLUSTER) >/dev/null 2>&1 || true; \
	else \
		k3d cluster create $(CLUSTER) \
			--api-port 127.0.0.1:$(API_PORT) \
			--servers 1 --agents $(AGENTS) \
			--image $(K3S_IMAGE) \
			--k3s-arg "--disable=traefik@server:*" \
			--wait; \
	fi
	@$(KCTL) get nodes

.PHONY: cluster-down
cluster-down: ## Delete the local k3d cluster
	k3d cluster delete $(CLUSTER)

.PHONY: cluster-dns
cluster-dns: ## Restore host.k3d.internal inside the cluster (see the manifest's header)
	# Without this name, training pods cannot reach the control plane they were told to
	# report to, and Prometheus cannot scrape it. k3s rewrites the CoreDNS entry k3d puts
	# it in, so it disappears on a cluster restart. Harmless to apply when it is intact.
	$(KCTL) apply -f deploy/local/coredns-host-alias.yaml
	$(KCTL) -n kube-system rollout restart deployment/coredns
	$(KCTL) -n kube-system rollout status deployment/coredns --timeout=90s

.PHONY: cluster-dns-check
cluster-dns-check: ## Ask a Pod whether it can reach the control plane on host.k3d.internal
	# Asks from inside the cluster, because that is the only place the answer matters --
	# the name resolves perfectly well on the workstation and tells you nothing.
	@$(KCTL) run ashml-dns-check-$$$$ --rm -i --restart=Never --image=busybox:1.36 \
		--command -- sh -c 'wget -qO- -T 4 http://host.k3d.internal:8080/healthz \
		|| echo "UNREACHABLE -- run: make cluster-dns (and check a control plane is running)"'

.PHONY: cluster-status
cluster-status: ## Nodes, and every AshML workload in the cluster
	@$(KCTL) get nodes
	@echo
	@$(KCTL) get jobs,pods -n $(NAMESPACE) 2>/dev/null || echo "namespace $(NAMESPACE) does not exist yet"

# ------------------------------------------------------------------ images

.PHONY: image
image: ## Build the smoke workload image and load it into the cluster
	# Built from the repository root so the image can carry the Python SDK; see
	# .dockerignore for what is kept out of the context.
	docker build -t $(TRAINER_IMAGE) -f deploy/images/trainer/Dockerfile .
	# k3d nodes have their own containerd; an image built on the host is invisible to
	# them until it is imported. Without this every Pod sits in ErrImagePull.
	k3d image import $(TRAINER_IMAGE) -c $(CLUSTER)

.PHONY: cifar10
cifar10: ## Fetch and checksum the CIFAR-10 dataset into $(DATA_DIR)
	scripts/fetch-cifar10.sh $(DATA_DIR)

.PHONY: resnet-image
resnet-image: cifar10 ## Build the ResNet-18/CIFAR-10 image and load it into the cluster
	# The dataset arrives as a named build context rather than through the repository
	# root, so 178 MB of CIFAR never enters the context of the other image builds.
	docker build -t $(RESNET_IMAGE) \
		-f deploy/images/resnet-trainer/Dockerfile \
		--build-context cifar=$(DATA_DIR) .
	# ~2 GB, mostly PyTorch, so this import takes a few minutes where the smoke image
	# takes seconds. Same reason as `image`: k3d nodes cannot see the host's daemon.
	k3d image import $(RESNET_IMAGE) -c $(CLUSTER)

.PHONY: cifar-png
cifar-png: cifar10 ## Write CIFAR-10 test images out as PNGs, for `ash predict`
	# Test images, not training ones, and the true label is in each filename -- so a
	# prediction can be checked rather than admired.
	python3 scripts/cifar-png.py --data $(DATA_DIR) --count $(PNG_COUNT) --out $(DATA_DIR)/cifar-png

.PHONY: model-server-image
model-server-image: ## Build the inference image and load it into the cluster
	# Shares its torch layer with the trainer image by construction — same base, same
	# pip line — so this build is cheap once `resnet-image` has run.
	docker build -t $(SERVER_IMAGE) -f deploy/images/model-server/Dockerfile .
	k3d image import $(SERVER_IMAGE) -c $(CLUSTER)

.PHONY: router-image
router-image: ## Build the model router image and load it into the cluster
	# Node, not Python: the router forwards HTTP and holds no model, so it shares
	# nothing with the serving image and is a fraction of its size.
	docker build -t $(ROUTER_IMAGE) -f deploy/images/router/Dockerfile .
	k3d image import $(ROUTER_IMAGE) -c $(CLUSTER)

# ------------------------------------------------------------------ demo Space

# The public demo is the *serving* slice of this platform and nothing more: the same
# `serve.py` a Deployment runs, loading a model version this control plane registered.
# The control plane itself is not deployable to a public URL -- it creates Kubernetes
# Jobs, and while it authenticates every request since Phase 10 it still has no rate
# limiting and no audit of refusals -- and the Space's README says so rather than letting
# a live link imply otherwise.

SPACE_PROJECT ?= ashml-demo
SPACE_MODEL   ?= resnet18-cifar10

.PHONY: space
space: ## Assemble space/ from the PRODUCTION version of $(SPACE_MODEL)
	# Refuses to build around an artifact AshML did not verify: a demo is the last place
	# an unconfirmed checkpoint would be noticed.
	node scripts/build-space.mjs --project $(SPACE_PROJECT) --model $(SPACE_MODEL)

.PHONY: space-verify
space-verify: ## Re-evaluate space/model.pt over the full CIFAR-10 test set
	# Inside the serving image, on the pinned torch, through the same normalisation the
	# pod applies. It has to reproduce the accuracy recorded for the artifact -- if it
	# does not, the Space is serving something other than the model that was evaluated,
	# which is exactly what the provenance chain exists to catch.
	docker run --rm --entrypoint python -e ASHML_MAX_BATCH=500 \
		-v "$(PWD)/space:/space:ro" -v "$(PWD)/$(DATA_DIR):/data:ro" \
		-v "$(PWD)/scripts:/scripts:ro" \
		$(SERVER_IMAGE) /scripts/verify-space.py

.PHONY: space-onnx
space-onnx: ## Export space/model.pt to ONNX for the browser demo, and verify it
	# Writes nothing unless the exported graph reproduces, over all 10 000 test images,
	# the accuracy AshML recorded for the artifact -- and agrees with torch prediction
	# for prediction. A browser cannot run `serve.py`, so the demo substitutes a runtime;
	# this target is what stops that substitution from being taken on trust.
	docker run --rm --entrypoint bash \
		-v "$(PWD)/space:/space" -v "$(PWD)/$(DATA_DIR):/data:ro" \
		-v "$(PWD)/scripts:/scripts:ro" -e OUT_DIR=/space/static \
		$(SERVER_IMAGE) -c "pip install --quiet --no-cache-dir onnx onnxruntime onnxscript && python /scripts/export-onnx.py"
	cp space/provenance.json space/static/provenance.json
	mkdir -p space/static/examples docs/demo/examples
	cp space/examples/*.png space/static/examples/
	# The page ships in the repository; the 45 MB of weights do not. `docs/demo/` is
	# served by GitHub Pages and fetches `model.onnx` from the Hugging Face Space, which
	# serves it with CORS.
	cp space/static/provenance.json space/static/onnx-verification.json docs/demo/
	cp space/examples/*.png docs/demo/examples/

# ------------------------------------------------------------------ database

.PHONY: db-up
db-up: ## Start PostgreSQL and MinIO
	docker compose -f deploy/local/docker-compose.yml up -d

.PHONY: db-down
db-down: ## Stop PostgreSQL and MinIO
	docker compose -f deploy/local/docker-compose.yml down

.PHONY: migrate
migrate: ## Apply database migrations
	# `up` is not optional: node-pg-migrate takes a direction and exits non-zero without
	# one, so a bare `npm run migrate` failed — in the Quick start, on a reader's first
	# five commands. `make migrate-down` is the deliberate other direction.
	npm run migrate up

.PHONY: migrate-down
migrate-down: ## Roll back the most recent migration
	npm run migrate down

.PHONY: db-test
db-test: ## Create and migrate the dedicated test database (integration tests wipe it)
	# The integration suites TRUNCATE every table, so they get their own database and
	# refuse to touch the development one. This is the command that makes that database.
	node scripts/create-test-db.mjs
	ASHML_DATABASE_URL=$${ASHML_TEST_DATABASE_URL:-$(TEST_DATABASE_URL)} npm run migrate up

# ------------------------------------------------------------------ running

.PHONY: dev
dev: ## Run the control plane against the local cluster
	npm run dev

.PHONY: token
token: ## Issue an API token for the seeded local user, and print it
	# The first token cannot come from the API, which needs one. This writes directly to
	# the database, so minting requires access that could already read every row (ADR 0013).
	#
	#   export ASHML_TOKEN=$$(make -s token)
	#
	@node scripts/issue-token.mjs --user local@ashml.dev --name cli

.PHONY: test
test: ## Unit and integration tests
	npm test

.PHONY: test-sdk
test-sdk: ## Python SDK tests (ASHML_ENDPOINT + ASHML_TOKEN adds the live suite)
	python3 -m unittest discover -s sdk/python/tests -v

.PHONY: e2e
e2e: ## End-to-end: submit a job, run it on k3d, assert it SUCCEEDED
	ASHML_KUBECONFIG_CONTEXT=$${ASHML_KUBECONFIG_CONTEXT:-k3d-$(CLUSTER)} node scripts/e2e.mjs

.PHONY: e2e-scheduler
e2e-scheduler: ## End-to-end: overfill the cluster, assert queueing and placement
	ASHML_KUBECONFIG_CONTEXT=$${ASHML_KUBECONFIG_CONTEXT:-k3d-$(CLUSTER)} node scripts/e2e-scheduler.mjs

.PHONY: e2e-isolation
e2e-isolation: ## End-to-end: two projects, and prove neither can reach the other's pods
	# Asks the cluster rather than AshML: `wget` inside a real pod, at a real address a
	# pod in the other project answered on seconds earlier. A NetworkPolicy is an object
	# every cluster accepts and only some enforce, so asserting on the manifest would
	# prove nothing. Needs only busybox -- no built images, no dataset.
	ASHML_KUBECONFIG_CONTEXT=$${ASHML_KUBECONFIG_CONTEXT:-k3d-$(CLUSTER)} node scripts/e2e-isolation.mjs

.PHONY: e2e-rollout
e2e-rollout: ## End-to-end: a 10% canary against real pods, and measure the split
	# Needs a control plane already running with its deployment sync loop, and the three
	# images (`make resnet-image model-server-image router-image`). It trains the two
	# versions it rolls out -- minutes, not seconds -- because two versions made by hand
	# are a test of a hand-made setup. Pins the cluster the same way every target here does.
	ASHML_KUBECONFIG_CONTEXT=$${ASHML_KUBECONFIG_CONTEXT:-k3d-$(CLUSTER)} node scripts/e2e-rollout.mjs

.PHONY: journey
journey: ## The spec's §50 user journey, all nine steps, start to finish
	# The Phase 5 exit criterion, and the closest thing here to the demo itself. Drives
	# the `ash` CLI rather than the API, because §50 is written in `ash` commands and the
	# question is whether a person can run them. Needs the cluster, all three images,
	# `make cifar-png`, a control plane reachable *from a pod* -- see the README's two
	# addresses -- and `export ASHML_TOKEN=$$(make -s token)`, because the API is
	# default-deny since Phase 10. Ten minutes or so; JOURNEY_MANIFEST=... points step 2 at the full
	# epoch instead of the bounded one.
	ASHML_KUBECONFIG_CONTEXT=$${ASHML_KUBECONFIG_CONTEXT:-k3d-$(CLUSTER)} node scripts/journey.mjs

.PHONY: chaos-resume
chaos-resume: ## Chaos: kill a training pod, assert the retry resumes from its checkpoint
	# Needs a control plane that is already *running* and reachable from a pod, because
	# what is being proved is that the platform recovers on its own loop rather than
	# when a test calls into it. See the header of the script for the two addresses.
	ASHML_KUBECONFIG_CONTEXT=$${ASHML_KUBECONFIG_CONTEXT:-k3d-$(CLUSTER)} node scripts/chaos-resume.mjs

.PHONY: chaos-restart
chaos-restart: ## Chaos: SIGKILL the control plane mid-run, assert nothing was lost
	# This one *starts* the control plane, because killing it is the experiment. It
	# refuses to run if one is already answering, so stop yours first.
	ASHML_KUBECONFIG_CONTEXT=$${ASHML_KUBECONFIG_CONTEXT:-k3d-$(CLUSTER)} node scripts/chaos-restart.mjs

.PHONY: chaos-serving
chaos-serving: ## Chaos: kill the pod serving a model, assert it returns serving the same one
	# Needs a deployment that is already serving (`ash model deploy`) and a control plane
	# running its deployment sync loop -- what is observed is that loop noticing.
	ASHML_KUBECONFIG_CONTEXT=$${ASHML_KUBECONFIG_CONTEXT:-k3d-$(CLUSTER)} node scripts/chaos-serving.mjs

.PHONY: chaos-resume-resnet
chaos-resume-resnet: ## The same chaos, against ResNet-18: weights, optimizer and schedule
	# Minutes rather than seconds, and it needs `make resnet-image`. Worth both: the
	# smoke workload's whole state is one integer, so it proves the platform path and
	# nothing about restoring a state dict into a freshly built architecture.
	ASHML_KUBECONFIG_CONTEXT=$${ASHML_KUBECONFIG_CONTEXT:-k3d-$(CLUSTER)} CHAOS_WORKLOAD=resnet CHAOS_TIMEOUT_MS=600000 node scripts/chaos-resume.mjs

.PHONY: bench
bench: ## Measured benchmarks against a running control plane (needs ASHML_TOKEN)
	# Like every target here that talks to a control plane somebody else started --
	# bench, the three chaos scripts, e2e-rollout, space and journey -- this needs a
	# token, because the API is default-deny since Phase 10:
	#
	#   export ASHML_TOKEN=$$(make -s token)
	#
	# The scripts say so themselves on a 401 rather than leaving you to work it out.
	# Needs a control plane already running, because what is being measured includes the
	# event loop that is also running a scheduler. Set BENCH_PROJECT to a project with a
	# READY deployment to include the inference sweep.
	node scripts/bench.mjs

.PHONY: media
media: ## Rebuild the README's GIFs from the captured transcripts
	# The terminal GIFs are rendered from `docs/media/transcripts/*.txt`, which are the
	# real captured output of the command in each file's first line -- so re-rendering is
	# reproducible and a reader can diff the GIF against the text that produced it.
	#
	# The dashboard GIF is NOT rebuilt here: it is screenshots of a live control plane
	# with real jobs running, which no target can conjure. Recapture it with a control
	# plane up and something training, then:
	#   python3 scripts/media/framesgif.py 'frames/f*.png' docs/media/dashboard.gif
	python3 scripts/media/termgif.py docs/media/transcripts/journey.txt \
		docs/media/journey.gif --cols 100 --speed 1.6 --rows 18
	python3 scripts/media/termgif.py docs/media/transcripts/chaos-resume.txt \
		docs/media/chaos-resume.gif --cols 100 --speed 1.5 --rows 14
	python3 scripts/media/termgif.py docs/media/transcripts/rollout.txt \
		docs/media/rollout.gif --cols 100 --speed 1.5 --rows 13

.PHONY: openapi
openapi: ## Regenerate api/openapi.yaml from the route schemas
	npm run openapi

# ------------------------------------------------------------ observability

OBS_DIR       := deploy/observability
OBS_NS        ?= ashml-observability
PROM_IMAGE    ?= prom/prometheus:v3.14.0
GRAFANA_IMAGE ?= grafana/grafana:13.1.4
LOKI_IMAGE    ?= grafana/loki:3.5.7
ALLOY_IMAGE   ?= grafana/alloy:v1.12.1
GRAFANA_PORT  ?= 3000
PROM_PORT     ?= 9090
LOKI_PORT     ?= 3100

# Where Grafana's PostgreSQL datasource should look, *from inside the cluster*. The
# committed default matches deploy/local/docker-compose.yml; override it for a database
# on another port, e.g. `make observability GRAFANA_PG_ADDR=host.k3d.internal:55432`.
GRAFANA_PG_ADDR     ?=
GRAFANA_PG_DATABASE ?=
GRAFANA_PG_USER     ?=
GRAFANA_PG_PASSWORD ?=

# Hashes of what the pods mount. A ConfigMap change with no pod-template change is
# applied and then ignored by the running process until something restarts it, which is
# a change with no visible effect -- the worst kind to debug. These go into a pod
# annotation, so changing a scrape config or a dashboard rolls the pod that reads it.
OBS_CONFIG_HASH = $(shell cat $(OBS_DIR)/10-prometheus-config.yaml $(OBS_DIR)/11-prometheus-rules.yaml | sha256sum | cut -c1-16)
# The log side has two config files and two pods, and each has to roll when its own
# changes: an Alloy holding a stale relabel list ships logs with the wrong labels, which is
# worse than shipping none, because the query that finds nothing looks like an empty run.
OBS_LOKI_HASH  = $(shell sha256sum $(OBS_DIR)/30-loki.yaml  | cut -c1-16)
OBS_ALLOY_HASH = $(shell sha256sum $(OBS_DIR)/31-alloy.yaml | cut -c1-16)
# The Grafana hash covers the datasource overrides as well as the files, because an
# address supplied on the command line is read once at process start exactly like a file
# would be -- and a changed address that does not roll the pod is a change with no effect.
OBS_GRAFANA_HASH = $(shell { cat $(OBS_DIR)/dashboards/*.json $(OBS_DIR)/20-grafana-provisioning.yaml $(OBS_DIR)/21-grafana-credentials.yaml; \
                             echo '$(GRAFANA_PG_ADDR)|$(GRAFANA_PG_DATABASE)|$(GRAFANA_PG_USER)|$(GRAFANA_PG_PASSWORD)'; } | sha256sum | cut -c1-16)

.PHONY: observability-images
observability-images: ## Pull Prometheus, Grafana, Loki and Alloy and load them into the cluster
	docker pull $(PROM_IMAGE)
	docker pull $(GRAFANA_IMAGE)
	docker pull $(LOKI_IMAGE)
	docker pull $(ALLOY_IMAGE)
	k3d image import $(PROM_IMAGE) $(GRAFANA_IMAGE) $(LOKI_IMAGE) $(ALLOY_IMAGE) -c $(CLUSTER)

.PHONY: observability
observability: ## Deploy Prometheus, Loki and Grafana with the dashboards in deploy/observability
	$(KCTL) apply -f $(OBS_DIR)/00-namespace.yaml
	$(KCTL) apply -f $(OBS_DIR)/10-prometheus-config.yaml -f $(OBS_DIR)/11-prometheus-rules.yaml
	$(KCTL) apply -f $(OBS_DIR)/20-grafana-provisioning.yaml
	# Credentials before the Deployment that reads them, and overrides before either.
	# The other order starts the pod on the committed default and needs a restart to
	# correct it, which on a first deploy leaves two ReplicaSets behind.
	$(KCTL) apply -f $(OBS_DIR)/21-grafana-credentials.yaml
	@for pair in ASHML_PG_ADDR:'$(GRAFANA_PG_ADDR)' ASHML_PG_DATABASE:'$(GRAFANA_PG_DATABASE)' \
	             ASHML_PG_USER:'$(GRAFANA_PG_USER)' ASHML_PG_PASSWORD:'$(GRAFANA_PG_PASSWORD)'; do \
		key=$${pair%%:*}; value=$${pair#*:}; \
		if [ -n "$$value" ]; then \
			echo "overriding $$key in the Grafana datasource secret"; \
			$(KCTL) patch secret grafana-datasource-credentials -n $(OBS_NS) \
				-p "{\"stringData\":{\"$$key\":\"$$value\"}}" >/dev/null; \
		fi; \
	done
	# Dashboards are .json files in git rather than YAML-embedded strings, so they stay
	# reviewable, diffable and machine-checkable; this is what turns them into the
	# ConfigMap Grafana mounts. `create --dry-run | apply` rather than `create`, so
	# running this twice is not an error.
	$(KCTL) create configmap grafana-dashboards -n $(OBS_NS) \
		$(foreach f,$(wildcard $(OBS_DIR)/dashboards/*.json),--from-file=$(f)) \
		--dry-run=client -o yaml | $(KCTL) apply -f -
	sed 's/replaced-by-make/$(OBS_CONFIG_HASH)/' $(OBS_DIR)/12-prometheus.yaml | $(KCTL) apply -f -
	sed 's/replaced-by-make/$(OBS_GRAFANA_HASH)/' $(OBS_DIR)/22-grafana.yaml   | $(KCTL) apply -f -
	# Loki before Alloy: Alloy pushes seconds after it starts, and pushing to an address
	# with nothing behind it is a retry loop in the logs of the thing that collects logs.
	# Ordering costs nothing and removes a confusing first minute.
	sed 's/replaced-by-make/$(OBS_LOKI_HASH)/'  $(OBS_DIR)/30-loki.yaml  | $(KCTL) apply -f -
	$(KCTL) rollout status deployment/loki -n $(OBS_NS) --timeout=300s
	sed 's/replaced-by-make/$(OBS_ALLOY_HASH)/' $(OBS_DIR)/31-alloy.yaml | $(KCTL) apply -f -
	$(KCTL) rollout status deployment/prometheus -n $(OBS_NS) --timeout=300s
	$(KCTL) rollout status deployment/alloy      -n $(OBS_NS) --timeout=300s
	$(KCTL) rollout status deployment/grafana    -n $(OBS_NS) --timeout=300s
	@echo
	@echo "Grafana:    make grafana     -> http://127.0.0.1:$(GRAFANA_PORT)"
	@echo "Prometheus: make prometheus  -> http://127.0.0.1:$(PROM_PORT)"
	@echo "Loki:       make loki        -> http://127.0.0.1:$(LOKI_PORT)"

.PHONY: observability-status
observability-status: ## Pods, and whether Prometheus can actually reach its targets
	@$(KCTL) get pods,svc -n $(OBS_NS)
	@echo
	@echo "scrape targets:"
	@$(KCTL) exec -n $(OBS_NS) deploy/prometheus -- \
		wget -qO- 'http://localhost:9090/api/v1/targets?state=any' \
		| tr ',' '\n' | grep -E '"(job|health|lastError|scrapeUrl)"' || true
	@echo
	@echo "labels Loki has seen (an empty list means nothing has shipped yet):"
	@$(KCTL) exec -n $(OBS_NS) deploy/loki -- \
		wget -qO- 'http://localhost:3100/loki/api/v1/labels' || true
	@echo

.PHONY: observability-down
observability-down: ## Remove Prometheus, Loki and Grafana (this deletes every sample and every log)
	# The namespace takes the PersistentVolumeClaim with it, and with it every sample
	# Prometheus has taken. Said out loud because `-down` on every other target here is
	# cheap and this one is not.
	$(KCTL) delete namespace $(OBS_NS) --ignore-not-found
	$(KCTL) delete clusterrole ashml-prometheus --ignore-not-found
	$(KCTL) delete clusterrolebinding ashml-prometheus --ignore-not-found
	$(KCTL) delete clusterrole ashml-alloy-discovery --ignore-not-found
	$(KCTL) delete clusterrolebinding ashml-alloy-discovery --ignore-not-found
	# Alloy's log-reading grant lives in the *workload* namespaces, so deleting the
	# observability namespace does not take it with it. Left behind it is a RoleBinding to
	# a ServiceAccount that no longer exists -- harmless, and exactly the kind of leftover
	# nobody ever finds again. There is one per project namespace now, so this deletes by
	# label across all of them rather than naming one.
	# By label and across every namespace: the only Roles AshML creates are these, and it
	# creates one per project namespace, so there is no list of names to keep in step.
	$(KCTL) delete role,rolebinding -l app.kubernetes.io/managed-by=ashml \
		--all-namespaces --ignore-not-found
	# The shared namespace's pair comes from this repo's YAML, which labels `part-of`
	# rather than `managed-by`, so it is named explicitly.
	$(KCTL) delete role ashml-log-reader -n $(NAMESPACE) --ignore-not-found
	$(KCTL) delete rolebinding ashml-log-reader -n $(NAMESPACE) --ignore-not-found
	# Renamed in ADR 0019; removed here so an upgraded cluster does not keep the old pair.
	$(KCTL) delete role ashml-alloy-logs -n $(NAMESPACE) --ignore-not-found
	$(KCTL) delete rolebinding ashml-alloy-logs -n $(NAMESPACE) --ignore-not-found

.PHONY: grafana
grafana: ## Port-forward Grafana to http://127.0.0.1:$(GRAFANA_PORT)
	# A port-forward rather than a NodePort: this Grafana has anonymous viewing switched
	# on, and a NodePort would put every graph on the network for anyone who can reach
	# the node. Ctrl-C to stop.
	$(KCTL) port-forward -n $(OBS_NS) svc/grafana $(GRAFANA_PORT):3000

.PHONY: loki
loki: ## Port-forward Loki to http://127.0.0.1:$(LOKI_PORT)
	# Loki has no UI of its own -- Grafana is the UI. This is for asking it directly:
	#   curl -sG http://127.0.0.1:$(LOKI_PORT)/loki/api/v1/query_range \
	#     --data-urlencode 'query={job_id="<a job id>"}'
	$(KCTL) port-forward -n $(OBS_NS) svc/loki $(LOKI_PORT):3100

.PHONY: prometheus
prometheus: ## Port-forward Prometheus to http://127.0.0.1:$(PROM_PORT)
	$(KCTL) port-forward -n $(OBS_NS) svc/prometheus $(PROM_PORT):9090
