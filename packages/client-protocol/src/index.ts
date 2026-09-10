export type ClientDeviceType = "desktop" | "android" | "computer-node" | "test";

export interface ClientDeviceDescriptor {
  readonly deviceId: string;
  readonly name: string;
  readonly type: ClientDeviceType;
}

export interface ClientHello {
  readonly kind: "client.hello";
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly device: ClientDeviceDescriptor;
  readonly challenge?: string | undefined;
}

export interface ClientResume {
  readonly kind: "client.resume";
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly deviceId: string;
  readonly afterSequence: number;
}

export interface ClientAuthenticate {
  readonly kind: "client.authenticate";
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly deviceId: string;
  readonly challenge: string;
  readonly signature: string;
  readonly afterSequence?: number | undefined;
}

export interface ClientSignalMessage {
  readonly kind: "webrtc.offer" | "webrtc.answer" | "webrtc.ice";
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly targetDeviceId: string;
  readonly sessionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ServerSignalMessage {
  readonly kind: "webrtc.offer" | "webrtc.answer" | "webrtc.ice";
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly sourceDeviceId: string;
  readonly sessionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ClientEventMessage {
  readonly kind: "event";
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly event: {
    readonly sequence: number;
    readonly id: string;
    readonly type: string;
    readonly source: string;
    readonly subject?: string | undefined;
    readonly occurredAt: string;
    readonly publishedAt: string;
    readonly data: unknown;
    readonly metadata: Readonly<Record<string, unknown>>;
  };
}

export interface ClientReadyMessage {
  readonly kind: "client.ready";
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly connectionId: string;
  readonly latestSequence: number;
}

export interface ClientErrorMessage {
  readonly kind: "client.error";
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly code: string;
  readonly message: string;
}

export type ClientProtocolMessage = ClientHello | ClientResume | ClientAuthenticate | ClientSignalMessage | ServerSignalMessage | ClientEventMessage | ClientReadyMessage | ClientErrorMessage;

export function encodeClientMessage(message: ClientProtocolMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeClientMessage(raw: string): ClientProtocolMessage {
  if (typeof raw !== "string" || raw.length > 2 * 1024 * 1024) throw new Error("client message is too large");
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error("client message must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("client message must be an object");
  const value = parsed as Record<string, unknown>;
  if (value.protocolVersion !== 1 || typeof value.kind !== "string" || typeof value.requestId !== "string" || !value.requestId.trim()) {
    throw new Error("unsupported or malformed client protocol message");
  }
  if (value.kind === "client.resume") {
    if (typeof value.deviceId !== "string" || !value.deviceId.trim() || typeof value.afterSequence !== "number" || !Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0) {
      throw new Error("client.resume is malformed");
    }
    return Object.freeze({ kind: "client.resume", protocolVersion: 1, requestId: value.requestId, deviceId: value.deviceId, afterSequence: value.afterSequence });
  }
  if (value.kind === "client.authenticate") {
    if (typeof value.deviceId !== "string" || !value.deviceId.trim() || typeof value.challenge !== "string" || !value.challenge.trim() || typeof value.signature !== "string" || !value.signature.trim()) {
      throw new Error("client.authenticate is malformed");
    }
    if (value.afterSequence !== undefined && (typeof value.afterSequence !== "number" || !Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0)) {
      throw new Error("client.authenticate afterSequence is malformed");
    }
    return Object.freeze({ kind: "client.authenticate", protocolVersion: 1, requestId: value.requestId, deviceId: value.deviceId, challenge: value.challenge, signature: value.signature, ...(value.afterSequence === undefined ? {} : { afterSequence: value.afterSequence }) });
  }
  if (value.kind === "webrtc.offer" || value.kind === "webrtc.answer" || value.kind === "webrtc.ice") {
    if (typeof value.sessionId !== "string" || !value.sessionId.trim() || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) {
      throw new Error(`${value.kind} is malformed`);
    }
    const payload = Object.freeze({ ...(value.payload as Record<string, unknown>) });
    if (typeof value.targetDeviceId === "string" && value.targetDeviceId.trim()) {
      return Object.freeze({ kind: value.kind, protocolVersion: 1, requestId: value.requestId, targetDeviceId: value.targetDeviceId, sessionId: value.sessionId, payload });
    }
    if (typeof value.sourceDeviceId === "string" && value.sourceDeviceId.trim()) {
      return Object.freeze({ kind: value.kind, protocolVersion: 1, requestId: value.requestId, sourceDeviceId: value.sourceDeviceId, sessionId: value.sessionId, payload });
    }
    throw new Error(`${value.kind} is malformed`);
  }
  if (value.kind !== "client.hello") throw new Error("unsupported client protocol message");
  const device = value.device;
  if (!device || typeof device !== "object" || Array.isArray(device)) throw new Error("client.hello device is malformed");
  const descriptor = device as Record<string, unknown>;
  if (typeof descriptor.deviceId !== "string" || !descriptor.deviceId.trim() || typeof descriptor.name !== "string" || !descriptor.name.trim() ||
      (descriptor.type !== "desktop" && descriptor.type !== "android" && descriptor.type !== "computer-node" && descriptor.type !== "test")) {
    throw new Error("client.hello device is malformed");
  }
  if (value.challenge !== undefined && typeof value.challenge !== "string") throw new Error("client.hello challenge is malformed");
  return Object.freeze({
    kind: "client.hello", protocolVersion: 1, requestId: value.requestId,
    device: Object.freeze({ deviceId: descriptor.deviceId, name: descriptor.name, type: descriptor.type }),
    ...(value.challenge === undefined ? {} : { challenge: value.challenge }),
  });
}
