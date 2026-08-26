# ADR 0017 — Per-project isolation, written as egress

**Status:** Accepted · **Date:** 2026-08-26 · **Phase:** 10

## Context
ADR 0016 closed what a pod *is* — no Kubernetes credential, no privilege escalation, no
capabilities, and a namespace the cluster itself refuses privileged pods in. It ended by
naming what it did not close:

> **projects are still not isolated from one another.** All pods share one namespace and
> one service account, so a training pod in one project can open a socket to a model
> server in another. […] The next real step is a namespace per project or a default-deny
> NetworkPolicy.

That gap is not something AshML's own authorization can reach. Every request to the
control plane is checked against a principal, a project and a permission
(`domain/roles.js`), and none of that applies here, because this traffic never goes near
the control plane. It is one pod opening a TCP connection to another pod's address inside
one namespace. The only thing in the system that can refuse it is the cluster.

Measured before it was fixed, on the development cluster: a pod labelled for one project
fetched a page from a pod labelled for another, first try, no obstacle.

Two shapes were available.

**A namespace per project** is the stronger boundary — it also separates Secrets, RBAC and
resource quotas — and it is a change to almost everything. Every manifest builder, the
executor's Job lookups, the deployment sync's list calls, `ensureNamespace`, the artifact
paths and the `ash` CLI's namespace assumptions all take a namespace that is currently one
constant. It also cannot be applied to a running cluster without moving every existing
workload.

> **Amended: this was done, and the last sentence was wrong.** ADR 0019 gives each project
> its own namespace. The cost of the first sentence was real and is why this ADR came
> first. The claim that it cannot be applied without moving every workload assumed the
> namespace would be *derived* from the project on every call — and deriving it is what
> breaks an upgrade, because the day the rule changes every running Job is looked for
> somewhere it is not. Recorded on the row instead, an upgrade moves nothing: a null means
> the shared namespace, running jobs finish where they started, and new ones go to their
> project's. The NetworkPolicy below is kept rather than replaced; see *The NetworkPolicy
> is kept, not replaced* in ADR 0019 for why a namespace does not make it redundant.

**A NetworkPolicy per project** costs one object per project and one API call on the path
that already creates the workload. Every AshML pod has carried `ashml.io/project` since
Phase 2, so the selector already exists. And on k3s it is enforced rather than decorative:
k3s ships kube-router's policy controller by default.

## Decision
**One NetworkPolicy per project, in the shared namespace, restricting egress.**

    podSelector: ashml.io/project = <project>
    policyTypes: [Egress]
    egress:
      - to: [podSelector: ashml.io/project = <project>]      # its own project, any port
      - to: [namespaceSelector: kube-system], ports: 53/UDP, 53/TCP
      - to: [ipBlock: 0.0.0.0/0 except <cluster pod CIDR>]   # everything not a pod here

Applied by `backend.ensureProjectIsolation(project)` **before** the workload it protects —
on every job launch and every deployment apply, not once at startup. A failure to apply it
fails the launch.

`ASHML_NETWORK_POLICY_ENABLED` (default true) and `ASHML_CLUSTER_POD_CIDR` (default
`10.42.0.0/16`, which is k3s's). The control plane compares the configured CIDR against
every node's `spec.podCIDR` at startup and logs a warning naming the node if they disagree.

## Rationale

### Egress, not ingress — the part that was measured
"A project's pods accept connections only from their own project" is the same rule read
from the other end, and it is the one that comes to mind first. It is wrong, and the way
it is wrong is the reason this ADR exists.

A NetworkPolicy that names `Ingress` denies every source it does not list, and the sources
it cannot list are the ones that are not pods: the kubelet's readiness probes, and the API
server's `/proxy` endpoint — which is how `callService` reaches a model server for
`ash predict`, a smoke test, or the demo. The obvious repair is an `ipBlock` allowing
everything outside the pod network, and on a single-node cluster that appears to work.

It does not work on two nodes. With k3s and flannel, traffic from the API server to a pod
on another node leaves the host through that node's flannel interface, whose address is
*inside* the pod CIDR — the same CIDR the `except` clause removes in order to keep other
projects out. So the allowance never matches. Asked of the cluster directly:

    $ kubectl get --raw '/api/v1/namespaces/netpol-probe/pods/beta-server-agent:8080/proxy/'
    Error from server (ServiceUnavailable): error trying to reach service:
    proxy error from 127.0.0.1:6443 while dialing 10.42.1.78:8080, code 502

while the identical call to a pod on the API server's own node returned its page. A policy
that passes every test on the development cluster and breaks serving in production,
intermittently, depending on where a pod happened to land.

Egress has none of that problem. It constrains the pod the platform is least sure about —
the user-submitted image — at the point where it *initiates*, and leaves every inbound
platform path untouched. And because every AshML pod carries a project label and every
project gets a policy, denying each project's egress to the others denies the traffic in
both directions: there is no pod left that is allowed to start the conversation.

### The three rules are the smallest set that keeps the platform working
Rule 3 is the one that looks too permissive and is not. A training job is user code that
is *meant* to fetch a dataset, install a package, and report its own metrics to a control
plane that runs outside the cluster. This is a boundary between tenants, not a firewall
around user code; the roadmap's honest limitations already say a compromised training
image is contained by the namespace, and that has not changed.

A ClusterIP is deliberately not listed anywhere. Traffic to a Service is translated to a
pod address before the policy is evaluated, so another project's Service is refused by
rule 1 exactly as its pod address is. Verified rather than reasoned about, because it
depends on the CNI evaluating after DNAT and would be a hole if it did not.

DNS is selected by namespace rather than by the `k8s-app: kube-dns` label, so a cluster
running something other than CoreDNS still resolves, and TCP is allowed alongside UDP
because a large answer falls back to it. A resolver that works until a response crosses
512 bytes is worse than one that does not work at all.

### Before the workload, and on every launch
The gap between a pod starting and its policy arriving is a real window and an entirely
avoidable one, so the policy goes first and a failure to apply it fails the launch. A
training pod that runs without its boundary is the quieter outcome, and the quieter
outcome is the wrong one.

On every launch rather than once at startup, because a policy deleted by hand at noon
would otherwise stay deleted until the next restart — a security control whose absence
nothing reports. Re-asserting it from the same action that creates the thing it protects
costs one API call.

### The CIDR is the one setting that can be wrong in silence
Too narrow a value does not fail. The pods it misses are read as "outside the cluster",
which is exactly the branch that permits traffic, so the isolation is simply absent for
those nodes and nothing says so. Hence a startup check against what the nodes report
(`k8s/cidr.js`), and a warning rather than a refusal to start: the policy still binds
every node that *is* covered, and exiting would take that away too.

### What this cannot do is enforce itself
A NetworkPolicy is an object every cluster accepts and only some clusters implement. A CNI
without a policy controller stores it, lists it back, and routes the traffic anyway. So
`make e2e-isolation` does not assert on the manifest: it runs two projects' pods on the
real cluster and runs `wget` inside one of them, and every refusal is paired with the same
address answering a pod in the project that owns it — because "alpha cannot reach beta"
proves nothing without "beta can, right now".

## Revisit when
- ~~**A project needs to be isolated from AshML's own workloads, not only from other
  projects.** That is a namespace per project, with everything it costs.~~ — **done**,
  ADR 0019. Each project has its own namespace; this policy now applies inside it.
- **A cluster runs a CNI that does not enforce NetworkPolicy.** The control plane cannot
  detect this and says so at startup rather than implying otherwise.
- **The cluster is dual-stack.** The `except` clause is IPv4; pod-to-pod traffic over IPv6
  is not refused, and `verifyClusterPodCidr` warns when a node reports an IPv6 range.
- **The counters and the boundary want to be one thing.** A NetworkPolicy says nothing
  about what it refused. Cross-project attempts are invisible to the audit trail
  (ADR 0015) because they never reach the API — they would need flow logs from the CNI.

## Consequences
- Each project gains one NetworkPolicy in `ashml-jobs`, named `ashml-project-<name>`,
  created before its first workload and left in place afterwards.
- No image changes and no restarts. A NetworkPolicy is evaluated against pods as they are;
  running pods come under it the moment it is applied.
- A cluster whose pod network is not `10.42.0.0/16` must set `ASHML_CLUSTER_POD_CIDR`, and
  is told at startup if it has not.
- `make e2e-isolation` is a new end-to-end check, and it needs only `busybox` — no built
  images, no dataset — so it runs in CI alongside `make e2e`.
- The roadmap's "next real step" for Phase 10 moves from *nothing stops a training pod in
  one project from reaching a model server in another* to *a project's pods share a
  namespace and a service account with every other project's*, which is a smaller
  sentence and a true one. That sentence was closed in turn by ADR 0019.
