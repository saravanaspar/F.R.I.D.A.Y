import { describe, expect, it } from "vitest";
import { decodeClientMessage, encodeClientMessage } from "../src/index.js";

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
});
