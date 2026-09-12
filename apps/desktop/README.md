# F.R.I.D.A.Y desktop — Phase 6 first slice

This is the presentation-only first slice for the desktop client. It demonstrates
the Phase 6 vertical path:

`conversation → background job → approval → artifact → Computer panel`

The renderer is intentionally dependency-light while the Electron/React shell is
being established. `src/core.ts` is the typed, framework-independent client cache
and reducer. It owns no durable data, credentials, Agent execution, or Computer
authority; those remain behind the authenticated Client Gateway.

## Run the slice

```bash
npm --prefix apps/desktop run build
npm --prefix apps/desktop run preview
# open http://127.0.0.1:4173 in a desktop browser
```

The optional Electron host is in [`electron/main.cjs`](electron/main.cjs). Install
the Electron toolchain in the app workspace before launching it; the browser
preview remains the canonical smoke-test path until the native shell is wired to
device pairing and OS credential storage.

## What is deliberately next

- Replace demo dispatches with authenticated `ClientGateway` HTTP/WebSocket calls.
- Persist only bounded cache data locally and resume using the event sequence.
- Add React/Zustand/TanStack Query adapters around the tested reducer.
- Add native pairing, credential storage, notifications, terminal, and WebRTC.
