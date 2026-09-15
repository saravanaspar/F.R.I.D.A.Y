import { chmodSync, closeSync, constants as fsConstants, mkdirSync, openSync, writeSync } from "node:fs";
import { reportOperationalError } from "@friday/operational-errors";
import { join } from "node:path";

const MAX_TRACE_DEPTH = 8;
const MAX_TRACE_ARRAY = 256;
const MAX_TRACE_STRING = 256_000;

export type RoutingTraceJson = null | boolean | number | string | RoutingTraceJson[] | { [key: string]: RoutingTraceJson };

export interface RoutingTraceRecord {
  readonly timestamp: string;
  readonly traceKind: "single" | "batch";
  readonly provider: string;
  readonly model: string;
  readonly messageIds: readonly string[];
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly rawResponseText?: string | undefined;
  readonly providerContent?: RoutingTraceJson | undefined;
  readonly parsedResponse?: RoutingTraceJson | undefined;
  readonly stopReason?: string | undefined;
  readonly usage?: RoutingTraceJson | undefined;
  readonly error?: Readonly<{ name: string; message: string }> | undefined;
}

function boundedString(value: string): string {
  const normalized = value.replaceAll("\u0000", "\ufffd");
  return normalized.length <= MAX_TRACE_STRING
    ? normalized
    : `${normalized.slice(0, MAX_TRACE_STRING)}\u2026`;
}

export function traceJson(value: unknown, depth = 0, seen = new WeakSet<object>()): RoutingTraceJson {
  if (value === null) return null;
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return String(value);
  if (depth >= MAX_TRACE_DEPTH) return "[depth-limit]";
  if (typeof value !== "object") return boundedString(String(value));
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, MAX_TRACE_ARRAY).map((item) => traceJson(item, depth + 1, seen));
    }
    const output: Record<string, RoutingTraceJson> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_TRACE_ARRAY)) {
      output[boundedString(key)] = traceJson(item, depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function routingTracePath(stateDir: string, timestamp = new Date()): string {
  return join(stateDir, "traces", "routing", `${timestamp.toISOString().slice(0, 10)}.jsonl`);
}

export function appendRoutingTrace(stateDir: string, record: RoutingTraceRecord): void {
  const directory = join(stateDir, "traces", "routing");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch (error) {
    reportOperationalError({
      component: "routing",
      operation: "tighten routing trace directory permissions",
      error,
      severity: "warn",
    });
  }
  const path = routingTracePath(stateDir, new Date(record.timestamp));
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | noFollow, 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, "utf8");
  } finally {
    closeSync(descriptor);
  }
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    reportOperationalError({
      component: "routing",
      operation: "tighten routing trace file permissions",
      error,
      severity: "warn",
    });
  }
}
