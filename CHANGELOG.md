# Changelog

Notable user-facing changes to F.R.I.D.A.Y are tracked here.

The project is in active development. GitHub Releases contain the authoritative
published release artifacts and generated release notes.

## [Unreleased]

### Client foundation

- Added the versioned client protocol package used by server transports and future desktop, Android, and Computer Node clients.
- Added persistent device pairing with Ed25519 challenge authentication, explicit approval, revocation, last-seen tracking, and private state storage.
- Added the loopback Client Gateway with health, pairing, authentication, event replay/resume, authenticated WebSocket streaming, and WebRTC signaling relay.
- Added deployment and verification documentation for loopback binding, TLS termination, pairing, replay, reconnect, and signaling checks.

### Agent Profiles and Conversations

- Added persistent named Agent Profiles with role instructions, scoped memory declarations, enabled Skills/plugins, notification preferences, approval policy, and restart-safe CRUD operations.
- Added persistent Direct/Group Conversation metadata over existing Sessions, including participants, pin/hide state, notification state, read sequence, Threads with reply counts, Reactions, mention resolution, and visible Agent-to-Agent handoffs.
- Routed handoffs through the existing Session Jobs capability when an execution runner is available, without introducing a second queue or transcript store.
- Added profile selection to Turn Loop turns, profile identity prompt sections, and authorized `global:user`, `agent:<id>`, `project:<id>`, and `local` Memory namespaces with cross-profile read/write isolation.
- Added durable `JobDirective` redirection: active jobs persist user directions, expose redacted directive metadata, and apply them through the Agent steering boundary; interrupted jobs include pending directions during restart reconstruction.
- Added authenticated client gateway APIs for Agent Profile CRUD, Conversation CRUD/read state, mentions, Threads, Reactions, profile-targeted turn submission, and durable active-job redirection.

### Projects and Execution Targets

- Added persistent server-owned Projects with canonical roots, repository metadata, validation commands, preferred Computer Node identity, and fail-closed execution policy.
- Added the provider-neutral `@friday/execution-targets` contract for Sandbox, Core Host, and future Computer Node targets, with Project-aware Turn Loop routing and target-aware shell/edit/process/IPython execution.
- Added restart-safe isolated coding worktrees, trusted diff Artifacts, deterministic validation, commit/promotion flows, authenticated Client Gateway Project APIs, and Session Job preservation of Project/target context.
- Added permission-gated canonical repository promotion by clean fast-forward merge or cherry-pick while keeping Computer Node execution fail-closed until Phase 4.

### Shared Agent Computer

- Started Phase 4 with a provider-neutral `computer` capability and `ComputerNodeAdapter` boundary for future Linux and Windows platform providers instead of adding a second executor or job system.
- Added resource-aware Computer admission across RAM, CPU, browser renderer count, GPU load, screen workload, browser requirements, and free Agent screens. Overloaded requests return `WAITING_FOR_COMPUTER`, and queued waits are retried when node telemetry or lease availability changes.
- Added exclusive expiring `ScreenLease` records plus generation-bound `ControlLease` ownership so stale GUI actions cannot survive lease changes or human takeover.
- Added human takeover with the roadmap's eight-second default idle hand-back (minimum five seconds or manual-only), zero keystroke/secret/sensitive-screenshot transcript capture, pending-action cancellation, and mandatory fresh screen/browser/process re-observation before Agent control resumes.
- Added a Browser Supervisor contract with persistent-profile/window/tab snapshots and the Computer-layer automation order of Playwright DOM, accessibility, CDP, then visual control; API/MCP remains an upstream preference.
- Added safe Computer status/doctor surfaces and provider-managed update, restart, and FRIDAY-managed-state reset operations that refuse to interrupt active screen leases and never imply resetting the person's operating system.
- Connected Phase 3 `computer:<node-id>` execution targets to the Computer capability: Projects now allow Computer-target workspaces, Turn Loop leases the selected Agent screen, and the existing bash/edit/process/IPython tools carry that lease and control generation into the provider instead of creating a parallel executor.
- Preserved the existing Permissions boundary for Computer execution, including the same tool action IDs, explicit write authorization, conservative network classification for remote shell/process/IPython work, and the existing subagent ban on persistent background-process starts.
- Added provider-bounded Computer tool execution with capability checks, output bounds, screen/owner/generation validation, and takeover/lease cancellation so a stale Computer tool call cannot continue after control changes.
- Added durable Session Job `waiting-for-computer` state so Computer admission pressure is visible as active work rather than an opaque running task; persisted wait context records the target node, stable `WAITING_FOR_COMPUTER` code, and bounded admission reasons.
- Wired Computer admission into Turn progress so a detached Project job persists its wait before blocking, returns to `running` after a screen grant, remains cancellable while waiting, and is reconstructed through the existing restart/resume path with Project and Computer target identity intact.
- Extended Session Job status/events/doctor surfaces with Computer wait counts and context while keeping Session Jobs provider-neutral; it stores generic wait metadata and does not import or own the Computer implementation.
- Reported contained Computer timer, admission-retry, and idle hand-back failures through the operational-error sink instead of silently discarding provider/runtime diagnostics, while preserving fail-closed human control on hand-back failure.
- Added permission-gated Agent `computer_observe` and `computer_browser` tools over the active leased screen. Observation is bounded/provider-neutral, browser actions remain generation-bound, and sensitive typing is rejected before provider execution so credentials/OTP/CAPTCHA values stay on the human-takeover path.
- Added authenticated Client Gateway Computer APIs for safe status, node/screen/lease discovery, observation, human takeover/activity, and hand-back. Human controller identity is derived from the authenticated device rather than caller input, and generic status surfaces expose browser readiness/counts instead of tab content.
- Reused typed Computer status/lease summaries across System and Client surfaces so external consumers receive one bounded representation without bypassing the Computer capability or provider boundary.
- Hardened Browser Supervisor orchestration with one opaque live browser-context identity, persistent shared-profile continuity, role-to-screen ownership checks for Human/Developer/Research/F.R.I.D.A.Y windows, unique tab assignment, and browser-ready admission that fails closed when the supervisor is stopped or its persistent profile is unavailable.
- Added takeover-aware Agent pause/resume semantics: interrupted Computer browser/tool actions are never replayed, the same leased Session Job waits for human hand-back, a fresh provider observation is attached to the resume result, and subsequent actions refresh to the new control generation.
- Added a provider-neutral login-wall acceptance path proving one Session Job survives human takeover, excludes human password/OTP content from durable/model-visible state, re-observes the signed-in browser after hand-back, and completes without replaying the interrupted GUI action.
- Hardened active Computer runs with a screen-lease heartbeat that renews the original lease lifetime until the Agent run settles, including while manual-only human takeover is active; renewal failure aborts the run instead of allowing ownership to expire silently.
- Made provider-owned background processes run-scoped: Computer bindings carry the same host-generated Agent `runId` used by the existing managed-process run, `process start` defaults to and is capped at one hour, fails closed unless the provider exposes run cleanup, and Turn Loop requires that cleanup before the run can complete even if the screen lease disappeared first.
- Extended durable Computer admission through server-owned Project `policy.computerAdmission` requirements and the model-facing browser boundary: initial acquisition can reserve Browser Supervisor readiness, memory, renderer, and GPU demand, and the leased binding retains that same demand so later browser actions re-check it rather than inventing a per-action resource claim; pressure waits as `waiting-for-computer` and returns to `running` before dispatch.
- Required every provider observation to attest omission of protected input, raw human keystrokes, CAPTCHA contents, and sensitive screenshots, and added Computer-core defense-in-depth redaction for credential/token/OTP/PIN/CAPTCHA/value-shaped URL, DOM, accessibility, tab, and process text before it can reach Agent or Client surfaces; Phase 5/8 providers must pass real-UI conformance tests for that attestation.
- Replaced the synthetic login-wall acceptance fixture with a real Agent-executor/Project/Permissions/Computer/Session-Jobs integration path, and routed asynchronous waiter-drain failures through the operational-error sink rather than leaving fire-and-forget rejections unobserved.
- Hardened the Phase 4 verification harness itself: Computer wait assertions now tolerate additive typed wait metadata, and the real login-wall integration case uses bounded stage waits plus cancellation-safe teardown under an integration-test timeout so regressions surface at the failing checkpoint without orphaned waiter rejections.
- Isolated the real login-wall acceptance case at the intended integration boundary: Turn Runtime detached-job admission remains covered separately, while the takeover case starts a durable Session Job whose run invokes the real Agent executor directly, avoiding unrelated routing/dedupe state while preserving Project, Permissions, Computer-tool, model-dispatch, takeover, and same-job completion coverage.
- Isolated the real login-wall acceptance fixture from the operator's default Events store by using a per-test durable Events database, so repeated runs exercise fresh Turn Loop submissions instead of being correctly deduplicated by stale test events in `~/.friday`.
- Made Computer Agent contribution identifiers compatible with the Agent executor's validated contribution namespace (`computer-observe` / `computer-browser`) while preserving the public tool names and permission action IDs, so the real Agent path can construct and dispatch Computer tools.
- Hardened the real login-wall acceptance assertion around Project workspace acquisition: it now matches the stable Project/owner/target fields while explicitly verifying that the run cancellation `AbortSignal` is propagated, so additive execution metadata does not fail the test before takeover.
- Raised the bounded self-improvement contract-catalog public-type ceiling from 48 to 64 after the provider-neutral Computer contract legitimately grew to 50 exported types, preserving fail-closed discovery above the new ceiling and keeping CI/self-improvement contract inventories aligned.
- Closed the final Phase 4 takeover/admission edge cases: `computer_browser` now pauses without provider dispatch when human control changes during browser readiness admission, GPU-required work fails closed when GPU telemetry is unavailable, and the roadmap distinguishes the real login-wall Agent/Session-Job path from separately covered Turn Runtime detached-job admission.
- Completed the provider-neutral Phase 4 Shared Agent Computer implementation after the audit-hardening repository verification gate passed; concrete Linux/Sway/Chromium and Windows native providers remain tracked for Phases 5 and 8.

## [1.0.4] - 2026-09-09

### Memory correctness and retrieval

- Made `memory.correct` a true patch operation: omitted note/relation fields are preserved, empty corrections are rejected, note corrections use optimistic version checks, and relation replacement now runs as one `BEGIN IMMEDIATE` SQLite transaction instead of delete/reinsert plus whole-state compensation. Failed replacements roll back without losing the original, while a correction that resolves to an already-known relation merges into that edge instead of creating a duplicate.
- Changed graph identity to the semantic `(scope, subject, predicate, object)` edge rather than including observation context. Schema 4 migrates old context-split rows by merging occurrences, confidence, timestamps and bounded latest-preferred context, so repeated observations with different provenance reinforce one fact instead of fragmenting frequency across duplicate edges.
- Restricted automatic Turn Loop and Routing note retrieval to actual `memory` entries so reusable prompt, skill, and subagent records cannot leak into human-memory context or influence destination selection.
- Made ordinary `MemoryStore.search()` deterministic and lexical-only, with neural retrieval exposed explicitly through async `hybridSearch()`. Search/recall never writes embeddings as a side effect, and stale vectors are excluded by exact entry version.
- Made BGE-small-en-v1.5 INT8 ONNX the default semantic Memory backend (384 dimensions, CPU, CLS pooling, L2 normalization, query instruction). The model/runtime is provisioned explicitly with `friday setup memory`, runs offline from private FRIDAY tooling, and never silently falls back to or mixes with the legacy `local-subword-v1` embedding space.
- Decoupled durable Memory writes from neural inference: note create/update succeeds even when BGE is missing or temporarily unhealthy, while explicit per-entry/batch maintenance attaches vectors afterward with a version check so an asynchronously computed stale vector cannot overwrite a newer entry. Added `memory.embeddings.status` and `memory.embeddings.refresh` System actions for bounded operator-visible health and maintenance.
- Explicit `memory_recall` now uses hybrid lexical+BGE retrieval when the pinned local model is ready and degrades to lexical retrieval if semantic inference is unavailable. Routing and automatic Turn Loop context remain deterministic lexical-only reads.
- Bounded `memory.review` relation retrieval through the relation query API instead of snapshotting the entire relation table, while query-driven note review now uses ranked Memory search and queryless review uses a newest-first bounded SQL query instead of listing the full note table.
- Added true read-only file-backed Memory access for Routing, automatic Turn Loop recall, explicit recall/review/status paths, and other non-mutating consumers. Existing SQLite state opens read-only/query-only without migration or permission changes, and missing state is viewed as empty without creating directories or database files.
- Reduced semantic idle RAM without coupling Memory to Voice environments: the shared BGE ONNX worker stays warm for bursty requests, automatically unloads after 90 seconds of inactivity by default, restarts lazily on the next semantic request, and is explicitly disposed with Memory plugin lifecycle shutdown.
- Added a `memory` System status contribution so Doctor/Diagnostics can report whether the pinned BGE runtime is provisioned, whether the worker is currently active, and whether persistent global Memory stores have missing/stale vectors; Diagnostics points operators to `friday setup memory`, `memory.embeddings.status`, and explicit refresh instead of attempting hidden repair writes.

### Compatibility

- Memory relation state upgrades to SQLite schema 4 when a writable Memory store opens it. Runtimes that only understand schema 3 (including v1.0.3) cannot open that upgraded Memory database; take a stopped-runtime state backup before testing v1.0.4 if you need binary rollback.

### Memory security and project knowledge

- Enforced Vault separation at Memory-owned persistence boundaries: durable `memory` entries, nested structured metadata, graph relations/context, refinement evidence, and bulk state replacement reject secret-shaped credential material even when a caller bypasses Agent-tool validation.
- Hardened project Markdown indexing by opening candidate files with `O_NOFOLLOW`, validating the opened file descriptor as a regular bounded file before reading, skipping raced/unreadable candidates, and no longer persisting absolute workspace paths in project-memory metadata.
- Further pinned project-knowledge traversal to the canonical workspace: directory recursion rejects symlink/identity changes and files are accepted only when the opened descriptor still matches the canonical in-workspace inode, closing ancestor-directory swap/path-escape races in addition to final-component symlink races.

## [1.0.3] - 2026-09-09

### Remote-first onboarding and administration

- Added Quick and Custom first-run setup modes without removing the existing local onboarding surfaces. Both modes require the routing model, one exact trusted operator channel, and an explicit host privilege policy locally. Quick setup stops after that mandatory block and hands the remaining optional onboarding to the trusted channel; Custom setup offers the existing terminal configuration areas as optional/skippable steps.
- Added router-only bootstrap runtime settings. A main reasoning model is optional during onboarding while typed system/admin operations remain available through the routing model. Legacy main-only v1.0.2 runtime settings are upgraded by deriving the router from the main model.
- Added a private resumable onboarding state under `FRIDAY_HOME/onboarding/state.json`, with mandatory local steps that cannot be skipped and optional steps that can be completed or intentionally skipped locally or from a trusted channel.
- Separated agent permission mode (`ask`/`auto`/`full`) from the fail-closed host privilege policy (`broker`/`none`). The policy can only be selected or changed locally (`friday setup privileges [broker|none]`); broker mode remains restricted to explicit root-owned helper operations and `none` never invokes sudo.
- Added trusted-channel administration for runtime settings, conversational protected main-model setup, additional channels with protected Vault credential capture, Voice (hosted or local, including explicit Chatterbox CPU/GPU selection), execution Python, Doctor/diagnostics, and existing sandbox/MCP/Skills/self-repository actions. Successful optional setup actions advance the resumable onboarding state automatically.
- Unified trusted-channel `diagnostics.doctor` and local `friday doctor` on one canonical host-owned Doctor collector. A narrow read-only `doctor.host` capability now carries only typed check results into the model/channel-facing Diagnostics plugin, so both surfaces run the same installation, configuration, security, tooling, Voice/channel/Vault/sandbox, backup/recovery, crash and disk checks without giving Diagnostics process-spawn, shell, repair, or sibling-implementation authority. `diagnostics.review` layers bounded FRIDAY-owned logs, failed spans and plugin/runtime evidence over that same Doctor result.
- Extended trusted-channel Voice administration so Chatterbox cloning reference audio can be set or replaced from a validated host path, replaced from one attached audio artifact, or cleared after onboarding. Reference audio is copied into private content-addressed FRIDAY tooling with mode `0600`, and partial updates preserve unrelated STT/TTS/language/voice/compute settings.
- Formalized the router/main-model execution boundary by ownership rather than difficulty: the routing/System model may select typed FRIDAY control-plane actions, parse bounded schedules, and optionally present already-validated system results under a no-new-reasoning prompt; substantive diagnostic interpretation and all ordinary user work continue through the configured main reasoning model. `transient:utility` remains a main-model Agent path rather than a router execution shortcut.
- Hardened remote onboarding state and Voice partial updates: generic state edits can skip/reset optional steps but cannot falsely mark them complete; untouched STT/TTS settings are preserved, `language=auto` clears a fixed language, and a new Chatterbox setup requires an explicit CPU/CUDA choice whenever a usable NVIDIA GPU is detected.
- Updated Doctor credential health to recognize canonical OAuth Vault bundles as well as API-key records, preventing OAuth-only Anthropic/OpenAI-Codex/GitHub-Copilot setups from being reported as missing credentials.
- Added bounded channel diagnostics that combine plugin status, onboarding/runtime state, recent redacted operational logs, failed spans, crashes, and private setup/provisioning outcome records without reading arbitrary host logs or Vault secrets.
- Added permission-gated diagnostic self-repair. Router-only mode may review evidence; source-code repair requires a configured main reasoning model, an originating trusted operator channel, a second explicit code-change approval, the existing isolated worktree/evaluation gates, verified promotion, and durable request resume after handoff.
- Hardened plugin reuse/discoverability repo-wide: every configured ordinary plugin is now architecture-checked for a public typed `contract.ts` surface, each capability/contribution/hook is bound to its exported public type, plugin ids must match their configured directory identities, and direct relative imports into sibling plugin implementations are rejected. Self-improvement now discovers capability services plus contribution/hook extension points and relevance-ranked bounded public APIs from all configured contracts, and incomplete contract discovery fails closed before code placement instead of risking duplicate plugin behavior. Voice no longer reaches into Runtime Settings implementation helpers; Host Doctor now consumes domain observations through ordinary typed capabilities while sharing the same Doctor engine with the CLI adapter; Sandbox exposes separate read-only `sandbox.health` probe/repair metadata so remote Doctor preserves provider-specific health semantics without execution authority.
- Made plugin discoverability self-maintaining from the ordinary contracts instead of relying on a second hand-written exposure list: every `defineCapability`/`defineContribution`/`defineHook` must be an exported contract constant, callable capabilities must be declared in the owner's `provides[]`, exported semantic `*Service`/`*Contribution`/`*Hook` APIs cannot be orphaned from all surfaces, and all exported ordinary contract types (including named type re-exports) are included in the generated/self-improvement inventory. Added machine-readable `npm run inspect:plugins:json` output and parity coverage so CI inspection and self-improvement reuse discovery cannot silently drift apart.
- Extended that discoverability to concrete contribution registrations as well: `inspect:plugins` and self-improvement now derive the owning plugin plus statically declared instance ids directly from actual `ctx.contribute(...)`/bootstrap registrations (for example Agent tools, System actions/status, scheduler actions, lifecycle participants, prompt sections, and finalizers), explicitly count factory/runtime-derived registrations as dynamic, and fail architecture validation on duplicate static ids within the same contribution surface. No secondary contribution-instance registry is required.
- Fixed custom-home state routing for Autonomy and Self-Improvement so their mission/session state consistently follows explicit state dir → `FRIDAY_STATE_DIR` → `FRIDAY_HOME` → `~/.friday` instead of bypassing a configured `FRIDAY_HOME`.
- Fixed GitHub/local MCP self-extension to use the explicitly configured FRIDAY self-improvement source checkout (Runtime Settings or `FRIDAY_SELF_REPOSITORY`) instead of implicitly treating the process working directory as source, so fail-closed contract discovery inspects and modifies the intended generation.
- Hardened the restricted host-privilege broker status check: broker readiness now requires a root-owned regular helper with no group/world write bit plus the matching root-owned `0440` sudoers file; new sudoers fragments use deterministic dot-free names so Linux usernames containing `.` are not silently skipped by `@includedir`, while valid legacy fragments remain recognized; canonical Doctor reports broker mode as unhealthy when integrity checks fail.

### Security

- Remote channel setup never accepts sudo passwords. When host privilege policy is `none`, root-required operations return exact manual host commands instead of invoking sudo. Broker mode can only call the pre-installed fixed helper with `sudo -n`.
- Remote channel credentials use protected capture directly into canonical Vault references and are not forwarded to the router/main model. Configuring a channel never implicitly trusts a new sender; operator trust remains a separate explicit Permissions action.
- Setup/diagnostic logs are private, bounded and secret-redacted. Diagnostics deliberately limits itself to FRIDAY-owned evidence instead of scraping `/var/log`, unrestricted `journalctl`, arbitrary files, or Vault secret values.
- Remote-triggered execution-Python and WhatsApp tooling subprocesses use an allowlisted host environment so model/channel/Vault credentials are not inherited by `uv`, Python/pip, or npm package-manager processes.

## [1.0.2] - 2026-09-08

F.R.I.D.A.Y v1.0.2 hardens OAuth and sandbox execution, makes sandbox backends
provider-neutral, adds MCP-first self-extension discovery, bounded concurrent
multi-agent fan-out/fan-in, and automatically provisioned low-memory local
speech backends.

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

- Added a narrowly scoped privileged setup broker for local voice host
  dependencies. The installed sudoers rule permits only the root-owned
  `friday-privileged voice-deps` operation; no model-facing sudo tool, password,
  arbitrary command, or unrestricted `NOPASSWD` rule is introduced.

- Scrubbed provider/Vault/API-key environment variables from local voice setup
  and inference subprocesses. Local model caches live under private F.R.I.D.A.Y
  tooling and runtime TTS inference is forced into offline Hugging Face /
  Transformers mode after setup preloads the selected model.

- Made Chatterbox acceleration operator-controlled. CPU is now the default and
  installs Torch/Torchaudio from PyTorch's CPU-only wheel index; a detected
  NVIDIA GPU causes setup to ask before any CUDA dependencies are installed.
  CUDA mode is explicit opt-in, uses the matching CUDA wheel index, verifies the
  selected backend, persists it for runtime, and never installs an OS GPU driver.

- Fixed Chatterbox Nano provisioning by pinning the immutable upstream Nano
  implementation revision rather than relying on the PyPI 0.1.7 wheel, which
  does not expose the `nano=True` loader used by Nano. Setup now verifies that
  API before preload and writes its ready marker only after preload succeeds.

- Made Chatterbox dependency provisioning compatible with `uv` retries by
  installing the upstream runtime dependency set explicitly and pinning the
  official Perth watermarking source to an immutable revision. This avoids the
  upstream moving `resemble-perth @ ...@master` transitive URL that `uv` refuses
  to resolve, while preserving the operator-selected CPU/CUDA Torch build.

- Fixed local Whisper verification for WAV probes by converting the source audio
  to a distinct normalized WAV path before invoking FFmpeg. This avoids using the
  same file as both FFmpeg input and output during `friday setup voice`.

### Sandbox providers

- Reduced Chatterbox Nano model provisioning from the upstream ~3 GB snapshot to about ~1.94 GB by pinning the model revision and downloading only the exact files consumed by the Nano loader; the unused 1.06 GB legacy `s3gen.safetensors` checkpoint is no longer fetched.

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

### MCP-first self-extension

- Added official MCP Registry discovery to the MCP service and a bounded
  `mcp_search_registry` tool. Registry metadata is treated as untrusted search
  data and unsafe/non-HTTPS remote endpoints are discarded.

- Changed self-improvement feasibility for external integrations to check
  configured MCP servers first, search the Registry when needed, and inspect a
  candidate server's live tool catalog before any code generation. A model must
  verify that one concrete tool description and input schema supports the exact
  requested operation; category/name similarity alone is not accepted.

- Added fail-closed MCP probing and rollback: temporary remote registrations are
  retained only after exact live capability verification, mismatches are
  removed, package-only metadata is never treated as proof of capability, and
  code generation remains the fallback only when no suitable MCP can be
  verified.

### Multi-agent orchestration

- Added bounded direct-subagent concurrency with queued admission and the
  `FRIDAY_SUBAGENT_MAX_CONCURRENT` operator limit. Independent child agents keep
  isolated sessions while the parent can continue coordinating work.

- Added live RAM-aware subagent admission using host `MemAvailable`/OS memory
  plus cgroup-v2 headroom when present. FRIDAY keeps a conservative host reserve,
  reserves memory for already-running children, queues/retries work under pressure,
  and emits user-visible channel progress when concurrency is constrained or resumes.
  Operators may tune `FRIDAY_SUBAGENT_HOST_RESERVE_MIB` and
  `FRIDAY_SUBAGENT_MEMORY_RESERVE_MIB` without changing the requested team size.

- Added batch `spawnMany` / `wait` primitives and RLM `spawn_many`,
  `wait_subagents`, and `gather` helpers for true concurrent fan-out/fan-in of up
  to 32 child tasks, including cancellation, timeout, persistence, and terminal
  result aggregation.

### Local voice

- Added automated local STT provisioning with three quantized `whisper.cpp`
  choices (`tiny-q5_1`, `base-q5_1`, and `small-q5_1`) and setup guidance for
  approximate RAM, model size, speed, and accuracy. These are OpenAI Whisper
  weights converted/quantized for the `whisper.cpp` runtime, not quantized
  checkpoints published by OpenAI. Model downloads are pinned to a fixed model
  repository revision and verified against per-model SHA-256 digests before use.

- Added automated local TTS provisioning for Chatterbox Nano, KittenTTS Nano
  int8, and Piper. Setup presents approximate runtime-memory guidance plus voice
  cloning and expression capability before installation; Chatterbox Nano
  supports a private staged cloning reference and provider-neutral FRIDAY
  expression intents including laugh/chuckle/sigh, angry/annoyed cues,
  tsundere, gasp/groan and tsk without creating separate emotion voice files.

- Local model assets are downloaded only when selected during `friday setup
  voice`, stored under private F.R.I.D.A.Y tooling, preflighted before settings
  are committed, and require no hosted-provider credential.

- Local voice setup now installs its fixed Debian/Ubuntu host dependency set
  automatically after a local model is selected, bootstrapping the restricted
  privilege broker in the local terminal when needed. Dependency detection now
  uses command-specific probes such as `ffmpeg -version` and checks standard
  system binary paths so an installed FFmpeg is not falsely reported missing.

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
