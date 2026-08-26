/**
 * Just enough IPv4 CIDR arithmetic to check one claim: that the address range AshML
 * believes the cluster gives to pods actually covers the ranges the cluster says it does.
 *
 * That claim is load-bearing. The per-project NetworkPolicy allows egress to
 * `0.0.0.0/0 except <cluster pod CIDR>` (`buildProjectNetworkPolicyManifest`), so if the
 * configured block is too narrow, the pods it fails to cover are read as "outside the
 * cluster" and cross-project traffic is permitted — silently, and in the direction where
 * nothing breaks and the isolation simply is not there. Hence a check rather than a
 * default that is assumed to be right.
 *
 * Pure and dependency-free, and IPv4 only: `spec.podCIDR` on a dual-stack node is the
 * first entry of `podCIDRs`, and an IPv6 cluster needs a second `except` entry rather
 * than a cleverer parser here. `podCidrsOf` says so rather than guessing.
 */

/** @returns {{address: number, bits: number}} the block as a number and a prefix length. */
function parseCidr(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(text ?? '').trim());
  if (!match) {
    throw new Error(`"${text}": want an IPv4 CIDR block, like 10.42.0.0/16`);
  }

  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) {
    throw new Error(`"${text}": an IPv4 octet cannot exceed 255`);
  }

  const bits = Number(match[5]);
  if (bits > 32) {
    throw new Error(`"${text}": an IPv4 prefix cannot exceed /32`);
  }

  // Built by multiplication rather than with `<<`, which would coerce to a signed
  // 32-bit integer and turn every address above 127.255.255.255 negative.
  const address = octets.reduce((acc, octet) => acc * 256 + octet, 0);
  return { address, bits };
}

/** The leading `bits` of an address, as a number that can be compared for equality. */
function prefixOf(address, bits) {
  return Math.floor(address / 2 ** (32 - bits));
}

/** True when `text` is an IPv4 CIDR block this module can read. */
export function isIpv4Cidr(text) {
  try {
    parseCidr(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when every address in `inner` is also in `outer`.
 *
 * A block never contains one with a shorter prefix — /24 inside /16 can be true, /16
 * inside /24 cannot — and a block contains itself.
 */
export function cidrContains(outer, inner) {
  const a = parseCidr(outer);
  const b = parseCidr(inner);
  if (b.bits < a.bits) return false;
  return prefixOf(a.address, a.bits) === prefixOf(b.address, a.bits);
}

/**
 * The pod CIDRs a node reports, as plain strings.
 *
 * `spec.podCIDRs` is the list and `spec.podCIDR` is its first entry, kept for clusters
 * old enough to predate dual-stack. A node that reports neither is not an error here:
 * it happens while a node is registering, and a missing value must not be read as a
 * mismatch — it is simply nothing to check yet.
 */
export function podCidrsOf(node) {
  const list = node?.spec?.podCIDRs ?? (node?.spec?.podCIDR ? [node.spec.podCIDR] : []);
  return list.filter((cidr) => typeof cidr === 'string' && cidr.length > 0);
}
