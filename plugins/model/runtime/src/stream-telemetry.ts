import { effectiveCacheSemantics } from "./cache-semantics.js";
import { reportOperationalError } from "@friday/operational-errors";
import { getLogger } from "./log.js";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  StreamOptions,
} from "./types.js";

const log = getLogger("ai.model");

function isFirstOutputEvent(event: AssistantMessageEvent): boolean {
  return (
    (event.type === "text_delta" && event.delta.length > 0) ||
    (event.type === "thinking_delta" && event.delta.length > 0) ||
    event.type === "toolcall_start"
  );
}

function boundedMs(startedAt: number, now: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.round(now - startedAt));
}

/**
 * Attach content-free request telemetry without consuming the stream.
 *
 * Inspired by mature agent runtimes that treat TTFT and cache token usage as
 * first-class model telemetry. No prompts, tool arguments, secrets, or model
 * output text are recorded here.
 */
export function attachModelStreamTelemetry<TApi extends Api>(
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
  options?: StreamOptions,
  now: () => number = () => Date.now(),
): AssistantMessageEventStream {
  const startedAt = now();
  let firstOutputAt: number | undefined;
  let finished = false;

  const semantics = effectiveCacheSemantics(model, options?.cacheRetention);
  const record = (message: AssistantMessage, observedAt: number): void => {
    if (finished) return;
    finished = true;
    const usage = message.usage;
    const inputTotal = Math.max(0, usage.input) + Math.max(0, usage.cacheRead) + Math.max(0, usage.cacheWrite);
    const cacheReadRatio = inputTotal > 0 ? Math.min(1, Math.max(0, usage.cacheRead / inputTotal)) : 0;
    const status = message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "ok";

    const fields = {
      provider: String(message.provider || model.provider),
      model: String(message.model || model.id),
      api: String(message.api || model.api),
      status,
      stopReason: message.stopReason,
      responseId: message.responseId,
      durationMs: boundedMs(startedAt, observedAt),
      ttftMs: firstOutputAt === undefined ? undefined : boundedMs(startedAt, firstOutputAt),
      inputTokens: Math.max(0, usage.input),
      outputTokens: Math.max(0, usage.output),
      cacheReadTokens: Math.max(0, usage.cacheRead),
      cacheWriteTokens: Math.max(0, usage.cacheWrite),
      totalTokens: Math.max(0, usage.totalTokens),
      cacheReadRatio,
      tokenSource: usage.tokenSource ?? "unavailable",
      costSource: usage.cost.source ?? "unavailable",
      estimatedCostTotal: usage.cost.estimated !== undefined
        ? Math.max(0, usage.cost.estimated)
        : usage.cost.source === "catalog-estimate" ? Math.max(0, usage.cost.total) : undefined,
      actualCostTotal: usage.cost.source === "provider-reported" || usage.cost.source === "provider-billing"
        ? Math.max(0, usage.cost.actual ?? usage.cost.total)
        : undefined,
      costCurrency: usage.cost.currency,
      cacheRetention: options?.cacheRetention ?? "short",
      cacheSemantics: semantics.kind,
      cacheBreakpointLimit: semantics.kind === "explicit-breakpoints" ? semantics.maxBreakpoints : undefined,
      sessionCacheKey: Boolean(options?.sessionId),
    };

    if (status === "ok") log.info("model request completed", fields);
    else log.warn("model request terminated", fields);
  };
  const unsubscribe = stream.subscribe((event) => {
    if (finished) return;
    const observedAt = now();
    if (firstOutputAt === undefined && isFirstOutputEvent(event)) firstOutputAt = observedAt;
    if (event.type !== "done" && event.type !== "error") return;

    unsubscribe();
    record(event.type === "done" ? event.message : event.error, observedAt);
  });

  // A provider may terminate synchronously before returning its stream (for
  // example, a request-construction failure). result() is already resolved in
  // that case, so this fallback records the terminal message on the next
  // microtask without duplicating the normal subscribed path.
  void stream.result().then((message) => record(message, now())).catch((error: unknown) => {
    reportOperationalError({ component: "model", operation: "record terminal stream telemetry", error });
  });

  return stream;
}
