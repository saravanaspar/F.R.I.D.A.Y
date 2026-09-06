import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type ObservabilityLogLevel = "debug" | "info" | "warn" | "error";
export type ObservabilitySpanStatus = "ok" | "error" | "cancelled";
export type ObservabilityMetricKind = "counter" | "gauge" | "distribution";

export type ObservabilityJsonPrimitive = string | number | boolean | null;
export type ObservabilityJsonValue =
  | ObservabilityJsonPrimitive
  | ObservabilityJsonValue[]
  | { [key: string]: ObservabilityJsonValue };
export type ObservabilityFields = Record<string, ObservabilityJsonValue>;
export type ObservabilityLabels = Record<string, string>;

export interface ObservabilityTraceContext {
  traceId: string;
  spanId: string;
}

export interface ObservabilityLogInput {
  level: ObservabilityLogLevel;
  component: string;
  message: string;
  at?: string | undefined;
  fields?: Record<string, unknown> | undefined;
}

export interface ObservabilityLogRecord {
  sequence: number;
  at: string;
  level: ObservabilityLogLevel;
  component: string;
  message: string;
  fields: ObservabilityFields;
  traceId?: string | undefined;
  spanId?: string | undefined;
}

export interface ObservabilityLogQuery {
  level?: ObservabilityLogLevel | undefined;
  component?: string | undefined;
  traceId?: string | undefined;
  limit?: number | undefined;
}

export interface ObservabilitySpanInput {
  name: string;
  component: string;
  attributes?: Record<string, unknown> | undefined;
}

export interface ObservabilitySpanRecord {
  sequence: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  component: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: ObservabilitySpanStatus;
  attributes: ObservabilityFields;
  error?: string | undefined;
}

export interface ObservabilitySpanQuery {
  traceId?: string | undefined;
  component?: string | undefined;
  name?: string | undefined;
  status?: ObservabilitySpanStatus | undefined;
  limit?: number | undefined;
}

export interface ObservabilitySpan {
  readonly context: ObservabilityTraceContext;
  end(status?: ObservabilitySpanStatus, error?: unknown): void;
}

export interface ObservabilityMetricSnapshot {
  name: string;
  kind: ObservabilityMetricKind;
  labels: ObservabilityLabels;
  updatedAt: string;
  value?: number | undefined;
  count?: number | undefined;
  sum?: number | undefined;
  min?: number | undefined;
  max?: number | undefined;
  average?: number | undefined;
}

export interface ObservabilityStatus {
  health: "healthy" | "degraded";
  logCount: number;
  spanCount: number;
  metricSeriesCount: number;
  maxLogRows: number;
  maxSpanRows: number;
  maxMetricSeries: number;
  droppedLogs: number;
  droppedSpans: number;
  droppedMetrics: number;
  droppedMetricsByReason: Readonly<Record<string, number>>;
  metricSeriesUtilization: number;
  metricSeriesNearCapacity: boolean;
  lastMetricDropAt?: string | undefined;
  lastMetricDropReason?: string | undefined;
  /** Present when the implementation supports durable model-usage accounting. */
  usageCount?: number | undefined;
  maxUsageRows?: number | undefined;
  droppedUsage?: number | undefined;
}

export type UsageTokenSource = "provider-reported" | "unavailable" | "simulated";
export type UsageCostSource = "provider-reported" | "provider-billing" | "catalog-estimate" | "unavailable";

export interface ModelUsageInput {
  at?: string | undefined;
  requestId?: string | undefined;
  responseId?: string | undefined;
  provider: string;
  model: string;
  api: string;
  status: "ok" | "error" | "aborted";
  sessionId?: string | undefined;
  rootSessionId?: string | undefined;
  parentSessionId?: string | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
  parentAgentId?: string | undefined;
  jobId?: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  tokenSource: UsageTokenSource;
  actualCost?: number | undefined;
  estimatedCost?: number | undefined;
  currency?: string | undefined;
  costSource: UsageCostSource;
  durationMs?: number | undefined;
}

export interface ModelUsageRecord extends ModelUsageInput {
  sequence: number;
}

export interface ModelUsageQuery {
  since?: string | undefined;
  until?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  sessionId?: string | undefined;
  rootSessionId?: string | undefined;
  agentId?: string | undefined;
  jobId?: string | undefined;
  limit?: number | undefined;
}

export interface ModelUsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  actualCost: number;
  actualCostRecords: number;
  estimatedCost: number;
  estimatedCostRecords: number;
  /** Actual cost when present, otherwise catalog estimate, counted once per request. */
  billableCost: number;
  billableCostRecords: number;
  currency: string;
}

export interface ModelUsageGroup extends ModelUsageTotals {
  key: string;
}

export interface ModelUsageSummary {
  totals: ModelUsageTotals;
  byAgent: readonly ModelUsageGroup[];
  byModel: readonly ModelUsageGroup[];
  byJob: readonly ModelUsageGroup[];
  note: string;
}

export interface ObservabilityService {
  log(input: ObservabilityLogInput): void;
  increment(name: string, value?: number, labels?: ObservabilityLabels): void;
  gauge(name: string, value: number, labels?: ObservabilityLabels): void;
  observe(name: string, value: number, labels?: ObservabilityLabels): void;
  currentTrace(): ObservabilityTraceContext | undefined;
  startSpan(input: ObservabilitySpanInput): ObservabilitySpan;
  withSpan<T>(input: ObservabilitySpanInput, operation: () => T): T;
  withSpan<T>(input: ObservabilitySpanInput, operation: () => Promise<T>): Promise<T>;
  logs(query?: ObservabilityLogQuery): readonly ObservabilityLogRecord[];
  spans(query?: ObservabilitySpanQuery): readonly ObservabilitySpanRecord[];
  metrics(name?: string): readonly ObservabilityMetricSnapshot[];
  /** Optional for compatibility with third-party observability providers predating usage accounting. */
  recordUsage?(input: ModelUsageInput): void;
  usage?(query?: ModelUsageQuery): readonly ModelUsageRecord[];
  usageSummary?(query?: ModelUsageQuery): ModelUsageSummary;
  status(): ObservabilityStatus;
  close(): void;
}

export const OBSERVABILITY_CAPABILITY: Capability<ObservabilityService> =
  defineCapability<ObservabilityService>("observability");
