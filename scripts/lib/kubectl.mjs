/**
 * `kubectl`, pinned to the cluster AshML is pointed at.
 *
 * Every script here asserts against the cluster with `kubectl`, and two of them delete
 * pods with it. Bare `kubectl` follows `current-context`, which is a *global* setting
 * belonging to whoever last ran `kubectl config use-context` — so on a workstation with
 * more than one cluster, an e2e run reads its assertions from one cluster while the
 * control plane it is testing works in another, and a chaos script kills a pod in
 * whichever one happened to be selected.
 *
 * That is the same hazard the control plane took `ASHML_KUBECONFIG_CONTEXT` for, and it
 * is worse here: the control plane looking somewhere else produces confusing failures,
 * while `kubectl delete pod` looking somewhere else deletes something real belonging to
 * someone else's work.
 *
 * So this reads the same variable the control plane reads. A script that builds a
 * control plane in-process therefore pins both sides from one setting and cannot pin
 * them differently, which is the failure mode worth ruling out rather than detecting:
 * two halves of one test, each correct about a different cluster.
 *
 * Unset means `k3d-ashml`, matching the Makefile's `CLUSTER` default, because a default
 * of "whatever is currently selected" is precisely what this exists to remove.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const KUBE_CONTEXT = process.env.ASHML_KUBECONFIG_CONTEXT
  ?? `k3d-${process.env.ASHML_CLUSTER ?? 'ashml'}`;

/** The context flag, for the callers that spawn `kubectl` themselves (port-forward). */
export const contextArgs = ['--context', KUBE_CONTEXT];

/** Runs kubectl against that context and returns its trimmed stdout. */
export async function kubectl(...args) {
  const { stdout } = await exec('kubectl', [...contextArgs, ...args]);
  return stdout.trim();
}

/**
 * Fails now, with the fix in the message, rather than at the first assertion.
 *
 * A missing context and an empty cluster look nothing alike to a person and very much
 * alike in a failing check three minutes into a run.
 */
export async function requireContext() {
  try {
    await kubectl('config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].name}');
  } catch (err) {
    throw new Error(
      `kubectl has no context "${KUBE_CONTEXT}" (${String(err.message).trim().split('\n')[0]}).\n`
      + '  Create the cluster with `make cluster`, or name the one to use in '
      + 'ASHML_KUBECONFIG_CONTEXT — the same variable the control plane takes.',
    );
  }
  return KUBE_CONTEXT;
}
