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
import { Permission } from '../domain/roles.js';
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
    replicas: {
      type: 'integer',
      description: 'Replicas asked for, per version. Each target runs this many.',
    },
    ready_replicas: {
      type: 'integer',
      description:
        'Replicas that passed their readiness probe — which for a model server means '
        + 'the weights are loaded, not merely that the pod exists — summed over the '
        + 'versions taking traffic',
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
    serving_version: {
      type: ['integer', 'null'],
      description:
        'The version the deployment\'s address currently resolves to. This is observed '
        + 'state: during a switch it is still the outgoing version, which is the one '
        + 'actually answering, and it lags what the targets ask for until the incoming '
        + 'version has a ready pod.',
    },
    targets: {
      type: 'array',
      description:
        'The model versions this deployment serves, and the share of traffic each is '
        + 'meant to take. Weights sum to 100 and are never normalised; a version at 0 '
        + 'is out of rotation and scaled to no pods, kept so that putting it back is a '
        + 'weight change rather than a redeploy.',
      items: {
        type: 'object',
        properties: {
          model_version_id: { type: 'string', format: 'uuid' },
          version: { type: 'integer' },
          version_status: { type: 'string' },
          traffic_weight: { type: 'integer' },
          replicas: { type: 'integer' },
          status: {
            type: 'string',
            enum: Object.values(deploymentService.DeploymentStatus),
            description: 'This version\'s own pods, observed separately from the deployment\'s',
          },
          ready_replicas: { type: 'integer' },
          last_error: { type: ['string', 'null'] },
          k8s_name: { type: ['string', 'null'] },
          endpoint_url: {
            type: ['string', 'null'],
            description:
              'This version\'s own address. Not the one callers use — that is the '
              + 'deployment\'s — but the one traffic is forwarded to.',
          },
          artifact_id: { type: 'string', format: 'uuid' },
          artifact_status: { type: 'string' },
          arch: {
            type: ['string', 'null'],
            description: 'The architecture the training run recorded on the artifact',
          },
        },
      },
    },
    router_status: {
      type: ['string', 'null'],
      enum: [...Object.values(deploymentService.DeploymentStatus), null],
      description:
        'The router\'s own pods, when there is a router. It is in front of every request '
        + 'once a deployment splits traffic, so its health is part of the deployment\'s '
        + 'and is observed rather than assumed.',
    },
    router_ready_replicas: { type: 'integer' },
    router_k8s_name: { type: ['string', 'null'] },
    dropped_versions: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'Versions this deploy took out of rotation. Deploying is a rollout to 100%, so '
        + 'anything that was taking traffic stops — named here rather than dropping to '
        + 'zero quietly. They keep their rows and their objects, at no replicas.',
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
      config: { permission: Permission.PROJECT_WRITE },
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
          version: deployment.serving_version,
          targets: deployment.targets.map((t) => `v${t.version}@${t.traffic_weight}`),
          replicas: deployment.replicas,
          endpoint: deployment.endpoint_url,
        },
        'model deployed',
      );
      return deployment;
    },
  );

  const deploymentParam = {
    type: 'object',
    required: ['name', 'deployment'],
    properties: { name: { type: 'string' }, deployment: { type: 'string' } },
  };

  app.post(
    '/api/v1/projects/:name/deployments/:deployment/rollout',
    {
      config: { permission: Permission.PROJECT_WRITE },
      schema: {
        tags: ['deployments'],
        summary: 'Move a share of the traffic onto one version',
        description:
          'Names one version and the share it should take; the rest of the split is taken '
          + 'from the other versions in proportion to what they already have. Weights are '
          + 'shares of traffic, not replica counts, and they always sum to exactly 100 — '
          + 'they are never normalised, because a share adjusted for you is a split you '
          + 'did not choose.\n\n'
          + 'A version not already served is added, and is validated exactly as deploying '
          + 'it would be: a canary that fails because its artifact was never confirmed '
          + 'looks like the model is bad, which is the worst possible outcome for a '
          + 'mechanism whose only purpose is to find out whether the model is bad.',
        params: deploymentParam,
        body: {
          type: 'object',
          required: ['version', 'traffic'],
          properties: {
            version: { type: 'integer', minimum: 1 },
            traffic: { type: 'integer', minimum: 0, maximum: 100 },
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
    async (request) => deploymentService.rollout(app.db, app.k8s, {
      projectName: request.params.name,
      deploymentName: request.params.deployment,
      version: request.body.version,
      traffic: request.body.traffic,
      apiUrl: app.apiAdvertiseUrl,
      namespace: app.k8s.namespace,
    }),
  );

  app.post(
    '/api/v1/projects/:name/deployments/:deployment/promote',
    {
      config: { permission: Permission.PROJECT_WRITE },
      schema: {
        tags: ['deployments'],
        summary: 'End a rollout: one version takes all the traffic',
        description:
          'The other versions go to weight 0 rather than being removed, so the version '
          + 'that was serving a minute ago is still there to go back to. Removing one is '
          + '`retire`, and it is deliberately a separate decision.',
        params: deploymentParam,
        body: {
          type: 'object',
          required: ['version'],
          properties: { version: { type: 'integer', minimum: 1 } },
        },
        response: {
          200: { $ref: 'Deployment#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request) => deploymentService.promote(app.db, app.k8s, {
      projectName: request.params.name,
      deploymentName: request.params.deployment,
      version: request.body.version,
      apiUrl: app.apiAdvertiseUrl,
      namespace: app.k8s.namespace,
    }),
  );

  app.delete(
    '/api/v1/projects/:name/deployments/:deployment/targets/:version',
    {
      config: { permission: Permission.PROJECT_WRITE },
      schema: {
        tags: ['deployments'],
        summary: 'Stop serving a version entirely, and remove its pods',
        description:
          'Refused while the version is taking traffic, and refused while the '
          + "deployment's address still resolves to it. Both refusals exist because the "
          + 'alternative is an outage caused by tidying up.',
        params: {
          type: 'object',
          required: ['name', 'deployment', 'version'],
          properties: {
            name: { type: 'string' },
            deployment: { type: 'string' },
            version: { type: 'integer' },
          },
        },
        response: {
          200: { $ref: 'Deployment#' },
          404: { $ref: 'Error#' },
          409: { $ref: 'Error#' },
        },
      },
    },
    async (request) => deploymentService.retire(app.db, app.k8s, {
      projectName: request.params.name,
      deploymentName: request.params.deployment,
      version: Number(request.params.version),
      namespace: app.k8s.namespace,
    }),
  );

  app.get(
    '/api/v1/deployments/:id/routing',
    {
      config: { authorization: 'handler' },
      schema: {
        tags: ['deployments'],
        summary: 'The traffic split a router should apply',
        description:
          'Read by the model router, once every few seconds, and by nothing else. It is '
          + 'addressed by **id** rather than by project and name because that is what the '
          + "router pod is given: a name is a thing an operator can change, and a router "
          + 'asking about a name that has moved would quietly stop working at the exact '
          + 'moment nobody was watching it.\n\n'
          + 'The document is deliberately small. Everything a router needs to choose a '
          + 'target and nothing it does not — no artifact metadata, no status history, no '
          + 'resource limits. It is fetched on a timer by every router pod, and a payload '
          + 'that grew with the deployment would make that a cost that grew too.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['deployment_id', 'targets'],
            properties: {
              deployment_id: { type: 'string', format: 'uuid' },
              deployment: { type: 'string' },
              model: { type: 'string' },
              updated_at: { type: ['string', 'null'], format: 'date-time' },
              targets: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    version: { type: 'integer' },
                    weight: {
                      type: 'integer',
                      description: 'Share of traffic, 0-100. The weights sum to exactly 100.',
                    },
                    url: {
                      type: ['string', 'null'],
                      description: "This version's own in-cluster Service",
                    },
                    ready: {
                      type: 'boolean',
                      description:
                        'What AshML last observed, which is up to a sync interval old. A '
                        + 'hint the router uses to keep traffic off a version whose pods '
                        + 'are not up — never a reason to keep it off one that has come '
                        + 'back, since the router finds that out first.',
                    },
                    artifact_id: { type: ['string', 'null'], format: 'uuid' },
                    model_version_id: { type: 'string', format: 'uuid' },
                  },
                },
              },
            },
          },
          404: { $ref: 'Error#' },
        },
      },
    },
    async (request) => {
      // Addressed by deployment id rather than by project name, because this is the
      // endpoint the router itself polls. ROUTING_READ rather than PROJECT_READ so a
      // router's token follows its own table without being able to read anything else.
      await app.requireDeployment(request, request.params.id, Permission.ROUTING_READ);
      const deployment = await deploymentService.getDeployment(app.db, request.params.id);
      return {
        deployment_id: deployment.id,
        deployment: deployment.name,
        model: deployment.model,
        updated_at: deployment.updated_at,
        targets: deployment.targets.map((target) => ({
          version: target.version,
          weight: target.traffic_weight,
          url: target.endpoint_url,
          ready: target.status === deploymentService.DeploymentStatus.READY,
          artifact_id: target.artifact_id,
          model_version_id: target.model_version_id,
        })),
      };
    },
  );

  app.get(
    '/api/v1/projects/:name/deployments',
    {
      config: { permission: Permission.PROJECT_READ },
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
      config: { permission: Permission.PROJECT_READ },
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
      // Read, not write: asking a served model a question changes nothing about the
      // project, so a VIEWER may try the model they can already see.
      config: { permission: Permission.PROJECT_READ },
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
                description:
                  'Which version produced this answer. With a split in place that is '
                  + "the router's word, taken from the response it returned; with one "
                  + "version taking traffic it is AshML's record of where the address "
                  + 'resolves. `source` says which, because the two are different degrees '
                  + 'of confidence.',
                additionalProperties: true,
                properties: {
                  deployment: { type: 'string' },
                  model: { type: 'string' },
                  version: { type: ['integer', 'null'] },
                  artifact_id: { type: ['string', 'null'] },
                  arch: { type: ['string', 'null'] },
                  source: { type: 'string', enum: ['router', 'deployment-record'] },
                  route_reason: {
                    type: 'string',
                    description:
                      'Why the router chose this version: weighted, sticky, only-ready, '
                      + 'sole-target, or failover',
                  },
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
      config: { permission: Permission.PROJECT_READ },
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
      config: { permission: Permission.PROJECT_WRITE },
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
