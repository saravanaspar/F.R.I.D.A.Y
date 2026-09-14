# F.R.I.D.A.Y desktop

This is the dependency-light desktop client shell for Phase 6. It implements the
core workflow used by the client:

`conversation → background job → approval → artifact → Computer panel`

The renderer is intentionally dependency-light so it can be previewed without a
large native toolchain. `src/core.ts` is the typed, framework-independent client
cache and reducer. `src/gateway.ts` provides authenticated HTTP and reconnecting
WebSocket transport, `src/storage.ts` provides versioned bounded cache storage,
`src/deep-links.ts` validates `friday://` routes, and `src/commands.ts` powers the
command palette. The authenticated gateway exposes conversations, profiles,
projects, Computer control, turns, background jobs, and artifact metadata. The
client owns no durable data, credentials, Agent execution, or Computer authority;
those remain behind the gateway.

## Run the desktop client

```bash
npm --prefix apps/desktop run build
npm --prefix apps/desktop run preview
# open http://127.0.0.1:4173 in a desktop browser
```

The Electron host is in [`electron/main.cjs`](electron/main.cjs), with an isolated
preload bridge for OS-encrypted credentials, deep links, and single-instance
behavior. Install the Electron toolchain in the app workspace before launching it.

## Integration boundary

The visible renderer runs in demo mode when no paired host is configured, which
makes the shell safe to preview. A production deployment connects the renderer to
`createDesktopGatewayClient`, supplies a device signer from the preload bridge,
and maps Gateway event types to the reducer. React/Zustand/TanStack Query,
terminal, WebRTC, and updater packaging are intentionally separate follow-up
adapters; they can consume these stable client boundaries without moving
authority into the app.
