# F.R.I.D.A.Y Roadmap

This roadmap defines the target platform and an implementation sequence. It is a planning document, not a promise of release dates. The guiding goal is **one self-hosted F.R.I.D.A.Y brain with persistent named teammates, shared computers, desktop and Android clients, and durable work that continues across devices and restarts**.

## Current foundation

F.R.I.D.A.Y already provides the core runtime: Turn Loop, Sessions, Session Jobs, Memory, Scheduler, Tools, Sandbox, Permissions, Vault, Events, Artifacts, Skills, MCP, Subagents, observability, and verified self-improvement. These remain authoritative. New features must compose them instead of creating duplicate agents, queues, memory stores, permission systems, or file systems.

Current release: **v1.0.3** — discoverability, remote administration, and safer self-improvement boundaries. See [`CHANGELOG.md`](../CHANGELOG.md).

## Near-term release: v1.0.4

The next release remains focused on Memory correctness and contributor ergonomics before the larger product phases begin.

Memory work includes atomic relation correction, true patch semantics when fields are omitted, separate embedding maintenance/backfill from read-only recall, clearer relation identity versus provenance semantics, stronger protection against credential-like persistence, and safer project-document ingestion with less absolute-path exposure.

Contributor work includes a plugin cookbook with complete examples, a plugin scaffold command, more channel/provider integrations behind typed boundaries, additional sandbox providers, setup/troubleshooting documentation, and focused WSL2/Linux/macOS testing.

## Longer-term hardening

These items should be scheduled alongside the relevant phases rather than added opportunistically:

- build provenance proving that the running binary matches the configured self-improvement source checkout;
- richer capability-quality and evaluation signals for reuse and self-improvement decisions;
- plugin registry UX with explicit trust and verification boundaries;
- platform hardening before native Windows execution is considered a supported security boundary.

## Target architecture

```text
Internet → Caddy/TLS → Client Gateway (HTTPS/WSS/WebRTC)
                              │
             ┌────────────────┼────────────────┐
             │                │                │
          Desktop          Android       Computer Nodes
             └────────────────┼────────────────┘
                              │
                         F.R.I.D.A.Y Core
                              │
               Sandbox / Agent Computer / Project Path
```

There is one brain, many clients, many Agent Profiles, and potentially many machines. Clients are presentation and control surfaces; Sessions and Session Jobs remain the source of truth.

## Ownership map

| Capability | Authority |
|---|---|
| Reasoning | Agent and existing Turn Loop |
| Transcript | Sessions |
| Durable background work | Session Jobs |
| Persistent teammate | Agent Profiles |
| Temporary worker | Subagents |
| User/project memory | Memory scopes |
| Scheduling engine | Scheduler |
| Workflow metadata | Routines |
| Operational signals | Events |
| Results and attachments | Artifacts |
| Permission decision | Permissions |
| Review rules | Review Policy |
| Credentials | Vault |
| External tools | Tools and MCP |
| Project identity and routing | Projects |
| Files, GUI, browser, displays | Computer Nodes |
| Client/device identity | Clients and Devices |
| Groups, threads, reactions, read state | Conversations |
| Full-text discovery | Search |

## Phased delivery plan

### Phase 0 — Memory and ecosystem quality (completed foundation)

Before broad expansion, improve relation correction atomicity, patch semantics, embedding maintenance, retrieval quality, credential-like persistence guards, filesystem race handling, plugin cookbook examples, scaffolding, provider integrations, and platform tests. Run `npm run inspect:plugins`, `npm run check:architecture`, `npx tsc --noEmit`, and `npm run verify` for every release.

Contributor-sized work is tracked through [good first issue](https://github.com/saravanaspar/F.R.I.D.A.Y/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22) and [help wanted](https://github.com/saravanaspar/F.R.I.D.A.Y/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22) issues.

### Phase 1 — Client protocol, gateway, and devices

Tracking: [pull request #18](https://github.com/saravanaspar/F.R.I.D.A.Y/pull/18).

Add `plugins/clients`, `plugins/devices`, and `packages/client-protocol`.

Status: **implemented on `feat/phase-1-client-foundation`**. The repository now has versioned protocol encoding/validation, persistent device pairing with Ed25519 challenge authentication, revocation and last-seen tracking, an event-backed gateway connection with replay/resume, a loopback HTTP API, authenticated WebSocket streaming, and WebRTC signaling relay. TLS termination remains a deployment concern; see [`docs/CLIENT_GATEWAY.md`](CLIENT_GATEWAY.md).

- HTTPS: pairing, history, search, settings, uploads/downloads, Agent Profiles, Projects, Routines, and artifacts.
- WSS: message streaming, job progress, approvals, questions, presence, attention state, and replayable synchronization.
- WebRTC signaling: voice, computer video, and computer control.
- Device records: device ID, type, public key, paired/last-seen/revoked timestamps.
- Pairing: QR or one-time challenge, device-generated key, explicit host approval, revocation, and no permanent master key in apps.
- Durable events carry monotonically increasing sequences; clients resume from `lastSeenSequence` after reconnect.
- Caddy terminates TLS. Internal Vault, databases, shell, Scheduler internals, and Agent APIs are never public endpoints.

Acceptance: two independent test clients connect, resume after disconnect, and observe the same existing Session and Session Job without duplicating runtime state.

### Phase 2 — Persistent Agent Profiles and Conversations

Tracking: [issue #27](https://github.com/saravanaspar/F.R.I.D.A.Y/issues/27).

Status: **complete**. The phase now persists Agent Profiles and Conversation metadata, restores both across restart, selects profiles in the Turn Loop, renders profile identity, enforces authorized Memory namespaces, records Threads/Reactions/read state, resolves Agent mentions, routes visible handoffs through existing Session Jobs, applies durable JobDirectives through the Agent steering boundary, and exposes authenticated client APIs for profile/conversation operations and profile-targeted turns.

Add `plugins/agent-profiles` and `plugins/conversations` over existing runtime services.

`AgentProfile` includes name, title, description, avatar, role instructions, default conversation, memory scope, enabled Skills/plugins, default Project or Computer screen, notifications, approval policy, and timestamps. An Agent Profile is a persistent teammate; a Subagent remains a bounded temporary worker.

Add direct and group Conversations with participants (user and Agent Profiles), titles, pinned/hidden state, notification settings, read sequence, mentions (`@Developer`, `@everyone`), Threads, Reactions, and visible Agent-to-Agent handoffs. Handoffs create durable Session Jobs and appear in the group transcript. Add `JobDirective` so a user can redirect running work at a safe continuation boundary without creating a second orchestration queue.

Add memory scopes such as `global:user`, `agent:developer`, and `project:atlas`; compose only the scopes authorized for the current Agent and Project.

Acceptance: create Developer and Research profiles, give them separate conversations and memory scopes, mention either from a group, and observe a durable visible handoff backed by the existing Turn Loop and Session Jobs.

Implementation notes: profile selection is host-owned on `InboundTurn`; untrusted channel text is resolved only after durable ingress against authorized Conversation participants. Shared group/channel surfaces are automatically bound to internal Conversations for common continuity, and any external chat/topic can also be durably bound explicitly, with deterministic selection precedence of explicit `@Agent` mention, sticky `/agent <profile>`, optional `/agent auto`, and general F.R.I.D.A.Y fallback. Shared Conversation continuity uses the Conversation-owned Session while preserving each sender's principal scope for authorization, approvals, and private Memory. Multi-Agent mentions and `@everyone` use bounded Session Jobs and visible handoff records; collaborator findings return to the primary Agent for a single synthesized answer instead of racing the same Session. Channel metadata needed for Threads and reply mapping survives ingress. Agent Profile Skill/plugin allowlists, approval policy, notification preference, default Project memory scope, and compatible Computer-screen defaults are enforced at runtime. Client Conversation turns use Conversation session affinity only after normal Router intent selection, so Scheduler/System/transient routing remains consistent with Channels. Memory keeps the existing SQLite store and `global`/`local` storage semantics while namespacing Agent and Project scopes under the owner root. JobDirectives are stored by Session Jobs and delivered through the Agent runtime's existing steering queue after the current tool boundary. The Client Gateway remains the authenticated protocol surface; desktop and Android clients consume these APIs in later phases. Channel/profile integration acceptance coverage lives in `test/agent-profiles-conversations.test.ts` and `test/channels.test.ts`, routing invariants in `test/turn-loop.test.ts`, and profile runtime-policy coverage in `test/turn-loop-agent.test.ts`.

### Phase 3 — Projects and Execution Targets

Tracking: [issue #21](https://github.com/saravanaspar/F.R.I.D.A.Y/issues/21).

Status: **complete**. Project records persist canonical server-owned roots, validation commands, repository metadata, preferred Computer Node identity, and fail-closed execution policy. `@friday/execution-targets` resolves provider-neutral Sandbox/Core Host/Computer Node targets; Turn Loop resolves each Project-aware Agent job to a stable workspace and target before tool construction; existing shell, edit, process, and IPython tools execute against Sandbox or explicitly allowed Core Host targets without duplicating an executor. Write-oriented coding jobs receive deterministic isolated Git worktrees that are reused after restart, publish trusted full diffs as Artifacts, and can commit and promote clean candidate history by authorized fast-forward merge or cherry-pick. Client turns may select a Project/target directly or inherit an Agent Profile default, while detached Session Jobs preserve Project context across client disconnect/restart. Actual Computer Node execution remains Phase 4 because that machine-control authority does not exist until the Computer capability is introduced.

Add `plugins/projects` and `packages/execution-targets`.

A Project records identity, root path, preferred Computer Node, repository metadata, and policy. An `ExecutionTarget` routes existing shell, edit, process, and Git tools to Sandbox, Core Host, or Computer Node. Coding jobs use job-specific Git worktrees, run tests/builds, expose diffs and artifacts, and merge/cherry-pick only after authorization.

A request from Android or desktop resolves the Project and target on the server; no client copies the canonical repository implicitly.

Acceptance: an Android request selects a Project on a local PC, creates an isolated worktree, edits/tests code, returns a diff, and survives client closure.

### Phase 4 — Shared Agent Computer

Tracking: [issue #22](https://github.com/saravanaspar/F.R.I.D.A.Y/issues/22).

Status: **complete**. The provider-neutral Computer core defines `ComputerNodeAdapter`, resource admission with `WAITING_FOR_COMPUTER`, expiring `ScreenLease` and generation-bound `ControlLease` records, Browser Supervisor ownership/readiness invariants and action fallback ordering, secret-safe human takeover, automatic/manual hand-back with mandatory re-observation, and guarded provider lifecycle operations. Phase 3 `computer:<node-id>` targets execute through the Computer capability: Projects select the target, Turn Loop leases the matching Agent screen, and existing bash/edit/process/IPython tools dispatch through the provider under their existing Permissions checks and a refreshed current control generation. Session Jobs persist a first-class `waiting-for-computer` active state with bounded node/reason context before Computer admission blocks, restore that wait metadata through restart reconstruction, and return to `running` when a screen is granted. The Computer plugin contributes permission-gated `computer_observe`/`computer_browser` Agent tools for the active leased screen, and authenticated Client Gateway APIs expose bounded status/node/screen/lease state plus observation and device-bound human takeover/activity/hand-back. Human takeover now pauses interrupted Agent Computer work without replaying it; hand-back records a fresh observation and wakes the same job/tool context at the new generation. The provider-neutral login-wall acceptance test covers secret-safe takeover, fresh signed-in re-observation, same-Session-Job continuation, and no stale GUI replay. Repository verification now passes for the provider-neutral Phase 4 implementation; Linux/Sway and Windows platform implementations remain in Phases 5 and 8.

Add `plugins/computer` with `ComputerNode`, `ScreenLease`, `ControlLease`, Browser Supervisor, resource admission, status/doctor, update, restart, and managed reset operations.

A Computer Node is shared by the user and Agents: one OS user, home directory, files, downloads, applications, and persistent browser profile. Each Agent receives a separate leased screen. Admission considers RAM, CPU, browser renderer count, GPU, and screen workload; overloaded work waits as `WAITING_FOR_COMPUTER` and resumes automatically.

The Browser Supervisor owns one persistent Chromium instance/profile and context. Windows are assigned to Human, Developer, Research, or F.R.I.D.A.Y. Automation priority is API/MCP, Playwright DOM, accessibility tree, CDP, then visual control.

Human takeover is a first-class lease. Agent input pauses while the user controls a screen; passwords, OTPs, CAPTCHAs, keystrokes, and sensitive screenshots are excluded from model-visible transcripts. On hand-back, pending GUI actions are invalidated, current URL/DOM/tabs/accessibility tree/screenshots/processes are re-observed, and the Agent replans rather than replaying stale clicks. Default hand-back is eight seconds of inactivity, configurable from five seconds to manual-only.

Acceptance: an Agent reaches a login wall, the user takes over, signs in without secret capture, stops interacting, and the same Session Job continues after fresh observation.

### Phase 5 — Linux and Raspberry Pi implementation

Tracking: [issue #22](https://github.com/saravanaspar/F.R.I.D.A.Y/issues/22).

Linux is the first-class Computer Node implementation.

- Debian-family Linux/Raspberry Pi OS, systemd user services, Sway/wlroots, Wayland virtual inputs, Chromium, Playwright/CDP, AT-SPI, PipeWire, and WebRTC screen streaming.
- Physical output is the human screen; headless outputs are leased to Agents with independent seats.
- Managed session is recommended for exact shared-screen behavior. GNOME/KDE/XFCE compatibility mode runs a separate headless Agent session.
- Raspberry Pi 4 uses no VM, KVM, or container per Agent. F.R.I.D.A.Y Core, Sway, Chromium, and screens run on the host; a USB SSD is recommended for browser state and workspace.
- Keep protected state separate from the writable workspace and do not run the Agent Computer as root.

Acceptance: a Pi user works on the physical monitor while two Agents browse independently with shared filesystem and browser login state.

### Phase 6 — Desktop client

Tracking: [issue #19](https://github.com/saravanaspar/F.R.I.D.A.Y/issues/19).

Start only after Phases 1–4 stabilize. Build `apps/desktop` with Electron, React, TypeScript, Vite, Zustand, TanStack Query, SQLite cache, OS credential storage, xterm.js, Monaco, native notifications, WebRTC voice/video, and the shared protocol.

Provide Agents, Groups, Conversations, Threads, Projects, Routines, Skills, Plugins, Files, Computer, Approvals, Jobs, Search, Usage, and Settings. The three-pane layout includes Agent/group navigation, streaming conversation with tool activity/diffs/approvals/artifacts, and an Activity/Computer/Files/Terminal/Diff panel. Add command palette, deep links, offline cache, reconnect, and desktop updater/recovery.

Acceptance: desktop replaces normal messaging-channel use for chat, streaming, background jobs, approvals, artifacts, project work, and computer takeover.

### Phase 7 — Android voice-first client

Tracking: [issue #20](https://github.com/saravanaspar/F.R.I.D.A.Y/issues/20).

Start after the gateway and desktop protocol are stable. Build `apps/android` with Kotlin, Jetpack Compose, ViewModel/Flow, Hilt, Retrofit/OkHttp, kotlinx.serialization, Room, Android Keystore, FCM, CameraX, Storage Access Framework, WorkManager, and WebRTC.

Screens: Voice, Chats, Agents, Groups, Tasks, Attention, Computer, Projects, Routines, Search, Files, Plugins, Settings. Support tap-to-talk, push-to-talk, conversation mode, barge-in, streaming STT/TTS, push notifications with minimal event IDs, approval actions, artifact viewing, computer screen viewing, touch takeover, and keyboard input. Work continues server-side when the app closes.

Acceptance: user speaks from Android, a local Computer Node performs Project work, the user receives progress/approval/result notifications, and can take over the live screen.

### Phase 8 — Windows Computer Node

Tracking: [issue #22](https://github.com/saravanaspar/F.R.I.D.A.Y/issues/22).

Keep F.R.I.D.A.Y Core in WSL2. Add a native per-user `friday-computer-node.exe` (Rust or C++) for display APIs, screen capture, Win32/COM, UI Automation, process/window metadata, and native input. The Electron desktop remains separate.

Use a dedicated F.R.I.D.A.Y browser profile rather than locking the user’s personal Chrome profile. Support CDP/Playwright, Windows UI Automation, and an optional Indirect Display Driver for virtual Agent monitors. `RawInputLease` serializes global pointer/keyboard injection because foreground interactive desktop constraints prevent unlimited arbitrary native GUI parallelism. Offer Native Windows mode and WSL2 Linux Computer mode for stronger multi-seat concurrency.

Acceptance: browser, shell, files, Git, UI Automation, and virtual-screen work run in parallel while raw visual input is safely serialized.

### Phase 9 — Routines and event automation

Tracking: [issue #23](https://github.com/saravanaspar/F.R.I.D.A.Y/issues/23).

Add `plugins/routines` as product metadata over Scheduler and Events. A Routine stores Agent Profile, instruction/Skill, trigger, Project/Computer target, approval policy, enabled state, and run history. Support create, edit, test, pause, resume, run now, next-run display, and history on desktop and Android. Existing Events trigger Routines, which create normal Turn Loop/Session Jobs.

Acceptance: scheduled and event-triggered routines run in the configured timezone, show history, respect approvals, and resume after restart.

### Phase 10 — Review Policy and safety controls

Tracking: [issue #24](https://github.com/saravanaspar/F.R.I.D.A.Y/issues/24).

Add `plugins/review-policy` before existing Permissions. Rules classify actions as Allow, Require Approval, or Deny; an optional independent review model can recommend a decision, while Permissions remains authoritative. Examples include approval for external email or `production/**` writes and automatic allowance for read-only Project operations. Reactions never constitute security approval.

Acceptance: policy decisions are explainable, persisted, auditable, and cannot bypass Vault or Permissions.

### Phase 11 — Search, artifacts, and plugin UX

Tracking: [issue #25](https://github.com/saravanaspar/F.R.I.D.A.Y/issues/25).

Add `plugins/search` over Agents, Groups, Sessions, Messages, Projects, Files, Artifacts, Skills, and Routines using SQLite FTS initially. Desktop command palette is `Ctrl/Cmd+K`; Android has global Search.

Extend existing Artifacts with rich cards for documents, spreadsheets, images, code, archives, links, screenshots, reports, and diffs with Preview, Save, Open Source, and source metadata. Add MCP Marketplace/Yours UX for install/remove/login/logout, tool enablement, and per-Agent enablement without changing MCP ownership.

Acceptance: users can find prior work, inspect a result, and configure an integration without accessing internal plugin implementations.

### Phase 12 — Teach, share, and lifecycle polish

Tracking: [issue #26](https://github.com/saravanaspar/F.R.I.D.A.Y/issues/26).

Teach-by-demonstration records semantic browser/UI actions during a takeover, omits secret values, drafts a Skill, tests it, and allows save/schedule. Agent duplicate/share exports sanitized `AgentProfileTemplate` data without conversations, memory history, Vault references, browser credentials, or private paths. Computer update/reset affects managed Agent state and never silently resets a person’s operating system; dedicated VMs may support full rebuilds. Add usage UI, deep links, offline recovery, health diagnostics, and migration tooling.

## Phase planning matrix

| Phase | New plugin domains | Extend/reuse | Depends on | Recommended vertical slice | Exit criteria |
|---:|---|---|---|---|---|
| 0 | None | Memory, plugin tooling, Doctor | Current v1 runtime | Fix one Memory mutation path end-to-end, then add regression coverage | Completed in the v1.0.4 memory work; invariants and repository gates pass |
| 1 | `clients`, `devices` | Events, Sessions, Vault, existing auth | Stable event identity and redaction | Pair one desktop/test client, stream one Session, reconnect from a sequence | Pair/revoke/replay works and private APIs stay private |
| 2 | `agent-profiles`, `conversations` | Agent, Turn Loop, Sessions, Jobs, Memory | Phase 1 identity | Create one profile, send one turn, persist one group handoff | Profile/group state survives restart and scopes are enforced |
| 3 | `projects` | Tools, Git, Sandbox, Permissions | Phase 1 identity; Phase 2 profile | Resolve one project, run one tool through one target, return one diff | Worktree and path policy are enforced server-side |
| 4 | `computer` | Tools, Events, Permissions, Vault, Subagents | Phase 2 profile and Phase 3 targets | Register one node, lease one screen, automate one browser task, take over once | Lease expiry, redaction, re-observation, and admission are tested |
| 5 | None | `computer` Linux provider, Doctor, deployment | Phase 4 provider contract | Run one managed Sway session with human plus one headless Agent output | Pi/Linux smoke test passes with shared browser/files |
| 6 | None | `clients`, protocol, Artifacts, Jobs, Events | Phases 1–4 contracts | Desktop chat → job → approval → artifact → computer panel | Desktop is usable without a messaging-channel fallback |
| 7 | None | Voice, Events, Artifacts, Computer | Phase 1 protocol; Phase 6 schemas | Android voice turn → push event → artifact/computer view | App closure does not stop server-side work |
| 8 | None | `computer` Windows provider, Projects, Tools | Phase 4 provider contract; WSL2 | Browser/CDP task plus UIA task on a Windows node | Raw input is serialized and Windows security boundaries are documented |
| 9 | `routines` | Scheduler, Events, Jobs, Agent Profiles | Phase 2 profiles; Phase 1 events | Create, run-now, pause, and resume one routine | Scheduled/event runs have durable history and timezone correctness |
| 10 | `review-policy` | Permissions, Vault, Events | Phase 3 targets; Phase 9 routines | Evaluate one write as Allow, Approval, and Deny | No policy path bypasses Permissions; decisions are explainable |
| 11 | `search` | Sessions, Artifacts, MCP, Events | Durable IDs from Phases 1–3 | Index one message and artifact; open from command palette | Results are permission-filtered and link to source records |
| 12 | None | Skills, Computer, Agent Profiles, Doctor | Stable takeover trace and profile schemas | Record one safe workflow, draft one Skill, export one profile template | Secrets are excluded and lifecycle recovery is documented |

For every phase, build persistence and server capability before client polish. If a phase cannot demonstrate restart, authorization, redaction, and failure recovery in its vertical slice, it is not ready to be marked complete.

## Plugin boundary and implementation decisions

The following rules prevent the roadmap from turning into a collection of overlapping subsystems.

### New plugins to create

Create a plugin only when a feature has its own durable state, trust boundary, lifecycle, operational ownership, or independently consumable capability. A UI screen, protocol type, provider adapter, deployment file, or small helper is not automatically a plugin.

| Plugin | Owns | Why it deserves a boundary | Recommended implementation |
|---|---|---|---|
| `clients` | Client Gateway API, WSS sessions, WebRTC signaling, sync subscriptions | Network-facing product access has a distinct authentication and rate-limit boundary | Keep handlers thin; call typed core capabilities; never expose internal plugin routes directly |
| `devices` | Device identity, public keys, pairing, revocation, last-seen state | Device trust is separate from user/channel identity and must be auditable | Challenge-response pairing, OS keystore storage, short-lived access tokens, event-driven revocation |
| `agent-profiles` | Persistent named teammates and profile configuration | A durable teammate has lifecycle and memory policy distinct from temporary Subagents | Persist profile metadata; invoke the existing Turn Loop with profile instructions and authorized scopes |
| `conversations` | Direct/group metadata, participants, mentions, Threads, Reactions, read/unread, pin/hide | These are product collaboration records over Sessions, not another transcript engine | Store metadata and references to Session message IDs; use Session sequence numbers for reads |
| `projects` | Project identity, root paths, repository metadata, target policy | Project routing must be consistent across clients and execution providers | Resolve project server-side; validate paths; bind policy and preferred Computer Node |
| `computer` | Computer Nodes, screens, browser supervisor, takeover leases, admission, lifecycle | GUI/display/browser control is a machine trust boundary with platform-specific providers | Define provider interfaces; keep Linux and Windows implementations behind the same contract |
| `routines` | Routine definitions, trigger metadata, run history, pause/test UX | Scheduler executes time; Routines describe user-facing repeatable work | Persist definitions; compile triggers to existing Scheduler and Events; create ordinary Session Jobs |
| `review-policy` | Allow/approval/deny rules and optional independent review | Review policy is policy composition, while Permissions remains the final authority | Evaluate before Permissions; produce explainable decisions; fail closed on ambiguity |
| `search` | Cross-domain indexing and query facade | Search spans Sessions, files, Agents, Projects, and artifacts and should not own any source data | SQLite FTS projections first; index through Events; return source IDs and permission-filtered results |

### Packages and applications, not plugins

| Component | Implement without a plugin because | Recommended implementation |
|---|---|---|
| `packages/client-protocol` | It is a shared schema/transport contract consumed by server, desktop, Android, and helpers | Versioned event and command schemas; generate TypeScript/Kotlin types; mark durable versus ephemeral messages |
| `packages/execution-targets` | It is a provider abstraction used by existing Tools and Projects | Define `ExecutionTarget` and adapters for Sandbox, Core Host, and Computer Node; keep authorization in existing Permissions |
| `apps/desktop` | A client is a presentation layer, not runtime ownership | Electron + React + TypeScript; local cache only; all durable mutations go through Gateway |
| `apps/android` | Mobile is a presentation and voice surface | Kotlin + Compose; Room cache and Keystore; WorkManager only for sync/notifications, never Agent execution |
| Windows `friday-computer-node.exe` | It is a platform provider for the Computer plugin | Rust/C++; Win32/COM/UI Automation, screen capture, IDD integration, CDP, and native input |
| Linux Sway/session services | They are deployment/provider code for Computer, not a new business domain | User-level systemd units; managed Sway session, headless outputs, PipeWire, Chromium |

### Existing plugins to extend

| Feature | Extend | Reason and implementation |
|---|---|---|
| Agent execution and profile turns | Agent/Turn Loop | Profiles select instructions, memory scopes, tools, and policy; do not create a second Agent runtime |
| Transcript, Threads, read sequence | Sessions + Conversations | Sessions remain the durable message tree; Conversations add product metadata |
| Background progress, handoffs, redirect | Session Jobs + Events | Handoffs and `JobDirective` are durable job state and signals, not a new queue |
| Agent/project memory | Memory | Add scope keys and authorization; do not create profile-specific databases |
| Schedules and event triggers | Scheduler + Events + Routines | Scheduler owns timing; Events own delivery; Routines own user configuration |
| Voice STT/TTS | Voice | Add WebRTC/realtime transport and Android/desktop adapters; keep provider credentials in Vault |
| Files/results/previews | Artifacts | Add result-card metadata and preview adapters; do not create a second file store |
| Tools, browser actions, external integrations | Tools + MCP + Computer | Prefer API/MCP, then DOM/accessibility/CDP, then visual control; preserve existing permission gates |
| Credentials and secret-safe takeover | Vault + Permissions + Events | Vault stores secrets; Permissions authorizes; Events records redacted state transitions |
| Skills and teach traces | Skills + Computer | Computer records semantic traces; Skills validates and stores reusable workflows |
| Subagent concurrency | Subagents | Computer admission follows the existing RAM-aware admission philosophy |
| Self-improvement and diagnostics | Self-improvement + observability + Doctor | Add providers/status checks to current lifecycle and diagnostics surfaces |
| Notifications | Events + channel/client delivery | FCM and desktop notifications carry event IDs; clients fetch authoritative state |
| Plugin marketplace | MCP | Add discovery/configuration UI; MCP remains the integration owner |

## Feature-by-feature delivery checklist

This checklist covers every capability in the target design and identifies its implementation home.

| Feature | Phase | New plugin? | Deliverable |
|---|---:|:---:|---|
| One core brain, many clients/machines | 1 | No | Gateway and protocol reference existing runtime |
| Durable conversations | Existing | No | Preserve Sessions |
| Background jobs | Existing | No | Preserve Session Jobs |
| Memory | 0/2 | No | Improve retrieval; add authorized scopes |
| Subagents | Existing | No | Reuse bounded workers |
| Skills | 12 | No | Extend existing Skills |
| Scheduler | 9 | No | Bind Routines to Scheduler |
| Events | 1/9 | No | Sync and trigger delivery |
| Permissions | 10 | No | Remain final authority |
| Vault | Existing | No | Keep credential ownership |
| MCP | 11 | No | Add marketplace UX |
| Artifacts | 11 | No | Add rich result cards |
| Persistent Agent Profiles | 2 | Yes | `agent-profiles` |
| Agent-specific memory | 2 | No | Memory scope extension |
| Groups | 2 | Yes | `conversations` metadata |
| Agent-to-Agent handoffs | 2 | No | Session Jobs + visible messages |
| Threads | 2 | No | Session tree + conversation metadata |
| Reactions | 2 | No | Conversation metadata |
| Pin/hide/unread | 2 | No | Per-user conversation metadata |
| Shared Agent Computer | 4 | Yes | `computer` |
| Computer Node abstraction | 4 | Yes | Provider contract |
| Separate screens | 4/5/8 | No | Screen leases in Computer |
| Persistent shared browser | 4 | No | Browser Supervisor |
| Browser automation | 4/8 | No | Tools/MCP/Playwright/CDP adapters |
| Human takeover | 4 | No | ControlLease |
| Automatic hand-back | 4 | No | Idle detector and grace period |
| Re-observation after takeover | 4 | No | Invalidate actions and replan |
| Secret-safe takeover | 4 | No | Redaction and input/screenshot suppression |
| Screen leases | 4 | No | Lease records and expiry |
| Computer admission | 4 | No | Resource controller |
| Linux managed session | 5 | No | Computer provider |
| Existing desktop compatibility mode | 5 | No | Deployment option |
| Raspberry Pi 4 | 5 | No | Host-native Sway/Chromium deployment |
| Windows Computer Node | 8 | No | Native provider helper |
| Windows virtual displays | 8 | No | Optional IDD provider |
| Windows UI Automation | 8 | No | UIA adapter |
| Windows raw-input serialization | 8 | No | RawInputLease |
| WSL2 Linux Computer mode | 8 | No | Linux provider option |
| Projects | 3 | Yes | `projects` |
| ExecutionTarget | 3 | No | Shared package and adapters |
| Project coding workflow | 3 | No | Project resolution + Session Job |
| Git worktree isolation | 3 | No | Existing execution/Git tools |
| HTTPS gateway | 1 | Yes | `clients` |
| WSS streaming | 1 | Yes | `clients` + protocol |
| WebRTC voice/video/control | 1/6/7 | No | Transport adapters |
| Public Caddy deployment | 1 | No | Deployment documentation |
| Device pairing | 1 | Yes | `devices` |
| Cross-device replay/sync | 1 | No | Events sequence/replay |
| Electron desktop | 6 | No | `apps/desktop` |
| Desktop command palette | 6/11 | No | Client feature over Search |
| Desktop computer/terminal/diff panels | 6 | No | Client feature |
| Android Kotlin/Compose | 7 | No | `apps/android` |
| Android voice-first home | 7 | No | Client feature over Voice |
| Realtime Android voice | 7 | No | Voice + WebRTC |
| Android computer takeover | 7 | No | Computer control client |
| FCM notifications | 7 | No | Events delivery adapter |
| Offline cache and reconnect | 6/7 | No | Client caches + event replay |
| Routines | 9 | Yes | `routines` |
| Event-triggered workflows | 9 | No | Events → Routines → Session Jobs |
| Teach-by-demonstration | 12 | No | Computer trace + Skills |
| Auto Review | 10 | Yes | `review-policy` before Permissions |
| Marketplace UX | 11 | No | MCP client surfaces |
| Rich result UI | 11 | No | Artifacts client adapters |
| Search facade | 11 | Yes | `search` |
| Work redirection | 2 | No | `JobDirective` on Session Jobs |
| Agent duplicate/share | 12 | No | Profile export/import service |
| Computer update/reset/recovery | 4/12 | No | Computer lifecycle provider |
| Desktop/Computer separation | 4/6/8 | No | Independent processes and contracts |
| Linux services | 5 | No | Deployment manifests |
| Windows process model | 8 | No | WSL2 core + interactive helper |
| Shared protocol schemas | 1 | No | `client-protocol` package |
| Architecture ownership tests | Every phase | No | Inspect/check gates |

## Phase execution template

Every phase should be implemented in this order:

1. Write the user-visible capability and failure cases.
2. Confirm the owner using `npm run inspect:plugins`; extend an existing contract when the feature belongs to an existing authority.
3. For a new plugin, define `contract.ts`, typed capabilities/contributions/hooks, persistence model, security boundary, and lifecycle participation before UI work.
4. Build the smallest vertical slice: persistence → core capability → protocol/API → one client surface.
5. Add redaction, authorization, restart/replay, offline, and platform failure behavior before polish.
6. Verify with focused tests, `npm run inspect:plugins`, `npm run check:architecture`, `npx tsc --noEmit`, and `npm run verify`.
7. Document migrations, setup/Doctor checks, operational recovery, and the acceptance test in the phase record.

Do not start desktop or Android feature development until the relevant core plugin contract and protocol messages are stable. Client UI can be prototyped earlier with fixtures, but it must not become a second source of truth.

## Coverage audit of the original architecture brief

The numbered items below are intentionally retained as an audit trail. Each item is represented in the phases and ownership tables above.

| Brief item | Roadmap location |
|---:|---|
| 1 | Target architecture and one-core/many-client model |
| 2 | Current foundation and feature-by-feature checklist |
| 3 | New plugins and packages/applications tables |
| 4 | Phase 2: Agent Profiles |
| 5 | Phase 2: Memory scopes |
| 6 | Phase 2: Conversations and Groups |
| 7 | Phase 2: Threads |
| 8 | Phase 2: Reactions |
| 9 | Phase 2: pin/hide/read state |
| 10 | Phase 4: Shared Agent Computer |
| 11 | Phase 4: Computer Node contract |
| 12 | Phase 5: Linux implementation |
| 13 | Phase 5: managed Sway outputs and seats |
| 14 | Phase 5: managed session and compatibility mode |
| 15 | Phase 5: Raspberry Pi 4 |
| 16 | Phase 4: Browser Supervisor |
| 17 | Phase 4: API/DOM/accessibility/CDP/visual priority |
| 18 | Phase 4: Human takeover |
| 19 | Phase 4: automatic hand-back and idle grace |
| 20 | Phase 4: re-observation and replanning |
| 21 | Phase 4: secret-safe takeover |
| 22 | Phase 4: ScreenLease |
| 23 | Phase 4: computer admission |
| 24 | Phase 8: Windows architecture and WSL2 |
| 25 | Phase 8: native Computer Node helper |
| 26 | Phase 8: IDD virtual displays |
| 27 | Phase 8: browser/CDP parallelism |
| 28 | Phase 8: dedicated F.R.I.D.A.Y browser profile |
| 29 | Phase 8: UI Automation and RawInputLease limitation |
| 30 | Phase 8: WSL2 Linux Computer mode |
| 31 | Phase 3: Projects and filesystem routing |
| 32 | Phase 3: ExecutionTarget package |
| 33 | Phase 3: Project coding workflow |
| 34 | Phase 3: Git worktree isolation |
| 35 | Phase 1: Client Gateway |
| 36 | Phase 1: Caddy/TLS and private internal services |
| 37 | Phase 1: Devices and pairing |
| 38 | Phase 6: Electron desktop stack |
| 39 | Phase 6: desktop layout |
| 40 | Phase 6: desktop feature surfaces |
| 41 | Phase 7: Kotlin/Compose Android stack |
| 42 | Phase 7: Android voice-first home |
| 43 | Phase 7: realtime voice, barge-in, and transport |
| 44 | Phase 7: Android screens |
| 45 | Phase 7: FCM notification delivery |
| 46 | Phase 1: event sequence replay and reconnect |
| 47 | Phase 9: Routine abstraction over Scheduler |
| 48 | Phase 9: Events → Routines → Session Jobs |
| 49 | Phase 12: teach-by-demonstration to Skills |
| 50 | Phase 10: Review Policy before Permissions |
| 51 | Phase 11: MCP Marketplace/Yours UX |
| 52 | Phase 11: Artifacts result cards |
| 53 | Phase 11: Search facade and command palette |
| 54 | Phase 2: JobDirective and safe redirection |
| 55 | Phase 12: sanitized Agent duplicate/share templates |
| 56 | Phase 4/12: Computer lifecycle and managed reset |
| 57 | Phase 4/6/8: independent Desktop and Computer Node processes |
| 58 | Phase 5: user-level Linux systemd services |
| 59 | Phase 8: WSL2 core and interactive Windows helper |
| 60 | Phase 1: versioned shared protocol schemas |
| 61 | Ownership map and plugin-boundary tables |
| 62 | Phases 0–12 and phase execution template |
| 63 | F.R.I.D.A.Y 2.0 milestone |

The platform strategy behind the brief is also explicit: Linux/Pi is the first-class shared-computer path, Windows provides strong browser/shell/UI Automation support with serialized raw input and an optional WSL2 Linux mode, and Android remains a thin voice-first client over the same server-authoritative runtime.

## Milestone: F.R.I.D.A.Y 2.0

The first major product milestone includes the gateway and device pairing, persistent Agents and Conversations, desktop and Android clients, shared Linux Agent Computer, separate Agent screens, shared browser state, human takeover with automatic resume, Projects and local execution, background notifications, approvals, and basic Routines. Windows native GUI breadth, teaching, marketplace UX, advanced search, Agent sharing, and richer collaboration follow as subsequent releases.

## How roadmap items become work

1. Start with the user problem and inspect existing capabilities with `npm run inspect:plugins`.
2. Reuse the owning plugin; propose a new domain only when no existing authority fits.
3. Define typed capability/contribution/hook contracts before implementation.
4. Document persistence, security, lifecycle, platform, and compatibility impact.
5. Add focused tests and run `npm run inspect:plugins`, `npm run check:architecture`, `npx tsc --noEmit`, and `npm run verify`.
6. Update [`docs/ARCHITECTURE.md`](ARCHITECTURE.md), this roadmap, and relevant setup/operations documentation when a boundary changes.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`docs/PLUGIN_DEVELOPMENT.md`](PLUGIN_DEVELOPMENT.md), and [`docs/plugins/README.md`](plugins/README.md) for contribution guidance.
