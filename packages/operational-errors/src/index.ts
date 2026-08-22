export type OperationalErrorSeverity = "warn" | "error";

export interface OperationalErrorInput {
  readonly component: string;
  readonly operation: string;
  readonly error: unknown;
  readonly severity?: OperationalErrorSeverity | undefined;
}

export interface OperationalErrorEvent {
  readonly at: string;
  readonly component: string;
  readonly operation: string;
  readonly severity: OperationalErrorSeverity;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly errorCode?: string | undefined;
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
  const error = input.error;
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const code = typeof record?.code === "string" || typeof record?.code === "number"
    ? bounded(record.code, "", 64)
    : undefined;
  return Object.freeze({
    at: new Date().toISOString(),
    component: bounded(input.component, "unknown", 128),
    operation: bounded(input.operation, "unknown", 256),
    severity: input.severity ?? "error",
    errorName: bounded(error instanceof Error ? error.name : typeof error, "Error", 128),
    errorMessage: redactSensitiveText(error instanceof Error ? error.message : error),
    ...(code ? { errorCode: code } : {}),
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
