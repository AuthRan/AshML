/**
 * Deployment endpoints.
 *
 * Project-scoped and addressed by name, like models and datasets: a deployment's name
 * is its address, and the thing an operator says out loud is "roll resnet-cifar back to
 * v3", never a UUID.
 *
 * Creating a deployment is a POST to the *model*, because that is what is being
 * deployed — the deployment is the result, not the input. Redeploying the same name is
 * the same call, which is what makes rolling out a new version an update rather than a
 * delete and recreate.
 */

import * as deploymentService from '../services/deployments.js';

const deploymentSchema = {
  $id: 'Deployment',
  type: 'object',
  required: ['id', 'name', 'project', 'model', 'status', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    project: { type: 'string' },
    model: { type: 'string' },
    status: {
      type: 'string',
      enum: Object.values(deploymentService.DeploymentStatus),
      description:
        'What the cluster reports, not what was asked for. PROGRESSING means the '
        + 'objects exist but no pod has loaded a model yet; DEGRADED means it was '
        + 'serving and is now short of replicas.',
    },
    image: { type: 'string' },
    replicas: { type: 'integer', description: 'Replicas asked for' },
    ready_replicas: {
      type: 'integer',
      description:
        'Replicas that passed their readiness probe — which for a model server means '
        + 'the weights are loaded, not merely that the pod exists',
    },
    cpu: { type: 'number' },
    memory_bytes: { type: 'integer' },
    gpu: { type: 'integer' },
    endpoint_url: {
      type: ['string', 'null'],
      description: 'The in-cluster address. Null means nothing is listening yet.',
    },
    k8s_name: { type: ['string', 'null'] },
    namespace: { type: ['string', 'null'] },
    last_error: {
      type: ['string', 'null'],
      description: 'Why it is not serving. Cleared when it is, so it cannot go stale.',
    },
    target: {
      type: ['object', 'null'],
      description: 'The model version this deployment serves.',
      properties: {
        model_version_id: { type: 'string', format: 'uuid' },
        version: { type: 'integer' },
        version_status: { type: 'string' },
        traffic_weight: { type: 'integer' },
        artifact_id: { type: 'string', format: 'uuid' },
        artifact_status: { type: 'string' },
        arch: {
          type: ['string', 'null'],
          description: 'The architecture the training run recorded on the artifact',
        },
      },
    },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: ['string', 'null'], format: 'date-time' },
  },
};

const projectParam = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
};

export async function registerDeploymentRoutes(app) {
  app.addSchema(deploymentSchema);

  app.post(
    '/api/v1/projects/:name/models/:model/deployments',
    {
      schema: {
        tags: ['deployments'],
        summary: 'Deploy a model version',
        description:
          'Creates the Kubernetes Deployment and Service that serve a version, or '
          + 'updates them if this deployment name already exists — which is how a new '
          + 'version is rolled out without dropping traffic. With no version given, the '
          + 'one in PRODUCTION is deployed; if none is promoted this fails rather than '
          + 'quietly serving the newest.',
        params: {
          type: 'object',
          required: ['name', 'model'],
          properties: { name: { type: 'string' }, model: { type: 'string' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            version: { type: 'integer', minimum: 1 },
            name: { type: 'string', description: 'Deployment name; defaults to the model name' },
            replicas: { type: 'integer', minimum: 1, default: 1 },
            image: { type: 'string' },
            cpu: { type: 'number', minimum: 0 },
            memory_bytes: { type: 'integer', minimum: 0 },
            gpu: { type: 'integer', minimum: 0 },
            arch: {
              type: 'string',
              description: 'Overrides the architecture recorded on the artifact',
            },
          },
        },
        response: {
          200: { $ref: 'Deployment#' },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      const body = request.body ?? {};
      const deployment = await deploymentService.deployModel(app.db, app.k8s, {
        projectName: request.params.name,
        modelName: request.params.model,
        version: body.version ?? null,
        name: body.name ?? null,
        replicas: body.replicas ?? 1,
        ...(body.image ? { image: body.image } : {}),
        ...(body.cpu != null ? { cpu: body.cpu } : {}),
        ...(body.memory_bytes != null ? { memoryBytes: body.memory_bytes } : {}),
        ...(body.gpu != null ? { gpu: body.gpu } : {}),
        arch: body.arch ?? null,
        apiUrl: app.apiAdvertiseUrl,
        namespace: app.k8s.namespace,
      });

      request.log.info(
        {
          deployment_id: deployment.id,
          model: deployment.model,
          version: deployment.target?.version,
          replicas: deployment.replicas,
          endpoint: deployment.endpoint_url,
        },
        'model deployed',
      );
      return deployment;
    },
  );

  app.get(
    '/api/v1/projects/:name/deployments',
    {
      schema: {
        tags: ['deployments'],
        summary: "List a project's deployments",
        params: projectParam,
        response: {
          200: {
            type: 'object',
            required: ['deployments'],
            properties: { deployments: { type: 'array', items: { $ref: 'Deployment#' } } },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => ({
      deployments: await deploymentService.listDeployments(app.db, {
        projectName: request.params.name,
      }),
    }),
  );

  app.get(
    '/api/v1/projects/:name/deployments/:deployment',
    {
      schema: {
        tags: ['deployments'],
        summary: 'Show a deployment',
        params: {
          type: 'object',
          required: ['name', 'deployment'],
          properties: { name: { type: 'string' }, deployment: { type: 'string' } },
        },
        response: { 200: { $ref: 'Deployment#' }, 404: { $ref: 'Error#' } },
      },
    },
    async (request) => deploymentService.getDeploymentByName(
      app.db,
      request.params.name,
      request.params.deployment,
    ),
  );

  app.delete(
    '/api/v1/projects/:name/deployments/:deployment',
    {
      schema: {
        tags: ['deployments'],
        summary: 'Remove a deployment',
        description:
          'Deletes the Kubernetes objects first and the record second. The other order '
          + 'can leave pods serving that nothing in AshML knows about.',
        params: {
          type: 'object',
          required: ['name', 'deployment'],
          properties: { name: { type: 'string' }, deployment: { type: 'string' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['id', 'name'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              project: { type: 'string' },
            },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      const removed = await deploymentService.undeploy(
        app.db,
        app.k8s,
        request.params.name,
        request.params.deployment,
      );
      request.log.info({ deployment_id: removed.id, name: removed.name }, 'deployment removed');
      return removed;
    },
  );
}
