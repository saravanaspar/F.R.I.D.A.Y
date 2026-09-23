import { describe, expect, it } from "vitest";
import { filterDesktopCommands } from "../apps/desktop/src/commands.js";
import { parseDesktopDeepLink } from "../apps/desktop/src/deep-links.js";
import { createDesktopStorage } from "../apps/desktop/src/storage.js";
import { clientRequestSigningPayload } from "@friday/client-protocol";
import { createDesktopGatewayClient } from "../apps/desktop/src/gateway.js";

describe("desktop client infrastructure", () => {
  it("accepts only scoped Friday deep links", () => {
    expect(parseDesktopDeepLink("friday://conversation/conversation-42")).toEqual({ kind: "conversation", id: "conversation-42" });
    expect(parseDesktopDeepLink("friday://computer/screen-1")).toEqual({ kind: "computer", screenLeaseId: "screen-1" });
    expect(parseDesktopDeepLink("https://example.com/conversation/conversation-42")).toBeUndefined();
    expect(parseDesktopDeepLink("friday://conversation/<script>")).toBeUndefined();
  });

  it("versions and safely ignores malformed local cache entries", () => {
    const backing = new Map<string, string>();
    const storage = { getItem: (key: string) => backing.get(key) ?? null, setItem: (key: string, value: string) => { backing.set(key, value); }, removeItem: (key: string) => { backing.delete(key); } } as unknown as Storage;
    const cache = createDesktopStorage(storage);
    cache.set("session", { lastSequence: 4 });
    expect(cache.get<{ readonly lastSequence: number }>("session")).toEqual({ lastSequence: 4 });
    backing.set("friday.desktop.bad", "not-json");
    expect(cache.get("bad")).toBeUndefined();
  });

  it("filters command palette entries by label, hint, or id", () => {
    const commands = [
      { id: "open-computer", label: "Open Computer", hint: "View the leased screen", run: () => undefined },
      { id: "open-settings", label: "Open Settings", hint: "Gateway and device settings", run: () => undefined },
    ];
    expect(filterDesktopCommands(commands, "leased").map((command) => command.id)).toEqual(["open-computer"]);
    expect(filterDesktopCommands(commands, "")).toHaveLength(2);
  });

  it("keeps Gateway authentication on the client transport boundary", async () => {
    const requests: Array<{ readonly url: string; readonly body?: string }> = [];
    const client = createDesktopGatewayClient({
      baseUrl: "http://127.0.0.1:4222/",
      deviceId: "desktop-1",
      sign: async (challenge) => `signature-for-${challenge}`,
      fetcher: async (input, init) => {
        requests.push({ url: String(input), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
        if (String(input).endsWith("/health")) return new Response(JSON.stringify({ status: "ok", protocolVersion: 1 }), { status: 200 });
        if (String(input).endsWith("/v1/auth/challenge")) return new Response(JSON.stringify({ challenge: "challenge-1" }), { status: 200 });
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      },
    });
    await expect(client.health()).resolves.toMatchObject({ status: "ok", protocolVersion: 1 });
    await expect(client.request("/v1/conversations/list")).resolves.toEqual({ conversations: [] });
    expect(JSON.parse(requests.at(-1)?.body ?? "{}")).toMatchObject({
      deviceId: "desktop-1",
      challenge: "challenge-1",
      signature: `signature-for-${clientRequestSigningPayload({
        challenge: "challenge-1",
        deviceId: "desktop-1",
        method: "POST",
        path: "/v1/conversations/list",
        body: {},
      })}`,
    });
  });

  it("submits a desktop pairing request before a credential has been approved", async () => {
    let request: { url: string; body: Record<string, unknown> } | undefined;
    const client = createDesktopGatewayClient({
      baseUrl: "http://127.0.0.1:8787", deviceId: "first-device", sign: async () => "unused",
      fetcher: async (url, init) => {
        request = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
        return new Response(JSON.stringify({ pairingId: "pending-1", expiresAt: "2026-09-23T00:00:00Z" }), { status: 202 });
      },
    });
    await expect(client.beginPairing({ deviceId: "first-device", name: "Desktop", publicKey: "public" })).resolves.toMatchObject({ pairingId: "pending-1" });
    expect(request).toEqual({ url: "http://127.0.0.1:8787/v1/pairings", body: { deviceId: "first-device", name: "Desktop", publicKey: "public", type: "desktop" } });
  });
});
