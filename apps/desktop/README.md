# F.R.I.D.A.Y desktop

The renderer uses the authenticated Client Gateway for turns, event replay, conversations, plugin enablement, pairing and Computer control. It shows Gateway errors instead of manufacturing approvals, artifacts or screen images. Other workspace surfaces and approval prompts still require server implementations. Closing the app does not stop a running turn.

## Run

```bash
npm --prefix apps/desktop run build
```

The renderer runs in the Electron host (`electron/main.cjs`). Its preload bridge stores the Ed25519 private key through Electron OS encryption and signs requests without exposing the private key to the renderer. A browser preview can display the interface, but cannot pair a device because it does not have the secure bridge.

1. Start FRIDAY. Its Gateway binds to `127.0.0.1:8787` by default.
2. In Desktop Settings, enter the Gateway URL and request pairing.
3. For the first device, on the FRIDAY host run `friday device approve PAIRING_ID` using the displayed ID. The temporary bootstrap secret is a mode 0600 file under `FRIDAY_HOME` and is valid only before a device has been paired.
4. Reconnect Desktop. An existing operator device can approve further devices under Settings.
5. Open Plugins to toggle built-in or installed packages. Changes take effect after a Core restart. The capability kernel cannot be disabled.

For remote use, configure TLS and a trusted reverse proxy as described in [`docs/CLIENT_GATEWAY.md`](../../docs/CLIENT_GATEWAY.md). The Gateway allows the opaque Electron renderer origin and local browser preview origins to access HTTP endpoints; signed device requests still require pairing.

The event stream exposes only events published by Core. Its current generic reducer displays text and job status when events contain those fields. Full transcript hydration, pending approvals, streamed computer pixels, richer Activity, Android and Channel removal remain open.
