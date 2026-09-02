# FRIDAY Architecture Contract

## Fundamental Rule

FRIDAY has no permanent application dispatcher, command registry, or god object.

The non-plugin host is deliberately tiny:

1. the optional setup CLI writes non-secret runtime defaults and performs explicit first-run setup;
2. bounded offline maintenance commands back up/restore state and create/restore Vault recovery material while the runtime is stopped;
3. the small runtime-environment helper loads only bounded non-secret defaults and establishes the dedicated writable workspace outside protected state;
4. the runtime entrypoint loads those defaults, enters that workspace before plugin activation, starts configured plugin discovery, waits for process shutdown, and disposes the runtime;
5. the ephemeral bootstrap session imports plugins and exposes only generic symbol-keyed finalizer/disposer/deferred-discovery hooks; and
6. the distribution entrypoint dispatches only these fixed host operations and can extract immutable bundled runtime assets.

Everything functional at runtime is a plugin. The `capabilities` plugin owns the
composition microkernel.

## Host Bootstrap May Only

1. Locate/read bootstrap configuration.
2. Read enough configuration to identify plugin entrypoints.
3. Locate/import those plugin entrypoints.
4. Expose generic symbol-keyed bootstrap finalizer, disposer, and deferred-discovery hooks.
5. Execute those generic hooks without interpreting subsystem semantics.
6. Load non-secret setup defaults and establish the persisted state-disjoint workspace before plugin discovery.
7. Wait for host shutdown signals and dispose the composed runtime.
8. Report startup/shutdown failures.
9. Run fixed, non-extensible stopped-runtime backup/recovery operations and
   package the same entrypoints as a host-native executable.

## Host Bootstrap Must Not Understand

Models, providers, agents, agent loops, tools, execution, interpreters,
model-facing filesystem operations, lifecycle, dependency graphs, capability resolution, permissions,
sandboxing, memory, sessions, context, evaluation, self-improvement,
checkpointing, generations, rollback, scheduling, events, voice, networking,
MCP, projects, skills, subagents, routing, conversational turns, or system
actions.

Those belong to plugins.

## Setup Rule

`friday setup` is a fixed, non-extensible host setup surface, not FRIDAY's runtime
entrypoint. On first run it asks only for the minimum boot configuration: the
main model plus a credential when that provider requires one, the IANA timezone,
and at least one ingress channel with one explicitly confirmed exact operator
identity. `allowAll` transport admission never implies operator authority. Safe
defaults use the main model for routing and `ask` permission mode. Rerunning setup
may collect and persist bounded non-secret runtime defaults and perform explicitly
approved host provisioning such as building the approved local sandbox image or
preflighting optional Voice STT/TTS providers. Setup also persists a dedicated
`FRIDAY_WORKSPACE` outside `FRIDAY_HOME`; the runtime enters it before plugin
activation. Secrets remain Vault-owned.

Setup must not load the runtime plugin graph, expose a dynamic command
registry, dispatch plugin operations, or become a second orchestration surface.
Operational interaction happens through normal plugin contracts after FRIDAY is
running. The `friday` runtime command is a foreground daemon/log process and does
not consume stdin as conversational ingress. Human turns arrive through configured
Channels transports such as Telegram or Discord. There is no conversational CLI
transport; local interactive administration belongs to `friday setup` and
`friday doctor`, not the runtime conversation path.

## Composition Kernel Rule

The `capabilities` plugin owns FRIDAY's composition microkernel: declarative
plugin manifests, service dependency resolution, contribution registries, hooks,
plugin-scoped effects, graph-ready callbacks, disposal, and activation ordering.

`friday.config.json` selects installed plugin entrypoints; except for loading the
composition plugin first, list position must not encode functional dependencies.
Behavioral plugins declare dependencies through capability contracts and consume
those services through their plugin-scoped activation context. Runtime helpers
receive dependencies by injection rather than reaching into a global service locator.

Adding an implementation of an existing extension point must not require editing
host bootstrap, a central application plugin, or unrelated consumers.

### Plugin Admission Test

Before creating a new plugin, answer all four questions:

1. **Independent responsibility:** does this feature own a coherent runtime domain rather than merely styling, configuring, or extending an existing owner?
2. **Independent lifecycle/state:** does it own resources, durable state, workers, transports, or cleanup whose lifecycle is meaningfully independent?
3. **Capability boundary:** does another plugin need to consume a stable typed capability from it, rather than a normal contribution or helper owned by an existing plugin?
4. **No cleaner existing owner:** would placing it under the obvious existing plugin create an actual dependency/coupling violation rather than simply extending that plugin's responsibility?

A new plugin is justified only when the answers establish a real ownership boundary.
If a feature is configuration plus an existing extension-point contribution, keep it
under the existing owner. Persona configuration, for example, belongs to
`runtime-settings` and contributes prompt/tool behavior through Turn Loop's generic
extension seams; it is not an independently loaded `personas` plugin.

A cross-plugin utility does **not** become a plugin merely because many plugins
use it. Utility packages own dependency-free mechanics, not runtime domains or
lifecycles. `@friday/operational-errors` therefore lives under
`packages/operational-errors`: callers can emit redacted fallback-safe failure
events before or after the plugin graph exists, while the `observability` plugin
owns the active telemetry sink, logs, and metrics. Audit remains reserved for
security/authority history and must not absorb ordinary operational failures.

### Workspace and Distribution Discovery Rule

Repository layout must not be duplicated as a central package registry. npm
workspaces are selected by bounded layout patterns (`packages/*` and
`plugins/*/runtime`), while `scripts/workspace-packages.mjs` discovers concrete
packages from those patterns and orders build/test execution by local workspace
dependencies. Adding, removing, or moving a normal workspace inside those
supported ownership roots must not require editing root build/test command lists
or CI package-name lists.

Runtime files that cannot be bundled as ordinary JavaScript (for example a
Containerfile, Python bridge, or helper package) are declared by the owning
subsystem in `friday.binary-assets.json`. Each declaration maps an owner-relative
source path to a stable logical bundled target. `scripts/build-binary.mjs`
discovers those manifests; it must not contain plugin-internal asset paths. CI
must invoke repository scripts such as `npm run verify` and
`npm run build:sandbox-image` instead of naming plugin-internal paths directly.
Moving an asset therefore changes its owner declaration, not the central binary
builder or CI workflow. Native third-party addons that are selected from
`node_modules` remain distribution-layer exceptions because FRIDAY does not own
their package layout.

Long-lived workers/transports are plugin-lifecycle owned. They register generic
`afterReady` work so external ingress or durable consumers begin only after the
complete configured graph is activated, plus reversible cleanup with the kernel.
Graph-ready failures fail bootstrap and roll the graph back. The last-stage
self-improvement readiness acknowledgement runs after those normal-plugin startup
callbacks, so successor readiness still means the usable graph came up. Host
bootstrap must not know how to start or stop any subsystem.

## Behavioral Composition Rule

The composition kernel connects plugin dependencies; it does not own FRIDAY's
conversation workflow. The ordinary `turn-loop` plugin owns the outer admission
lifecycle of one normalized human turn: trusted identity context, Routing,
executor selection, reply delivery, and bounded outcome Events. It serializes
one external conversation through routing/admission so contextual route inputs
cannot race. When the optional `session-jobs` capability is installed, persistent
Agent work is durably admitted and acknowledged there, then Session Jobs owns the
detached execution lifecycle and per-persistent-session serialization. Different
sessions may execute concurrently; two jobs targeting the same session may not.
Without Session Jobs, Turn Loop retains its synchronous persistent-session
serialization fallback. The Agent plugin still owns the inner model/tool loop.

Conversational ingress adapters publish the generic `turn.ingress` hook. They do
not import Routing, Sessions, Agent, Memory, or a concrete Turn Loop
implementation. Execution behavior is selected from `turn.executor`
contributions. Therefore a new transport such as Voice can publish the existing
ingress contract, and a new execution profile can contribute an executor,
without editing Turn Loop, host bootstrap, or unrelated plugins.

Attachment intake remains Artifacts-owned. Optional processors such as Voice STT contribute through the generic `artifact.input-enrichment` seam after Artifacts has persisted the attachment, so a transport does not download the same media twice and Turn Loop does not acquire media-specific branches. Enrichment output is bounded host context over untrusted user content and may be persisted with the Session to avoid repeating external processing after restart.

Routing owns WHERE/HOW classification only. Turn Loop must not embed
Scheduler/System policy or transport-specific branches.

Scheduler and System execution profiles are ordinary `turn.executor`
contributions. Scheduler owns the scheduler executor and resolves durable work
through generic `scheduler.action` contributions; it must not import channel
transport implementations. Security-sensitive scheduled payload fields are
materialized by the contributing owner from host-owned Turn context rather than
accepted from model output. Scheduled execution runs under a trusted Scheduler
system principal, while creation/cancellation/removal and future side effects
remain explicit Permissions actions.

The System executor is a replaceable action dispatcher over generic
`system.action` and `system.status` contributions. It must not import the
implementations whose actions/status it exposes. Mutating system actions carry
host-owned permission metadata and remain implemented by their owning plugin.
System must never become a generic shell/CLI bridge or host-bootstrap proxy.

A declarative plugin may be contribution-only when its complete public role is
a typed multi-provider extension. A singleton capability is not required merely
to satisfy plugin shape.

Model-facing capability extensions publish the generic `agent.tool` contribution
rather than teaching Turn Loop about plugin identities. Turn Loop dynamically
collects those contributions at the Agent boundary. The contributing plugin
retains ownership of its own authorization, secrets, transport, and side-effect
policy. Adding an implementation of an existing Agent-tool extension point must
not require a Turn Loop edit.


## Detached Session Job Rule

A persistent Session is long-lived conversation/project context. A Session Job is
a bounded execution record for work currently queued or running in that context.
They must not be conflated or duplicated. Sessions remains the authoritative
transcript/compaction owner; Session Jobs stores only job lifecycle metadata and
explicit user-visible progress/retry records.

A background job must be persisted before FRIDAY tells the user it started. Work
for different persistent sessions may run concurrently. Work for one persistent
session is serialized. A `session:new` execution must bind its concrete Session ID
back into the active job queue as soon as the persistent Agent runtime exists, so
a contextual follow-up cannot race the first turn in the newly created session.

The originating channel receives an immediate admission acknowledgement, bounded
meaningful progress/retry updates, and a terminal success or failure report.
Progress is public operational commentary (phase/tool/retry status), never raw
chain-of-thought. Transcript queries may show user prompts, assistant text and
those public progress entries while omitting hidden reasoning.

Natural-language cancellation resolves only active jobs. Ambiguous selectors must
be disambiguated through the exact protected channel interaction, then the chosen
job requires an exact bound approval before its AbortSignal is triggered. Cancelling
a job never deletes its Session/history. Current-work, cancellation and transcript
queries are owner-contributed `system.action`/`system.status` operations rather
than special Turn Loop commands.

Transient model/provider failures are retried at the model-request boundary, not
by replaying the whole Agent job. Retry classification follows the proven OpenCode
session retry policy: retry rate limits, provider overload/server errors and
network/timeout failures; honor provider `Retry-After` hints; otherwise use
jittered exponential backoff with a bounded delay. Context-window errors and
ordinary non-retryable client failures fail immediately. FRIDAY permits up to ten
retries per model request. Because retries occur before a successful assistant
turn reaches tool execution, previously completed mutating tools are never blindly
replayed by this policy.

## Protected Interaction Rule

Approvals, secret values, protected setup prompts, and cancellation replies are
intercepted by the trusted channel boundary before `turn.ingress`. They are
matched to exact channel/account/conversation/sender/thread state and are never
interpreted by Routing or an LLM. Secret capture must be field-specific, may
validate before Vault mutation, and must not return plaintext into the normal
turn path. Cancellation is checked before other protected interactions. Native
provider actions and strict text fallbacks share the same one-shot state, which is
privately persisted as bounded restart/replay tombstones so stale responses fail
closed rather than becoming ordinary turns.

## Runtime Configuration Rule

Runtime settings are typed plugin-owned operations, not arbitrary environment
file edits. Main model, optional dedicated Routing model, permission mode and
custom model metadata may be changed only through validated configuration APIs.
Restart-required changes use the Lifecycle successor/takeover handshake and
restore the prior settings on failed startup. The predecessor exits only after
the initiating reply is delivered. Secrets remain Vault-owned.

## Artifact and Self-Extension Rule

Channel attachments and user-supplied package URLs enter through the generic
Artifacts safety boundary. Package download/extraction must be sandboxed,
bounded, traversal/symlink safe, integrity checked and disposable. Skills/MCP
own validation and installation semantics after intake.

When an explicitly requested software capability is missing, FRIDAY must assess
feasibility before claiming it can build the feature. Only a feasible result may
produce the short user notice, request authorization, and enter Self-Improvement.
A promoted successor must resume the durable original request after verification
and takeover. Infeasible or denied requests must not create a candidate.

## Cache-Stability Rule

Stable system instructions/tool schemas/skill descriptions should remain a
predictable prefix. Per-session path/depth/parent metadata and volatile Memory
remain after that stable prefix or are injected ephemerally for the current model
call rather than persisted as fake transcript. Prompts may publish stable-prefix
metadata, but Model alone lowers it into provider-native cache breakpoints. The
canonical Agent/session representation remains one system-prompt string. Model
records content-free request duration, time-to-first-output, cache semantics and
cache read/write usage; Observability may derive bounded metrics from those events.

## Operational Alert Rule

Raw Audit/Observability records are queried on demand through their owner
actions, with a conversational default of 10 and bounded explicit limits.
Proactive channel alerts use a separate Events-metadata subscription capability;
they must not forward raw log streams or Event payload data by default.

## Unattended Network Availability Rule

Detached sandbox executions and persistent kernels have outbound network access
by default. The runtime must not silently convert ordinary tool metadata into a
network-off container or apply a default destination allowlist. An explicit
host caller may request network-disabled isolation, but the default for
unattended work remains unrestricted egress.

This availability guarantee does not bypass Permissions for the requested
action or credential consumption. Rootless isolation, narrow authorized mounts,
resource/PID/file ceilings, a read-only container root, dropped capabilities and
a pinned locally built image remain mandatory.

## Relevant Memory Rule

Memory may represent explicit preferences and recurring habits as normalized
subject/relation/object records with confidence, frequency and timestamps. The
Agent receives only bounded query-relevant results for the current turn, never a
full graph dump. Secret-shaped relationship keys fail closed. Preference writes
and deletion remain explicit, permission-gated operations.

## Operational Failure and Usage Rule

Audit and Observability have separate obligations. Audit is the durable,
tamper-evident authority/decision ledger. Observability owns bounded operational
logs, metrics, traces and model usage. A best-effort subsystem may avoid changing
the business result when telemetry fails, but it must report the failure through
the redacting operational-error sink; a safe stderr fallback is mandatory before
Observability starts or if its sink fails. No operational rejection may be
silently swallowed.

Model usage retains provider response values for input, output, cache read/cache
write, provider-reported cost and currency, attributed by session, root/parent
agent and detached job. Provider-reported cost is actual data. Any catalog-based
calculation is stored and presented separately as an estimate and must never be
labelled as provider billing.

## Recovery and Distribution Rule

A normal runtime holds a private process lease. Stopped-runtime backup/restore
must refuse while a live lease exists, hash every regular file, reject symlinks,
and restore through verified atomic staging. Vault recovery exports only a
passphrase-encrypted master-key kit and must authenticate current records before
installing a replacement key.

The supported single-file distribution is a host-native Node SEA executable
built separately per platform/architecture. It embeds code, native bindings and
immutable runtime assets. Privileged host facilities such as Podman and optional
integration runtimes remain explicit prerequisites rather than being silently
installed by the executable.

## Replaceability Rule

If functionality can be removed while the minimal host can still load and
dispose the Plugin Kernel, that functionality belongs in a plugin.

## Operational Control Rule

There is no permanent runtime CLI command registry. Explicit operator/runtime
operations are exposed by their owning plugins through typed capabilities and,
when conversational control is appropriate, bounded `system.action` /
`system.status` contributions. System is only a selector/authorization boundary;
it is not the owner of those operations.

## Self-Hosting Rule

Generated changes must pass configured tests/evaluations before promotion.

Evaluation, candidate management, checkpointing, promotion, rollback, and
generation handoff are themselves plugin-provided. Self-improvement's successor
process uses private restart metadata flags; those flags are process handoff
protocol, not public CLI commands.

## Stability Rule

The host bootstrap/setup contract should change extremely rarely.
Self-development should modify plugins unless the generic bootstrap protocol
itself is insufficient.
