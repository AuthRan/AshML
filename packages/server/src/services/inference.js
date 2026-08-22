/**
 * Asking a deployment a question, from outside the cluster.
 *
 * This is step 7 of the §50 user journey — `ash predict` — and it is deliberately the
 * thinnest thing that can work. The control plane holds a body, hands it to the Service
 * through the API server's proxy (`callService`), and hands the answer back. It does not
 * decode images, batch, cache, or interpret predictions: the model server owns the
 * transform its own weights were trained with, and a second implementation of that on
 * this side of the wire would be a silent accuracy loss that no error message points at.
 *
 * **This is not the serving path.** Real traffic goes to `endpoint_url` from inside the
 * cluster. Every request routed through here occupies the event loop that also runs the
 * scheduler, and a control plane being restarted must not take inference down with it.
 * What this is for is a human — a demo, a smoke test, the first question anyone asks a
 * model they just deployed — from a laptop where a ClusterIP is not an address.
 *
 * The one thing it adds to a bare proxy is *provenance*: an answer comes back saying
 * which deployment, model version and artifact AshML records as serving it. A number
 * with no idea which model produced it is how the wrong model serves for a week.
 */

import { UpstreamError, ConflictError, ValidationError } from './errors.js';
import { getDeploymentByName } from './deployments.js';

/**
 * Longer than a forward pass and shorter than anyone's patience. A cold pod is not the
 * case this covers — a pod that has not loaded its model is not in the Service's
 * endpoints at all, and the proxy says so immediately rather than hanging.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The target the deployment's front Service currently selects.
 *
 * Not "the deployment's version" — a deployment can serve several — and not the one an
 * operator most recently asked for either. It is the version the address actually
 * resolves to right now, because that is the one that answers the request this is
 * attached to. During a blue/green switch those are different versions for a few
 * seconds, and reporting the desired one would attribute a prediction to a version that
 * did not make it.
 */
function frontTarget(deployment) {
  const targets = deployment.targets ?? [];
  if (deployment.serving_version != null) {
    const selected = targets.find((t) => t.version === deployment.serving_version);
    if (selected) return selected;
  }
  // Nothing recorded yet: with one version taking traffic there is only one answer, and
  // with more than one there is no answer worth guessing at.
  const serving = targets.filter((t) => t.traffic_weight > 0);
  return serving.length === 1 ? serving[0] : null;
}

/**
 * Which version answered.
 *
 * With one version taking traffic, AshML's record of where its address resolves is the
 * answer and there is nothing to disagree with. With a split there is: the router chose,
 * per request, and it is the only thing that knows which way. It says so in
 * `x-ashml-served-by`, and that header is preferred over anything derived from the
 * database — a prediction attributed to the version AshML *expected* would be a canary
 * whose results are all recorded against the incumbent, which is worse than no
 * attribution at all because it looks like attribution.
 *
 * `source` says which of the two it was, because "the router told us" and "we worked it
 * out from the deployment" are different degrees of confidence and collapsing them hides
 * the case where the router was in the path and said nothing.
 */
function servedBy(deployment, response = null) {
  const claimed = response?.headers?.['x-ashml-served-by'];
  const routed = typeof claimed === 'string' && /^v\d+$/.test(claimed);
  const version = routed ? Number(claimed.slice(1)) : null;

  const target = routed
    ? (deployment.targets ?? []).find((t) => t.version === version) ?? null
    : frontTarget(deployment);

  return {
    deployment: deployment.name,
    model: deployment.model,
    version: target?.version ?? version,
    artifact_id: target?.artifact_id ?? null,
    arch: target?.arch ?? null,
    source: routed ? 'router' : 'deployment-record',
    ...(routed && response.headers['x-ashml-route-reason']
      ? { route_reason: response.headers['x-ashml-route-reason'] }
      : {}),
  };
}

/**
 * AshML's own view of the deployment, in one sentence, for attaching to a failure.
 *
 * The age matters and is why this is not just the status: deployment status is polled
 * (`ASHML_DEPLOYMENT_SYNC_INTERVAL_MS`, ten seconds by default), so "READY" here means
 * "was READY when last asked", and a reader deciding whether to believe it needs to know
 * whether that was four seconds ago or four minutes.
 */
function lastObserved(deployment) {
  const at = deployment.updated_at ?? deployment.created_at;
  const seconds = at ? Math.round((Date.now() - Date.parse(at)) / 1000) : null;
  const when = seconds === null ? 'at an unknown time' : `${seconds}s ago`;
  // Desired is summed across the versions taking traffic rather than read off the
  // deployment, which carries the per-version count: a deployment splitting between two
  // versions at one replica each wants two pods, and reporting "1 desired" would make a
  // half-failed split look whole.
  const desired = (deployment.targets ?? [])
    .filter((t) => t.traffic_weight > 0)
    .reduce((sum, t) => sum + (t.replicas ?? 0), 0);
  return `AshML last observed it ${deployment.status} with `
    + `${deployment.ready_replicas}/${desired} replicas ready, ${when}`;
}

/** Finds the deployment, then asks it. The two halves are separable; see `resolve`. */
async function call(pool, backend, { projectName, deploymentName, ...rest }) {
  const deployment = await resolve(pool, backend, projectName, deploymentName);
  return { deployment, response: await callResolved(backend, deployment, rest) };
}

/**
 * Finds the deployment and refuses the two cases where no pod can be reached at all.
 *
 * Notably it does **not** refuse on a deployment AshML believes is not ready. That check
 * was written and then removed: readiness here is up to a sync interval old, so refusing
 * on it means a prediction denied because of a ten-second-old observation — confidently
 * wrong, and about a pod that is answering perfectly well. The cluster is asked instead,
 * and it answers a request to a Service with no ready endpoints immediately rather than
 * hanging. What AshML knows is attached to the failure instead of being used to pre-empt
 * it, which is the useful half without the wrong half.
 *
 * It is a step of its own because of what may be *labelled*. A metric carrying the name
 * from the URL would mint a series for every name anyone types, which is the same
 * unbounded-cardinality mistake as labelling HTTP by URL instead of by route. A name
 * that does not resolve is not a deployment, so nothing is timed until one has.
 */
async function resolve(pool, backend, projectName, deploymentName) {
  const deployment = await getDeploymentByName(pool, projectName, deploymentName);

  if (!deployment.k8s_name || !deployment.namespace) {
    throw new ConflictError(
      'DEPLOYMENT_NOT_LAUNCHED',
      `deployment "${deployment.name}" has no Kubernetes objects yet, so there is `
      + 'nothing to ask. Deploy it with `ash model deploy` first.',
    );
  }

  if (typeof backend.callService !== 'function') {
    throw new ConflictError(
      'BACKEND_CANNOT_CALL_SERVICES',
      `the "${backend.name}" execution backend cannot reach a Service`,
    );
  }

  return deployment;
}

async function callResolved(backend, deployment, { path, method = 'GET', body = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  try {
    return await backend.callService(deployment.namespace, deployment.k8s_name, {
      path, method, body, timeoutMs,
    });
  } catch (err) {
    // A transport failure: the API server was unreachable, or the proxy hung up. This
    // is about the path to the pod, not about the pod, and saying which is most of the
    // diagnosis.
    throw new UpstreamError(
      'DEPLOYMENT_UNREACHABLE',
      `could not reach deployment "${deployment.name}" (${deployment.k8s_name} in `
      + `${deployment.namespace}): ${err.message}. ${lastObserved(deployment)}.`,
      502,
    );
  }
}

/**
 * The upstream's own message, whatever shape it came back in.
 *
 * Three shapes reach here and all three are worth reading: AshML's own error envelope
 * (from a service that is another AshML), the model server's `{"error": "..."}`, and
 * Kubernetes' Status object — whose message, "no endpoints available for service", is
 * the entire answer when the pod behind a deployment is gone. Falling back to the raw
 * text covers the fourth: a proxy error page, which is not JSON at all.
 */
function upstreamMessage(response) {
  for (const candidate of [response.body?.error?.message, response.body?.error, response.body?.message]) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return (response.text ?? '').trim().slice(0, 500) || `HTTP ${response.status}`;
}

/**
 * Turns a non-2xx from the model server into the right status for whoever asked.
 *
 * Three cases, kept apart because they send the reader to three different places:
 * the batch was malformed (fix the request), the deployment has no model loaded (wait,
 * or look at the deployment), or something else entirely (look at the pod).
 */
function relayFailure(deployment, response) {
  const message = upstreamMessage(response);

  if (response.status === 400 || response.status === 422) {
    throw new UpstreamError(
      'INVALID_INSTANCES',
      `deployment "${deployment.name}" refused the request: ${message}`,
      400,
    );
  }
  if (response.status === 503) {
    throw new UpstreamError(
      'DEPLOYMENT_NOT_SERVING',
      `deployment "${deployment.name}" is not serving: ${message}. ${lastObserved(deployment)}.`,
      503,
    );
  }
  throw new UpstreamError(
    'DEPLOYMENT_ERROR',
    `deployment "${deployment.name}" answered HTTP ${response.status}: ${message}`,
    502,
  );
}

/**
 * Sends instances to a deployment and returns its predictions.
 *
 * `instances` is passed through untouched and unvalidated beyond being a non-empty
 * array. The control plane does not know what shape any given architecture wants, and
 * guessing would mean a second place that has to be updated for every new one — the
 * model server refuses what it cannot use, and that refusal is relayed verbatim.
 */
export async function predict(pool, backend, {
  projectName, deploymentName, instances, timeoutMs = DEFAULT_TIMEOUT_MS, metrics = null,
}) {
  if (!Array.isArray(instances) || instances.length === 0) {
    throw new ValidationError(
      'NO_INSTANCES',
      'instances must be a non-empty array; there is nothing to predict on',
    );
  }

  // Resolved before the clock starts, and before any label exists. A request that names
  // a deployment which does not exist never reached a pod, and timing it would put a
  // rejection that cost nothing into the same histogram as a forward pass — as well as
  // minting a series for a name someone mistyped.
  const deployment = await resolve(pool, backend, projectName, deploymentName);
  const labels = { project: deployment.project, deployment: deployment.name };

  const startedAt = Date.now();
  try {
    const response = await callResolved(backend, deployment, {
      path: '/predict',
      method: 'POST',
      body: { instances },
      timeoutMs,
    });

    if (response.status < 200 || response.status >= 300) relayFailure(deployment, response);

    const answer = response.body ?? {};
    observePrediction(metrics, labels, 'ok', startedAt);
    // Counted only on success, because this is the denominator of per-image cost and a
    // batch that was refused predicted on nothing.
    metrics?.predictionInstances.inc(labels, instances.length);
    // The pod's own measurement, kept as a series of its own. Subtracting it from the
    // round trip is what makes "this is not the serving path" a number rather than a
    // claim: the difference is this control plane and the API server's proxy.
    if (typeof answer.latency_ms === 'number') {
      metrics?.predictionUpstreamDuration.observe(labels, answer.latency_ms / 1000);
    }

    return {
      predictions: answer.predictions ?? [],
      // The model server's own measurement of the forward pass, and ours of the whole
      // round trip. Reporting only the first would credit the platform with a latency it
      // does not deliver; only the second hides where the time went.
      latency_ms: answer.latency_ms ?? null,
      round_trip_ms: Date.now() - startedAt,
      // The pod's answer about what ran, next to AshML's record of what should have. They
      // are separate fields because they have separate authorities.
      arch: answer.arch ?? null,
      served_by: servedBy(deployment, response),
      // A backend that fabricates says so, and it travels with the answer rather than
      // being something the caller has to know to ask about (spec Rule 5).
      ...(response.simulated ? { simulated: true } : {}),
    };
  } catch (err) {
    observePrediction(metrics, labels, outcomeOf(err), startedAt);
    throw err;
  }
}

/**
 * Records how long a prediction took and how it ended.
 *
 * Failures are timed too, and deliberately: a deployment that is refusing in 4 ms and one
 * that is timing out at 15 s are both "failing", and a histogram that only saw successes
 * would show neither. `outcome` is what keeps them from being averaged together.
 */
function observePrediction(metrics, labels, outcome, startedAt) {
  metrics?.predictionDuration.observe({ ...labels, outcome }, (Date.now() - startedAt) / 1000);
}

/**
 * Three outcomes, which is as many as a label may usefully have here.
 *
 * Not the error code: the vocabulary is small today and would grow with every new
 * refusal, and each new value is a new series on every deployment. The division that
 * matters on a dashboard is who has to act — the caller sent a batch the model cannot
 * use, or the platform failed to deliver it — and `status` is already the field that
 * decides that everywhere else in this API.
 */
function outcomeOf(err) {
  const status = err?.statusCode;
  if (typeof status !== 'number') return 'server_error';
  return status >= 400 && status < 500 ? 'client_error' : 'server_error';
}

/**
 * What the pod itself says it has loaded.
 *
 * The counterpart to `served_by`, and the reason that field can be trusted: one is
 * AshML's record of what it deployed, the other is the process's answer about what is in
 * its memory right now. They agree in every normal case — and when they do not, that is
 * exactly the thing worth being able to see, rather than a discrepancy that only shows up
 * as predictions nobody can reproduce.
 */
export async function servedMetadata(pool, backend, { projectName, deploymentName, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const { deployment, response } = await call(pool, backend, {
    projectName, deploymentName, path: '/metadata', timeoutMs,
  });

  if (response.status < 200 || response.status >= 300) relayFailure(deployment, response);

  const reported = response.body ?? {};
  const expected = servedBy(deployment, response);
  return {
    ...expected,
    reported,
    // Compared here rather than left to every caller, because a caller that has to
    // notice the difference for itself will not.
    matches_record: reported.artifact_id != null && expected.artifact_id != null
      ? reported.artifact_id === expected.artifact_id
      : null,
    ...(response.simulated ? { simulated: true } : {}),
  };
}
