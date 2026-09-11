# F.R.I.D.A.Y platform architecture

F.R.I.D.A.Y has one core brain and many clients. Agents, Sessions, Session Jobs, Memory, Scheduler, Tools, Sandbox, Permissions, Vault, Events, Artifacts, Skills, MCP, Subagents, and observability remain the existing authorities. New product domains compose those contracts.

## New domains

```text
plugins/clients plugins/devices plugins/agent-profiles plugins/conversations
plugins/computer plugins/projects plugins/routines plugins/search plugins/review-policy
packages/client-protocol packages/execution-targets
apps/desktop apps/android
```

An Agent Profile is a persistent named teammate; a Subagent remains a temporary worker. A Computer Node is shared by the user and Agents, with separate leased screens and a persistent browser supervisor. Human takeover pauses computer input, protects secrets, then forces fresh observation and replanning before work resumes.

Linux is first-class through a managed Sway/wlroots session, Chromium/Playwright/CDP, and headless agent outputs. Windows keeps F.R.I.D.A.Y Core in WSL2 and adds a native Computer Node helper for browser/CDP, UI Automation, virtual displays, and serialized raw input. The Android app is a thin Kotlin/Compose client; the desktop app is Electron/React. Neither owns durable work.

See the [roadmap](ROADMAP.md), [plugin development guide](PLUGIN_DEVELOPMENT.md), and [plugin cookbook](plugins/cookbook.md) before proposing a new owner.

For gateway startup, pairing, reverse-proxy, and WebSocket operations, see [`CLIENT_GATEWAY.md`](CLIENT_GATEWAY.md).

## Projects and execution targets

Projects are durable server-owned records, not client-side path aliases. A Project binds an identity to a canonical root, repository metadata, an optional preferred Computer Node, and an execution policy. The provider-neutral `@friday/execution-targets` package decides whether a requested shell/edit/process/Git operation is allowed on Sandbox, Core Host, or a named Computer Node and whether a write must use an isolated worktree.

The Projects plugin does not reimplement Git or shell execution. It delegates coding workspace lifecycle, trusted diff/commit operations, and canonical-repository promotion to Worktrees, while Sandbox/Execution/Tools remain the authorities that define and authorize code execution. Turn Loop asks Projects for a stable job-owned workspace before constructing core tools, so shell, edit, process, and IPython automatically inherit the resolved target and working directory. Sandbox remains the default; Core Host execution must be explicitly permitted by Project policy. For `computer:<node-id>`, Turn Loop additionally leases an Agent screen from the Computer capability and passes that generation-bound lease to Tools, which delegates the already-authorized operation to the provider through `ComputerService.runTool()` rather than adding a second executor.

Project coding jobs are restart-safe rather than client-owned. Detached Session Jobs persist the Project and requested target, deterministic job ownership reopens the same isolated worktree after restart, configured test/build commands run through the same target-aware bash capability, and complete diffs can be stored in Artifacts while only bounded previews are added to conversational output. Candidate commits cannot change the canonical repository through the ordinary edit path. Promotion is a distinct permission-gated operation and Worktrees requires both candidate and canonical worktrees to be clean; fast-forward merge is preferred and cherry-pick is available for a diverged clean primary. This keeps authorization identity, Project/workspace identity, and execution-target selection separate.

## Shared Agent Computer

Phase 4 introduces `plugins/computer` as the provider-neutral owner of Computer Node identity/runtime state, resource admission, screen/control leases, browser-supervisor coordination, takeover safety, and managed node lifecycle requests. It does not duplicate Execution, Session Jobs, Permissions, Events, or platform-specific display/browser implementations. Linux and Windows providers implement the `ComputerNodeAdapter` boundary in later phases.

Agent screens are exclusive expiring leases. Control is generation-bound: taking over a screen increments the generation and aborts pending Computer actions. The provider-neutral pause/resume path waits on that same leased owner while the human controls the screen, never replays the interrupted action, and wakes only after hand-back publishes a fresh observation at the newer generation. Human takeover exposes no key/text payload through the Computer contract, fixes transcript policy to exclude keystrokes/secrets/sensitive screenshots, and hands control back only after a new provider observation of the current browser/screen/process state succeeds. Turn Loop renews the screen lease at roughly one-third of its original TTL for the lifetime of the Agent run, including while manual-only human takeover is active; renewal loss aborts the run rather than allowing stale ownership to continue.

Resource admission evaluates provider telemetry and returns the stable `WAITING_FOR_COMPUTER` state instead of overcommitting a node. For detached work, Turn Loop reports that resource boundary through its existing progress port and Session Jobs persists `waiting-for-computer` as an active status with bounded node/reason context; restart reconstruction keeps Project/target identity and re-enters admission without giving Computer ownership of durable jobs. Computer-target Agent runs bind their existing Tools to the selected node/screen/control generation; Computer rechecks that binding and the provider's declared execution capability immediately before dispatch, and takeover/lease invalidation aborts pending provider work. Model-facing browser work repeats Browser Supervisor/resource readiness checks on the already-leased screen and uses the same durable wait/run progress transition. Each Computer binding also carries one Agent-run identity; provider-owned persistent process starts are bounded and accepted only when the provider supports run-scoped cleanup, which Turn Loop requires before that Agent run can settle.

Model-facing Computer observation/browser control is contributed through Turn Loop's generic Agent extension points and remains subject to Permissions; it does not give the Agent a provider adapter. Authenticated desktop/Android-facing Computer operations are similarly thin Client Gateway adapters over the same typed Computer status/lease/observation/takeover APIs, with human controller identity derived from the authenticated device. System, Agent, and Client surfaces therefore reuse one bounded Computer representation and one control-generation authority. Provider observations must positively attest that secrets, keystrokes, CAPTCHA contents, and sensitive screenshots were omitted; Computer validates that attestation and independently redacts common credential/token/OTP/PIN/CAPTCHA-shaped observation text before it can cross Agent or Client boundaries.

The Browser Supervisor contract keeps one provider-owned persistent profile plus one opaque live context and assigns Human/Developer/Research/F.R.I.D.A.Y windows to the correct Human or Agent screens. The Computer core rejects replacement persistent-profile identity, stopped supervisors that claim live browser state, and multiply assigned tabs; browser-required admission fails closed unless the supervisor is running with its persistent profile ready. At the Computer layer, browser automation falls back through Playwright DOM, accessibility, CDP, then visual control; API/MCP remains preferred by higher-level orchestration. Provider update/restart/reset calls are blocked while screen leases are active, and reset is explicitly limited to FRIDAY-managed Agent state. See [`COMPUTER.md`](COMPUTER.md).
