# Changelog

Notable user-facing changes to F.R.I.D.A.Y are tracked here.

The project is in active development. GitHub Releases contain the authoritative
published release artifacts and generated release notes.

## [1.0.2] - Unreleased

F.R.I.D.A.Y v1.0.2 is the current development release. This section remains
unreleased and will continue to accumulate changes until release preparation is
explicitly started.

### Security

- Hardened OpenAI Codex and Anthropic OAuth authorization-code flows so the
  CSRF `state` value is generated independently from the PKCE verifier instead
  of reusing PKCE material for request correlation.

- Restricted local OAuth callback listeners to loopback hosts and added focused
  regression coverage for state/PKCE separation and callback-host validation.

- Added replace-environment execution support for sandboxed child processes so
  provider/API credentials and unrelated host environment variables are not
  implicitly inherited by model-executed sandbox commands.

- Moved promoted self-improvement dependency installation and binary builds into
  the configured sandbox provider instead of running candidate-controlled npm
  lifecycle/build commands directly with host authority. Single-binary
  promotion also verifies that the sandbox build OS/architecture matches the
  running F.R.I.D.A.Y host before staging a successor.

### Sandbox providers

- Replaced the hard-coded sandbox runtime with a generic `SandboxProvider`
  contract and centralized provider registry. Execution, Tools, Evaluation,
  Artifacts, Autonomy, Permissions, and Self-Improvement now depend only on the
  sandbox capability rather than a vendor-specific backend.

- Added fail-closed provider capability validation for filesystem, process and
  network isolation, resource limits, writable workspaces, trusted read-only
  mounts, and persistent processes. Missing or insufficient providers are
  rejected instead of silently falling back to host execution or a weaker
  runtime.

- Added provider selection through `FRIDAY_SANDBOX_PROVIDER`. The first
  registered built-in provider is the default, so adding or replacing an
  in-repository backend only requires implementing the provider contract and
  registering it in `plugins/sandbox/providers/index.ts`.

- Added kern as the first built-in provider. Its provider-owned implementation
  and image assets live under `plugins/sandbox/providers/kern/`, keeping core
  sandbox code vendor-neutral. The provider uses kern's untrusted profile,
  required resource limits, isolated workspaces, network-off-by-default policy,
  and persistent-process support for the IPython kernel.

- Removed the legacy Podman implementation and the intermediate gVisor/Cube
  integrations, vendor-specific setup scripts, image-build wrapper, and stale
  documentation. Sandbox setup is now the generic `friday setup sandbox` /
  `npm run setup:sandbox` flow delegated to the selected provider.

- Updated Doctor, onboarding, architecture documentation, packaging discovery,
  and CI to report/test the configured sandbox provider and its generic
  security contract rather than assuming one runtime implementation.

### Execution and tooling

- Updated sandbox-backed artifacts, autonomy, secure editing, evaluation/tool
  processes, and persistent kernel launches to use the provider-returned command
  context and its filtered environment consistently.

- Kept sandbox networking provider-independent: requested networking remains
  disabled by default and is enabled only when an operation explicitly asks for
  it and the existing Permissions flow authorizes the network-bearing action.

- Added sandbox-provider contract tests and real-provider integration coverage
  for host secret/file isolation, workspace access, trusted mounts, process
  execution, and persistent IPython behavior.

## [1.0.1] - 2026-09-06

- Added durable operator controls, including correlated approval/question
  workflows with job IDs, operator dashboards, persistent spending limits,
  memory correction, and attachment lifecycle management.

- Added the Spending plugin and integrated durable spending enforcement with the
  existing runtime and operator-control flows.

- Hardened session-job delivery recovery, scheduler slot refill behavior, and
  memory candidate filtering for long-running always-on operation.

- Added automated release preparation and publishing workflows. Release
  preparation synchronizes package versions and opens a release branch/PR;
  publishing verifies and packages the merged release commit while preserving
  tag, provenance, and source checks.

- Synchronized the release package set to v1.0.1 across the root package,
  workspaces, internal dependency metadata, and lockfiles.

## [1.0.0-dev] - 2026-09-02

F.R.I.D.A.Y v1.0.0-dev is the first public development release.

This release includes the self-hosted assistant runtime, durable sessions and
background work, memory, scheduling, multi-channel communication, tools and
sandboxed execution, encrypted secrets, recovery, self-improvement, release
packaging, security hardening, and cross-platform Linux/macOS binaries.

- Removed the conversational CLI channel and its trusted local-ingress API. The
  command line remains for setup/onboarding compatibility, Doctor, and bounded
  stopped-runtime maintenance.

- Added exact first-run operator pairing, native approval buttons for Telegram,
  Discord, Slack, Teams, and Google Chat, private replay-resistant protected
  interaction state, and strict text fallbacks for every transport.

- Hardened Discord admission/session checkpoints, Email UIDVALIDITY checkpoints,
  Teams signed-route persistence, unsupported attachment handling, and
  Events/Scheduler cooperative shutdown behavior.

- Removed unreferenced model-runtime code, redundant direct dependencies, a
  duplicate script alias, and an unused upscaled brand asset.

- Added the optional Voice plugin with OpenAI/Deepgram STT and OpenAI/ElevenLabs
  TTS, Vault-backed credentials, artifact enrichment, and bounded untrusted
  transcript persistence.

- Added a dedicated persisted `FRIDAY_WORKSPACE`, stable `FRIDAY_HOME/tooling`
  environments, rebuildable-runtime backup exclusions, packaged Linux SEA smoke
  tests, and stronger Doctor deployment-readiness checks.

- Hardened release installation with attested installer assets, candidate
  preflight/rollback, and provenance verification before binary activation.

- Replaced module-sized cross-plugin `service.api` bags with semantic typed
  capability contracts; self-improvement now inspects configured ordinary
  contracts and prefers existing actions, tools, capabilities, or an MCP
  boundary before generating code.

- Split custom-model registry mutation from ordinary model inference through the
  `model.registry` capability.

- Enforced dependency-tree-free `plugins/` and `packages/` workspaces; workspace
  Vitest runs use a non-bundling config loader with persistent cache disabled so
  tests do not recreate local `node_modules`.

- Restored the secure sandbox default: network is disabled unless an action
  explicitly requests network and receives approval; Doctor warns on an
  unrestricted host override.

- Added user-scoped Conditional Hooks for reusable turn/action/handover
  conditions with bounded invocation counts.
