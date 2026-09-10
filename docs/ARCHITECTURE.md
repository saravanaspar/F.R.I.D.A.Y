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

The Projects plugin does not reimplement Git or shell execution. It delegates coding workspace lifecycle and trusted diff/commit operations to Worktrees, while Sandbox/Execution/Tools remain the authorities that actually run code. This keeps authorization identity, Project/workspace identity, and execution-target selection separate. The Phase 3 foundation supports durable Project resolution and isolated local coding workspaces; Computer Node execution is introduced by the later Computer phase.

