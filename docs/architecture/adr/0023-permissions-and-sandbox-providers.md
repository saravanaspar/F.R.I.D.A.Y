# ADR-0023: Workspace Permissions and Pluggable Sandbox Providers

## Status

Accepted. Setup-interface wording amended by ADR-0038. Network-approval semantics are reaffirmed and clarified by ADR-0050. The sandbox implementation was generalized into a provider contract in 2026.

## Context

FRIDAY executes model-generated edits and shell commands. Permission policy and OS isolation are different responsibilities: policy decides whether an action is authorized, while isolation constrains where the authorized action can run. Both are security boundaries and must remain independently replaceable.

Binding core execution to one container engine, userspace kernel, namespace launcher, or microVM makes portability and threat-model changes unnecessarily invasive.

## Decision

`permissions` retains the workspace/effect authorization model. `sandbox` owns a vendor-neutral `SandboxProvider` contract and provider registry.

Core consumers depend only on the Sandbox capability. Providers translate the same generic requests for workspace access, network intent, resource ceilings, environment, trusted read-only mounts, direct processes, and persistent kernels into backend-specific enforcement.

A provider must advertise filesystem, process and network isolation, resource-limit enforcement, writable workspace support, trusted read-only mounts, and persistent-process support. Registration fails closed when any required guarantee is missing. Unknown providers also fail closed. FRIDAY never silently downgrades to unsandboxed host execution.

Built-in providers are registered only in `plugins/sandbox/providers/index.ts`. The first built-in provider is kern, but no model-facing or execution-owning plugin contains kern-specific policy.

The default network mode is `requested`. A sandbox operation has no network unless the caller explicitly requests it and Permissions authorizes the network-bearing action. `FRIDAY_SANDBOX_NETWORK_MODE=unrestricted` remains an explicit operator override and Doctor warns about it.

Authorized execution receives only the selected workspace and host-registered auxiliary read-only mounts. Mount sources and mutable targets are revalidated before launch. Provider client processes receive a bounded environment instead of the full FRIDAY credential environment.

The approved runtime image remains Sandbox-owned and declared as a binary asset. `friday setup sandbox` delegates preparation to the selected provider rather than installing privileged host software or assuming a particular engine.

## Consequences

Changing sandbox technology is local to a provider module and registration entry. Tools, Permissions, Execution, Evaluation, Artifacts, Autonomy and Self-Improvement do not change.

Provider isolation classes and tradeoffs remain explicit. A namespace/seccomp provider that shares the host kernel is not represented as equivalent to a userspace-kernel or microVM provider.

Provider-specific host prerequisites are documented by that provider. The built-in kern provider requires Linux with its user-namespace/cgroup prerequisites and an installed kern binary; other providers may have different requirements.
