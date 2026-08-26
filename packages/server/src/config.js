/**
 * Configuration, resolved once from the environment.
 *
 * Every setting is an environment variable so the same image runs unchanged in local
 * dev and in Kubernetes (12-factor). Defaults are chosen for the development host.
 */

import { DEFAULT_CLUSTER_POD_CIDR } from './k8s/manifest.js';
import { DEFAULT_MAX_TTL_DAYS } from './domain/token-lifetime.js';

export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.ASHML_PORT ?? '8080', 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`ASHML_PORT="${env.ASHML_PORT}": want a port between 1 and 65535`);
  }

  return {
    port,
    host: env.ASHML_HOST ?? '0.0.0.0',
    logLevel: env.ASHML_LOG_LEVEL ?? 'info',

    // Default to real hardware. `sim` must always be opted into explicitly so a demo
    // can never accidentally present fabricated telemetry (spec Rule 5).
    gpuProvider: env.ASHML_GPU_PROVIDER ?? 'nvidia',

    // Passed through to whichever provider is selected. This module is the only
    // place that reads the environment, so providers stay testable.
    gpuProviderOptions: {
      simDeviceCount: parseCount(env.ASHML_SIM_GPUS, 'ASHML_SIM_GPUS'),
    },

    // Kubernetes execution (Phase 2). Like the GPU provider, the real backend is the
    // default and `sim` must be opted into explicitly, so a demo can never quietly
    // present a fabricated run as a real one (spec Rule 5).
    k8sBackend: env.ASHML_K8S_BACKEND ?? 'kubernetes',
    k8sNamespace: env.ASHML_K8S_NAMESPACE ?? 'ashml-jobs',
    // Unset means the standard resolution order: $KUBECONFIG, ~/.kube/config, then
    // the in-cluster service account.
    kubeconfig: env.ASHML_KUBECONFIG ?? null,
    // Which context inside that file to use. Unset follows `current-context`, which is
    // a global setting belonging to whoever last ran `kubectl config use-context` —
    // so on a workstation with more than one cluster, leaving this unset means a
    // control plane that comes back from a restart pointed somewhere else.
    kubeconfigContext: env.ASHML_KUBECONFIG_CONTEXT ?? null,

    // Per-project network isolation (Phase 10, spec §31).
    //
    // On by default, like authentication and the rate limiter, and off only by saying so.
    // A boundary that appears when a variable happens to be set is one nobody can state
    // the presence of.
    //
    // The CIDR is the addresses this cluster hands to pods, and it is what the policy's
    // "everything that is not a pod here" rule is written against (`manifest.js`). The
    // default is k3s's, which is what `make cluster` brings up; a cluster configured with
    // a different pod network needs this set, and the control plane compares it against
    // every node's `spec.podCIDR` at startup and says so if they disagree, because too
    // narrow a value does not fail — it quietly permits the traffic it was written to
    // refuse.
    networkPolicyEnabled:
      parseBool(env.ASHML_NETWORK_POLICY_ENABLED, 'ASHML_NETWORK_POLICY_ENABLED', true),
    clusterPodCidr: env.ASHML_CLUSTER_POD_CIDR ?? DEFAULT_CLUSTER_POD_CIDR,

    // The executor is what makes jobs actually run. It is disabled only for a server
    // deliberately brought up as a read-only API replica.
    executorEnabled: parseBool(env.ASHML_EXECUTOR_ENABLED, 'ASHML_EXECUTOR_ENABLED', true),
    executorIntervalMs: parseCount(env.ASHML_EXECUTOR_INTERVAL_MS, 'ASHML_EXECUTOR_INTERVAL_MS') ?? 2000,

    // Node inventory changes on the order of minutes and GPU telemetry on the order of
    // seconds; neither is worth a `LIST nodes` and an `nvidia-smi` fork on every job pass.
    discoveryIntervalMs: parseCount(env.ASHML_DISCOVERY_INTERVAL_MS, 'ASHML_DISCOVERY_INTERVAL_MS') ?? 15_000,

    // Deployments change far less often than jobs: one sits READY for days, where a job
    // moves through five states in a minute. Polling them on the executor's interval
    // would be load spent to observe nothing.
    deploymentSyncIntervalMs: parseCount(env.ASHML_DEPLOYMENT_SYNC_INTERVAL_MS, 'ASHML_DEPLOYMENT_SYNC_INTERVAL_MS') ?? 10_000,

    // The address a training pod should call the control plane on. It is not
    // `host`/`port`: the API binds 0.0.0.0 inside its own network namespace, which is
    // not an address anything else can reach. In development the control plane runs on
    // the workstation and k3d resolves `host.k3d.internal` to it; in a cluster this is
    // the Service URL. Injected into every training container as ASHML_ENDPOINT.
    apiAdvertiseUrl: env.ASHML_API_ADVERTISE_URL ?? 'http://host.k3d.internal:8080',

    // Artifact storage (Phase 4). `s3` is real and is the default, in the same spirit
    // as the GPU provider and the execution backend; `none` is the honest description of
    // a control plane with no bucket, not a simulation of one.
    artifactStore: env.ASHML_ARTIFACT_STORE ?? 's3',
    artifactStoreOptions: {
      bucket: env.ASHML_S3_BUCKET ?? 'ashml',
      // Defaults match deploy/local/docker-compose.yml, exactly as databaseUrl below
      // defaults to the compose Postgres. Unset the endpoint for real AWS, where the
      // SDK resolves the host and the credential chain by itself.
      endpoint: env.ASHML_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      region: env.ASHML_S3_REGION ?? 'us-east-1',
      accessKeyId: env.ASHML_S3_ACCESS_KEY ?? 'ashml',
      secretAccessKey: env.ASHML_S3_SECRET_KEY ?? 'ashml-dev-secret',
      // MinIO serves buckets as a path; AWS serves them as a subdomain.
      forcePathStyle: parseBool(env.ASHML_S3_FORCE_PATH_STYLE, 'ASHML_S3_FORCE_PATH_STYLE', true),
      // Long enough for a large checkpoint on a slow link, short enough that a URL
      // leaked into a log is not a standing grant.
      presignTtlSeconds: parseCount(env.ASHML_S3_PRESIGN_TTL, 'ASHML_S3_PRESIGN_TTL') ?? 3600,
    },

    // Authentication (Phase 10, spec §31).
    //
    // Required by default, and disabling it takes the same shape as every other
    // "make this less real" switch in this file: explicit, opt-in, and named for what
    // it does. An API that quietly accepts anonymous writes because a variable was unset
    // is the failure this default exists to prevent — the previous behaviour, in other
    // words. `disabled` acts as the seeded local administrator and logs a warning on
    // every start, and exists so the k3d end-to-end scripts and a bare `make dev` still
    // work without a token ceremony.
    authEnabled: parseBool(env.ASHML_AUTH_ENABLED, 'ASHML_AUTH_ENABLED', true),

    // The ceiling on a personal API token's life, in days — and, because it is also the
    // default, the guarantee that every token has an end (`domain/token-lifetime.js`).
    // A token minted before this existed keeps working: the policy governs minting, and
    // revoking live credentials as a side effect of editing a config file is how a
    // security setting gets switched off.
    //
    // `none` is the way to have no ceiling, spelled as a word for the same reason
    // `ASHML_ARTIFACT_STORE=none` is: an absent limit should be something somebody chose
    // and can be read back, not the shape of an unset variable.
    tokenMaxTtlDays: parseTokenTtlDays(env.ASHML_TOKEN_MAX_TTL_DAYS),

    // How long a training pod's run token lives. Long enough for a slow epoch, short
    // enough that a token scraped from a pod spec is not a standing grant — and it is
    // revoked when the job ends regardless, so this is the backstop for a job whose
    // terminal state was never observed, not the primary control.
    runTokenTtlSeconds: parseCount(env.ASHML_RUN_TOKEN_TTL, 'ASHML_RUN_TOKEN_TTL') ?? 86_400,

    // How long a *finished* run's token keeps working. Not zero, and that is the whole
    // point: the final checkpoint's upload is confirmed after the pod has exited, so
    // cutting the credential the moment the job reaches a terminal state would leave
    // every successful run's model stuck at PENDING. A retry is the case that revokes
    // immediately, and it does so regardless of this.
    runTokenGraceSeconds: parseCount(env.ASHML_RUN_TOKEN_GRACE, 'ASHML_RUN_TOKEN_GRACE') ?? 300,

    // Reaping artifacts that were registered and never confirmed.
    //
    // `reapAfterSeconds` must be **longer than `runTokenGraceSeconds` above**, and the
    // reaper refuses to start otherwise. A successful run confirms its final checkpoint
    // after the pod has exited — that is what the grace window is for — so a sweep that
    // ran first would mark the final model of every run that worked FAILED. The two
    // settings look unrelated and are not.
    artifactReaperEnabled:
      parseBool(env.ASHML_ARTIFACT_REAP_ENABLED, 'ASHML_ARTIFACT_REAP_ENABLED', true),
    artifactReapIntervalMs:
      parseLimit(env.ASHML_ARTIFACT_REAP_INTERVAL_MS, 'ASHML_ARTIFACT_REAP_INTERVAL_MS') ?? 300_000,
    artifactReapAfterSeconds:
      parseLimit(env.ASHML_ARTIFACT_REAP_AFTER, 'ASHML_ARTIFACT_REAP_AFTER') ?? 900,
    // The backstop, measured from registration, for a job whose ending was never
    // observed — the one case where nothing else will ever come along to settle it.
    artifactMaxPendingSeconds:
      parseLimit(env.ASHML_ARTIFACT_MAX_PENDING, 'ASHML_ARTIFACT_MAX_PENDING') ?? 86_400,

    // Rate limiting (Phase 10, spec §31). Two budgets — see auth/rate-limit.js for
    // which request is counted against which, and why the anonymous one is the tight
    // one.
    rateLimit: {
      // On by default, like authentication, and for the same reason: the failure of
      // being off is silent until the day it is not.
      enabled: parseBool(env.ASHML_RATE_LIMIT_ENABLED, 'ASHML_RATE_LIMIT_ENABLED', true),
      // A backstop against a runaway loop, not a throttle. Twenty requests a second,
      // sustained, with a full minute available as a burst — `make bench` makes about
      // six hundred calls in a few seconds and fits inside it with room to spare. Raise
      // it before pointing anything heavier at one token.
      identifiedPerMinute:
        parseLimit(env.ASHML_RATE_LIMIT_PER_MINUTE, 'ASHML_RATE_LIMIT_PER_MINUTE') ?? 1200,
      // Requests that presented no valid credential, per source address.
      //
      // Higher than it first looks like it should be, and deliberately. Every pod in a
      // k3d cluster reaches the control plane from one address, so this budget is shared
      // by everything behind a NAT or an ingress — which means a single misconfigured
      // workload 401-looping must not be able to lock out the healthy ones beside it.
      // Ten a second is far above any real failure loop (a crash-looping pod restarts on
      // backoff; the router polls every five seconds) and still three orders of magnitude
      // below the flood this exists to stop. The ceiling is the point, not the number.
      anonymousPerMinute:
        parseLimit(env.ASHML_RATE_LIMIT_ANON_PER_MINUTE, 'ASHML_RATE_LIMIT_ANON_PER_MINUTE') ?? 600,
      // How many callers to remember at once. Ten thousand buckets is about a megabyte;
      // past the cap the least recently seen is forgotten, which is the honest limit of
      // an in-process limiter and is stated in auth/rate-limit.js rather than implied.
      maxKeys: parseLimit(env.ASHML_RATE_LIMIT_MAX_KEYS, 'ASHML_RATE_LIMIT_MAX_KEYS') ?? 10_000,
    },

    // The authorization audit trail (Phase 10, spec §31).
    //
    // Denials are buffered and written in batches, so that a refusal costs the request
    // that produced it nothing. Two knobs, and both are about the same failure: what
    // happens when refusals arrive faster than PostgreSQL takes them. The buffer is
    // bounded and overflow is dropped rather than queued — an audit that grows without
    // limit is a memory leak that fires exactly when the platform is already in trouble,
    // and `ashml_audit_dropped_total` says how large the gap is rather than hiding it.
    auditBufferSize: parseLimit(env.ASHML_AUDIT_BUFFER, 'ASHML_AUDIT_BUFFER') ?? 1000,
    auditFlushIntervalMs:
      parseLimit(env.ASHML_AUDIT_FLUSH_MS, 'ASHML_AUDIT_FLUSH_MS') ?? 2000,

    // Whether to believe `X-Forwarded-For` about who is calling.
    //
    // Off, because it is only ever safe when something in front of this server rewrites
    // that header on every request. Turned on without such a proxy, any caller picks
    // their own rate-limit bucket by sending a header, which is worse than no limit at
    // all because it looks like one. Turned off *behind* a proxy, every anonymous caller
    // shares the proxy's address and therefore one budget — so this has to be set when
    // an ingress is put in front, and its default has to be the safe direction.
    trustProxy: parseBool(env.ASHML_TRUST_PROXY, 'ASHML_TRUST_PROXY', false),

    databaseUrl: env.ASHML_DATABASE_URL
      ?? 'postgresql://ashml:ashml@127.0.0.1:5432/ashml',
    databasePoolMax: parseCount(env.ASHML_DB_POOL_MAX, 'ASHML_DB_POOL_MAX') ?? 10,

    version: env.ASHML_VERSION ?? '0.1.0-dev',
  };
}

/**
 * The token ceiling, in days, or null for "no ceiling".
 *
 * Zero is refused for the reason `parseLimit` refuses it elsewhere, and more sharply: a
 * ceiling of zero days would mint tokens that have already expired, so every caller would
 * be handed a credential that fails on first use and no message would say why.
 */
function parseTokenTtlDays(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_TTL_DAYS;
  if (String(raw).trim().toLowerCase() === 'none') return null;

  const days = Number.parseInt(raw, 10);
  if (Number.isNaN(days) || String(days) !== String(raw).trim()) {
    throw new Error(
      `ASHML_TOKEN_MAX_TTL_DAYS="${raw}": want a whole number of days, or "none" for no limit`,
    );
  }
  if (days < 1) {
    throw new Error(
      `ASHML_TOKEN_MAX_TTL_DAYS="${raw}": a ceiling below one day would issue tokens that `
      + 'have already expired. To have no ceiling, set it to "none".',
    );
  }
  return days;
}

/**
 * A limit of zero is refused rather than read as "unlimited".
 *
 * Zero means unlimited for quotas (`domain/quota.js`), which is exactly why it must not
 * mean it here: the same convention applied to a rate limit turns a typo into an open
 * door, and the two settings are close enough in kind that someone will assume it. The
 * way to have no rate limit is to say so.
 */
function parseLimit(raw, name) {
  const value = parseCount(raw, name);
  if (value === 0) {
    throw new Error(
      `${name}="0": a rate limit of zero would refuse every request. `
      + 'To run without a limit, set ASHML_RATE_LIMIT_ENABLED=false.',
    );
  }
  return value;
}

function parseBool(raw, name, fallback) {
  if (raw === undefined) return fallback;

  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name}="${raw}": want a boolean (true/false)`);
}

function parseCount(raw, name) {
  if (raw === undefined) return undefined;

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`${name}="${raw}": want a non-negative integer`);
  }
  return value;
}
