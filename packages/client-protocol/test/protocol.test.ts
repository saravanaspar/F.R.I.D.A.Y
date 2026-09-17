import { describe, expect, it } from "vitest";
import { clientRequestSigningPayload, clientWebSocketSigningPayload, decodeClientMessage, encodeClientMessage } from "../src/index.js";

describe("client protocol", () => {
  it("round-trips a versioned hello", () => {
    const message = { kind: "client.hello" as const, protocolVersion: 1 as const, requestId: "req-1", device: { deviceId: "device-1", name: "Desktop", type: "desktop" as const } };
    expect(decodeClientMessage(encodeClientMessage(message))).toEqual(message);
  });

  it("rejects unsupported versions and invalid resume cursors", () => {
    expect(() => decodeClientMessage(JSON.stringify({ kind: "client.resume", protocolVersion: 2, requestId: "r", deviceId: "d", afterSequence: 0 }))).toThrow();
    expect(() => decodeClientMessage(JSON.stringify({ kind: "client.resume", protocolVersion: 1, requestId: "r", deviceId: "d", afterSequence: -1 }))).toThrow();
  });

  it("validates authentication and WebRTC signaling envelopes", () => {
    expect(decodeClientMessage(JSON.stringify({ kind: "client.authenticate", protocolVersion: 1, requestId: "r", deviceId: "d", challenge: "c", signature: "s", afterSequence: 4 }))).toMatchObject({ kind: "client.authenticate", afterSequence: 4 });
    expect(decodeClientMessage(JSON.stringify({ kind: "webrtc.offer", protocolVersion: 1, requestId: "r", targetDeviceId: "node", sessionId: "call", payload: { type: "offer", sdp: "bounded" } }))).toMatchObject({ kind: "webrtc.offer", targetDeviceId: "node" });
    expect(decodeClientMessage(JSON.stringify({ kind: "webrtc.answer", protocolVersion: 1, requestId: "r", sourceDeviceId: "node", sessionId: "call", payload: { type: "answer", sdp: "bounded" } }))).toMatchObject({ kind: "webrtc.answer", sourceDeviceId: "node" });
    expect(() => decodeClientMessage(JSON.stringify({ kind: "webrtc.ice", protocolVersion: 1, requestId: "r", targetDeviceId: "node", sessionId: "call", payload: "bad" }))).toThrow();
  });
  it("builds stable request-bound authentication payloads", () => {
    const first = clientRequestSigningPayload({
      challenge: "challenge-1",
      deviceId: "device-1",
      method: "post",
      path: "/v1/projects",
      body: { z: 1, nested: { b: true, a: "x" }, a: [3, 2, 1] },
    });
    const reordered = clientRequestSigningPayload({
      challenge: "challenge-1",
      deviceId: "device-1",
      method: "POST",
      path: "/v1/projects",
      body: { a: [3, 2, 1], nested: { a: "x", b: true }, z: 1 },
    });
    const changedPath = clientRequestSigningPayload({
      challenge: "challenge-1",
      deviceId: "device-1",
      method: "POST",
      path: "/v1/profiles",
      body: { a: [3, 2, 1], nested: { a: "x", b: true }, z: 1 },
    });

    expect(first).toBe(reordered);
    expect(first).not.toBe(changedPath);
    expect(first).toContain("friday-client-auth-v1");
  });

  it("binds websocket authentication to the resume cursor", () => {
    expect(clientWebSocketSigningPayload({ challenge: "c", deviceId: "d", afterSequence: 4 }))
      .not.toBe(clientWebSocketSigningPayload({ challenge: "c", deviceId: "d", afterSequence: 5 }));
  });

});
