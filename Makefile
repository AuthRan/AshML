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
NAMESPACE    ?= ashml-jobs

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
	@kubectl --context k3d-$(CLUSTER) get nodes

.PHONY: cluster-down
cluster-down: ## Delete the local k3d cluster
	k3d cluster delete $(CLUSTER)

.PHONY: cluster-status
cluster-status: ## Nodes, and every AshML workload in the cluster
	@kubectl get nodes
	@echo
	@kubectl get jobs,pods -n $(NAMESPACE) 2>/dev/null || echo "namespace $(NAMESPACE) does not exist yet"

# ------------------------------------------------------------------ images

.PHONY: image
image: ## Build the smoke workload image and load it into the cluster
	docker build -t $(TRAINER_IMAGE) deploy/images/trainer
	# k3d nodes have their own containerd; an image built on the host is invisible to
	# them until it is imported. Without this every Pod sits in ErrImagePull.
	k3d image import $(TRAINER_IMAGE) -c $(CLUSTER)

# ------------------------------------------------------------------ database

.PHONY: db-up
db-up: ## Start PostgreSQL and MinIO
	docker compose -f deploy/local/docker-compose.yml up -d

.PHONY: db-down
db-down: ## Stop PostgreSQL and MinIO
	docker compose -f deploy/local/docker-compose.yml down

.PHONY: migrate
migrate: ## Apply database migrations
	npm run migrate

# ------------------------------------------------------------------ running

.PHONY: dev
dev: ## Run the control plane against the local cluster
	npm run dev

.PHONY: test
test: ## Unit and integration tests
	npm test

.PHONY: e2e
e2e: ## End-to-end: submit a job, run it on k3d, assert it SUCCEEDED
	node scripts/e2e.mjs

.PHONY: e2e-scheduler
e2e-scheduler: ## End-to-end: overfill the cluster, assert queueing and placement
	node scripts/e2e-scheduler.mjs

.PHONY: openapi
openapi: ## Regenerate api/openapi.yaml from the route schemas
	npm run openapi
