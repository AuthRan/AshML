/**
 * Deployment service: turning registered model versions into something that answers.
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
 *
 * ## Desired state is applied; observed state is written back
 *
 * The two halves are separate functions and never the same pass. `applyDesiredState`
 * runs when someone asks for a change and creates or updates Kubernetes objects;
 * `syncDeployments` runs on a timer and only reads. Re-applying manifests on every sync
 * tick would restart a rolling update every ten seconds and the deployment would never
 * converge — a loop that looks like reconciliation and is actually a treadmill.
 */

import { withTransaction } from '../db/pool.js';
import { ensureServingToken } from './auth.js';
import { ArtifactStatus } from '../domain/artifact-status.js';
import { ModelStatus } from '../domain/model-status.js';
import {
  buildTargetManifest, buildTargetServiceManifest, buildServiceManifest, buildRouterManifest,
  buildServingSecretManifest, servingSecretName,
  kubeDeploymentName, kubeTargetName, serviceUrl, targetServiceUrl,
  frontSelector,
} from '../k8s/manifest.js';
import {
  needsRouter, applyRollout, validateWeights, TOTAL_WEIGHT,
} from '../domain/routing.js';
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

/** The targets that are meant to be taking requests. A weight of 0 is out of rotation. */
function servingTargets(deployment) {
  return deployment.targets.filter((t) => t.traffic_weight > 0);
}

/**
 * Where the deployment's front Service should point.
 *
 * A version when one version is taking traffic — nothing to decide, and a router in that
 * path would be a hop and a dependency bought for nothing. The router the moment a second
 * version starts taking a share. `needsRouter` in `domain/routing.js` is the definition,
 * so the control plane and the router cannot disagree about when routing is in effect.
 *
 * @returns {{kind: 'version', version: number} | {kind: 'router'} | {kind: 'none'}}
 */
export function desiredFront(deployment) {
  const serving = servingTargets(deployment);
  if (serving.length === 0) return { kind: 'none' };
  if (needsRouter(deployment.targets.map((t) => ({ version: t.version, weight: t.traffic_weight })))) {
    return { kind: 'router' };
  }
  return { kind: 'version', version: serving[0].version };
}

/**
 * Where it points now.
 *
 * Read from `serving_version`, which is null in two different situations that must not be
 * confused: nothing has been created yet, and the front door is on the router. `k8s_name`
 * is what tells them apart — it is set when the front Service exists.
 */
export function currentFront(deployment) {
  if (!deployment.k8s_name) return { kind: 'none' };
  if (deployment.serving_version != null) {
    return { kind: 'version', version: deployment.serving_version };
  }
  return { kind: 'router' };
}

/** Whether two destinations are the same place. */
function sameFront(a, b) {
  return a.kind === b.kind && a.version === b.version;
}

/** `v7` or `the router`, for a log line or an error message. */
function describeFront(front) {
  if (front.kind === 'version') return `v${front.version}`;
  if (front.kind === 'router') return 'the router';
  return 'nothing';
}

/**
 * Creates or updates a deployment, and launches it.
 *
 * Idempotent by name within a project: deploying again over the same name is how a new
 * version is rolled out. That rollout is blue/green rather than a rolling update — the
 * new version's pods are started alongside the old ones and the front Service is moved
 * to them only once they are ready. It costs both versions' capacity for the length of
 * the switch, and it buys the thing a rolling update cannot give: there is no window in
 * which some requests are answered by one version and some by the other with nothing
 * recording which. For a model, that window is unattributable predictions.
 *
 * Deploying is a rollout to 100%: the named version takes all the traffic and every
 * other version goes to weight 0. It is one operation with `ash deployment rollout`
 * rather than a second mechanism, which is what makes it the way out of a canary that
 * has gone wrong — and the versions it takes out of rotation are named in the result
 * rather than dropping to zero quietly.
 *
 * They are taken out of rotation, not deleted. A version at weight 0 keeps its row and
 * its Kubernetes objects at zero replicas, so going back to it is a weight change rather
 * than a redeploy — which is the difference between a rollback that takes a second and
 * one that waits for an image pull. `ash deployment retire` is how a version is actually
 * removed, and it is deliberately a thing someone has to ask for.
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
    assertDeployable(model, resolved, artifact);

    const deploymentName = name ?? modelName;
    const existing = await deploymentsRepo.getDeploymentByName(client, projectName, deploymentName);

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
      await deploymentsRepo.updateSpec(client, id, { image, replicas, cpu, memoryBytes, gpu });
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

    const dropped = (existing?.targets ?? [])
      .filter((t) => t.model_version_id !== resolved.id && t.traffic_weight > 0)
      .map((t) => t.version);
    for (const target of existing?.targets ?? []) {
      if (target.model_version_id !== resolved.id) {
        await deploymentsRepo.setWeights(client, id, [
          { model_version_id: target.model_version_id, weight: 0 },
        ]);
      }
    }
    await deploymentsRepo.upsertTarget(client, id, resolved.id, { weight: 100, replicas });

    return { id, dropped };
  });

  // The cluster calls happen outside the transaction on purpose: holding a database
  // transaction open across a network call to the API server couples one system's
  // latency to the other's lock duration, and a slow cluster would start blocking
  // unrelated writes.
  await applyDesiredState(pool, backend, prepared.id, { namespace, apiUrl, arch });

  const deployment = await getDeployment(pool, prepared.id);
  return { ...deployment, dropped_versions: prepared.dropped };
}

/**
 * Makes the cluster match what the database says a deployment should be serving.
 *
 * Called whenever someone asks for a change — a deploy, a rollout, a retirement — and
 * never on the status timer. What it does not do is decide that the new pods are ready
 * or move the front Service onto them: only an observation can say that, and
 * `syncDeployments` is what observes.
 *
 * The one exception is a deployment that has no front Service yet. There is nothing
 * serving to protect, so the Service is created pointing at the version being deployed
 * rather than waiting a sync interval to be pointed anywhere.
 */
export async function applyDesiredState(pool, backend, deploymentId, {
  namespace = 'ashml-jobs', apiUrl = null, arch = null, servingTokenTtlSeconds = null,
} = {}) {
  const deployment = await deploymentsRepo.getDeploymentById(pool, deploymentId);
  if (!deployment) throw new NotFoundError(`deployment ${deploymentId} not found`);

  // One credential for every pod this pass writes — the model servers and the router
  // alike. They are one workload with one set of rights: fetch this project's artifacts,
  // and follow this deployment's routing table (domain/roles.js).
  //
  // It goes into a Secret and the pod templates reference it by name, so the template is
  // byte-identical across applies and a traffic-weight change does not restart the pods
  // carrying the traffic.
  //
  // `ensure`, not `issue`: the token is minted once per deployment and left alone
  // afterwards. Rotating it here would revoke the credential the *running* router is
  // holding, and because a Secret-sourced env var is fixed at container start, nothing
  // would restart to pick up the replacement — the router would 401 on its next poll and
  // go on serving the last table it had. See `ensureServingToken`.
  const secretName = servingSecretName(deployment);
  const serving = await ensureServingToken(pool, deployment.id, {
    ttlSeconds: servingTokenTtlSeconds,
  });
  if (serving.created) {
    await backend.applySecret(
      buildServingSecretManifest(deployment, serving.token, { namespace }),
    );
  }

  for (const target of deployment.targets) {
    // `arch` overrides only what the artifact failed to record; it is per-deployment, so
    // it cannot be right for one target and wrong for another.
    const resolved = { ...target, arch: target.arch ?? arch };
    try {
      await backend.applyDeployment(
        buildTargetManifest(deployment, resolved, { namespace, apiUrl, secretName }),
      );
      await backend.applyService(buildTargetServiceManifest(deployment, resolved, { namespace }));
    } catch (err) {
      await deploymentsRepo.recordObservation(pool, deployment.id, {
        status: DeploymentStatus.FAILED,
        readyReplicas: deployment.ready_replicas,
        lastError: `could not create Kubernetes objects for v${target.version}: ${err.message}`,
      });
      throw err;
    }
    await deploymentsRepo.recordTargetLaunch(pool, deployment.id, target.model_version_id, {
      k8sName: kubeTargetName(deployment, target.version),
      endpointUrl: targetServiceUrl(deployment, target.version, { namespace }),
    });
  }

  await applyRouter(pool, backend, deployment, { namespace, apiUrl, secretName });

  const front = desiredFront(deployment);
  if (!deployment.k8s_name) {
    // The address is created pointing straight at what it should serve, because there is
    // nothing serving yet to protect. Every later move waits for readiness instead.
    //
    // A first deploy that already needs a router is possible — nothing forbids creating a
    // deployment that starts split — and the front door then points at a router with no
    // ready pod. That is the same "not ready yet" a brand-new model server is in, and the
    // status says PROGRESSING for both.
    const version = front.kind === 'version' ? front.version : null;
    await backend.applyService(buildServiceManifest(deployment, { namespace, version }));
    await deploymentsRepo.recordLaunch(pool, deployment.id, {
      k8sName: kubeDeploymentName(deployment),
      namespace,
      endpointUrl: serviceUrl(deployment, { namespace }),
    });
    await deploymentsRepo.recordServingVersion(pool, deployment.id, version);
    deployment.k8s_name = kubeDeploymentName(deployment);
    deployment.serving_version = version;
  }

  // Re-judged now rather than left to the next sync pass. Whatever the last pass
  // concluded was about a different desired state: a deployment that was READY on v1 is
  // still READY *on v1* the instant v2 is asked for, and returning that word to whoever
  // asked reads as "v2 is live" — which is the one thing that is certainly not true yet.
  const fresh = await deploymentsRepo.getDeploymentById(pool, deployment.id);
  await deploymentsRepo.recordObservation(
    pool,
    deployment.id,
    judge(fresh, fresh.targets, { previousStatus: deployment.status }),
  );

  await removeRouterIfUnused(pool, backend, deployment, {
    namespace: deployment.namespace ?? namespace,
  });
  await reap(pool, backend, deployment.id, { namespace: deployment.namespace ?? namespace });
}

/**
 * Creates the router, if the split now needs one.
 *
 * Safe at any time: a router that exists and is not selected by the front Service takes
 * no traffic, and having it running and ready is precisely the condition the front door
 * waits for before moving onto it. So this runs on the apply path, well before anything
 * is routed through it.
 */
async function applyRouter(pool, backend, deployment, { namespace, apiUrl, secretName = null }) {
  if (desiredFront(deployment).kind !== 'router') return;

  const manifest = buildRouterManifest(deployment, { namespace, apiUrl, secretName });
  await backend.applyDeployment(manifest);
  if (deployment.router_k8s_name !== manifest.metadata.name) {
    await deploymentsRepo.recordRouter(pool, deployment.id, manifest.metadata.name);
    // Keeps the caller's in-memory row in step with the write above, so the rest of this
    // pass reads what is now true rather than what was true when it loaded the row.
    // eslint-disable-next-line require-atomic-updates -- one caller, one pass, no concurrency here
    deployment.router_k8s_name = manifest.metadata.name;
  }
}

/**
 * Removes the router once nothing needs it and nothing points at it.
 *
 * Both conditions, and the second is the one that matters. A router still selected by the
 * front Service is the only thing answering, so deleting it the moment the weights stop
 * requiring one would drop every request in flight — the same rule that keeps an outgoing
 * version's pods alive during a switch, for the same reason. It goes on the pass after
 * the address has moved off it.
 */
async function removeRouterIfUnused(pool, backend, deployment, { namespace, logger = null }) {
  if (!deployment.router_k8s_name) return;
  if (desiredFront(deployment).kind === 'router') return;
  if (currentFront(deployment).kind === 'router') return;

  await backend.deleteDeployment(namespace, deployment.router_k8s_name);
  await deploymentsRepo.recordRouter(pool, deployment.id, null);
  logger?.info?.({
    deployment_id: deployment.id,
  }, 'router removed: one version is taking traffic, so there is nothing to decide');
  // As above: the row this pass is holding must not go on naming a router that has just
  // been deleted.
  // eslint-disable-next-line require-atomic-updates -- one caller, one pass, no concurrency here
  deployment.router_k8s_name = null;
}

/**
 * Removes Kubernetes objects for versions this deployment no longer serves.
 *
 * Two things are spared. A version that is still a target, obviously — including one at
 * weight 0, which is out of rotation but kept so that putting it back is a weight change
 * rather than a redeploy. And whatever the front Service currently selects, even if it
 * has been dropped from the targets: during a blue/green switch the old version is no
 * longer wanted and is still the only thing answering, and deleting it there would drop
 * every request in flight. It goes on the next pass, once the front door has moved.
 *
 * The cluster is asked what exists rather than the database, because objects left behind
 * by a process that died between creating them and recording them are exactly the ones
 * no database query can find.
 */
async function reap(pool, backend, deploymentId, { namespace = 'ashml-jobs', logger = null } = {}) {
  if (typeof backend.listDeploymentNames !== 'function') return { removed: [] };

  const deployment = await deploymentsRepo.getDeploymentById(pool, deploymentId);
  if (!deployment) return { removed: [] };

  const keep = new Set(deployment.targets.map((t) => String(t.version)));
  if (deployment.serving_version != null) keep.add(String(deployment.serving_version));

  let existing;
  try {
    existing = await backend.listDeploymentNames(namespace, {
      'ashml.io/deployment-id': deployment.id,
      'app.kubernetes.io/component': 'model-server',
    });
  } catch (err) {
    // Reaping is housekeeping. Failing it must not fail the deploy that triggered it —
    // the cost of a missed pass is some pods that answer nothing until the next one.
    logger?.warn?.({ deployment_id: deployment.id, err: err.message }, 'could not list deployment objects');
    return { removed: [] };
  }

  const removed = [];
  for (const object of existing) {
    const version = object.labels['ashml.io/model-version'];
    if (version != null && keep.has(String(version))) continue;
    await backend.deleteDeployment(namespace, object.name);
    removed.push(object.name);
  }
  return { removed };
}

/**
 * Maps what the cluster reports about one version's pods onto AshML's status vocabulary.
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

  // Deliberately scaled to nothing is not a failure to reach one replica. A target at
  // weight 0 has been taken out of rotation, and calling that PROGRESSING would leave a
  // deployment permanently short of a readiness it was never meant to have.
  if (desired === 0) {
    return { status: DeploymentStatus.STOPPED, readyReplicas: ready, lastError: null };
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
 * The deployment's own status, from its targets' and from where its front door points.
 *
 * A deployment is more than the versions under it: it is an address, and an address that
 * resolves to nothing is down however healthy the pods behind it are. So `frontReady` —
 * whether the thing the address currently resolves to can answer — leads, and everything
 * else refines it.
 *
 * The distinction the branches exist for is between two states that look identical from
 * the target rows and mean opposite things. A deployment answering on v1 while v2's pods
 * start is **progressing**: nothing is wrong, a change was asked for and is underway. A
 * deployment answering on v1 while v2 crash-loops is **degraded**: something that should
 * be taking traffic cannot. Reporting the first as DEGRADED makes every ordinary deploy
 * look like an incident; reporting the second as PROGRESSING hides one inside a word that
 * sounds like startup.
 *
 * Pure, for the same reason `statusFromObservation` is.
 *
 * @param {object[]} targets the deployment's targets, with observed statuses
 * @param {boolean} options.frontReady can the address answer right now
 * @param {boolean} options.frontDoorInPlace is the address pointing where it should be
 */
export function rollUpStatus(targets, { frontReady, frontDoorInPlace, previousStatus } = {}) {
  const serving = targets.filter((t) => t.traffic_weight > 0);
  const ready = serving.reduce((sum, t) => sum + (t.ready_replicas ?? 0), 0);

  if (serving.length === 0) {
    return {
      status: DeploymentStatus.STOPPED,
      readyReplicas: 0,
      lastError: 'every version is at weight 0, so nothing is taking traffic',
    };
  }

  const describe = (list) => list
    .map((t) => `v${t.version} is ${t.status}${t.last_error ? `: ${t.last_error}` : ''}`)
    .join('; ');

  const broken = serving.filter((t) => t.status === DeploymentStatus.FAILED
    || t.status === DeploymentStatus.DEGRADED);

  // FAILED is reserved for a deployment where nothing can proceed without intervention,
  // so it takes every version having actually failed — not merely being short. A version
  // running one replica of the two it wants is DEGRADED, and a deployment made only of
  // that is degraded too: it is answering, which FAILED would deny.
  if (serving.every((t) => t.status === DeploymentStatus.FAILED)) {
    return {
      status: DeploymentStatus.FAILED,
      readyReplicas: ready,
      lastError: describe(serving),
    };
  }

  if (!frontReady) {
    // The address itself cannot answer. Whether that is an outage or a cold start is the
    // one thing the target rows cannot say, and the previous status is what does.
    const wasServing = previousStatus === DeploymentStatus.READY
      || previousStatus === DeploymentStatus.DEGRADED;
    return {
      status: wasServing ? DeploymentStatus.DEGRADED : DeploymentStatus.PROGRESSING,
      readyReplicas: ready,
      lastError: wasServing
        ? `the deployment's address is not answering; ${describe(serving.filter((t) => t.status !== DeploymentStatus.READY))}`
        : null,
    };
  }

  // Answering, but part of what should be taking traffic is not. Named, because
  // "degraded" without a version sends an operator to look at all of them.
  if (broken.length > 0) {
    return {
      status: DeploymentStatus.DEGRADED,
      readyReplicas: ready,
      lastError: `the deployment is answering, but ${describe(broken)}`,
    };
  }

  const starting = serving.filter((t) => t.status !== DeploymentStatus.READY);
  if (starting.length === 0 && frontDoorInPlace) {
    return { status: DeploymentStatus.READY, readyReplicas: ready, lastError: null };
  }

  // Answering correctly, and not yet answering with what was last asked for. Not an
  // error, so `last_error` stays null: a field that fills up during every ordinary
  // deploy is a field operators learn to ignore.
  return { status: DeploymentStatus.PROGRESSING, readyReplicas: ready, lastError: null };
}

/**
 * How the deployment's status should read, given targets observed just now.
 *
 * Shared by the apply path and the sync path so that `ash model deploy` returns the same
 * judgement the next sync pass would write. Without it a deploy returns whatever the last
 * pass concluded — READY, from before the new version was asked for — and an operator
 * reads that as "the new version is live".
 */
function judge(deployment, targets, { previousStatus }) {
  const current = currentFront({ ...deployment, targets });
  const desired = desiredFront({ ...deployment, targets });

  // Whether the address can answer, which depends on what it points at. On a version,
  // that version's pods; on the router, the router's — and a router with no ready pod is
  // a deployment that is down however healthy every version behind it is, which is
  // exactly why it is observed rather than assumed.
  const frontReady = current.kind === 'router'
    ? deployment.router_ready_replicas > 0
    : targets.find((t) => t.version === current.version)?.status === DeploymentStatus.READY;

  return rollUpStatus(targets, {
    frontReady,
    frontDoorInPlace: sameFront(current, desired),
    previousStatus,
  });
}

/**
 * Moves the deployment's front Service onto what it should be serving.
 *
 * Only when the destination has a ready pod. Moving a front door onto pods that are
 * still loading their weights is an outage an operator asked for by deploying — the
 * whole reason the switch is separate from the apply is that it must wait for evidence,
 * and readiness observed on this same pass is that evidence.
 */
async function moveFrontDoor(pool, backend, deployment, { namespace, logger = null }) {
  const current = currentFront(deployment);
  const wanted = desiredFront(deployment);
  if (wanted.kind === 'none' || sameFront(current, wanted)) return false;

  // Both directions wait for the same evidence, and both need it. Moving onto a version
  // whose pods are still loading weights is the outage a blue/green switch exists to
  // avoid; moving onto a router that has not fetched a split yet is the same outage with
  // a different pod in it.
  const ready = wanted.kind === 'router'
    ? deployment.router_ready_replicas > 0
    : deployment.targets.find((t) => t.version === wanted.version)?.status === DeploymentStatus.READY;
  if (!ready) return false;

  const version = wanted.kind === 'version' ? wanted.version : null;
  await backend.patchServiceSelector(namespace, deployment.k8s_name, frontSelector(deployment, version));
  await deploymentsRepo.recordServingVersion(pool, deployment.id, version);
  logger?.info?.({
    deployment_id: deployment.id,
    from: describeFront(current),
    to: describeFront(wanted),
  }, 'deployment front Service moved');
  return true;
}

/**
 * Scales down the versions that no longer need pods.
 *
 * Called after the front Service has moved, and only then. A version at weight 0 that
 * the address still resolved to kept its pods for as long as it was answering; once the
 * address has left, those pods serve nobody and holding them is capacity spent on
 * traffic that cannot arrive.
 *
 * Only the versions that actually need scaling are re-applied. Re-applying every target's
 * manifest would be simpler and would restart a rolling update on versions nothing asked
 * about — which is the treadmill this file's header warns against, arriving by a side
 * door.
 */
async function scaleDownRetired(pool, backend, deployment, {
  namespace, apiUrl = null, logger = null,
}) {
  const retired = deployment.targets.filter((t) => (
    t.traffic_weight === 0 && t.version !== deployment.serving_version && t.k8s_name
  ));

  for (const target of retired) {
    try {
      // The Secret reference is stable, so it is rebuilt here from the deployment rather
      // than threaded in: this path scales a retired version to zero and must not differ
      // from the template that version already has, or it would roll pods on the way to
      // deleting them.
      await backend.applyDeployment(
        buildTargetManifest(deployment, target, {
          namespace, apiUrl, secretName: servingSecretName(deployment),
        }),
      );
      logger?.info?.({
        deployment_id: deployment.id, version: target.version,
      }, 'version scaled to zero: out of rotation and no longer serving');
    } catch (err) {
      // Housekeeping again. A version left running costs capacity, not correctness, and
      // failing the sync pass over it would stop the others being observed.
      logger?.warn?.({
        deployment_id: deployment.id, version: target.version, err: err.message,
      }, 'could not scale down a retired version');
    }
  }
}

/**
 * Asks the cluster about every active deployment and writes back what it says.
 *
 * Polls, for the same reasons ADR 0007 gives for the job status loop: a watch is the
 * better answer and belongs with the operator in Phase 6.
 */
export async function syncDeployments(pool, backend, { logger = null, namespace = 'ashml-jobs' } = {}) {
  const active = await deploymentsRepo.listActiveDeployments(pool);
  let changed = 0;

  for (const deployment of active) {
    try {
      // The namespace recorded on the deployment, not the one this process is
      // configured with. They are the same until someone changes the configuration, and
      // then they are not: an existing deployment's objects are wherever they were
      // created, and looking for them anywhere else finds nothing and reports it as the
      // deployment having vanished.
      const ns = deployment.namespace ?? namespace;
      const observed = [];
      for (const target of deployment.targets) {
        if (!target.k8s_name) {
          observed.push(target);
          continue;
        }
        const observation = await backend.observeDeployment(ns, target.k8s_name);
        const next = statusFromObservation(observation, { previousStatus: target.status });
        if (
          next.status !== target.status
          || next.readyReplicas !== target.ready_replicas
          || (next.lastError ?? null) !== (target.last_error ?? null)
        ) {
          await deploymentsRepo.recordTargetObservation(
            pool, deployment.id, target.model_version_id, next,
          );
          changed += 1;
          logger?.info?.({
            deployment_id: deployment.id,
            version: target.version,
            from: target.status,
            to: next.status,
            ready: next.readyReplicas,
          }, 'deployment target status changed');
        }
        observed.push({
          ...target, status: next.status, ready_replicas: next.readyReplicas, last_error: next.lastError,
        });
      }

      const withObserved = { ...deployment, targets: observed };

      // The router is in the serving path once there is a split, so its health is part of
      // the deployment's — observed the same way and on the same pass, rather than assumed
      // from the fact that AshML created it.
      if (deployment.router_k8s_name) {
        const observation = await backend.observeDeployment(ns, deployment.router_k8s_name);
        const next = statusFromObservation(observation, { previousStatus: deployment.router_status });
        withObserved.router_status = next.status;
        withObserved.router_ready_replicas = next.readyReplicas;
        if (
          next.status !== deployment.router_status
          || next.readyReplicas !== deployment.router_ready_replicas
        ) {
          await deploymentsRepo.recordRouterObservation(pool, deployment.id, {
            status: next.status,
            readyReplicas: next.readyReplicas,
          });
          changed += 1;
          logger?.info?.({
            deployment_id: deployment.id,
            from: deployment.router_status,
            to: next.status,
            ready: next.readyReplicas,
          }, 'router status changed');
        }
      }

      const moved = await moveFrontDoor(pool, backend, withObserved, { namespace: ns, logger });
      if (moved) {
        const front = desiredFront(withObserved);
        withObserved.serving_version = front.kind === 'version' ? front.version : null;
        // A version out of rotation keeps its pods only while the address still points
        // at it. That has just stopped being true, so this is the moment it stops
        // costing capacity — and the moment anything AshML has no row for at all can go.
        await scaleDownRetired(pool, backend, withObserved, { namespace: ns, logger });
        // And the moment a router the address has left can go too. Removing it while it
        // was still selected would have been the outage; now it is just tidying.
        await removeRouterIfUnused(pool, backend, withObserved, { namespace: ns, logger });
        await reap(pool, backend, deployment.id, { namespace: ns, logger });
      }

      const next = judge(withObserved, observed, { previousStatus: deployment.status });
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
 *
 * Every version's objects, then the front Service. The front door last, so that nothing
 * is ever pointing at pods that have already gone: a Service with no endpoints answers a
 * caller with a connection failure, which at least names the address they asked for.
 */
export async function undeploy(pool, backend, projectName, name) {
  const deployment = await getDeploymentByName(pool, projectName, name);
  const namespace = deployment.namespace ?? 'ashml-jobs';

  for (const target of deployment.targets) {
    if (target.k8s_name) await backend.deleteDeployment(namespace, target.k8s_name);
  }
  if (deployment.router_k8s_name) {
    await backend.deleteDeployment(namespace, deployment.router_k8s_name);
  }
  if (deployment.k8s_name) {
    await backend.deleteDeployment(namespace, deployment.k8s_name);
  }
  // The token row goes with the deployment row (ON DELETE CASCADE), which is what makes
  // the credential stop working. The Secret holding its plaintext is inert once that
  // happens, but leaving it would accumulate one dead object per deployment ever made.
  await backend.deleteSecret(namespace, servingSecretName(deployment));

  await deploymentsRepo.deleteDeployment(pool, deployment.id);

  return { id: deployment.id, name: deployment.name, project: deployment.project };
}

// ------------------------------------------------------------ moving traffic

/**
 * Shifts a share of the traffic onto one version (spec §21).
 *
 * `ash deployment rollout resnet-cifar --version 7 --traffic 10` names one version and
 * one share; where the rest of the split comes from is `applyRollout`'s decision and is
 * argued out in `domain/routing.js`. This function's job is the part that touches the
 * world: check the version can actually be served, write the whole split at once, and
 * make the cluster match.
 *
 * The version is validated exactly as `deploy` validates one, and for the same reason. A
 * canary that fails because its artifact was never confirmed is a canary that looks like
 * the *model* is bad — the worst possible outcome for a mechanism whose only purpose is
 * to tell you whether the model is bad.
 */
export async function rollout(pool, backend, {
  projectName, deploymentName, version, traffic, apiUrl = null, namespace = 'ashml-jobs',
}) {
  if (!Number.isInteger(traffic) || traffic < 0 || traffic > TOTAL_WEIGHT) {
    throw new ValidationError(
      'INVALID_TRAFFIC',
      `traffic is a whole percentage between 0 and ${TOTAL_WEIGHT}; got ${traffic}`,
    );
  }

  const id = await withTransaction(pool, async (client) => {
    const deployment = await deploymentsRepo.getDeploymentByName(client, projectName, deploymentName);
    if (!deployment) {
      throw new NotFoundError(`deployment "${deploymentName}" not found in project "${projectName}"`);
    }

    const existing = deployment.targets.find((t) => t.version === version);
    let modelVersionId = existing?.model_version_id;

    if (!existing) {
      const model = await requireModel(client, projectName, deployment.model);
      const resolved = await resolveVersion(client, projectName, model, version);
      const artifact = resolved.artifact
        ? await artifactsRepo.getArtifactById(client, resolved.artifact.id)
        : null;
      assertDeployable(model, resolved, artifact);
      modelVersionId = resolved.id;
      await deploymentsRepo.upsertTarget(client, deployment.id, modelVersionId, {
        weight: 0,
        replicas: deployment.replicas,
      });
    }

    const current = deployment.targets.map((t) => ({ version: t.version, weight: t.traffic_weight }));
    if (!existing) current.push({ version, weight: 0 });
    const next = applyRollout(current, version, traffic);

    const check = validateWeights(next);
    if (!check.ok) {
      // Reachable only through a bug in `applyRollout`, and checked anyway: the weights
      // are what the router will apply, and a split that does not sum to 100 is one
      // where some share of the traffic has no defined destination.
      throw new ValidationError(check.code, check.message);
    }

    const byVersion = new Map(
      [...deployment.targets, ...(existing ? [] : [{ version, model_version_id: modelVersionId }])]
        .map((t) => [t.version, t.model_version_id]),
    );
    await deploymentsRepo.setWeights(client, deployment.id, next.map((t) => ({
      model_version_id: byVersion.get(t.version),
      weight: t.weight,
    })));

    return deployment.id;
  });

  await applyDesiredState(pool, backend, id, { namespace, apiUrl });
  return getDeployment(pool, id);
}

/**
 * Ends a rollout: one version takes everything.
 *
 * The others go to weight 0 rather than being removed, so the version that was serving a
 * minute ago is still there to go back to — a rollback is then a weight change and a
 * scale-up rather than an image pull, which is the difference between seconds and
 * minutes at the moment it matters most. `retire` is how one is actually removed.
 */
export async function promote(pool, backend, {
  projectName, deploymentName, version, apiUrl = null, namespace = 'ashml-jobs',
}) {
  return rollout(pool, backend, {
    projectName, deploymentName, version, traffic: TOTAL_WEIGHT, apiUrl, namespace,
  });
}

/**
 * Stops serving a version at all, and removes its Kubernetes objects.
 *
 * Refused while the version is taking traffic, and refused while it is the version the
 * address resolves to. Both refusals say what to do instead, because the alternative —
 * doing it anyway — is an outage caused by tidying up, and this is the one operation here
 * whose whole purpose is tidying up.
 */
export async function retire(pool, backend, {
  projectName, deploymentName, version, namespace = 'ashml-jobs',
}) {
  const deployment = await getDeploymentByName(pool, projectName, deploymentName);
  const target = deployment.targets.find((t) => t.version === version);

  if (!target) {
    throw new NotFoundError(
      `deployment "${deploymentName}" does not serve v${version}`,
    );
  }
  if (target.traffic_weight > 0) {
    throw new ConflictError(
      'VERSION_TAKES_TRAFFIC',
      `v${version} is taking ${target.traffic_weight}% of this deployment's traffic. `
      + 'Move it to 0 first with `ash deployment rollout`, so that removing it is a '
      + 'separate decision from stopping it being used.',
    );
  }
  if (deployment.serving_version === version) {
    throw new ConflictError(
      'VERSION_STILL_SERVING',
      `v${version} takes no traffic, and the deployment's address still resolves to it — `
      + 'the switch onto what should be serving has not finished. Wait for it, or look at '
      + `why: ${deployment.last_error ?? 'no reason recorded'}`,
    );
  }

  const ns = deployment.namespace ?? namespace;
  if (target.k8s_name) await backend.deleteDeployment(ns, target.k8s_name);
  await deploymentsRepo.removeTarget(pool, deployment.id, target.model_version_id);

  return getDeployment(pool, deployment.id);
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
export function startDeploymentSync(pool, backend, {
  logger = null, intervalMs = 10_000, metrics = null, namespace = 'ashml-jobs',
} = {}) {
  let stopped = false;
  let timer = null;
  let settled = Promise.resolve();

  async function tick() {
    if (stopped) return;
    const startedAt = process.hrtime.bigint();
    try {
      const summary = await syncDeployments(pool, backend, { logger, namespace });
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
