/**
 * Deployment service: turning a registered model version into something that answers.
 *
 * Three rules are enforced here, and each exists because the alternative fails somewhere
 * much worse than a rejected API call:
 *
 * 1. **Only a READY artifact can be deployed.** The same rule the registry applies to
 *    registration, applied again at serving time — because an artifact's bytes can be
 *    confirmed at registration and the version can still be pointing at a store that no
 *    longer has them. The failure this prevents is a pod that pulls a model, gets a 404,
 *    and crash-loops with the reason four layers down in a container log.
 *
 * 2. **Only an architecture the server has code for can be deployed.** A state_dict is
 *    weights without structure, so the serving image can only reconstruct shapes it has
 *    a builder for. Checking here turns "shape mismatch traceback at 3am" into "this
 *    server cannot serve that architecture" at the moment of asking.
 *
 * 3. **An ARCHIVED version is refused.** Archiving is how a version is retired; letting
 *    one be deployed anyway would make the lifecycle decorative.
 *
 * What this service deliberately does *not* do is decide when a deployment is healthy.
 * That comes from the cluster, through `syncDeployments`, for the same reason job state
 * comes from observed Pod status rather than from a timer: a control plane that believes
 * its own optimism reports success it has not checked.
 */

import { withTransaction } from '../db/pool.js';
import { ArtifactStatus } from '../domain/artifact-status.js';
import { ModelStatus } from '../domain/model-status.js';
import {
  buildDeploymentManifest, buildServiceManifest, kubeDeploymentName, serviceUrl,
} from '../k8s/manifest.js';
import * as deploymentsRepo from '../repos/deployments.js';
import * as modelsRepo from '../repos/models.js';
import * as artifactsRepo from '../repos/artifacts.js';
import * as projectsRepo from '../repos/projects.js';
import { ConflictError, NotFoundError, ValidationError, UNIQUE_VIOLATION } from './errors.js';

/** Deployment status values. AshML's vocabulary, not Kubernetes'. */
export const DeploymentStatus = Object.freeze({
  PENDING: 'PENDING',
  PROGRESSING: 'PROGRESSING',
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  FAILED: 'FAILED',
  STOPPED: 'STOPPED',
});

/**
 * Architectures the model server can reconstruct.
 *
 * Kept in step with `ARCHITECTURES` in `deploy/images/model-server/serve.py` by hand,
 * which is a seam worth naming: the control plane refuses early and the server refuses
 * late, and if the two lists disagree the server is the one that is right. The check
 * here is a courtesy that turns a crash loop into an error message — it is not the
 * authority, which is why the server validates again rather than trusting this.
 */
export const SERVABLE_ARCHITECTURES = Object.freeze(['resnet18-cifar']);

const DEFAULT_IMAGE = 'ashml/model-server:v1';
const DEFAULT_MEMORY = 2 * 1024 ** 3;

async function requireProject(client, projectName) {
  const project = await projectsRepo.getProjectByName(client, projectName);
  if (!project) throw new NotFoundError(`project "${projectName}" not found`);
  return project;
}

async function requireModel(client, projectName, name) {
  const model = await modelsRepo.getModelByName(client, projectName, name);
  if (!model) {
    await requireProject(client, projectName);
    throw new NotFoundError(`model "${name}" not found in project "${projectName}"`);
  }
  return model;
}

/**
 * Resolves which version to deploy.
 *
 * With no version given this deploys whatever is in PRODUCTION, which is the whole
 * point of the registry's one promise: "deploy the production model" is a question with
 * an answer. If nothing is promoted, that is said plainly rather than silently falling
 * back to the newest version — "latest" and "the one we chose" are different things, and
 * quietly substituting one for the other is how the wrong model ends up serving.
 */
async function resolveVersion(client, projectName, model, requested) {
  if (requested != null) {
    const version = await modelsRepo.getVersion(client, projectName, model.name, requested);
    if (!version) {
      throw new NotFoundError(`model "${model.name}" has no version ${requested}`);
    }
    return version;
  }

  if (model.production_version == null) {
    throw new ConflictError(
      'NO_PRODUCTION_VERSION',
      `model "${model.name}" has no version in PRODUCTION, so there is no default to `
      + 'deploy. Promote one with `ash model promote`, or name a version explicitly.',
    );
  }
  return modelsRepo.getVersion(client, projectName, model.name, model.production_version);
}

/**
 * Everything that must be true before a version can be handed to a serving pod.
 *
 * Takes the artifact separately rather than reading it off the version: the version
 * view carries only `verified` out of the artifact's metadata, and the architecture
 * lives in the rest of it.
 */
function assertDeployable(model, version, artifact) {
  if (version.status === ModelStatus.ARCHIVED) {
    throw new ConflictError(
      'VERSION_ARCHIVED',
      `${model.name} v${version.version} is ARCHIVED; archiving is how a version is `
      + 'retired, so deploying one would make the lifecycle decorative',
    );
  }

  if (!artifact || artifact.status !== ArtifactStatus.READY) {
    throw new ConflictError(
      'ARTIFACT_NOT_READY',
      `${model.name} v${version.version} points at an artifact that is `
      + `${artifact?.status ?? 'missing'}, not READY; its bytes are not confirmed `
      + 'to exist, and a pod that cannot fetch its model crash-loops rather than failing here',
    );
  }

  const arch = artifact.metadata?.architecture ?? null;
  if (!arch) {
    throw new ValidationError(
      'ARCHITECTURE_UNKNOWN',
      `${model.name} v${version.version} does not record an architecture in its artifact `
      + 'metadata, so nothing can know what shape to load the weights into. Pass --arch '
      + 'to say explicitly.',
    );
  }
  if (!SERVABLE_ARCHITECTURES.includes(arch)) {
    throw new ValidationError(
      'ARCHITECTURE_UNSUPPORTED',
      `the model server has no builder for architecture "${arch}"; it can serve: `
      + SERVABLE_ARCHITECTURES.join(', '),
    );
  }
  return arch;
}

/**
 * Creates or updates a deployment, and launches it.
 *
 * Idempotent by name within a project: deploying again over the same name is how a new
 * version is rolled out, and Kubernetes' rolling update keeps the previous pods serving
 * until the new ones pass readiness. That is why this updates rather than refusing a
 * duplicate — the alternative is an operator deleting a deployment to change its
 * version, which drops traffic every time.
 */
export async function deployModel(pool, backend, {
  projectName, modelName, version = null, name = null, replicas = 1,
  image = DEFAULT_IMAGE, cpu = 1, memoryBytes = DEFAULT_MEMORY, gpu = 0,
  arch = null, apiUrl = null, namespace = 'ashml-jobs',
}) {
  if (replicas < 1) {
    throw new ValidationError('INVALID_REPLICAS', 'replicas must be at least 1');
  }

  const prepared = await withTransaction(pool, async (client) => {
    const project = await requireProject(client, projectName);
    const model = await requireModel(client, projectName, modelName);
    const resolved = await resolveVersion(client, projectName, model, version);
    const artifact = resolved.artifact
      ? await artifactsRepo.getArtifactById(client, resolved.artifact.id)
      : null;
    const detectedArch = assertDeployable(model, resolved, artifact);

    const deploymentName = name ?? modelName;
    let existing = await deploymentsRepo.getDeploymentByName(client, projectName, deploymentName);

    let id;
    if (existing) {
      if (existing.model !== modelName) {
        throw new ConflictError(
          'DEPLOYMENT_NAME_TAKEN',
          `deployment "${deploymentName}" in project "${projectName}" already serves `
          + `model "${existing.model}"; a deployment's name is its address, so pointing `
          + 'it at a different model would silently change what callers receive',
        );
      }
      id = existing.id;
      await deploymentsRepo.updateSpec(client, id, {
        image, replicas, cpu, memoryBytes, gpu,
      });
    } else {
      try {
        id = await deploymentsRepo.createDeployment(client, {
          projectId: project.id,
          modelId: model.id,
          name: deploymentName,
          image,
          replicas,
          cpu,
          memoryBytes,
          gpu,
        });
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION) {
          throw new ConflictError(
            'DEPLOYMENT_EXISTS',
            `deployment "${deploymentName}" already exists in project "${projectName}"`,
          );
        }
        throw err;
      }
    }

    await deploymentsRepo.setSingleTarget(client, id, resolved.id, { replicas });

    const record = await deploymentsRepo.getDeploymentById(client, id);
    return { record, arch: arch ?? detectedArch };
  });

  // The cluster call happens outside the transaction on purpose: holding a database
  // transaction open across a network call to the API server couples one system's
  // latency to the other's lock duration, and a slow cluster would start blocking
  // unrelated writes.
  const deployment = { ...prepared.record, target: { ...prepared.record.target, arch: prepared.arch } };

  const deploymentManifest = buildDeploymentManifest(deployment, { namespace, apiUrl });
  const serviceManifest = buildServiceManifest(deployment, { namespace });

  try {
    await backend.applyDeployment(deploymentManifest);
    await backend.applyService(serviceManifest);
  } catch (err) {
    await deploymentsRepo.recordObservation(pool, deployment.id, {
      status: DeploymentStatus.FAILED,
      readyReplicas: 0,
      lastError: `could not create Kubernetes objects: ${err.message}`,
    });
    throw err;
  }

  await deploymentsRepo.recordLaunch(pool, deployment.id, {
    k8sName: kubeDeploymentName(deployment),
    namespace,
    endpointUrl: serviceUrl(deployment, { namespace }),
  });
  // PROGRESSING, not READY: the objects exist, which is not the same as a pod having
  // loaded a model. Only the cluster can say that, and `syncDeployments` is what asks.
  await deploymentsRepo.recordObservation(pool, deployment.id, {
    status: DeploymentStatus.PROGRESSING,
    readyReplicas: 0,
    lastError: null,
  });

  return getDeployment(pool, deployment.id);
}

/**
 * Maps what the cluster reports onto AshML's status vocabulary.
 *
 * Pure, so the mapping can be tested without a cluster — and it is the part most worth
 * testing, because every one of these branches is a claim made to an operator.
 */
export function statusFromObservation(observation, { previousStatus } = {}) {
  if (observation === null) {
    return {
      status: DeploymentStatus.FAILED,
      readyReplicas: 0,
      lastError: 'the Kubernetes Deployment is gone from the cluster',
    };
  }

  const { desired, ready, reason, pendingReason = null } = observation;

  if (ready >= desired && desired > 0) {
    return { status: DeploymentStatus.READY, readyReplicas: ready, lastError: null };
  }

  // Short of replicas *after* having been READY is a regression, not a first rollout,
  // and the two deserve different words: DEGRADED says something that was working
  // stopped, PROGRESSING says it has not started working yet.
  const wasServing = previousStatus === DeploymentStatus.READY
    || previousStatus === DeploymentStatus.DEGRADED;

  if (reason) {
    return { status: DeploymentStatus.FAILED, readyReplicas: ready, lastError: reason };
  }

  // The reason is carried on DEGRADED and withheld on PROGRESSING, and the asymmetry is
  // deliberate. A deployment short of replicas *before* it ever served is starting up:
  // "has not become ready yet" is the normal state of a cold start, and putting it in
  // `last_error` would train an operator to ignore the field. A deployment that was
  // serving and is now short is an outage, and the first question is why — leaving it
  // null there means AshML says DEGRADED and sends the operator to kubectl for the half
  // of the answer it already has.
  return {
    status: wasServing ? DeploymentStatus.DEGRADED : DeploymentStatus.PROGRESSING,
    readyReplicas: ready,
    lastError: wasServing ? pendingReason : null,
  };
}

/**
 * Asks the cluster about every active deployment and writes back what it says.
 *
 * Polls, for the same reasons ADR 0007 gives for the job status loop: a watch is the
 * better answer and belongs with the operator in Phase 6.
 */
export async function syncDeployments(pool, backend, { logger = null } = {}) {
  const active = await deploymentsRepo.listActiveDeployments(pool);
  let changed = 0;

  for (const deployment of active) {
    try {
      const observation = await backend.observeDeployment(deployment.namespace, deployment.k8s_name);
      const next = statusFromObservation(observation, { previousStatus: deployment.status });

      if (
        next.status !== deployment.status
        || next.readyReplicas !== deployment.ready_replicas
        || (next.lastError ?? null) !== (deployment.last_error ?? null)
      ) {
        await deploymentsRepo.recordObservation(pool, deployment.id, next);
        changed += 1;
        logger?.info?.({
          deployment_id: deployment.id,
          from: deployment.status,
          to: next.status,
          ready: next.readyReplicas,
          desired: deployment.replicas,
        }, 'deployment status changed');
      }
    } catch (err) {
      // One unreachable deployment must not stop the loop from reporting the others.
      logger?.warn?.({ deployment_id: deployment.id, err: err.message }, 'could not observe deployment');
    }
  }

  return { observed: active.length, changed };
}

export async function getDeployment(pool, id) {
  const deployment = await deploymentsRepo.getDeploymentById(pool, id);
  if (!deployment) throw new NotFoundError(`deployment ${id} not found`);
  return deployment;
}

export async function getDeploymentByName(pool, projectName, name) {
  const deployment = await deploymentsRepo.getDeploymentByName(pool, projectName, name);
  if (!deployment) {
    throw new NotFoundError(`deployment "${name}" not found in project "${projectName}"`);
  }
  return deployment;
}

export async function listDeployments(pool, { projectName = null } = {}) {
  return deploymentsRepo.listDeployments(pool, { projectName });
}

/**
 * Removes a deployment from the cluster and from the database.
 *
 * The cluster objects go first. If the row were deleted first and the cluster call then
 * failed, the pods would keep serving with nothing in AshML that knows they exist —
 * which is the one outcome that cannot be recovered from the API.
 */
export async function undeploy(pool, backend, projectName, name) {
  const deployment = await getDeploymentByName(pool, projectName, name);

  if (deployment.k8s_name) {
    await backend.deleteDeployment(deployment.namespace ?? 'ashml-jobs', deployment.k8s_name);
  }
  await deploymentsRepo.deleteDeployment(pool, deployment.id);

  return { id: deployment.id, name: deployment.name, project: deployment.project };
}

/**
 * Starts the deployment status loop.
 *
 * Separate from the executor's loop, and slower. The executor reconciles jobs whose
 * state changes on the order of seconds and which hold a queue slot while they wait; a
 * deployment sits READY for days at a time, so asking the API server about every one of
 * them twice a second would be load spent to observe nothing. Passes never overlap, for
 * the same reason the executor's do not.
 *
 * @returns {{ stop: () => Promise<void> }}
 */
export function startDeploymentSync(pool, backend, { logger = null, intervalMs = 10_000, metrics = null } = {}) {
  let stopped = false;
  let timer = null;
  let settled = Promise.resolve();

  async function tick() {
    if (stopped) return;
    const startedAt = process.hrtime.bigint();
    try {
      const summary = await syncDeployments(pool, backend, { logger });
      if (summary.changed > 0) {
        logger?.debug({ ...summary, backend: backend.name }, 'deployment sync pass');
      }
    } catch (err) {
      // syncDeployments isolates per-deployment failures, so reaching here means the
      // database is unreachable. Keep looping: it may come back, and stopping would
      // leave every deployment's status frozen at whatever it last was — which is worse
      // than late, because it looks current.
      logger?.error({ err }, 'deployment sync pass failed');
    } finally {
      metrics?.deploymentSyncDuration.observe(Number(process.hrtime.bigint() - startedAt) / 1e9);
    }
    if (!stopped) {
      timer = setTimeout(() => { settled = tick(); }, intervalMs);
      timer.unref?.();
    }
  }

  settled = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await settled.catch(() => {});
    },
  };
}
