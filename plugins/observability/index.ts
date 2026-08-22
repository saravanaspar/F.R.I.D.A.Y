import type { FridayPlugin } from "../../src/plugin.js";
import { installOperationalErrorSink } from "@friday/operational-errors";
import { definePlugin } from "../capabilities/protocol.js";
import { EVENTS_CAPABILITY, type EventRecord } from "../events/contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  type SystemJsonObject,
} from "../system/contract.js";
import {
  OBSERVABILITY_CAPABILITY,
  type ObservabilityLogLevel,
  type ObservabilitySpanStatus,
  type ModelUsageQuery,
} from "./contract.js";
import { createObservabilityService } from "./observability.js";

function eventLogLevel(event: EventRecord): ObservabilityLogLevel {
  const type = event.type.toLowerCase();
  if (type.includes("failed") || type.includes("error") || type.includes("dead-letter")) return "warn";
  return "info";
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

function optionalLimit(input: Readonly<SystemJsonObject>, fallback = 10): number {
  const value = input.limit;
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 500) {
    throw new Error("limit must be an integer from 1 to 500");
  }
  return value as number;
}

function optionalLogLevel(input: Readonly<SystemJsonObject>): ObservabilityLogLevel | undefined {
  const value = input.level;
  if (value === undefined) return undefined;
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  throw new Error("level must be debug, info, warn, or error");
}

function optionalSpanStatus(input: Readonly<SystemJsonObject>): ObservabilitySpanStatus | undefined {
  const value = input.status;
  if (value === undefined) return undefined;
  if (value === "ok" || value === "error" || value === "cancelled") return value;
  throw new Error("status must be ok, error, or cancelled");
}

function usageQuery(input: Readonly<SystemJsonObject>, includeLimit = false): ModelUsageQuery {
  const since = optionalString(input, "since", 64);
  const until = optionalString(input, "until", 64);
  for (const [label, value] of [["since", since], ["until", until]] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO date/time`);
  }
  const provider = optionalString(input, "provider");
  const model = optionalString(input, "model");
  const sessionId = optionalString(input, "sessionId");
  const agentId = optionalString(input, "agentId");
  const jobId = optionalString(input, "jobId");
  return {
    ...(since === undefined ? {} : { since: new Date(since).toISOString() }),
    ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(includeLimit ? { limit: optionalLimit(input, 100) } : {}),
  };
}

const USAGE_QUERY_PROPERTIES = Object.freeze({
  since: { type: "string", description: "ISO start time" },
  until: { type: "string", description: "ISO end time" },
  provider: { type: "string" },
  model: { type: "string" },
  sessionId: { type: "string" },
  agentId: { type: "string" },
  jobId: { type: "string" },
});

const observabilityPlugin: FridayPlugin = definePlugin({
  id: "observability",
  requires: [EVENTS_CAPABILITY],
  provides: [OBSERVABILITY_CAPABILITY],
}, (ctx) => {
  const events = ctx.services.require(EVENTS_CAPABILITY);
  const observability = createObservabilityService();
  const uninstallOperationalErrorSink = installOperationalErrorSink((event) => {
    observability.log({
      at: event.at,
      level: event.severity,
      component: event.component,
      message: `Operational failure: ${event.operation}`,
      fields: {
        operation: event.operation,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
      },
    });
    observability.increment("friday.operational_failures.total", 1, {
      component: event.component,
      operation: event.operation,
      severity: event.severity,
    });
  });

  ctx.effect(events.subscribe((event) => {
    observability.increment("friday.events.total", 1, {
      source: event.source,
      type: event.type,
    });
    observability.log({
      at: event.publishedAt,
      level: eventLogLevel(event),
      component: "events",
      message: event.type,
      fields: {
        eventId: event.id,
        sequence: event.sequence,
        source: event.source,
        ...(event.subject === undefined ? {} : { subject: event.subject }),
        ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
      },
    });
  }));
  ctx.effect(() => observability.close());
  // Registered after close so reverse-order disposal removes the global sink
  // before closing its durable destination.
  ctx.effect(uninstallOperationalErrorSink);

  ctx.services.provide(OBSERVABILITY_CAPABILITY, observability);
  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
    id: "observability",
    label: "Observability",
    snapshot: () => observability.status(),
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "observability.logs",
    label: "Observability logs",
    description: "Query bounded redacted FRIDAY operational logs. Default to the latest 10 records when the user does not specify a count; honor explicit counts up to 500.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        level: { type: "string", enum: ["debug", "info", "warn", "error"] },
        component: { type: "string" },
        traceId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    }),
    execute(input) {
      const level = optionalLogLevel(input);
      const component = optionalString(input, "component");
      const traceId = optionalString(input, "traceId");
      const limit = optionalLimit(input);
      return observability.logs({
        ...(level === undefined ? {} : { level }),
        ...(component === undefined ? {} : { component }),
        ...(traceId === undefined ? {} : { traceId }),
        limit,
      });
    },
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "observability.usage",
    label: "Model token and cost usage",
    description: "Summarize provider-reported tokens, cache hit rate, actual provider/billing cost when available, separate catalog estimates, and attribution by agent/subagent, model, and background job. Use this for natural-language usage questions from any connected channel.",
    parameters: Object.freeze({ type: "object", properties: USAGE_QUERY_PROPERTIES, additionalProperties: false }),
    execute(input) {
      if (!observability.usageSummary) {
        throw new Error("The active observability provider does not support usage summaries.");
      }
      return observability.usageSummary(usageQuery(input));
    },
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "observability.usage-records",
    label: "Model usage records",
    description: "Query bounded individual model-usage records for diagnosis.",
    parameters: Object.freeze({
      type: "object",
      properties: { ...USAGE_QUERY_PROPERTIES, limit: { type: "integer", minimum: 1, maximum: 500 } },
      additionalProperties: false,
    }),
    execute(input) {
      if (!observability.usage) {
        throw new Error("The active observability provider does not support usage records.");
      }
      return observability.usage(usageQuery(input, true));
    },
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "observability.metrics",
    label: "Observability metrics",
    description: "Show current FRIDAY metric series, optionally for one metric name.",
    parameters: Object.freeze({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    }),
    execute(input) {
      return observability.metrics(optionalString(input, "name"));
    },
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "observability.spans",
    label: "Observability spans",
    description: "Query bounded FRIDAY tracing spans. Default to the latest 10 spans when the user does not specify a count; honor explicit counts up to 500.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        traceId: { type: "string" },
        component: { type: "string" },
        name: { type: "string" },
        status: { type: "string", enum: ["ok", "error", "cancelled"] },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    }),
    execute(input) {
      const traceId = optionalString(input, "traceId");
      const component = optionalString(input, "component");
      const name = optionalString(input, "name");
      const status = optionalSpanStatus(input);
      const limit = optionalLimit(input);
      return observability.spans({
        ...(traceId === undefined ? {} : { traceId }),
        ...(component === undefined ? {} : { component }),
        ...(name === undefined ? {} : { name }),
        ...(status === undefined ? {} : { status }),
        limit,
      });
    },
  });
});

export default observabilityPlugin;
export * from "./contract.js";
export { createObservabilityService, type ObservabilityServiceOptions } from "./observability.js";
export {
  OBSERVABILITY_DATABASE_FILE_NAME,
  getObservabilityDatabasePath,
  getObservabilityStateDir,
} from "./store.js";
