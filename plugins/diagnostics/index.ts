import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isSensitiveFieldName, redactSensitiveText, reportOperationalError } from "@friday/operational-errors";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { OBSERVABILITY_CAPABILITY, type ObservabilityFields, type ObservabilityLogRecord, type ObservabilitySpanRecord } from "../observability/contract.js";
import { RUNTIME_SETTINGS_CAPABILITY } from "../runtime-settings/contract.js";
import { HOST_DOCTOR_CAPABILITY } from "../host-doctor/contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  type SystemJsonObject,
} from "../system/contract.js";
import { DIAGNOSTICS_CAPABILITY, type DiagnosticCrashRecord, type DiagnosticDoctorCheck, type DiagnosticSetupRecord, type DiagnosticsService } from "./contract.js";

const MAX_LOGS = 100;
const MAX_CRASHES = 20;

function optionalString(input: Readonly<SystemJsonObject>, name: string, maximum = 128): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function optionalLimit(input: Readonly<SystemJsonObject>): number | undefined {
  const value = input.limit;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_LOGS) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LOGS}`);
  }
  return value as number;
}

async function recentCrashRecords(home: string): Promise<readonly DiagnosticCrashRecord[]> {
  const path = join(home, "logs", "crashes.ndjson");
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Crash log path is unsafe: ${path}`);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error(`Crash log permissions are too broad: ${path}`);
    const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).slice(-MAX_CRASHES);
    const records: DiagnosticCrashRecord[] = [];
    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        records.push(Object.freeze({
          ...(typeof raw.at === "string" ? { at: raw.at } : {}),
          ...(typeof raw.operation === "string" ? { operation: redactSensitiveText(raw.operation, 512) } : {}),
          ...(typeof raw.errorName === "string" ? { errorName: redactSensitiveText(raw.errorName, 256) } : {}),
          ...(typeof raw.message === "string" ? { message: redactSensitiveText(raw.message, 4_096) } : {}),
          ...(typeof raw.fingerprint === "string" ? { fingerprint: raw.fingerprint.slice(0, 128) } : {}),
          ...(Number.isSafeInteger(raw.consecutiveCount) ? { consecutiveCount: raw.consecutiveCount as number } : {}),
          ...(typeof raw.restartStorm === "boolean" ? { restartStorm: raw.restartStorm } : {}),
        }));
      } catch (error) {
        reportOperationalError({
          component: "diagnostics",
          operation: "parse bounded crash record",
          error,
          severity: "warn",
          outcome: "degraded",
        });
      }
    }
    return Object.freeze(records);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
}



async function recentSetupRecords(home: string): Promise<readonly DiagnosticSetupRecord[]> {
  const path = join(home, "logs", "setup.ndjson");
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Setup log path is unsafe: ${path}`);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error(`Setup log permissions are too broad: ${path}`);
    const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).slice(-50);
    const records: DiagnosticSetupRecord[] = [];
    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const outcome = raw.outcome === "started" || raw.outcome === "success" || raw.outcome === "failure" ? raw.outcome : undefined;
        records.push(Object.freeze({
          ...(typeof raw.at === "string" ? { at: raw.at } : {}),
          ...(typeof raw.component === "string" ? { component: redactSensitiveText(raw.component, 128) } : {}),
          ...(typeof raw.operation === "string" ? { operation: redactSensitiveText(raw.operation, 256) } : {}),
          ...(outcome === undefined ? {} : { outcome }),
          ...(typeof raw.message === "string" ? { message: redactSensitiveText(raw.message, 4_096) } : {}),
          ...(typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) ? { durationMs: Math.max(0, raw.durationMs) } : {}),
        }));
      } catch (error) {
        reportOperationalError({ component: "diagnostics", operation: "parse bounded setup record", error, severity: "warn", outcome: "degraded" });
      }
    }
    return Object.freeze(records);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
}

function sanitizedStatusValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactSensitiveText(value, 512);
  if (depth >= 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 24).map((entry) => sanitizedStatusValue(entry, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 48)) {
      result[key.slice(0, 128)] = isSensitiveFieldName(key) ? "[REDACTED]" : sanitizedStatusValue(entry, depth + 1);
    }
    return result;
  }
  return redactSensitiveText(String(value), 256);
}

function boundedStatusDetail(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(sanitizedStatusValue(value));
    const bounded = text.length <= 2_000 ? text : `${text.slice(0, 1_999)}…`;
    return bounded && bounded !== "{}" ? bounded : undefined;
  } catch {
    return undefined;
  }
}

function sanitizedObservabilityFields(fields: ObservabilityFields): ObservabilityFields {
  const sanitized = sanitizedStatusValue(fields);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as ObservabilityFields
    : {};
}

function sanitizedLogRecord(entry: ObservabilityLogRecord): ObservabilityLogRecord {
  return Object.freeze({
    sequence: entry.sequence,
    at: entry.at,
    level: entry.level,
    component: redactSensitiveText(entry.component, 128),
    message: redactSensitiveText(entry.message, 2_000),
    fields: sanitizedObservabilityFields(entry.fields),
    ...(entry.traceId === undefined ? {} : { traceId: entry.traceId.slice(0, 128) }),
    ...(entry.spanId === undefined ? {} : { spanId: entry.spanId.slice(0, 128) }),
  });
}

function sanitizedSpanRecord(entry: ObservabilitySpanRecord): ObservabilitySpanRecord {
  return Object.freeze({
    sequence: entry.sequence,
    traceId: entry.traceId.slice(0, 128),
    spanId: entry.spanId.slice(0, 128),
    ...(entry.parentSpanId === undefined ? {} : { parentSpanId: entry.parentSpanId.slice(0, 128) }),
    name: redactSensitiveText(entry.name, 256),
    component: redactSensitiveText(entry.component, 128),
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: entry.durationMs,
    status: entry.status,
    attributes: sanitizedObservabilityFields(entry.attributes),
    ...(entry.error === undefined ? {} : { error: redactSensitiveText(entry.error, 2_000) }),
  });
}

function suggestedActions(checks: readonly DiagnosticDoctorCheck[]): readonly string[] {
  const result = new Set<string>();
  for (const check of checks) {
    if (check.level === "ok") continue;
    if (check.repair === "execution-python") result.add("execution.python.setup");
    if (check.repair === "sandbox") result.add("sandbox.setup");
    if (check.repair === "setup") result.add("onboarding.continue");
    if (check.id === "voice") result.add("voice.setup");
    if (check.id === "memory") result.add("memory.embeddings.status");
  }
  return Object.freeze([...result]);
}

export function createDiagnosticsPlugin(): FridayPlugin {
  return definePlugin({
    id: "diagnostics",
    requires: [HOST_DOCTOR_CAPABILITY, OBSERVABILITY_CAPABILITY, RUNTIME_SETTINGS_CAPABILITY],
    provides: [DIAGNOSTICS_CAPABILITY],
  }, (ctx) => {
    const hostDoctor = ctx.services.require(HOST_DOCTOR_CAPABILITY);
    const observability = ctx.services.require(OBSERVABILITY_CAPABILITY);
    const runtime = ctx.services.require(RUNTIME_SETTINGS_CAPABILITY);
    const home = resolve(process.env.FRIDAY_HOME?.trim() || join(homedir(), ".friday"));

    const service: DiagnosticsService = Object.freeze({
      doctor: () => hostDoctor.collect(),
      async review(options: { readonly component?: string | undefined; readonly limit?: number | undefined } = {}) {
        const limit = Math.min(MAX_LOGS, Math.max(1, options.limit ?? 50));
        const doctor = await hostDoctor.collect();
        const statuses: Record<string, string> = {};
        for (const contribution of ctx.collect(SYSTEM_STATUS_CONTRIBUTION)) {
          if (contribution.id === "diagnostics") continue;
          try {
            const detail = boundedStatusDetail(await contribution.snapshot());
            statuses[contribution.id] = detail ?? "{}";
          } catch (error) {
            statuses[contribution.id] = redactSensitiveText(
              `status collection failed: ${error instanceof Error ? error.message : String(error)}`,
              2_000,
            );
          }
        }
        const logs = observability.logs({
          ...(options.component ? { component: options.component } : {}),
          limit,
        }).filter((entry) => entry.level === "warn" || entry.level === "error")
          .map(sanitizedLogRecord);
        const spans = observability.spans({
          ...(options.component ? { component: options.component } : {}),
          status: "error",
          limit: Math.min(limit, 50),
        }).map(sanitizedSpanRecord);
        const onboarding = await runtime.onboarding();
        const settings = await runtime.read();
        return Object.freeze({
          generatedAt: new Date().toISOString(),
          doctor,
          runtime: Object.freeze({
            routerOnly: Boolean(settings && !settings.modelProvider),
            mainModelConfigured: Boolean(settings?.modelProvider && settings.modelId),
            routingModel: settings?.routingProvider && settings.routingModelId
              ? `${settings.routingProvider}/${settings.routingModelId}`
              : null,
            permissionMode: settings?.permissionMode ?? null,
            hostPrivilegeMode: settings?.hostPrivilegeMode ?? "none",
            onboarding: onboarding ?? null,
          }),
          statuses: Object.freeze(statuses),
          logs: Object.freeze([...logs]),
          spans: Object.freeze([...spans]),
          crashes: await recentCrashRecords(home),
          setup: await recentSetupRecords(home),
          suggestedActions: suggestedActions(doctor),
        });
      },
    });
    ctx.services.provide(DIAGNOSTICS_CAPABILITY, service);

    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "diagnostics",
      label: "Diagnostics",
      async snapshot() {
        const checks = await service.doctor();
        return {
          healthy: !checks.some((check) => check.level === "error"),
          errors: checks.filter((check) => check.level === "error").length,
          warnings: checks.filter((check) => check.level === "warn").length,
          suggestedActions: suggestedActions(checks),
        };
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "diagnostics.doctor",
      label: "Run Doctor",
      description: "Run the same canonical read-only Doctor checks as local `friday doctor`, including installation, configuration, security, tooling, backup/recovery, disk, Voice, channels, Vault metadata, and sandbox readiness. Returns typed results plus safe repair suggestions; does not perform repairs by itself.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission() {
        return { id: "diagnostics.doctor", effect: "global-operational-read", resource: "diagnostics:doctor", network: false };
      },
      async execute() {
        const checks = await service.doctor();
        const summary = Object.freeze({
          healthy: checks.filter((check) => check.level === "ok").length,
          info: checks.filter((check) => check.level === "info").length,
          warnings: checks.filter((check) => check.level === "warn").length,
          blocked: checks.filter((check) => check.level === "error").length,
        });
        return {
          status: summary.blocked > 0 ? "needs-attention" : summary.warnings > 0 ? "ready-with-warnings" : "ready",
          summary,
          checks,
          suggestedActions: suggestedActions(checks),
        };
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "diagnostics.review",
      label: "Review FRIDAY failure evidence",
      description: "Collect bounded redacted FRIDAY-owned diagnostic evidence: Doctor checks, plugin status, recent setup/provisioning outcomes, warn/error observability logs, failed spans, crash records, and onboarding/runtime state. Never reads arbitrary host logs or Vault secrets.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          component: { type: "string", description: "Optional FRIDAY component to focus on, such as voice or execution" },
          limit: { type: "integer", minimum: 1, maximum: MAX_LOGS },
        },
        additionalProperties: false,
      }),
      permission() {
        return { id: "diagnostics.review", effect: "global-operational-read", resource: "diagnostics:evidence", network: false };
      },
      execute(input) {
        const component = optionalString(input, "component");
        const limit = optionalLimit(input);
        return service.review({
          ...(component === undefined ? {} : { component }),
          ...(limit === undefined ? {} : { limit }),
        });
      },
    });
  });
}

export default createDiagnosticsPlugin();
