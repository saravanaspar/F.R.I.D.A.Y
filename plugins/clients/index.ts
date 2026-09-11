import { randomUUID } from "node:crypto";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { DEVICES_CAPABILITY } from "../devices/contract.js";
import { AGENT_PROFILES_CAPABILITY } from "../agent-profiles/contract.js";
import { CONVERSATIONS_CAPABILITY } from "../conversations/contract.js";
import { EVENTS_CAPABILITY, type EventRecord } from "../events/contract.js";
import { TURN_LOOP_CAPABILITY } from "../turn-loop/contract.js";
import { SESSION_JOBS_CAPABILITY } from "../session-jobs/contract.js";
import { PROJECTS_CAPABILITY } from "../projects/contract.js";
import { COMPUTER_CAPABILITY } from "../computer/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION } from "../system/contract.js";
import { CLIENT_GATEWAY_CAPABILITY, type ClientConnection, type ClientConnectInput, type ClientEventMessage, type ClientGatewayListenOptions, type ClientGatewayServerStatus, type ClientGatewayService } from "./contract.js";
import { startClientTransport, type ClientTransportController } from "./transport.js";

function eventMessage(event: EventRecord, requestId: string): ClientEventMessage {
  return Object.freeze({
    kind: "event", protocolVersion: 1, requestId,
    event: Object.freeze({
      sequence: event.sequence, id: event.id, type: event.type, source: event.source,
      ...(event.subject === undefined ? {} : { subject: event.subject }),
      occurredAt: event.occurredAt, publishedAt: event.publishedAt, data: event.data, metadata: event.metadata,
    }),
  });
}

const clientsPlugin: FridayPlugin = definePlugin({
  id: "clients",
  requires: [DEVICES_CAPABILITY, EVENTS_CAPABILITY],
  optional: [AGENT_PROFILES_CAPABILITY, CONVERSATIONS_CAPABILITY, TURN_LOOP_CAPABILITY, SESSION_JOBS_CAPABILITY, PROJECTS_CAPABILITY, COMPUTER_CAPABILITY],
  provides: [CLIENT_GATEWAY_CAPABILITY],
}, (ctx) => {
  const devices = ctx.services.require(DEVICES_CAPABILITY);
  const events = ctx.services.require(EVENTS_CAPABILITY);
  const connections = new Map<string, { readonly connectionId: string; readonly deviceId: string; readonly connectedAt: string; readonly close: () => void }>();
  let transport: ClientTransportController | undefined;

  const service: ClientGatewayService = Object.freeze({
    connect: async (input: ClientConnectInput) => {
      const device = await devices.authenticate(input.deviceId, input.challenge, input.signature);
      const connectionId = randomUUID();
      const connectedAt = new Date().toISOString();
      const listeners = new Set<(message: ClientEventMessage) => void>();
      let closed = false;
      const unsubscribe = events.subscribe((event) => {
        if (closed) return;
        const message = eventMessage(event, connectionId);
        for (const listener of listeners) listener(message);
      });
      const close = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        connections.delete(connectionId);
        listeners.clear();
      };
      const connection: ClientConnection = Object.freeze({
        connectionId, deviceId: device.deviceId, connectedAt,
        resume: (afterSequence = 0) => {
          if (closed) throw new Error("client connection is closed");
          if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative integer");
          return Object.freeze(events.replay({ afterSequence, order: "asc" }).map((event) => eventMessage(event, connectionId)));
        },
        subscribe: (listener: (message: ClientEventMessage) => void) => {
          if (closed) throw new Error("client connection is closed");
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close,
      });
      connections.set(connectionId, { connectionId, deviceId: device.deviceId, connectedAt, close });
      return connection;
    },
    connections: () => Object.freeze([...connections.values()].map(({ connectionId, deviceId, connectedAt }) => Object.freeze({ connectionId, deviceId, connectedAt }))),
    latestSequence: () => events.storageStatus().latestSequence,
    start: async (options: ClientGatewayListenOptions = {}) => {
      if (!transport) transport = await startClientTransport(service, devices, options, {
        agentProfiles: ctx.services.optional(AGENT_PROFILES_CAPABILITY),
        conversations: ctx.services.optional(CONVERSATIONS_CAPABILITY),
        turnRuntime: ctx.services.optional(TURN_LOOP_CAPABILITY),
        sessionJobs: ctx.services.optional(SESSION_JOBS_CAPABILITY),
        projects: ctx.services.optional(PROJECTS_CAPABILITY),
        computer: ctx.services.optional(COMPUTER_CAPABILITY),
      });
      return service.serverStatus();
    },
    stop: async () => {
      const active = transport;
      transport = undefined;
      if (active) await active.stop();
      for (const connection of connections.values()) connection.close();
    },
    serverStatus: (): ClientGatewayServerStatus => transport?.status() ?? Object.freeze({ running: false, connections: service.connections().length, latestSequence: service.latestSequence() }),
  });
  ctx.services.provide(CLIENT_GATEWAY_CAPABILITY, service);
  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, { id: "clients", label: "Client Gateway", snapshot: () => service.serverStatus() });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "clients.start", label: "Start client gateway", description: "Start the loopback HTTP/WebSocket gateway. Put Caddy in front for public TLS.",
    parameters: Object.freeze({ type: "object", properties: { host: { type: "string" }, port: { type: "integer", minimum: 0, maximum: 65535 } }, additionalProperties: false }),
    permission: () => ({ id: "clients.start", effect: "system-write", resource: "clients:gateway", network: true }),
    execute: async (input) => service.start({ ...(typeof input.host === "string" ? { host: input.host } : {}), ...(typeof input.port === "number" ? { port: input.port } : {}) }),
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "clients.stop", label: "Stop client gateway", description: "Stop the client gateway and close all client connections.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission: () => ({ id: "clients.stop", effect: "system-write", resource: "clients:gateway", network: false }),
    execute: async () => { await service.stop(); return service.serverStatus(); },
  });
  ctx.effect(() => { for (const connection of connections.values()) connection.close(); });
  ctx.effect(() => service.stop());
});

export default clientsPlugin;
export * from "./contract.js";
