# Client Gateway operations

Phase 1 includes a transport adapter that is intentionally disabled until an operator starts it. It binds to loopback by default and exposes a small HTTP API plus an authenticated WebSocket stream. Public TLS belongs at the deployment edge.

Start it from a trusted System action or a local integration:

```ts
const gateway = requireCapability(CLIENT_GATEWAY_CAPABILITY);
await gateway.start({ host: "127.0.0.1", port: 3180 });
```

Health check:

```bash
curl --fail http://127.0.0.1:3180/health
```

The device flow is:

1. `POST /v1/pairings` with `deviceId`, `name`, `type`, and a public key.
2. A trusted operator reviews `devices.pairings` and runs `devices.approve-pairing`.
3. The device calls `POST /v1/auth/challenge`.
4. The device signs the returned challenge with its private key.
5. The device calls `POST /v1/events/replay` or opens `/v1/stream` and sends a `client.authenticate` message.

WebSocket clients receive `client.ready`, replayed events from `afterSequence`, and live event envelopes. WebRTC `offer`, `answer`, and `ice` messages are relayed only between authenticated paired devices; signaling payloads are ephemeral and are not written to the Events ledger.

The gateway must remain behind an authenticated TLS reverse proxy when exposed outside the host. A minimal Caddy deployment is:

```caddyfile
friday.example.com {
    reverse_proxy 127.0.0.1:3180
}
```

Caddy handles HTTPS and WebSocket upgrades. Do not expose the Events database, Vault, shell, internal plugin services, or the gateway’s loopback port directly. Use a firewall and, when WebRTC media is enabled, add a separately managed TURN service.

The gateway does not provide an unauthenticated administrative approval endpoint. Pairing approval and device revocation remain trusted System actions backed by the existing Permissions and Audit boundaries.

## Profile and Conversation APIs

After authentication, Phase 2 resource requests use `POST` JSON bodies containing the device credentials (`deviceId`, a fresh `challenge`, and its `signature`) plus the operation fields. Challenges are single-use. These routes are intentionally thin adapters over the Agent Profiles, Conversations, and Turn Loop capabilities; they do not create client-side stores:

```text
/v1/agent-profiles/list
/v1/agent-profiles/create
/v1/agent-profiles/update
/v1/agent-profiles/remove

/v1/conversations/list
/v1/conversations/create
/v1/conversations/update
/v1/conversations/mark-read
/v1/conversations/mentions/resolve
/v1/conversations/threads/create
/v1/conversations/threads/reply
/v1/conversations/reactions/add
/v1/conversations/reactions/remove
/v1/conversations/reactions/list

/v1/turns

/v1/session-jobs/redirect
```

`/v1/turns` accepts a conversation id, text, and optional `agentProfileId`/thread id. If the profile has a default conversation, the conversation id may be omitted. The server resolves the conversation's Session and submits one host-owned Turn Loop turn; desktop and Android clients must treat the returned event stream and Session state as authoritative.

`/v1/session-jobs/redirect` accepts an active `jobId` and new instruction text. It records a durable JobDirective and returns redacted directive metadata; the existing Session Jobs runner delivers the full instruction to the Agent at its next safe steering boundary.

## Verification

Run the focused Phase 1 tests while developing:

```bash
npx vitest run --config vitest.config.ts test/client-gateway.test.ts
npm --workspace @friday/client-protocol test
```

The gateway test creates temporary device state, pairs Ed25519 devices, authenticates HTTP and WebSocket requests, disconnects and resumes from an event sequence, receives a live event, and relays a WebRTC offer between two authenticated devices. The protocol test checks every supported message shape and rejects malformed or incompatible protocol messages.

Before considering the phase ready, run the repository gate:

```bash
npm run verify
git diff --check
```

For a manual deployment check, start the gateway on loopback and verify:

1. `curl --fail http://127.0.0.1:3180/health` returns a healthy response.
2. An unapproved device cannot request an authentication challenge.
3. A paired device can sign a challenge and open `/v1/stream`.
4. Reconnecting with the previous `afterSequence` returns only later durable events.
5. A newly published Event arrives on the open WebSocket once and in sequence order.
6. WebRTC signaling reaches the addressed paired device, while an unknown or disconnected target fails without broadcasting the payload.
7. Revoking the device prevents its next authentication attempt.

These checks cover Phase 1 transport and signaling. Voice and computer media streams, TURN behavior, desktop UI, and Android UI are introduced in their later phases.
