import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  type SystemJsonObject,
} from "../system/contract.js";
import {
  EVENTS_CAPABILITY,
  type EventDeliveryStatus,
  type EventWorkerOptions,
} from "./contract.js";
import { createEventsService } from "./events.js";
import {
  isLifecycleRestartEnvironment,
  LIFECYCLE_HANDOFF_CONTRIBUTION,
} from "../lifecycle/contract.js";

export interface EventsPluginOptions {
  readonly autoStartWorker?: boolean | undefined;
  readonly worker?: EventWorkerOptions | undefined;
}

function optionalString(input: Readonly<SystemJsonObject>, name: string, maximum = 256): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function optionalInteger(
  input: Readonly<SystemJsonObject>,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function optionalOrder(input: Readonly<SystemJsonObject>): "asc" | "desc" | undefined {
  const value = input.order;
  if (value === undefined) return undefined;
  if (value === "asc" || value === "desc") return value;
  throw new Error("order must be asc or desc");
}

function optionalDeliveryStatus(input: Readonly<SystemJsonObject>): EventDeliveryStatus | undefined {
  const value = input.status;
  if (value === undefined) return undefined;
  if (
    value === "running"
    || value === "success"
    || value === "error"
    || value === "cancelled"
    || value === "abandoned"
    || value === "dead-letter"
  ) return value;
  throw new Error("status must be running, success, error, cancelled, abandoned, or dead-letter");
}

function optionalTypes(input: Readonly<SystemJsonObject>): readonly string[] | undefined {
  const value = input.types;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("types must be an array of strings");
  const types = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`types[${index}] must be a non-empty string`);
    const normalized = entry.trim();
    if (normalized.length > 256) throw new Error(`types[${index}] exceeds 256 characters`);
    return normalized;
  });
  if (types.length > 32) throw new Error("types may contain at most 32 entries");
  return Object.freeze(types);
}

export function createEventsPlugin(options: EventsPluginOptions = {}): FridayPlugin {
  return definePlugin({ id: "events", provides: [EVENTS_CAPABILITY] }, (ctx) => {
    const events = createEventsService();
    ctx.services.provide(EVENTS_CAPABILITY, events);
    ctx.effect(() => events.close());

    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "events",
      label: "Events",
      snapshot: () => ({
        worker: events.workerStatus(),
        consumerCount: events.consumers().length,
      }),
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "events.replay",
      label: "Event replay",
      description: "Read a bounded slice of the immutable FRIDAY event log.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          afterSequence: { type: "integer", minimum: 0 },
          beforeSequence: { type: "integer", minimum: 0 },
          types: { type: "array", items: { type: "string" }, maxItems: 32 },
          source: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          order: { type: "string", enum: ["asc", "desc"] },
        },
        additionalProperties: false,
      }),
      execute(input) {
        const afterSequence = optionalInteger(input, "afterSequence", 0);
        const beforeSequence = optionalInteger(input, "beforeSequence", 0);
        const types = optionalTypes(input);
        const source = optionalString(input, "source");
        const limit = optionalInteger(input, "limit", 1, 500);
        const order = optionalOrder(input);
        return events.replay({
          ...(afterSequence === undefined ? {} : { afterSequence }),
          ...(beforeSequence === undefined ? {} : { beforeSequence }),
          ...(types === undefined ? {} : { types }),
          ...(source === undefined ? {} : { source }),
          ...(limit === undefined ? {} : { limit }),
          ...(order === undefined ? {} : { order }),
        });
      },
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "events.consumers",
      label: "Event consumers",
      description: "List durable FRIDAY event consumers and their cursors.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      execute: () => events.consumers(),
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "events.delivery-history",
      label: "Event delivery history",
      description: "Read bounded durable event-consumer delivery history.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          consumerId: { type: "string" },
          eventId: { type: "string" },
          status: { type: "string", enum: ["running", "success", "error", "cancelled", "abandoned", "dead-letter"] },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      }),
      execute(input) {
        const consumerId = optionalString(input, "consumerId");
        const eventId = optionalString(input, "eventId");
        const status = optionalDeliveryStatus(input);
        const limit = optionalInteger(input, "limit", 1, 500);
        return events.deliveryHistory({
          ...(consumerId === undefined ? {} : { consumerId }),
          ...(eventId === undefined ? {} : { eventId }),
          ...(status === undefined ? {} : { status }),
          ...(limit === undefined ? {} : { limit }),
        });
      },
    });

    if (options.autoStartWorker === true) {
      ctx.contribute(LIFECYCLE_HANDOFF_CONTRIBUTION, {
        id: "events.worker",
        activate: () => events.startWorker(options.worker),
        quiesce: () => events.stopWorker(),
      });
    }
    if (options.autoStartWorker === true && !isLifecycleRestartEnvironment()) {
      ctx.afterReady(() => events.startWorker(options.worker));
    }
  });
}

export default createEventsPlugin({ autoStartWorker: true });
export * from "./contract.js";
export { createEventsService, type EventsServiceOptions } from "./events.js";
export { EVENTS_DATABASE_FILE_NAME, getEventsDatabasePath, getEventsStateDir } from "./store.js";
