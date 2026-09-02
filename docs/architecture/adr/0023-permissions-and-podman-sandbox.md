# ADR-0023: Workspace Permissions and Rootless Podman Sandbox

## Status

Accepted. Setup-interface wording amended by ADR-0038. Network-approval semantics are reaffirmed and clarified by ADR-0050.

## Context

FRIDAY executes model-generated edits and shell commands. Permission policy and
OS isolation are different responsibilities: policy decides whether an action
is authorized, while isolation constrains where the authorized action can run.
Both are meaningful security boundaries and independently replaceable.

## Decision

FRIDAY uses two plugins.

`permissions` provides three workspace-scoped modes:

- `ask`: reads are automatic; shell/edit writes require user approval.
- `auto`: reads and workspace writes are automatic; network access still requires
  user approval.
- `full`: non-network workspace operations do not prompt for approval; explicit network use still requires approval.

All modes reject paths outside the selected workspace.

`sandbox` uses rootless Podman as the first backend. Model-generated shell
commands, persistent IPython kernels, deterministic evaluation gates, and
host-owned inspection commands that consume model-controlled workspace state run in
containers with a read-only container root, dropped Linux capabilities,
`no-new-privileges`, bounded PID count, and private tmpfs. The sandbox is
network-capable for model shell commands when the caller explicitly requests
network and the permissions policy authorizes it; otherwise Podman is launched
with `--network=none`. Persistent IPython remains network-off and uses filesystem
IPC sockets shared only through a per-kernel temporary directory; networked
fetch/install work is performed through the permission-gated bash tool instead.
Execution uses `--pull=never`; image acquisition is a separate explicit setup
action. The fixed setup surface (`friday setup sandbox`) and the permission-gated
`sandbox.setup` System action first check rootless Podman and the configured
local image. If the image already
exists it is reused unchanged; if only the image is missing, FRIDAY requires
explicit approval before building it from the Sandbox-owned Containerfile declared
in `plugins/sandbox/friday.binary-assets.json`
(pulling the base image only during this approved setup step). Missing or
non-rootless Podman remains a host prerequisite rather than an automatically
privileged system-package installation.

Model-generated bash calls do not declare their own authorization class. Shell
commands are conservatively treated as workspace-write authority because a
model-supplied label cannot reliably describe arbitrary shell effects. In
`ask` mode that authority requires approval; `auto` explicitly authorizes
autonomous workspace mutation. Network is a separate privilege request and requires approval in all modes,
including `full` (ADR-0050). Authorized bash and IPython execution receive a read-write workspace mount.
External read-only mounts are never accepted from model-controlled paths alone.
A host consumer must register each source mount for the exact workspace and,
when needed, an explicit target mountpoint inside that workspace. Sandbox never
derives host bind sources from model-writable symlinks or Git metadata. Linked-worktree
Git mounts reuse Worktrees' validated Git metadata rather than duplicating that
trust logic inside Sandbox. Registered sources and mutable in-workspace targets
are revalidated on every launch, so replacing a previously approved mountpoint
with a symlink does not extend the registration's authority. Direct host-owned process launches use the same
workspace/network/mount boundary without a shell, so internal Git inspection
cannot escape the container merely because candidate `.git` metadata was
modified.

The sandbox backend is exposed through a capability contract so Podman can be
replaced later without changing the non-plugin host, autonomy policy, or agent
runtime.

## Consequences

Permission prompts remain policy rather than container behavior. Container
isolation remains enforcement rather than approval policy. `full` means full
access to the selected workspace, not unrestricted host access.

The initial sandbox image is built locally from the Sandbox-owned Containerfile.
Distribution and CI discover that source through `plugins/sandbox/friday.binary-assets.json`
and includes Node.js 22/npm, Git, Python 3, IPython kernel support, dill, a native
build toolchain, pkg-config, curl, jq, ripgrep, zip and unzip. Repository
dependencies are installed once in the primary checkout's root-hoisted
`node_modules`; plugin/package-local `node_modules` trees are forbidden. Isolated
self-improvement worktrees receive the primary checkout's dependency tree through
an explicit read-only trusted mount so normal test/typecheck/build commands can
use local package binaries without exposing unrelated host paths.
