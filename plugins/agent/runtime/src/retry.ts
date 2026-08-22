import type { ProviderResponse } from "./model-types.js";

export const MODEL_RETRY_INITIAL_DELAY_MS = 2_000;
export const MODEL_RETRY_BACKOFF_FACTOR = 2;
export const MODEL_RETRY_JITTER_FACTOR = 0.25;
export const MODEL_RETRY_MAX_DELAY_NO_HEADERS_MS = 30_000;
export const MODEL_RETRY_TIMER_MAX_MS = 2_147_483_647;
export const FRIDAY_MODEL_RETRY_MAX_RETRIES = 10;

const RETRYABLE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
];

const NON_RETRYABLE_CONTEXT_PATTERNS = [
  /context (?:window|length).*exceed/i,
  /context.*overflow/i,
  /maximum context/i,
  /too many tokens/i,
  /prompt is too long/i,
];

export interface ModelRetryFailure {
  readonly message: string;
  readonly status?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface ModelRetryDecision {
  readonly message: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function headerRecord(value: unknown): Record<string, string> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === "string" || typeof entry === "number") result[key.toLowerCase()] = String(entry);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function modelRetryFailure(error: unknown, response?: ProviderResponse): ModelRetryFailure {
  const root = record(error);
  const diagnostics = Array.isArray(root?.diagnostics) ? root.diagnostics : [];
  const providerDiagnostic = diagnostics
    .map((entry) => record(entry))
    .find((entry) => entry?.type === "provider_stream_failure");
  const diagnosticDetails = record(providerDiagnostic?.details);
  const nestedResponse = record(root?.response);
  const message = [
    typeof root?.errorMessage === "string" ? root.errorMessage : undefined,
    error instanceof Error ? error.message : undefined,
    typeof root?.message === "string" ? root.message : undefined,
    typeof root?.body === "string" ? root.body : undefined,
    typeof root?.responseBody === "string" ? root.responseBody : undefined,
  ].filter((value): value is string => !!value).join(" ") || String(error);
  const statusCandidate = response?.status
    ?? (typeof diagnosticDetails?.status === "number" ? diagnosticDetails.status : undefined)
    ?? (typeof root?.status === "number" ? root.status : undefined)
    ?? (typeof root?.statusCode === "number" ? root.statusCode : undefined)
    ?? (typeof nestedResponse?.status === "number" ? nestedResponse.status : undefined);
  const headers = response?.headers
    ?? headerRecord({
      "retry-after-ms": diagnosticDetails?.retryAfterMs,
      "retry-after": diagnosticDetails?.retryAfter,
    })
    ?? headerRecord(root?.headers)
    ?? headerRecord(nestedResponse?.headers);
  return {
    message,
    ...(statusCandidate === undefined ? {} : { status: statusCandidate }),
    ...(headers === undefined ? {} : { headers }),
  };
}

export function retryableModelFailure(failure: ModelRetryFailure): ModelRetryDecision | undefined {
  const message = failure.message.trim();
  if (!message) return undefined;
  if (NON_RETRYABLE_CONTEXT_PATTERNS.some((pattern) => pattern.test(message))) return undefined;
  if (failure.status !== undefined && failure.status >= 500) return { message };
  if (failure.status === 429) return { message: "Too Many Requests" };
  // An explicit client response is authoritative. Do not let numbers or words in
  // a validation/authentication message fall through to the broad network regexes.
  if (failure.status !== undefined && failure.status >= 400 && failure.status < 500) return undefined;
  if (RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))) {
    const lower = message.toLowerCase();
    if (lower.includes("exhausted") || lower.includes("unavailable") || lower.includes("overloaded")) {
      return { message: "Provider is overloaded" };
    }
    return { message };
  }
  return undefined;
}

function exponential(attempt: number, random: number): number {
  const base = MODEL_RETRY_INITIAL_DELAY_MS * Math.pow(MODEL_RETRY_BACKOFF_FACTOR, Math.max(0, attempt - 1));
  return Math.ceil(base + base * MODEL_RETRY_JITTER_FACTOR * random);
}

function capTimer(ms: number): number {
  return Math.min(Math.max(0, Math.ceil(ms)), MODEL_RETRY_TIMER_MAX_MS);
}

export function modelRetryDelayMs(attempt: number, failure?: ModelRetryFailure, random = Math.random()): number {
  const headers = failure?.headers;
  if (headers) {
    const retryAfterMs = headers["retry-after-ms"];
    if (retryAfterMs) {
      const parsed = Number.parseFloat(retryAfterMs);
      if (!Number.isNaN(parsed)) return capTimer(parsed);
    }
    const retryAfter = headers["retry-after"];
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter);
      if (!Number.isNaN(seconds)) return capTimer(seconds * 1_000);
      const parsedDate = Date.parse(retryAfter) - Date.now();
      if (!Number.isNaN(parsedDate) && parsedDate > 0) return capTimer(parsedDate);
    }
  }
  return capTimer(Math.min(exponential(attempt, random), MODEL_RETRY_MAX_DELAY_NO_HEADERS_MS));
}

export async function waitForModelRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw Object.assign(new Error("Request was aborted"), { name: "AbortError" });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(Object.assign(new Error("Request was aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
