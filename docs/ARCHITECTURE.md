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
