import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isSensitiveFieldName, redactSensitiveText } from "@friday/operational-errors";
import type {
  ObservabilityFields,
  ObservabilityJsonValue,
  ObservabilityLabels,
  ObservabilityLogInput,
  ObservabilityLogQuery,
  ObservabilityLogRecord,
  ObservabilityMetricKind,
  ObservabilityMetricSnapshot,
  ObservabilityService,
  ObservabilitySpan,
  ObservabilitySpanInput,
  ObservabilitySpanQuery,
  ObservabilitySpanRecord,
  ObservabilitySpanStatus,
  ObservabilityStatus,
  ObservabilityTraceContext,
  ModelUsageInput,
  ModelUsageQuery,
  ModelUsageRecord,
  ModelUsageSummary,
  ModelUsageTotals,
} from "./contract.js";
import { getObservabilityStateDir, ObservabilityDatabase } from "./store.js";

const DEFAULT_MAX_LOG_ROWS = 10_000;
const DEFAULT_MAX_SPAN_ROWS = 5_000;
const DEFAULT_MAX_METRIC_SERIES = 2_000;
const DEFAULT_MAX_USAGE_ROWS = 50_000;
const MAX_COMPONENT_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 2_048;
const MAX_FIELD_STRING_LENGTH = 2_048;
const MAX_FIELD_DEPTH = 5;
const MAX_OBJECT_KEYS = 48;
const MAX_ARRAY_ITEMS = 32;
const MAX_LABELS = 12;
const MAX_LABEL_LENGTH = 128;
const MAX_FIELDS_JSON_LENGTH = 16_384;

const METRIC_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export interface ObservabilityServiceOptions {
  stateDir?: string | undefined;
  maxLogRows?: number | undefined;
  maxSpanRows?: number | undefined;
  maxMetricSeries?: number | undefined;
  maxUsageRows?: number | undefined;
  now?: (() => Date) | undefined;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function boundedText(value: unknown, maxLength: number, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!text) return fallback;
  return text.slice(0, maxLength);
}

function redactString(value: string): string {
  return redactSensitiveText(value, MAX_FIELD_STRING_LENGTH, "");
}

function sanitizeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): ObservabilityJsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return `[${typeof value}]`;
  if (value instanceof Error) {
    return {
      name: boundedText(value.name, 128, "Error"),
      message: redactString(value.message),
    };
  }
  if (depth >= MAX_FIELD_DEPTH) return "[MaxDepth]";
  if (typeof value !== "object") return redactString(String(value));
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeValue(entry, depth + 1, seen));
    }
    const output: Record<string, ObservabilityJsonValue> = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const safeKey = boundedText(key, 128, "field");
      output[safeKey] = isSensitiveFieldName(safeKey) ? "[REDACTED]" : sanitizeValue(entry, depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeObservabilityFields(fields: Record<string, unknown> | undefined): ObservabilityFields {
  if (!fields) return {};
  const sanitized = sanitizeValue(fields);
  if (typeof sanitized !== "object" || sanitized === null || Array.isArray(sanitized)) return {};
  try {
    if (JSON.stringify(sanitized).length > MAX_FIELDS_JSON_LENGTH) {
      return { truncated: "[FieldsTooLarge]" };
    }
  } catch {
    return { truncated: "[FieldsUnserializable]" };
  }
  return sanitized;
}

function normalizeLabels(labels: ObservabilityLabels | undefined): ObservabilityLabels {
  if (!labels) return {};
  const output: ObservabilityLabels = {};
  const entries = Object.entries(labels)
    .filter(([key]) => key.trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_LABELS);
  for (const [key, value] of entries) {
    const safeKey = key.slice(0, MAX_LABEL_LENGTH);
    output[safeKey] = isSensitiveFieldName(safeKey)
      ? "[REDACTED]"
      : redactString(String(value)).slice(0, MAX_LABEL_LENGTH);
  }
  return output;
}

function canonicalLabels(labels: ObservabilityLabels): string {
  return JSON.stringify(labels);
}

function safeIso(value: string | undefined, fallback: Date): string {
  if (value === undefined) return fallback.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

function errorText(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  const raw = error instanceof Error ? error.message : String(error);
  return redactString(raw).slice(0, MAX_MESSAGE_LENGTH);
}

function statusForError(error: unknown): ObservabilitySpanStatus {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "cancelled";
  return "error";
}

export class ObservabilityRuntime implements ObservabilityService {
  readonly #database: ObservabilityDatabase;
  readonly #trace = new AsyncLocalStorage<ObservabilityTraceContext>();
  readonly #maxLogRows: number;
  readonly #maxSpanRows: number;
  readonly #maxMetricSeries: number;
  readonly #maxUsageRows: number;
  readonly #now: () => Date;
  #droppedLogs = 0;
  #droppedSpans = 0;
  #droppedMetrics = 0;
  readonly #droppedMetricReasons = new Map<string, number>();
  #lastMetricDropAt: string | undefined;
  #lastMetricDropReason: string | undefined;
  #metricCapacityAlerted = false;
  #droppedUsage = 0;
  #closed = false;

  constructor(options: ObservabilityServiceOptions = {}) {
    this.#maxLogRows = positiveInteger(options.maxLogRows, DEFAULT_MAX_LOG_ROWS, "maxLogRows");
    this.#maxSpanRows = positiveInteger(options.maxSpanRows, DEFAULT_MAX_SPAN_ROWS, "maxSpanRows");
    this.#maxMetricSeries = positiveInteger(options.maxMetricSeries, DEFAULT_MAX_METRIC_SERIES, "maxMetricSeries");
    this.#maxUsageRows = positiveInteger(options.maxUsageRows, DEFAULT_MAX_USAGE_ROWS, "maxUsageRows");
    this.#now = options.now ?? (() => new Date());
    this.#database = new ObservabilityDatabase({
      stateDir: options.stateDir ?? getObservabilityStateDir(),
      maxLogRows: this.#maxLogRows,
      maxSpanRows: this.#maxSpanRows,
      maxUsageRows: this.#maxUsageRows,
    });
  }

  log(input: ObservabilityLogInput): void {
    if (this.#closed) {
      this.#droppedLogs += 1;
      return;
    }
    try {
      const context = this.#trace.getStore();
      this.#database.insertLog({
        at: safeIso(input.at, this.#now()),
        level: input.level,
        component: boundedText(input.component, MAX_COMPONENT_LENGTH, "unknown"),
        message: redactString(boundedText(input.message, MAX_MESSAGE_LENGTH, "log")),
        fields: sanitizeObservabilityFields(input.fields),
        ...(context ? { traceId: context.traceId, spanId: context.spanId } : {}),
      });
    } catch (error) {
      this.#droppedLogs += 1;
      this.#reportDrop("log", error, this.#droppedLogs);
    }
  }

  increment(name: string, value = 1, labels?: ObservabilityLabels): void {
    this.#recordMetric("counter", name, value, labels);
  }

  gauge(name: string, value: number, labels?: ObservabilityLabels): void {
    this.#recordMetric("gauge", name, value, labels);
  }

  observe(name: string, value: number, labels?: ObservabilityLabels): void {
    this.#recordMetric("distribution", name, value, labels);
  }

  currentTrace(): ObservabilityTraceContext | undefined {
    const context = this.#trace.getStore();
    return context ? { ...context } : undefined;
  }

  startSpan(input: ObservabilitySpanInput): ObservabilitySpan {
    const parent = this.#trace.getStore();
    const context = Object.freeze<ObservabilityTraceContext>({
      traceId: parent?.traceId ?? randomUUID(),
      spanId: randomUUID(),
    });
    const startedAtDate = this.#now();
    const startedAt = startedAtDate.toISOString();
    const startedMs = startedAtDate.getTime();
    const name = boundedText(input.name, 160, "span");
    const component = boundedText(input.component, MAX_COMPONENT_LENGTH, "unknown");
    const attributes = sanitizeObservabilityFields(input.attributes);
    let ended = false;

    return Object.freeze({
      context,
      end: (status: ObservabilitySpanStatus = "ok", error?: unknown): void => {
        if (ended) return;
        ended = true;
        if (this.#closed) {
          this.#droppedSpans += 1;
          return;
        }
        try {
          const endedAtDate = this.#now();
          const safeError = errorText(error);
          this.#database.insertSpan({
            traceId: context.traceId,
            spanId: context.spanId,
            ...(parent ? { parentSpanId: parent.spanId } : {}),
            name,
            component,
            startedAt,
            endedAt: endedAtDate.toISOString(),
            durationMs: Math.max(0, endedAtDate.getTime() - startedMs),
            status,
            attributes,
            ...(safeError ? { error: safeError } : {}),
          });
        } catch (error) {
          this.#droppedSpans += 1;
          this.#reportDrop("span", error, this.#droppedSpans);
        }
      },
    });
  }

  withSpan<T>(input: ObservabilitySpanInput, operation: () => T): T;
  withSpan<T>(input: ObservabilitySpanInput, operation: () => Promise<T>): Promise<T>;
  withSpan<T>(input: ObservabilitySpanInput, operation: () => T | Promise<T>): T | Promise<T> {
    const span = this.startSpan(input);
    return this.#trace.run(span.context, () => {
      try {
        const result = operation();
        if (result !== null && typeof result === "object" && "then" in result && typeof result.then === "function") {
          return Promise.resolve(result).then(
            (value) => {
              span.end("ok");
              return value;
            },
            (error: unknown) => {
              span.end(statusForError(error), error);
              throw error;
            },
          );
        }
        span.end("ok");
        return result;
      } catch (error) {
        span.end(statusForError(error), error);
        throw error;
      }
    });
  }

  logs(query: ObservabilityLogQuery = {}): readonly ObservabilityLogRecord[] {
    this.#assertOpen();
    const limit = query.limit === undefined ? 100 : positiveInteger(query.limit, 100, "limit");
    return this.#database.logs({ ...query, limit: Math.min(limit, 1_000) });
  }

  spans(query: ObservabilitySpanQuery = {}): readonly ObservabilitySpanRecord[] {
    this.#assertOpen();
    const limit = query.limit === undefined ? 100 : positiveInteger(query.limit, 100, "limit");
    return this.#database.spans({ ...query, limit: Math.min(limit, 1_000) });
  }

  metrics(name?: string): readonly ObservabilityMetricSnapshot[] {
    this.#assertOpen();
    return this.#database.metrics(name);
  }

  recordUsage(input: ModelUsageInput): void {
    if (this.#closed) {
      this.#droppedUsage += 1;
      return;
    }
    try {
      const token = (value: number, label: string): number => {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
        return value;
      };
      const cost = (value: number | undefined, label: string): number | undefined => {
        if (value === undefined) return undefined;
        if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
        return value;
      };
      if (input.status !== "ok" && input.status !== "error" && input.status !== "aborted") throw new Error("usage status is invalid");
      this.#database.insertUsage({
        ...input,
        at: safeIso(input.at, this.#now()),
        provider: boundedText(input.provider, 128, "unknown"),
        model: boundedText(input.model, 256, "unknown"),
        api: boundedText(input.api, 128, "unknown"),
        inputTokens: token(input.inputTokens, "inputTokens"),
        outputTokens: token(input.outputTokens, "outputTokens"),
        cacheReadTokens: token(input.cacheReadTokens, "cacheReadTokens"),
        cacheWriteTokens: token(input.cacheWriteTokens, "cacheWriteTokens"),
        totalTokens: token(input.totalTokens, "totalTokens"),
        ...(cost(input.actualCost, "actualCost") === undefined ? {} : { actualCost: cost(input.actualCost, "actualCost")! }),
        ...(cost(input.estimatedCost, "estimatedCost") === undefined ? {} : { estimatedCost: cost(input.estimatedCost, "estimatedCost")! }),
      });
    } catch (error) {
      this.#droppedUsage += 1;
      this.#reportDrop("usage", error, this.#droppedUsage);
    }
  }

  usage(query: ModelUsageQuery = {}): readonly ModelUsageRecord[] {
    this.#assertOpen();
    const limit = query.limit === undefined ? 100 : positiveInteger(query.limit, 100, "limit");
    return this.#database.usage(query, Math.min(limit, 1_000));
  }

  usageSummary(query: ModelUsageQuery = {}): ModelUsageSummary {
    this.#assertOpen();
    const records = this.#database.usage({ ...query, limit: undefined }, this.#maxUsageRows);
    const totalsFor = (values: readonly ModelUsageRecord[]): ModelUsageTotals => {
      const totalInput = values.reduce((sum, value) => sum + value.inputTokens, 0);
      const cacheRead = values.reduce((sum, value) => sum + value.cacheReadTokens, 0);
      const cacheWrite = values.reduce((sum, value) => sum + value.cacheWriteTokens, 0);
      const cacheDenominator = totalInput + cacheRead + cacheWrite;
      const currencies = new Set(values.flatMap((value) => value.currency ? [value.currency] : []));
      return {
        requests: values.length,
        inputTokens: totalInput,
        outputTokens: values.reduce((sum, value) => sum + value.outputTokens, 0),
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        totalTokens: values.reduce((sum, value) => sum + value.totalTokens, 0),
        cacheHitRate: cacheDenominator === 0 ? 0 : cacheRead / cacheDenominator,
        actualCost: values.reduce((sum, value) => sum + (value.actualCost ?? 0), 0),
        actualCostRecords: values.filter((value) => value.actualCost !== undefined).length,
        estimatedCost: values.reduce((sum, value) => sum + (value.estimatedCost ?? 0), 0),
        estimatedCostRecords: values.filter((value) => value.estimatedCost !== undefined).length,
        currency: currencies.size === 1 ? [...currencies][0]! : currencies.size > 1 ? "mixed" : "unknown",
      };
    };
    const groups = (keyFor: (value: ModelUsageRecord) => string | undefined) => {
      const grouped = new Map<string, ModelUsageRecord[]>();
      for (const record of records) {
        const key = keyFor(record);
        if (!key) continue;
        const values = grouped.get(key) ?? [];
        values.push(record);
        grouped.set(key, values);
      }
      return [...grouped.entries()]
        .map(([key, values]) => ({ key, ...totalsFor(values) }))
        .sort((left, right) => right.totalTokens - left.totalTokens || left.key.localeCompare(right.key));
    };
    return Object.freeze({
      totals: totalsFor(records),
      byAgent: Object.freeze(groups((value) => value.agentName || value.agentId || value.sessionId)),
      byModel: Object.freeze(groups((value) => `${value.provider}/${value.model}`)),
      byJob: Object.freeze(groups((value) => value.jobId)),
      note: "Token counts are provider-reported when marked so. actualCost includes only provider/billing-reported values; catalog estimates are reported separately and are never presented as billed cost.",
    });
  }

  status(): ObservabilityStatus {
    this.#assertOpen();
    const metricSeriesCount = this.#database.metricSeriesCount();
    const metricSeriesUtilization = metricSeriesCount / this.#maxMetricSeries;
    return {
      health: this.#droppedLogs > 0 || this.#droppedSpans > 0 || this.#droppedMetrics > 0 || this.#droppedUsage > 0 || metricSeriesUtilization >= 0.8
        ? "degraded"
        : "healthy",
      logCount: this.#database.logCount(),
      spanCount: this.#database.spanCount(),
      metricSeriesCount,
      maxLogRows: this.#maxLogRows,
      maxSpanRows: this.#maxSpanRows,
      maxMetricSeries: this.#maxMetricSeries,
      droppedLogs: this.#droppedLogs,
      droppedSpans: this.#droppedSpans,
      droppedMetrics: this.#droppedMetrics,
      droppedMetricsByReason: Object.freeze(Object.fromEntries([...this.#droppedMetricReasons].sort(([left], [right]) => left.localeCompare(right)))),
      metricSeriesUtilization,
      metricSeriesNearCapacity: metricSeriesUtilization >= 0.8,
      ...(this.#lastMetricDropAt === undefined ? {} : { lastMetricDropAt: this.#lastMetricDropAt }),
      ...(this.#lastMetricDropReason === undefined ? {} : { lastMetricDropReason: this.#lastMetricDropReason }),
      usageCount: this.#database.usageCount(),
      maxUsageRows: this.#maxUsageRows,
      droppedUsage: this.#droppedUsage,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #recordMetric(kind: ObservabilityMetricKind, name: string, value: number, labels?: ObservabilityLabels): void {
    if (this.#closed) return this.#dropMetric("closed");
    if (!METRIC_NAME.test(name)) return this.#dropMetric("invalid-name");
    if (!Number.isFinite(value)) return this.#dropMetric("non-finite-value");
    if (kind === "counter" && value < 0) {
      return this.#dropMetric("negative-counter");
    }
    try {
      const normalized = normalizeLabels(labels);
      const labelsJson = canonicalLabels(normalized);
      const exists = this.#database.hasMetricSeries(name, kind, labelsJson);
      if (!exists && this.#database.metricSeriesCount() >= this.#maxMetricSeries) {
        return this.#dropMetric("series-limit");
      }
      const nowIso = this.#now().toISOString();
      if (kind === "counter") this.#database.incrementCounter(name, value, labelsJson, nowIso);
      else if (kind === "gauge") this.#database.setGauge(name, value, labelsJson, nowIso);
      else this.#database.observeDistribution(name, value, labelsJson, nowIso);
      const utilization = this.#database.metricSeriesCount() / this.#maxMetricSeries;
      if (utilization >= 0.8 && !this.#metricCapacityAlerted) {
        this.#metricCapacityAlerted = true;
        this.#database.insertLog({
          at: nowIso,
          level: "warn",
          component: "observability",
          message: "Metric series capacity is above 80%",
          fields: { metricSeriesUtilization: utilization, maxMetricSeries: this.#maxMetricSeries },
        });
      }
    } catch (error) {
      this.#dropMetric("storage-error", error);
    }
  }

  #dropMetric(reason: string, error?: unknown): void {
    this.#droppedMetrics += 1;
    const reasonCount = (this.#droppedMetricReasons.get(reason) ?? 0) + 1;
    this.#droppedMetricReasons.set(reason, reasonCount);
    this.#lastMetricDropAt = this.#now().toISOString();
    this.#lastMetricDropReason = reason;
    if (error !== undefined) this.#reportDrop(`metric (${reason})`, error, reasonCount);
    else if (reasonCount === 1 || (reasonCount & (reasonCount - 1)) === 0) {
      process.stderr.write(`friday: observability dropped metric (${reason}, ${reasonCount})\n`);
    }
  }

  #reportDrop(kind: string, error: unknown, count: number): void {
    // Emit the first and power-of-two repeats so telemetry storage failures are
    // visible without creating an unbounded stderr storm or recursive logging.
    if (count !== 1 && (count & (count - 1)) !== 0) return;
    const message = errorText(error) ?? "unknown failure";
    process.stderr.write(`friday: observability dropped ${kind} record (${count}): ${message}\n`);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Observability service is closed");
  }
}

export function createObservabilityService(options: ObservabilityServiceOptions = {}): ObservabilityRuntime {
  return new ObservabilityRuntime(options);
}
