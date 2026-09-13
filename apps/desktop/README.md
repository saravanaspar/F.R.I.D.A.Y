# F.R.I.D.A.Y desktop

This is the presentation-only foundation for the Phase 6 desktop client. It
implements this initial workflow:

`conversation → background job → approval → artifact → Computer panel`

The renderer is intentionally dependency-light while the native Electron/React
shell is being established. `src/core.ts` is the typed, framework-independent
client cache and reducer. `src/gateway.ts` provides authenticated HTTP and
reconnecting WebSocket transport, `src/storage.ts` provides versioned bounded
cache storage, `src/deep-links.ts` validates `friday://` routes, and
`src/commands.ts` powers the command palette. The client owns no durable data,
credentials, Agent execution, or Computer authority; those remain behind the
authenticated Client Gateway.

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

The visible renderer currently runs in demo mode so it can be previewed without a
paired host. Wiring a production deployment requires connecting the renderer to
`createDesktopGatewayClient`, supplying a device signer from the preload bridge,
and mapping Gateway event types to the reducer. React/Zustand/TanStack Query,
terminal, WebRTC, and the remaining native panels can then consume these stable
client boundaries without moving authority into the app.
