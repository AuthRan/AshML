# The model router (Phase 5, spec §21).
#
# One process in front of a deployment's versions, choosing which one answers each
# request. It holds no model and knows nothing about inference: it reads a traffic split
# from the control plane every few seconds and forwards.
#
#   docker build -t ashml/model-router:v1 -f deploy/images/router/Dockerfile .
#
# `make router-image` does this and imports it into k3d.
FROM node:22-slim

# Routers must not run as root, for the same reason training and inference containers
# must not. The node image ships a `node` user; using it is one fewer account to explain.
WORKDIR /app

# Dependency manifests first, so a change to the router's source does not re-resolve npm.
COPY package.json package-lock.json ./
COPY packages/router/package.json packages/router/

# Only the router's dependencies. `--workspace` keeps the control plane's tree out of
# this image entirely: it depends on the AWS SDK, the Kubernetes client and pg, none of
# which a process that forwards HTTP has any business carrying.
RUN npm ci --omit=dev --workspace @ashml/router --ignore-scripts

COPY packages/router/src packages/router/src

# One file from the control plane, at the path the router imports it from. `routing.js`
# is pure and imports nothing, which is what makes copying it possible — and copying it
# rather than reimplementing it is the point: the control plane validates and stores the
# weights, the router applies them, and two implementations of what a weight *means*
# would be two answers to the question §21 exists to make answerable.
COPY packages/server/src/domain/routing.js packages/server/src/domain/routing.js

USER node

ENV NODE_ENV=production
ENV ASHML_PORT=8082

EXPOSE 8082

ENTRYPOINT ["node", "packages/router/src/index.js"]
