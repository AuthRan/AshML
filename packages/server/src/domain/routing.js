/**
 * Weighted routing between the versions a deployment serves (spec §21).
 *
 * Pure: no database, no HTTP, no clock. It is imported by the control plane, which
 * validates and stores weights, and by the router image, which uses it to choose a target
 * for every request — so this module is the single definition of what a weight *means*.
 * Two implementations of that would be two answers to "which version served this", and
 * the whole point of §21 is being able to say.
 *
 * ## Weights are shares of traffic, not replica counts
 *
 * The tempting implementation is to give the versions one Kubernetes Service and set
 * replica counts — three pods of v6 and one of v7 for a 75/25 split. It is wrong in two
 * ways that only show up later. A 99/1 canary needs a hundred pods. And it conflates
 * "how much traffic should this version take" with "how much capacity does it need",
 * which are different questions the moment one version is slower than the other: sizing
 * v7 for its load then silently changes the split.
 *
 * So weight and replicas are separate columns, and a router makes the choice per request.
 *
 * ## Random for a canary, sticky for an A/B test
 *
 * `chooseTarget` picks at random by default, which is right for a canary: what is being
 * measured is the version's error rate over many requests, and independence between them
 * is what makes the sample mean mean anything.
 *
 * It is wrong for an A/B test. If the same user is routed to v6 and then v7 and then v6,
 * the difference being measured is diluted by every switch, and any per-user metric —
 * conversion, session length, whether the answer was accepted — is measuring a mixture.
 * So a caller may supply a **route key** (a user id, a session id), and the same key
 * always lands on the same version for a given set of weights. That is the difference
 * between the two use cases §21 names, and it is one hash.
 */

/** The resolution of a weight. Percentages, because that is what an operator types. */
export const TOTAL_WEIGHT = 100;

/**
 * Buckets a sticky key is hashed into.
 *
 * Ten thousand rather than a hundred so that a 1% target gets ~100 buckets rather than
 * one: with only a hundred, the difference between a key landing in bucket 42 and bucket
 * 43 is the whole of a 1% canary, and the split a small population actually receives
 * would be dominated by how the hash happened to fall.
 */
const STICKY_BUCKETS = 10_000;

/**
 * FNV-1a, 32-bit.
 *
 * Chosen for being short, dependency-free and identical in every runtime that
 * implements it — which matters here in a way it usually does not: the control plane and
 * the router both compute this, and a key that lands on v7 in one and v6 in the other
 * would make stickiness silently untrue. A cryptographic hash would be a better mixer
 * and is not needed; nothing here is a secret and nothing is defended against an
 * adversary choosing keys.
 */
export function hashKey(key) {
  let hash = 0x811c9dc5;
  const text = String(key);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // The FNV prime, 16777619, by shifts — `hash * 16777619` overflows into a float.
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return hash >>> 0;
}

/**
 * Checks a proposed set of weights before anything is written.
 *
 * Weights must sum to exactly 100. Normalising instead — accepting 30/30 and calling it
 * 50/50 — is the friendlier-looking option and is how an operator ends up with a split
 * they did not ask for: someone sets v7 to 10 intending 90/10, forgets to lower v6 from
 * 100, and gets 91/9 with no complaint from anything.
 *
 * @param {Array<{version: number, weight: number}>} targets
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function validateWeights(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { ok: false, code: 'NO_TARGETS', message: 'a deployment must serve at least one version' };
  }

  for (const target of targets) {
    if (!Number.isInteger(target.weight) || target.weight < 0 || target.weight > TOTAL_WEIGHT) {
      return {
        ok: false,
        code: 'INVALID_WEIGHT',
        message: `v${target.version} has weight ${target.weight}; weights are whole `
          + `percentages between 0 and ${TOTAL_WEIGHT}`,
      };
    }
  }

  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target.version)) {
      return {
        ok: false,
        code: 'DUPLICATE_VERSION',
        message: `v${target.version} appears twice; a version has one weight or none`,
      };
    }
    seen.add(target.version);
  }

  const total = targets.reduce((sum, t) => sum + t.weight, 0);
  if (total !== TOTAL_WEIGHT) {
    return {
      ok: false,
      code: 'WEIGHTS_MUST_SUM_TO_100',
      message: `the weights given sum to ${total}, not ${TOTAL_WEIGHT}: `
        + targets.map((t) => `v${t.version}=${t.weight}`).join(', ')
        + '. They are shares of the same traffic, so they are stated in full rather than '
        + 'normalised — a share that is adjusted for you is a split you did not choose.',
    };
  }

  if (!targets.some((t) => t.weight > 0)) {
    return {
      ok: false,
      code: 'NO_TARGET_TAKES_TRAFFIC',
      message: 'every version is at weight 0, so nothing would answer',
    };
  }

  return { ok: true };
}

/**
 * Applies a single `rollout` to an existing set of weights.
 *
 * `ash deployment rollout model --version 7 --traffic 10` names one version and one
 * share, and the rest of the split has to come from somewhere. It is taken from the other
 * versions **in proportion to what they already have**, which is what makes a sequence of
 * rollouts behave the way the spec's example reads: 10, then 50, then promote.
 *
 * Proportional rather than "take it all from the previous incumbent", because with three
 * versions in play there is no such thing as the previous one, and a rule that picks the
 * largest would move traffic an operator never mentioned.
 *
 * The arithmetic is done in whole percentages and the remainder is given to the largest
 * of the others, so the total is exactly 100 with no rounding drift accumulating over a
 * sequence of rollouts.
 *
 * @param {Array<{version: number, weight: number}>} current
 * @param {number} version the version being rolled out; may be new
 * @param {number} weight the share it should take
 */
export function applyRollout(current, version, weight) {
  const others = current.filter((t) => t.version !== version);
  const remaining = TOTAL_WEIGHT - weight;

  if (others.length === 0) return [{ version, weight: TOTAL_WEIGHT }];

  const othersTotal = others.reduce((sum, t) => sum + t.weight, 0);
  // Every other version at zero: nothing to be proportional to, so the remainder is
  // spread evenly rather than being dropped on whichever happens to be first.
  const shares = othersTotal > 0
    ? others.map((t) => (t.weight / othersTotal) * remaining)
    : others.map(() => remaining / others.length);

  const rounded = shares.map((share) => Math.floor(share));
  let leftover = remaining - rounded.reduce((sum, n) => sum + n, 0);

  // Hand the rounding remainder out largest-share-first, which is stable and keeps the
  // relative order of the others intact.
  const order = rounded
    .map((value, index) => ({ index, fraction: shares[index] - value }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (leftover <= 0) break;
    rounded[index] += 1;
    leftover -= 1;
  }

  const next = others.map((target, index) => ({ version: target.version, weight: rounded[index] }));
  next.push({ version, weight });
  return next.sort((a, b) => a.version - b.version);
}

/**
 * Chooses which target answers one request.
 *
 * @param {Array<{version: number, weight: number, ready?: boolean}>} targets
 * @param {object} [options]
 * @param {string|null} [options.key] a sticky route key; the same key always chooses the
 *   same version for a given set of weights
 * @param {function} [options.random] injectable, so the tests are not statistical
 * @returns {{target: object, reason: string} | null} null when nothing can answer
 *
 * A target with `ready: false` is skipped and the remaining weights are used as they
 * stand — deliberately *not* renormalised onto 100. The weights are what the operator
 * asked for, and a canary whose single pod is restarting must not silently become the
 * whole of the traffic on the way back up. What happens instead is that its share goes to
 * whoever else is ready, which is the same thing a Service does when an endpoint drops
 * out, and the reason is reported so a caller can tell the two cases apart.
 */
export function chooseTarget(targets, { key = null, random = Math.random } = {}) {
  const eligible = targets.filter((t) => t.weight > 0 && t.ready !== false);

  if (eligible.length === 0) {
    // Nothing that should be taking traffic is able to. Falling back to a zero-weight
    // version would be worse than failing: a version at weight 0 is one an operator has
    // deliberately taken out of rotation, and quietly serving from it is the exact
    // failure §21 exists to prevent.
    return null;
  }

  if (eligible.length === 1) {
    const only = eligible[0];
    const reason = targets.filter((t) => t.weight > 0).length > 1 ? 'only-ready' : 'sole-target';
    return { target: only, reason };
  }

  const total = eligible.reduce((sum, t) => sum + t.weight, 0);

  if (key != null && key !== '') {
    const bucket = hashKey(key) % STICKY_BUCKETS;
    // Scaled by the eligible total rather than by 100, so stickiness still works when a
    // target is down. A key's version may change when readiness changes; it may not
    // change from one request to the next while nothing else did.
    const point = (bucket / STICKY_BUCKETS) * total;
    return { target: pick(eligible, point), reason: 'sticky' };
  }

  return { target: pick(eligible, random() * total), reason: 'weighted' };
}

/** Walks the cumulative weights and returns the target `point` falls in. */
function pick(eligible, point) {
  let cumulative = 0;
  for (const target of eligible) {
    cumulative += target.weight;
    if (point < cumulative) return target;
  }
  // Only reachable through floating-point equality at the very top of the range.
  return eligible[eligible.length - 1];
}

/**
 * Whether a deployment needs a router in front of it.
 *
 * One version at 100 does not: the Service selects its pods and there is nothing to
 * decide. The moment there are two, something has to choose per request, and that is the
 * whole reason the router exists.
 */
export function needsRouter(targets) {
  return targets.length > 1;
}
