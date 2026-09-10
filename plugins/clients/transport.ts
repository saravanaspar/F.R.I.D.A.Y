import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { reportOperationalError, sanitizeOperationalError } from "@friday/operational-errors";
import { decodeClientMessage, encodeClientMessage, type ClientAuthenticate, type ClientErrorMessage, type ClientSignalMessage, type ServerSignalMessage } from "@friday/client-protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { DevicesService, DeviceType } from "../devices/contract.js";
import type { ClientConnection, ClientGatewayListenOptions, ClientGatewayResources, ClientGatewayServerStatus, ClientGatewayService } from "./contract.js";

const MAX_HTTP_BODY_BYTES = 64 * 1024;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 2 * 1024 * 1024;

export interface ClientTransportController {
  readonly status: () => ClientGatewayServerStatus;
  readonly stop: () => Promise<void>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > MAX_HTTP_BODY_BYTES) throw new Error("request body exceeds 64 KiB");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new Error("request body must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function requiredText(input: Record<string, unknown>, name: string, maximum = 16_384): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${name} is required`);
  return value;
}

function requestedDeviceType(value: unknown): DeviceType {
  if (value === "desktop" || value === "android" || value === "computer-node" || value === "test") return value;
  throw new Error("type is invalid");
}

function cursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("afterSequence must be a non-negative integer");
  return value;
}

function pathOf(request: IncomingMessage): string {
  try { return new URL(request.url ?? "/", "http://localhost").pathname; } catch { return "/invalid"; }
}

function safeFailure(error: unknown): { readonly code: string; readonly message: string } {
  const safe = sanitizeOperationalError(error);
  return { code: safe.code, message: safe.safeMessage };
}

function sendSocket(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(encodeClientMessage(value as Parameters<typeof encodeClientMessage>[0]));
}

function sendSocketError(socket: WebSocket, requestId: string, error: unknown): void {
  const failure = safeFailure(error);
  const message: ClientErrorMessage = Object.freeze({ kind: "client.error", protocolVersion: 1, requestId, code: failure.code, message: failure.message });
  sendSocket(socket, message);
}

export async function startClientTransport(
  gateway: ClientGatewayService,
  devices: DevicesService,
  options: ClientGatewayListenOptions = {},
  resources: ClientGatewayResources = {},
): Promise<ClientTransportController> {
  const host = options.host?.trim() || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") throw new Error("client gateway must bind to loopback; use Caddy for public TLS exposure");
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("client gateway port must be from 0 to 65535");
  const authenticationTimeoutMs = options.authenticationTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(authenticationTimeoutMs) || authenticationTimeoutMs < 1_000 || authenticationTimeoutMs > 60_000) throw new Error("authenticationTimeoutMs must be from 1000 to 60000");

  const socketsByDevice = new Map<string, Set<WebSocket>>();
  const server = createServer(async (request, response) => {
    try {
      const path = pathOf(request);
      if (request.method === "GET" && path === "/health") {
        json(response, 200, { status: "ok", protocolVersion: 1 });
        return;
      }
      if (request.method !== "POST") { json(response, 404, { error: "not_found" }); return; }
      const body = await requestJson(request);
      if (path === "/v1/pairings") {
        const pairing = await devices.beginPairing({
          deviceId: requiredText(body, "deviceId", 128),
          name: requiredText(body, "name", 128),
          type: requestedDeviceType(body.type),
          publicKey: requiredText(body, "publicKey"),
        });
        json(response, 202, { pairingId: pairing.pairingId, challenge: pairing.challenge, expiresAt: pairing.expiresAt });
        return;
      }
      if (path === "/v1/auth/challenge") {
        json(response, 200, await devices.issueChallenge(requiredText(body, "deviceId", 128)));
        return;
      }
      if (path === "/v1/events/replay") {
        const connection = await gateway.connect({ deviceId: requiredText(body, "deviceId", 128), challenge: requiredText(body, "challenge", 512), signature: requiredText(body, "signature") });
        try { json(response, 200, { events: connection.resume(cursor(body.afterSequence)), latestSequence: gateway.latestSequence() }); }
        finally { connection.close(); }
        return;
      }
      const authenticatedDevice = async (): Promise<string> => {
        const deviceId = requiredText(body, "deviceId", 128);
        await gateway.connect({ deviceId, challenge: requiredText(body, "challenge", 512), signature: requiredText(body, "signature") }).then((connection) => { connection.close(); });
        return deviceId;
      };
      if (path === "/v1/agent-profiles/list") {
        await authenticatedDevice();
        if (!resources.agentProfiles) throw new Error("agent profiles capability is unavailable");
        json(response, 200, { profiles: resources.agentProfiles.list() });
        return;
      }
      if (path === "/v1/agent-profiles/create") {
        await authenticatedDevice();
        if (!resources.agentProfiles) throw new Error("agent profiles capability is unavailable");
        const profile = await resources.agentProfiles.create({
          id: typeof body.id === "string" ? body.id : undefined,
          name: requiredText(body, "name", 128),
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.roleInstructions === "string" ? { roleInstructions: body.roleInstructions } : {}),
          ...(typeof body.memoryScope === "string" ? { memoryScope: body.memoryScope } : {}),
        });
        json(response, 201, { profile });
        return;
      }
      if (path === "/v1/agent-profiles/update") {
        await authenticatedDevice();
        if (!resources.agentProfiles) throw new Error("agent profiles capability is unavailable");
        const profile = await resources.agentProfiles.update(requiredText(body, "profileId", 96), {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.roleInstructions === "string" ? { roleInstructions: body.roleInstructions } : {}),
          ...(typeof body.memoryScope === "string" ? { memoryScope: body.memoryScope } : {}),
          ...(typeof body.notificationPreference === "string" ? { notificationPreference: body.notificationPreference as "all" | "important" | "muted" } : {}),
          ...(typeof body.approvalPolicy === "string" ? { approvalPolicy: body.approvalPolicy } : {}),
        });
        json(response, 200, { profile });
        return;
      }
      if (path === "/v1/agent-profiles/remove") {
        await authenticatedDevice();
        if (!resources.agentProfiles) throw new Error("agent profiles capability is unavailable");
        json(response, 200, { removed: await resources.agentProfiles.remove(requiredText(body, "profileId", 96)) });
        return;
      }
      if (path === "/v1/conversations/list") {
        await authenticatedDevice();
        if (!resources.conversations) throw new Error("conversations capability is unavailable");
        json(response, 200, { conversations: resources.conversations.list() });
        return;
      }
      if (path === "/v1/conversations/create") {
        await authenticatedDevice();
        if (!resources.conversations) throw new Error("conversations capability is unavailable");
        const conversation = await resources.conversations.create({ type: body.type as "direct" | "group", title: typeof body.title === "string" ? body.title : undefined, sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined, participants: body.participants as never });
        json(response, 201, { conversation });
        return;
      }
      if (path === "/v1/conversations/update") {
        await authenticatedDevice();
        if (!resources.conversations) throw new Error("conversations capability is unavailable");
        const conversation = await resources.conversations.update(requiredText(body, "conversationId", 256), {
          ...(body.title === undefined ? {} : { title: requiredText(body, "title", 256) }),
          ...(body.pinned === undefined ? {} : { pinned: body.pinned === true }),
          ...(body.hidden === undefined ? {} : { hidden: body.hidden === true }),
          ...(body.notificationsEnabled === undefined ? {} : { notificationsEnabled: body.notificationsEnabled === true }),
        });
        json(response, 200, { conversation });
        return;
      }
      if (path === "/v1/conversations/mark-read") {
        await authenticatedDevice();
        if (!resources.conversations) throw new Error("conversations capability is unavailable");
        json(response, 200, { conversation: await resources.conversations.markRead(requiredText(body, "conversationId", 256), cursor(body.sequence)) });
        return;
      }
      if (path === "/v1/conversations/mentions/resolve") {
        await authenticatedDevice();
        if (!resources.conversations) throw new Error("conversations capability is unavailable");
        json(response, 200, { mentions: resources.conversations.resolveMentions(requiredText(body, "conversationId", 256), requiredText(body, "text", 128_000)) });
        return;
      }
      if (path === "/v1/conversations/threads/create") {
        await authenticatedDevice();
        if (!resources.conversations) throw new Error("conversations capability is unavailable");
        json(response, 201, { thread: await resources.conversations.createThread(requiredText(body, "conversationId", 256), requiredText(body, "rootMessageId", 256)) });
        return;
      }
      if (path === "/v1/conversations/threads/reply") {
        await authenticatedDevice();
        if (!resources.conversations) throw new Error("conversations capability is unavailable");
        json(response, 200, { thread: await resources.conversations.recordThreadReply(requiredText(body, "threadId", 256)) });
        return;
      }
      if (path === "/v1/conversations/reactions/add") {
        await authenticatedDevice();
        if (!resources.conversations) throw new Error("conversations capability is unavailable");
        json(response, 201, { reaction: await resources.conversations.addReaction(requiredText(body, "messageId", 256), requiredText(body, "actorId", 256), requiredText(body, "emoji", 32)) });
        return;
      }
      if (path === "/v1/conversations/reactions/remove") {
        await authenticatedDevice();
        if (!resources.conversations) throw new Error("conversations capability is unavailable");
        json(response, 200, { removed: await resources.conversations.removeReaction(requiredText(body, "messageId", 256), requiredText(body, "actorId", 256), requiredText(body, "emoji", 32)) });
        return;
      }
      if (path === "/v1/conversations/reactions/list") {
        await authenticatedDevice();
        if (!resources.conversations) throw new Error("conversations capability is unavailable");
        json(response, 200, { reactions: resources.conversations.listReactions(requiredText(body, "messageId", 256)) });
        return;
      }
      if (path === "/v1/turns") {
        const deviceId = await authenticatedDevice();
        if (!resources.conversations || !resources.turnRuntime) throw new Error("conversation turn capabilities are unavailable");
        const text = requiredText(body, "text", 128_000);
        const profileId = typeof body.agentProfileId === "string" ? body.agentProfileId.trim() : undefined;
        const profile = profileId ? resources.agentProfiles?.get(profileId) : undefined;
        if (profileId && !profile) throw new Error("agent profile not found");
        const conversationId = typeof body.conversationId === "string" && body.conversationId.trim()
          ? body.conversationId.trim()
          : profile?.defaultConversationId;
        if (!conversationId) throw new Error("conversationId is required unless the Agent Profile has a default conversation");
        const conversation = resources.conversations.get(conversationId);
        if (!conversation) throw new Error("conversation not found");
        let reply = "";
        const result = await resources.turnRuntime.submit({
          id: typeof body.turnId === "string" ? body.turnId : randomUUID(),
          principal: { authority: "local", channel: "client", accountId: deviceId, conversationId: conversation.id, senderId: "operator", ...(typeof body.threadId === "string" ? { threadId: body.threadId } : {}) },
          text,
          timestamp: Date.now(),
          agentProfileId: profileId,
          destinationId: `session:${conversation.sessionId}`,
          reply: async (value) => { reply = value; },
        });
        json(response, 202, { result, reply });
        return;
      }
      if (path === "/v1/session-jobs/redirect") {
        await authenticatedDevice();
        if (!resources.sessionJobs) throw new Error("session jobs capability is unavailable");
        const directive = await resources.sessionJobs.redirect(requiredText(body, "jobId", 96), requiredText(body, "text", 128_000));
        json(response, 202, { directive });
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      const failure = safeFailure(error);
      json(response, 400, { error: failure.code, message: failure.message });
    }
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES });
  server.on("upgrade", (request, socket, head) => {
    if (pathOf(request) !== "/v1/stream") { socket.destroy(); return; }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      let connection: ClientConnection | undefined;
      let authenticatedDeviceId: string | undefined;
      const timeout = setTimeout(() => websocket.close(4401, "authentication timeout"), authenticationTimeoutMs);
      timeout.unref();

      const cleanup = (): void => {
        clearTimeout(timeout);
        connection?.close();
        if (!authenticatedDeviceId) return;
        const sockets = socketsByDevice.get(authenticatedDeviceId);
        sockets?.delete(websocket);
        if (sockets?.size === 0) socketsByDevice.delete(authenticatedDeviceId);
      };

      websocket.on("message", (data) => {
        void (async () => {
          let message: ReturnType<typeof decodeClientMessage>;
          try { message = decodeClientMessage(data.toString()); }
          catch (error) { sendSocketError(websocket, "invalid", error); return; }
          if (!connection) {
            if (message.kind !== "client.authenticate") { sendSocketError(websocket, message.requestId, new Error("authentication is required")); return; }
            const auth = message as ClientAuthenticate;
            try {
              connection = await gateway.connect(auth);
              authenticatedDeviceId = auth.deviceId;
              clearTimeout(timeout);
              const deviceSockets = socketsByDevice.get(auth.deviceId) ?? new Set<WebSocket>();
              deviceSockets.add(websocket);
              socketsByDevice.set(auth.deviceId, deviceSockets);
              sendSocket(websocket, { kind: "client.ready", protocolVersion: 1, requestId: auth.requestId, connectionId: connection.connectionId, latestSequence: gateway.latestSequence() });
              for (const event of connection.resume(auth.afterSequence ?? 0)) sendSocket(websocket, event);
              connection.subscribe((event) => sendSocket(websocket, event));
            } catch (error) { sendSocketError(websocket, auth.requestId, error); websocket.close(4401, "authentication failed"); }
            return;
          }
          if (message.kind !== "webrtc.offer" && message.kind !== "webrtc.answer" && message.kind !== "webrtc.ice") {
            sendSocketError(websocket, message.requestId, new Error("message is not valid after authentication"));
            return;
          }
          const signal = message as ClientSignalMessage;
          const targetSockets = socketsByDevice.get(signal.targetDeviceId);
          if (!targetSockets?.size) { sendSocketError(websocket, signal.requestId, new Error("target device is not connected")); return; }
          const relayed: ServerSignalMessage = Object.freeze({ kind: signal.kind, protocolVersion: 1, requestId: signal.requestId, sourceDeviceId: authenticatedDeviceId!, sessionId: signal.sessionId, payload: signal.payload });
          for (const target of targetSockets) sendSocket(target, relayed);
        })().catch((error: unknown) => {
          reportOperationalError({ component: "clients", operation: "process WebSocket client message", error });
          sendSocketError(websocket, "internal", error);
        });
      });
      websocket.on("close", cleanup);
      websocket.on("error", (error) => {
        reportOperationalError({ component: "clients", operation: "serve WebSocket client", error, severity: "warn", outcome: "degraded" });
        cleanup();
      });
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => { server.off("listening", onListening); rejectListen(error); };
    const onListening = (): void => { server.off("error", onError); resolveListen(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("client gateway did not expose a listening address");
  const startedAt = new Date().toISOString();
  let running = true;
  return Object.freeze({
    status: () => Object.freeze({ running, host, port: address.port, startedAt, connections: gateway.connections().length, latestSequence: gateway.latestSequence() }),
    stop: async () => {
      if (!running) return;
      running = false;
      for (const sockets of socketsByDevice.values()) for (const socket of sockets) socket.close(1001, "gateway stopping");
      socketsByDevice.clear();
      await new Promise<void>((resolveClose, rejectClose) => websocketServer.close((error) => error ? rejectClose(error) : resolveClose()));
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    },
  });
}
