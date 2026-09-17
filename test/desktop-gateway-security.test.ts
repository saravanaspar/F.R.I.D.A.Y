import { describe, expect, it } from "vitest";
import { clientRequestSigningPayload, clientWebSocketSigningPayload } from "@friday/client-protocol";
import { createDesktopGatewayClient } from "../apps/desktop/src/gateway.js";

class FakeSocket {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  addEventListener(name: string, listener: (event: { data?: unknown }) => void): void {
    const entries = this.listeners.get(name) ?? new Set();
    entries.add(listener);
    this.listeners.set(name, entries);
  }
  send(value: string): void { this.sent.push(value); }
  close(): void { this.emit("close", {}); }
  emit(name: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

describe("desktop gateway security", () => {
  it("rejects plaintext HTTP for non-loopback gateways", () => {
    expect(() => createDesktopGatewayClient({
      baseUrl: "http://192.0.2.10:4222",
      deviceId: "desktop-1",
      sign: async () => "signature",
    })).toThrow(/HTTPS.*loopback/i);
  });

  it("signs the exact request operation instead of only the challenge", async () => {
    const signed: string[] = [];
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = createDesktopGatewayClient({
      baseUrl: "http://127.0.0.1:4222",
      deviceId: "desktop-1",
      sign: async (payload) => { signed.push(payload); return "signature"; },
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/challenge")) return new Response(JSON.stringify({ challenge: "challenge-1" }), { status: 200 });
        requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    await client.request("/v1/projects/update", { id: "atlas", policy: { allowCoreHostWrites: true } });

    expect(signed).toEqual([clientRequestSigningPayload({
      challenge: "challenge-1",
      deviceId: "desktop-1",
      method: "POST",
      path: "/v1/projects/update",
      body: { id: "atlas", policy: { allowCoreHostWrites: true } },
    })]);
    expect(requests[0]?.body).toMatchObject({ deviceId: "desktop-1", challenge: "challenge-1", signature: "signature" });
  });

  it("becomes online only after client.ready and binds stream auth to the cursor", async () => {
    const statuses: string[] = [];
    const signed: string[] = [];
    const socket = new FakeSocket();
    const client = createDesktopGatewayClient({
      baseUrl: "http://localhost:4222",
      deviceId: "desktop-1",
      sign: async (payload) => { signed.push(payload); return "signature"; },
      fetcher: async () => new Response(JSON.stringify({ challenge: "stream-challenge" }), { status: 200 }),
      webSocketFactory: () => socket as unknown as WebSocket,
    });

    const stop = client.stream(7, () => undefined, (status) => statuses.push(status.status));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    socket.emit("open", {});
    expect(statuses).toEqual(["connecting"]);
    expect(signed).toEqual([clientWebSocketSigningPayload({ challenge: "stream-challenge", deviceId: "desktop-1", afterSequence: 7 })]);

    socket.emit("message", { data: JSON.stringify({ kind: "client.ready", protocolVersion: 1, requestId: "ready", connectionId: "c", latestSequence: 9 }) });
    expect(statuses).toEqual(["connecting", "online"]);
    stop();
  });
});
