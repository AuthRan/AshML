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
import * as inferenceService from '../services/inference.js';

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

  /**
   * A batch of 64 CIFAR images is about a megabyte of JSON, which is exactly Fastify's
   * default body limit — so the default would reject the largest batch the model server
   * is willing to accept, and the error would name a byte count rather than a batch size.
   * Raised here only, because no other endpoint on this API has any business taking a
   * body this size.
   */
  const PREDICT_BODY_LIMIT = 16 * 1024 * 1024;

  app.post(
    '/api/v1/projects/:name/deployments/:deployment/predict',
    {
      bodyLimit: PREDICT_BODY_LIMIT,
      schema: {
        tags: ['deployments'],
        summary: 'Ask a deployment for predictions',
        description:
          'Forwards instances to the pods behind a deployment and returns what they '
          + 'answer, together with which model version AshML records as serving.\n\n'
          + '**This is not the serving path.** It goes through the Kubernetes API '
          + "server's proxy so that a human outside the cluster can ask a ClusterIP a "
          + 'question. Production traffic goes to `endpoint_url` from inside the '
          + 'cluster: routing it through here would put every inference on the event '
          + 'loop that runs the scheduler, and would make a control-plane restart an '
          + 'inference outage.\n\n'
          + 'The shape of an instance is the model server\'s business, not this API\'s. '
          + 'For `resnet18-cifar` it is a 32x32x3 array of 0..255 values, and the '
          + 'normalisation the weights were trained with is applied by the server — '
          + 'doing it on the caller\'s side is a silent accuracy loss no error mentions.',
        params: {
          type: 'object',
          required: ['name', 'deployment'],
          properties: { name: { type: 'string' }, deployment: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['instances'],
          additionalProperties: false,
          properties: {
            instances: {
              type: 'array',
              minItems: 1,
              description: 'One entry per thing to predict on, in whatever shape the architecture takes',
            },
            timeout_ms: {
              type: 'integer',
              minimum: 100,
              maximum: 120_000,
              description: 'How long to wait for the pod to answer',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['predictions', 'served_by'],
            properties: {
              predictions: {
                type: 'array',
                description: "The model server's answers, relayed unchanged",
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    class_id: { type: 'integer' },
                    class_name: { type: ['string', 'null'] },
                    confidence: { type: 'number' },
                  },
                },
              },
              latency_ms: {
                type: ['number', 'null'],
                description: 'The forward pass, as measured by the pod that ran it',
              },
              round_trip_ms: {
                type: 'number',
                description:
                  'The whole call as measured here, including the API server proxy. '
                  + 'Larger than latency_ms, and the difference is not the model.',
              },
              arch: {
                type: ['string', 'null'],
                description: 'The architecture the answering pod says it is running',
              },
              served_by: {
                type: 'object',
                description: 'What AshML records this deployment as serving',
                additionalProperties: true,
                properties: {
                  deployment: { type: 'string' },
                  model: { type: 'string' },
                  version: { type: ['integer', 'null'] },
                  artifact_id: { type: ['string', 'null'] },
                  arch: { type: ['string', 'null'] },
                },
              },
              simulated: {
                type: 'boolean',
                description: 'Present and true only when no real pod answered (spec Rule 5)',
              },
            },
          },
          400: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
          502: { $ref: 'Error#' },
          503: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      const body = request.body ?? {};
      const answer = await inferenceService.predict(app.db, app.k8s, {
        projectName: request.params.name,
        deploymentName: request.params.deployment,
        instances: body.instances,
        metrics: app.metrics,
        ...(body.timeout_ms ? { timeoutMs: body.timeout_ms } : {}),
      });

      request.log.info(
        {
          deployment: request.params.deployment,
          model_version: answer.served_by.version,
          instances: body.instances.length,
          latency_ms: answer.latency_ms,
          round_trip_ms: answer.round_trip_ms,
        },
        'prediction served',
      );
      return answer;
    },
  );

  app.get(
    '/api/v1/projects/:name/deployments/:deployment/metadata',
    {
      schema: {
        tags: ['deployments'],
        summary: 'Ask the pods what they actually have loaded',
        description:
          "What the process says is in its memory, as against what AshML's record says "
          + 'it deployed. Normally identical — and the point is the case where they are '
          + 'not, which otherwise surfaces only as predictions nobody can reproduce. '
          + '`matches_record` is that comparison, made here so a caller cannot forget '
          + 'to make it.',
        params: {
          type: 'object',
          required: ['name', 'deployment'],
          properties: { name: { type: 'string' }, deployment: { type: 'string' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['reported'],
            additionalProperties: true,
            properties: {
              deployment: { type: 'string' },
              model: { type: 'string' },
              version: { type: ['integer', 'null'] },
              artifact_id: { type: ['string', 'null'] },
              arch: { type: ['string', 'null'] },
              reported: {
                type: 'object',
                additionalProperties: true,
                description: "The pod's own answer, relayed unchanged",
              },
              matches_record: {
                type: ['boolean', 'null'],
                description:
                  'Whether the pod is serving the artifact AshML recorded. Null when '
                  + 'one side did not say, which is not the same as a mismatch.',
              },
              simulated: { type: 'boolean' },
            },
          },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
          502: { $ref: 'Error#' },
          503: { $ref: 'Error#' },
        },
      },
    },
    async (request) => inferenceService.servedMetadata(app.db, app.k8s, {
      projectName: request.params.name,
      deploymentName: request.params.deployment,
    }),
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
