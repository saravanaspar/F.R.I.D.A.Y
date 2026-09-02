import { createHash } from "node:crypto";

export type OperationalErrorSeverity = "warn" | "error";
export type OperationalErrorOutcome = "failure" | "cancelled" | "degraded";

export interface OperationalErrorContext {
  readonly code?: string | undefined;
  readonly errorClass?: string | undefined;
  readonly retryable?: boolean | undefined;
  readonly outcome?: OperationalErrorOutcome | undefined;
}

export interface SanitizedOperationalError {
  readonly code: string;
  readonly errorClass: string;
  readonly errorName: string;
  readonly fingerprint: string;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly outcome: OperationalErrorOutcome;
}

export interface OperationalErrorInput {
  readonly component: string;
  readonly operation: string;
  /** Stable bounded enum-like identifier used in metrics. Never include IDs or paths. */
  readonly operationCode?: string | undefined;
  readonly error: unknown;
  readonly severity?: OperationalErrorSeverity | undefined;
  readonly outcome?: OperationalErrorOutcome | undefined;
  readonly retryable?: boolean | undefined;
  readonly attempt?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly recoveryAction?: string | undefined;
  readonly nextRetryAt?: string | undefined;
}

export interface OperationalErrorEvent {
  readonly at: string;
  readonly component: string;
  readonly operation: string;
  readonly operationCode: string;
  readonly severity: OperationalErrorSeverity;
  readonly outcome: OperationalErrorOutcome;
  readonly retryable: boolean;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly errorCode: string;
  readonly errorClass: string;
  readonly errorFingerprint: string;
  readonly attempt?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly recoveryAction?: string | undefined;
  readonly nextRetryAt?: string | undefined;
}

export type OperationalErrorSink = (event: OperationalErrorEvent) => void;

const SECRET_KEY = /(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|api[-_]?key|credential|client[-_]?secret|private[-_]?key|signing[-_]?key)/i;
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|api[-_]?key|credential|client[-_]?secret|private[-_]?key|signing[-_]?key)\s*[:=]\s*([^\s,;&#]+)/gi;
const SECRET_QUERY = /([?&](?:password|passwd|secret|token|access_token|refresh_token|id_token|session_token|api_key|apikey|client_secret|credential)=)([^&#\s]+)/gi;
const AUTHORIZATION_ASSIGNMENT = /\b(authorization|proxy[-_]?authorization)\s*([:=])\s*(?:(Bearer|Basic)\s+)?([^\s,;]+)/gi;
const COOKIE_ASSIGNMENT = /\b(cookie|set[-_]?cookie)\s*([:=])\s*(.*?)(?=\s+(?:(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|api[-_]?key|credential|client[-_]?secret|private[-_]?key|signing[-_]?key)\s*[:=]|https?:\/\/)|$)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/gi;
let activeSink: { readonly id: symbol; readonly sink: OperationalErrorSink } | undefined;

function bounded(value: unknown, fallback: string, maximum: number): string {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maximum);
}

function stableIdentifier(value: unknown, fallback: string, maximum = 128): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized.charCodeAt(start) === 45) start += 1;
  while (end > start && normalized.charCodeAt(end - 1) === 45) end -= 1;
  const identifier = normalized.slice(start, end).slice(0, maximum);
  return /^[a-z0-9][a-z0-9._:-]*$/.test(identifier) ? identifier : fallback;
}

function inferredErrorClass(error: unknown): string {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const code = String(record?.code ?? "").toUpperCase();
  const name = error instanceof Error ? error.name.toLowerCase() : typeof error;
  if (code.includes("SQLITE_BUSY") || code.includes("SQLITE_LOCKED")) return "storage-contention";
  if (code === "ENOSPC") return "storage-capacity";
  if (code === "EROFS" || code === "EACCES" || code === "EPERM") return "storage-permission";
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ENOTFOUND") return "network";
  if (name.includes("abort") || name.includes("timeout")) return "cancelled";
  if (name.includes("type") || name.includes("validation") || name.includes("syntax")) return "validation";
  return "internal";
}

function inferredCode(error: unknown, errorClass: string): string {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  if (typeof record?.code === "string" || typeof record?.code === "number") {
    return stableIdentifier(record.code, "operational-failure", 64);
  }
  return stableIdentifier(errorClass, "operational-failure", 64);
}

/**
 * Canonical safe representation for every durable domain error. Subsystems must
 * persist `safeMessage`/classification fields from this result, never Error.message.
 */
export function sanitizeOperationalError(
  error: unknown,
  context: OperationalErrorContext = {},
): SanitizedOperationalError {
  const errorName = bounded(error instanceof Error ? error.name : typeof error, "Error", 128);
  const safeMessage = redactSensitiveText(error instanceof Error ? error.message : error);
  const errorClass = stableIdentifier(context.errorClass, inferredErrorClass(error), 64);
  const code = stableIdentifier(context.code, inferredCode(error, errorClass), 64);
  const outcome = context.outcome ?? (errorClass === "cancelled" ? "cancelled" : "failure");
  const retryable = context.retryable ?? new Set(["storage-contention", "network", "cancelled"]).has(errorClass);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([code, errorClass, errorName, safeMessage]))
    .digest("hex")
    .slice(0, 24);
  return Object.freeze({ code, errorClass, errorName, fingerprint, safeMessage, retryable, outcome });
}

/** Redact common credential forms in free-form text without changing unrelated content. */
export function redactSensitiveText(value: unknown, maximum = 2_048, fallback = "unknown failure"): string {
  return bounded(value, fallback, maximum)
    .replace(AUTHORIZATION_ASSIGNMENT, (_match, name: string, separator: string, scheme: string | undefined) =>
      `${name}${separator === ":" ? ": " : "="}${scheme ? `${scheme} ` : ""}[REDACTED]`)
    .replace(COOKIE_ASSIGNMENT, (_match, name: string, separator: string) =>
      `${name}${separator === ":" ? ": " : "="}[REDACTED]`)
    .replace(BEARER, (_match, scheme: string) => `${scheme} [REDACTED]`)
    .replace(SECRET_QUERY, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(SECRET_ASSIGNMENT, (_match, name: string) => `${name}=[REDACTED]`);
}

/** Return true when an object key names data that should never be emitted verbatim. */
export function isSensitiveFieldName(value: string): boolean {
  return SECRET_KEY.test(value);
}

function eventFor(input: OperationalErrorInput): OperationalErrorEvent {
  const sanitized = sanitizeOperationalError(input.error, {
    outcome: input.outcome,
    retryable: input.retryable,
  });
  return Object.freeze({
    at: new Date().toISOString(),
    component: bounded(input.component, "unknown", 128),
    operation: bounded(input.operation, "unknown", 256),
    operationCode: stableIdentifier(input.operationCode, "unspecified", 128),
    severity: input.severity ?? "error",
    outcome: sanitized.outcome,
    retryable: sanitized.retryable,
    errorName: sanitized.errorName,
    errorMessage: sanitized.safeMessage,
    errorCode: sanitized.code,
    errorClass: sanitized.errorClass,
    errorFingerprint: sanitized.fingerprint,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.traceId === undefined ? {} : { traceId: stableIdentifier(input.traceId, "invalid", 128) }),
    ...(input.spanId === undefined ? {} : { spanId: stableIdentifier(input.spanId, "invalid", 128) }),
    ...(input.correlationId === undefined ? {} : { correlationId: stableIdentifier(input.correlationId, "invalid", 128) }),
    ...(input.recoveryAction === undefined ? {} : { recoveryAction: bounded(input.recoveryAction, "none", 256) }),
    ...(input.nextRetryAt === undefined ? {} : { nextRetryAt: bounded(input.nextRetryAt, "unknown", 64) }),
  });
}

function stderr(event: OperationalErrorEvent, sinkError?: unknown): void {
  const record = {
    type: "friday.operational-error",
    ...event,
    ...(sinkError === undefined ? {} : { sinkError: redactSensitiveText(sinkError instanceof Error ? sinkError.message : sinkError) }),
  };
  try {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  } catch {
    // This is the terminal failure sink. Avoid recursion if stderr itself is unavailable.
  }
}

export function reportOperationalError(input: OperationalErrorInput): void {
  const event = eventFor(input);
  if (!activeSink) { stderr(event); return; }
  try {
    activeSink.sink(event);
  } catch (error) {
    stderr(event, error);
  }
}

export function installOperationalErrorSink(sink: OperationalErrorSink): () => void {
  if (typeof sink !== "function") throw new Error("Operational error sink must be a function");
  const registration = Object.freeze({ id: Symbol("operational-error-sink"), sink });
  activeSink = registration;
  return () => { if (activeSink?.id === registration.id) activeSink = undefined; };
}

export function isExpectedAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function reportUnlessExpectedAbort(input: OperationalErrorInput, signal?: AbortSignal): void {
  if (!isExpectedAbort(input.error, signal)) reportOperationalError(input);
}
