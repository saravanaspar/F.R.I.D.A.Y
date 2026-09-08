# Sandbox providers

FRIDAY treats sandboxing as a capability, not as a hard-coded runtime. Core execution, tools, evaluation, artifacts, autonomy, and self-improvement depend only on `plugins/sandbox/contract.ts`.

The selected backend is a `SandboxProvider`. A provider must advertise and implement the guarantees FRIDAY requires before it can be registered:

- filesystem isolation;
- process isolation;
- network isolation;
- resource limits;
- writable workspace mounts;
- trusted read-only auxiliary mounts; and
- persistent processes for the IPython kernel.

FRIDAY fails closed if the configured provider is missing or claims that it cannot supply one of those required guarantees. It never silently falls back to an ordinary host process or a weaker runtime.

## Selecting a provider

The default built-in provider is `kern`:

```bash
export FRIDAY_SANDBOX_PROVIDER=kern
```

The environment variable is optional while kern is the default. `friday doctor` reports the selected provider, its isolation class, readiness, and the approved sandbox image.

The network policy remains provider-independent:

```bash
FRIDAY_SANDBOX_NETWORK_MODE=requested      # default
FRIDAY_SANDBOX_NETWORK_MODE=unrestricted   # explicit host override
```

In `requested` mode, a provider must keep network unavailable unless the operation explicitly requests it and the Permissions capability approves the network-bearing action.

## Adding another provider

Built-in provider registration is intentionally isolated to:

```text
plugins/sandbox/providers/index.ts
```

A new in-repository backend normally needs only:

1. a provider module implementing `SandboxProvider` and returning a `SandboxService`;
2. provider-owned assets beside that module when needed (for example a rootfs/Containerfile plus its own `friday.binary-assets.json`);
3. contract-compliance tests;
4. an import plus one entry in `BUILTIN_SANDBOX_PROVIDERS` in `providers/index.ts`.

The first entry in `BUILTIN_SANDBOX_PROVIDERS` is the default when `FRIDAY_SANDBOX_PROVIDER` is unset. Replacing kern with another built-in therefore requires no second core edit.

Everything above the sandbox capability remains unchanged. Do not add provider-specific branches to Tools, Execution, Evaluation, Autonomy, Artifacts, Permissions, or Self-Improvement.

Embedding hosts can also pass additional `SandboxProvider` implementations through `createSandboxPlugin({ providers: [...] })` and select one by id. Duplicate provider ids are rejected.

A provider must translate FRIDAY's generic policy into its native enforcement primitives. It must not reinterpret an unavailable feature as permission to run unsandboxed.

## Built-in kern provider

The repository currently ships kern as its only built-in provider. kern is daemonless and rootless, uses Linux namespaces, seccomp, cgroup v2 limits and OCI images, and runs directly on Linux/ARM boards including Raspberry Pi-class systems.

kern shares the host Linux kernel. It is suitable for the FRIDAY threat model of locally chosen/model-generated work whose blast radius the operator owns; it is not equivalent to a microVM or userspace-kernel boundary for hostile multi-tenant code.

Install kern from its current upstream source (kern is still pre-1.0, so pin the revision you deploy in production):

```bash
cargo install --git https://github.com/getkern/kern getkern --locked
export PATH="$HOME/.cargo/bin:$PATH"
```

Then verify it and prepare FRIDAY's approved image:

```bash
kern --version
kern doctor
friday setup sandbox
friday doctor
```

`friday setup sandbox` asks the selected provider to prepare the approved `friday-sandbox` OCI image from `plugins/sandbox/providers/kern/Containerfile`. The generic setup CLI does not know how kern builds images; that logic stays inside the kern provider.

The provider launches untrusted work with the kern `untrusted` security profile and `--require-limits`, keeps network off unless FRIDAY has authorized it, binds only the selected workspace plus host-registered read-only mounts, bounds `/tmp` and `/dev/shm`, and passes only a small host environment to the kern client process.

### kern configuration

```bash
FRIDAY_KERN_BIN=/path/to/kern          # optional; default: kern on PATH
FRIDAY_SANDBOX_IMAGE=friday-sandbox:gen0
FRIDAY_SANDBOX_MEMORY=2g
FRIDAY_SANDBOX_CPUS=4
FRIDAY_SANDBOX_PIDS=1024
FRIDAY_SANDBOX_OPEN_FILES=4096
FRIDAY_SANDBOX_FILE_SIZE_BYTES=2147483648
FRIDAY_SANDBOX_TEMP_SIZE=64m
```

Resource values are ceilings, not reserved RAM. Lower them for small boards when appropriate.

### Integration test

After kern and the sandbox image are ready:

```bash
FRIDAY_RUN_KERN_INTEGRATION=1 \
  npx vitest run --config vitest.config.ts test/sandbox-kernel.integration.test.ts
```

The integration test verifies that host secrets/files stay unavailable, trusted read-only mounts remain read-only, workspace writes work, and the persistent IPython kernel runs inside the selected provider.

## Provider review checklist

Before registering another provider, verify at minimum:

- no host credential/environment inheritance;
- no host-home/Vault/state visibility;
- read-only vs writable workspace enforcement;
- network-off behavior under `requested` mode;
- CPU/memory/PID limits fail closed when unavailable;
- timeout/termination does not leave unmanaged descendants;
- trusted mount source and target revalidation;
- persistent kernel behavior;
- Linux path/symlink escape resistance; and
- provider setup cannot silently replace the configured security boundary.
