# Shared Agent Computer

Phase 4 defines the provider-neutral Computer Node authority. Platform-specific Linux/Sway and Windows implementations come later; the core contract must stay usable by both.

## Ownership and reuse

`plugins/computer` owns Computer Node runtime registration, resource admission, screen/control leases, Browser Supervisor coordination, human takeover state, and managed node lifecycle requests. It deliberately reuses the existing architecture instead of duplicating it:

- Projects and `@friday/execution-targets` continue to decide which execution target a Project may use.
- Execution/Tools remain the shell, edit, process, and IPython authorities.
- Session Jobs remain the durable work queue and restart/resume owner.
- Permissions remains the authorization authority for model/operator actions.
- Events receives Computer lifecycle/lease/takeover events.
- Platform providers implement `ComputerNodeAdapter`; Phase 5 supplies Linux/Sway and Phase 8 supplies Windows.

## Computer Node provider contract

A provider registers one `ComputerNodeAdapter` with a stable node descriptor and supplies current runtime snapshots. Snapshots contain only provider-neutral state: availability, bounded resource telemetry, screen descriptors, and optional Browser Supervisor metadata.

A node may declare existing execution operations (`shell`, `edit`, `process`, `git`) plus browser, Playwright, accessibility, CDP, visual-control, screen-capture, raw-input, virtual-display, and managed-lifecycle capabilities. The Computer core does not emulate a capability the provider does not declare.

## Project and tool execution bridge

Phase 4 reuses the Phase 3 execution path rather than adding Computer-specific Agent tools for shell/edit/process/Python. Projects still resolve `computer:<node-id>` through `@friday/execution-targets` and still own canonical/worktree selection. Turn Loop then leases an Agent screen on the resolved node and attaches a `ComputerExecutionBinding` containing the node, screen lease, Agent owner, owner kind, and current control generation.

The existing Tools capability remains the policy/schema authority. For a Computer target it performs the same Permissions authorization as Sandbox/Core Host and then calls `ComputerService.runTool()`. The Computer core validates that the binding still owns the exact screen, that the control generation is current, and that the node declared the required execution operation before delegating to `ComputerNodeAdapter.runTool()`. Bash and IPython map to the node's `shell` capability, edit maps to `edit`, and process maps to `process`; Project Git/worktree lifecycle remains owned by Worktrees.

Computer shell/process/IPython calls are conservatively classified as network-capable because the provider-neutral contract does not promise per-command network isolation. Remote background process starts retain the existing main-Agent-only rule. Provider tool calls share the same cancellation set as browser actions, so takeover, lease expiry, or release aborts pending execution before control can move elsewhere.

Each `ComputerExecutionBinding` also carries one host-generated Agent `runId`. Provider-owned `process start` requests default to a one-hour maximum lifetime, reject larger lifetimes, and fail closed unless the provider implements run-scoped `cleanupRunProcesses`. Turn Loop invokes that cleanup before a Computer run can settle, and a cleanup failure prevents an otherwise-successful run from being reported as complete. Providers must scope every persistent process operation and cleanup decision to the supplied `runId` rather than only the Session or screen owner. Cleanup remains callable if the screen lease expired or was released first, so loss of the lease cannot strand provider-owned run processes.

## Resource admission

Projects may declare provider-neutral `policy.computerAdmission` requirements (`requireBrowser`, memory MiB, browser renderer count, and GPU demand). Turn Loop carries those requirements into the initial screen request so browser/resource-heavy Project work enters `WAITING_FOR_COMPUTER` before tool construction instead of acquiring an under-provisioned screen.

Agent screen admission considers:

- available RAM after requested demand,
- CPU utilization,
- current plus requested browser renderer count,
- GPU availability/utilization for GPU-requiring work (missing GPU telemetry fails closed),
- provider-observed screen workload, and
- availability of an unleased Agent screen.

If no node can satisfy the request, the result is `WAITING_FOR_COMPUTER` with stable reason codes. `waitForScreen()` keeps the request pending and retries after telemetry refresh, lease release/expiry, or the service poll tick. This lets Session Jobs remain the durable job owner while Computer remains the resource authority.

For detached Agent work, `waitForScreen()` reports its first admission failure through a generic callback before the request is parked. Turn Loop maps that callback onto the existing public progress channel. Session Jobs persists the job as `waiting-for-computer` together with the stable wait code, preferred node id, bounded reason codes, and request timestamp. A later screen grant reports `running` again and clears the active wait record. Waiting work remains part of the normal active-job set, can be cancelled through the existing Session Jobs action, and is never moved into a Computer-owned queue of durable jobs.

On FRIDAY restart, Session Jobs uses its existing resumable-request mechanism: the interrupted active row is durably returned to `queued`, its last Computer wait context remains available for status/diagnostics, and the resume turn preserves the original Project and `computer:<node-id>` target. When the reconstructed Agent run reaches admission again it either acquires a screen immediately or persists a fresh `waiting-for-computer` state. Computer therefore owns only live resource waiters; Session Jobs owns durable work and restart semantics.

Browser readiness is also rechecked after a screen has already been leased. The leased `ComputerExecutionBinding` retains the server-owned Project resource demand; before a model-facing `computer_browser` action is dispatched, Computer refreshes the selected node and waits for a running persistent Browser Supervisor while reapplying that memory/renderer/GPU demand together with the configured CPU/RAM reserve and screen-workload thresholds. The same Turn Loop progress channel persists this as `waiting-for-computer` and returns the durable job to `running` before a new browser action is issued.

## ScreenLease and ControlLease

A `ScreenLease` is exclusive to one Agent owner and expires unless renewed. Releasing or expiring it aborts pending Computer actions before the screen can be reused.

Turn Loop keeps an active Computer lease alive with a run-scoped heartbeat at roughly one-third of the original lease lifetime. Renewal continues while a human holds manual-only takeover because the underlying Agent screen is still reserved for the same Session Job. If renewal fails, the Agent run is aborted and cannot silently continue after ownership expires.

Each leased screen also has a `ControlLease`. Agent actions must present the current generation. The generation changes whenever control changes or human activity invalidates pending work. Stale generations fail closed with an instruction to re-observe and replan.

## Browser Supervisor

Providers expose one Browser Supervisor snapshot for the node's shared persistent browser profile and one opaque live context identity. The Computer core rejects stopped supervisors that claim live windows/tabs, duplicate tab ownership across windows, Human windows bound to Agent screens, Agent-role windows bound to Human screens, and replacement persistent-profile identities after registration. Browser-required admission and browser actions proceed only while that supervisor is running with the persistent shared profile ready. Status surfaces report only readiness/counts; they do not publish tab URLs/titles, browser content, profile paths, cookies, or credentials in generic Computer status.

Higher-level orchestration should use API/MCP before Computer browser automation. Once Computer is selected, the provider fallback order is:

1. Playwright DOM
2. accessibility tree
3. CDP
4. visual control

The provider returns which mode was used and a fresh bounded observation. Browser action contents are not written to Computer Events. Explicitly sensitive typing is rejected by the generic action path and must use human takeover or a dedicated protected-credential flow.

Every provider observation must carry a positive model-safety attestation that secrets, keystrokes, CAPTCHA contents, and sensitive screenshots were omitted. Computer validates that attestation at runtime and then applies defense-in-depth redaction to credential/token/OTP/PIN/CAPTCHA-shaped URL, DOM, accessibility, tab, and process text before any Agent or Client surface can consume it. Raw screenshot bytes never cross the Computer capability; providers expose only a safe Artifact reference. Phase 5/8 provider conformance tests must prove this attestation against the real browser/UI primitives they implement.

## Agent Computer tools

When Turn Loop has an active `ComputerExecutionBinding`, the Computer plugin contributes two model-facing tools through the existing Agent tool extension point rather than creating a parallel Agent runtime:

- `computer_observe` authorizes a private read through Permissions and returns a fresh bounded `ComputerObservation` for the currently leased screen.
- `computer_browser` authorizes an external write through Permissions, accepts only the provider-neutral navigate/click/type/press action contract, and dispatches through the current screen/control generation.

Both tools fail closed without an active Computer binding. Observation and browser execution are tracked as in-flight screen actions, so takeover, lease expiry, or release aborts them. If human takeover advances the generation while an Agent Computer action is in flight, the trusted adapter waits for Agent control to return instead of replaying that action. Successful hand-back supplies the fresh re-observation that caused the resume, marks the interrupted action as `staleActionReplayed: false`, and refreshes later tool calls to the new host-owned control generation. Sensitive browser typing is rejected before provider dispatch; passwords, OTPs, CAPTCHA solutions, and similar secrets require human takeover or a dedicated protected-credential flow. The active-screen prompt section tells the Agent that the original generation is only the initial binding and that a takeover resume must replan from the attached fresh observation.

## Client Gateway Computer APIs

Authenticated clients use the Client Gateway as a thin adapter over the Computer capability. Phase 4 exposes:

```text
/v1/computer/status
/v1/computer/nodes
/v1/computer/screens
/v1/computer/leases
/v1/computer/observe
/v1/computer/takeover
/v1/computer/human-activity
/v1/computer/hand-back
```

Status, node, screen, and lease responses use Computer-owned bounded serializers. Generic status never publishes browser tab URLs/titles or raw screenshot bytes. Observation returns only the normalized provider-neutral observation, where screenshot data may be referenced by an Artifact id rather than embedded as sensitive image bytes.

Takeover, human-activity, and hand-back derive the human holder id from the authenticated device (`client:<device-id>`); a request body cannot claim another controller identity. Observe derives the active lease owner and generation server-side and therefore fails while human control is active or after a generation change. Client routes never receive a `ComputerNodeAdapter` and cannot call platform-provider methods directly.

## Human takeover and hand-back

Human takeover is a control transition, not a second Agent. The screen remains leased to the original job while the user temporarily holds control.

On takeover, the Computer core:

1. aborts pending Computer actions,
2. increments the control generation,
3. switches the holder to the human identity,
4. applies a fixed transcript policy that excludes keystrokes, secrets, and sensitive screenshots, and
5. starts the idle hand-back grace period.

The default idle grace is eight seconds. Configured values must be at least five seconds; `null` means manual-only hand-back. Human activity refreshes the grace period without sending key/text/screenshot content through this API.

Hand-back increments the generation again and requires `observeScreen()` to succeed before Agent control is restored. The fresh observation and resumed control generation are published atomically to paused Agent waiters; if re-observation fails or the user interacts again during hand-back, the Agent remains paused. The Computer API accepts only human activity timing/identity here—never the password, OTP, CAPTCHA solution, or keystroke stream itself. Interrupted browser and execution actions are explicitly not replayed; a browser action submitted while human control is already active also pauses before provider dispatch, then returns the fresh hand-back observation instead of replaying the stale action. The Agent must replan before issuing a new action.

## Managed lifecycle

Computer Node `restart`, `update`, and `resetManagedState` operations delegate to the platform provider. The core refuses these operations while screen leases are active. `resetManagedState` means FRIDAY-managed Agent/browser/display state only; it must never silently reset the person's operating system.

## Phase 4 completion

The first slice established the provider contract, admission, lease expiry/waiting, browser-action generation checks, takeover/hand-back behavior, status/doctor surfaces, and managed lifecycle guards. The second slice connected Project/Turn Loop execution to Computer targets and routed the existing bash/edit/process/IPython tool surfaces through the leased node while preserving Permissions and stale-generation checks. The third slice made Computer admission a durable Session Job state and reused the existing restart/resume path rather than introducing Computer-owned durable scheduling. The fourth slice added permission-gated Agent observe/browser tools plus authenticated Client Gateway status/observation/takeover APIs over the same Computer authority. The fifth slice completes the provider-neutral Browser Supervisor invariants and the human-takeover continuation path: a login-wall action may be interrupted, the user controls the same leased screen without secret capture, hand-back re-observes current state, and the same Session Job resumes without replaying the interrupted action. The final audit-hardening pass adds run-scoped lease renewal, provider process cleanup, browser-level durable readiness waits, mandatory observation safety attestation with core redaction, operational-error handling for asynchronous waiter drains, and a real Agent-executor/Project/Permissions/Computer/Session-Jobs login-wall acceptance path.

Phase 4 provider-neutral implementation is complete in scope and the audit-hardening repository verification gate has passed. Linux/Sway/Chromium and Windows platform providers remain Phase 5/8 work, including platform conformance tests that prove the observation-safety attestation against real UI/browser primitives.
