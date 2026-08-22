import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ObservabilityFields,
  ObservabilityLabels,
  ObservabilityLogLevel,
  ObservabilityLogQuery,
  ObservabilityLogRecord,
  ObservabilityMetricKind,
  ObservabilityMetricSnapshot,
  ObservabilitySpanQuery,
  ObservabilitySpanRecord,
  ObservabilitySpanStatus,
  ModelUsageInput,
  ModelUsageQuery,
  ModelUsageRecord,
  UsageCostSource,
  UsageTokenSource,
} from "./contract.js";

export const OBSERVABILITY_DATABASE_FILE_NAME = "observability.sqlite";
const DATABASE_SCHEMA_VERSION = 2;

export interface ObservabilityDatabaseOptions {
  stateDir: string;
  maxLogRows: number;
  maxSpanRows: number;
  maxUsageRows: number;
}

interface LogInsert {
  at: string;
  level: ObservabilityLogLevel;
  component: string;
  message: string;
  fields: ObservabilityFields;
  traceId?: string | undefined;
  spanId?: string | undefined;
}

interface SpanInsert {
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

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`observability database column ${key} is invalid`);
  return value;
}

function rowOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`observability database column ${key} is invalid`);
  return value;
}

function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`observability database column ${key} is invalid`);
  }
  return value;
}

function rowOptionalNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`observability database column ${key} is invalid`);
  return value;
}

function rowInteger(row: Record<string, unknown>, key: string): number {
  const value = rowNumber(row, key);
  if (!Number.isInteger(value)) throw new Error(`observability database column ${key} is invalid`);
  return value;
}

function parseObjectJson<T extends Record<string, unknown>>(value: string, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`observability database ${label} contains invalid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`observability database ${label} must contain a JSON object`);
  }
  return parsed as T;
}

function parseLevel(value: unknown): ObservabilityLogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  throw new Error("observability database log level is invalid");
}

function parseSpanStatus(value: unknown): ObservabilitySpanStatus {
  if (value === "ok" || value === "error" || value === "cancelled") return value;
  throw new Error("observability database span status is invalid");
}

function parseMetricKind(value: unknown): ObservabilityMetricKind {
  if (value === "counter" || value === "gauge" || value === "distribution") return value;
  throw new Error("observability database metric kind is invalid");
}

function parseTokenSource(value: unknown): UsageTokenSource {
  if (value === "provider-reported" || value === "unavailable" || value === "simulated") return value;
  throw new Error("observability database usage token source is invalid");
}

function parseCostSource(value: unknown): UsageCostSource {
  if (value === "provider-reported" || value === "provider-billing" || value === "catalog-estimate" || value === "unavailable") return value;
  throw new Error("observability database usage cost source is invalid");
}

function initializeSchema(db: DatabaseSync): void {
  const versionRow = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const version = typeof versionRow?.user_version === "number" ? versionRow.user_version : 0;
  if (version > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Observability database schema ${version} is newer than supported ${DATABASE_SCHEMA_VERSION}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      level TEXT NOT NULL,
      component TEXT NOT NULL,
      message TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      trace_id TEXT,
      span_id TEXT
    );
    CREATE INDEX IF NOT EXISTS logs_at_idx ON logs(at DESC);
    CREATE INDEX IF NOT EXISTS logs_component_idx ON logs(component, sequence DESC);
    CREATE INDEX IF NOT EXISTS logs_trace_idx ON logs(trace_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS spans (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL UNIQUE,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      component TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms REAL NOT NULL,
      status TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS spans_trace_idx ON spans(trace_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS spans_component_idx ON spans(component, sequence DESC);

    CREATE TABLE IF NOT EXISTS metrics (
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      value REAL,
      count INTEGER,
      sum REAL,
      min REAL,
      max REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (name, kind, labels_json)
    );
    CREATE INDEX IF NOT EXISTS metrics_name_idx ON metrics(name, kind);

    CREATE TABLE IF NOT EXISTS model_usage (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      request_id TEXT,
      response_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      api TEXT NOT NULL,
      status TEXT NOT NULL,
      session_id TEXT,
      root_session_id TEXT,
      parent_session_id TEXT,
      agent_id TEXT,
      agent_name TEXT,
      parent_agent_id TEXT,
      job_id TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      token_source TEXT NOT NULL,
      actual_cost REAL,
      estimated_cost REAL,
      currency TEXT,
      cost_source TEXT NOT NULL,
      duration_ms REAL
    );
    CREATE INDEX IF NOT EXISTS model_usage_at_idx ON model_usage(at DESC);
    CREATE INDEX IF NOT EXISTS model_usage_session_idx ON model_usage(session_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS model_usage_agent_idx ON model_usage(agent_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS model_usage_job_idx ON model_usage(job_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS model_usage_model_idx ON model_usage(provider, model, sequence DESC);
  `);
  db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
}

function configureDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA journal_mode = WAL");
  initializeSchema(db);
}

export function getObservabilityStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_STATE_DIR?.trim() || environment.FRIDAY_HOME?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "observability");
}

export function getObservabilityDatabasePath(stateDir: string): string {
  return join(stateDir, OBSERVABILITY_DATABASE_FILE_NAME);
}

export class ObservabilityDatabase {
  readonly path: string;
  readonly #maxLogRows: number;
  readonly #maxSpanRows: number;
  readonly #maxUsageRows: number;
  #db: DatabaseSync;
  #closed = false;

  constructor(options: ObservabilityDatabaseOptions) {
    this.#maxLogRows = options.maxLogRows;
    this.#maxSpanRows = options.maxSpanRows;
    this.#maxUsageRows = options.maxUsageRows;
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(options.stateDir, 0o700);
    this.path = getObservabilityDatabasePath(options.stateDir);
    const existed = existsSync(this.path);
    this.#db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      configureDatabase(this.#db);
    } catch (error) {
      try {
        this.#db.close();
      } catch (closeError) {
        process.stderr.write(`friday: observability database close failed during initialization: ${closeError instanceof Error ? closeError.name : typeof closeError}\n`);
      }
      if (!existed) {
        rmSync(this.path, { force: true });
        rmSync(`${this.path}-wal`, { force: true });
        rmSync(`${this.path}-shm`, { force: true });
      }
      throw error;
    }
  }

  insertLog(input: LogInsert): void {
    this.#assertOpen();
    this.#db.prepare(`
      INSERT INTO logs(at, level, component, message, fields_json, trace_id, span_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.at,
      input.level,
      input.component,
      input.message,
      JSON.stringify(input.fields),
      input.traceId ?? null,
      input.spanId ?? null,
    );
    this.#trim("logs", this.#maxLogRows);
  }

  insertSpan(input: SpanInsert): void {
    this.#assertOpen();
    this.#db.prepare(`
      INSERT INTO spans(
        trace_id, span_id, parent_span_id, name, component,
        started_at, ended_at, duration_ms, status, attributes_json, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.traceId,
      input.spanId,
      input.parentSpanId ?? null,
      input.name,
      input.component,
      input.startedAt,
      input.endedAt,
      input.durationMs,
      input.status,
      JSON.stringify(input.attributes),
      input.error ?? null,
    );
    this.#trim("spans", this.#maxSpanRows);
  }

  hasMetricSeries(name: string, kind: ObservabilityMetricKind, labelsJson: string): boolean {
    this.#assertOpen();
    return this.#db.prepare(
      "SELECT 1 AS present FROM metrics WHERE name = ? AND kind = ? AND labels_json = ?",
    ).get(name, kind, labelsJson) !== undefined;
  }

  incrementCounter(name: string, value: number, labelsJson: string, nowIso: string): void {
    this.#assertOpen();
    this.#db.prepare(`
      INSERT INTO metrics(name, kind, labels_json, value, updated_at)
      VALUES (?, 'counter', ?, ?, ?)
      ON CONFLICT(name, kind, labels_json) DO UPDATE SET
        value = COALESCE(metrics.value, 0) + excluded.value,
        updated_at = excluded.updated_at
    `).run(name, labelsJson, value, nowIso);
  }

  setGauge(name: string, value: number, labelsJson: string, nowIso: string): void {
    this.#assertOpen();
    this.#db.prepare(`
      INSERT INTO metrics(name, kind, labels_json, value, updated_at)
      VALUES (?, 'gauge', ?, ?, ?)
      ON CONFLICT(name, kind, labels_json) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(name, labelsJson, value, nowIso);
  }

  observeDistribution(name: string, value: number, labelsJson: string, nowIso: string): void {
    this.#assertOpen();
    this.#db.prepare(`
      INSERT INTO metrics(name, kind, labels_json, count, sum, min, max, updated_at)
      VALUES (?, 'distribution', ?, 1, ?, ?, ?, ?)
      ON CONFLICT(name, kind, labels_json) DO UPDATE SET
        count = COALESCE(metrics.count, 0) + 1,
        sum = COALESCE(metrics.sum, 0) + excluded.sum,
        min = CASE WHEN metrics.min IS NULL OR excluded.min < metrics.min THEN excluded.min ELSE metrics.min END,
        max = CASE WHEN metrics.max IS NULL OR excluded.max > metrics.max THEN excluded.max ELSE metrics.max END,
        updated_at = excluded.updated_at
    `).run(name, labelsJson, value, value, value, nowIso);
  }

  insertUsage(input: Omit<ModelUsageInput, "at"> & { at: string }): void {
    this.#assertOpen();
    this.#db.prepare(`
      INSERT INTO model_usage(
        at, request_id, response_id, provider, model, api, status,
        session_id, root_session_id, parent_session_id, agent_id, agent_name, parent_agent_id, job_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, token_source,
        actual_cost, estimated_cost, currency, cost_source, duration_ms
      ) VALUES (
        @at, @requestId, @responseId, @provider, @model, @api, @status,
        @sessionId, @rootSessionId, @parentSessionId, @agentId, @agentName, @parentAgentId, @jobId,
        @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens, @totalTokens, @tokenSource,
        @actualCost, @estimatedCost, @currency, @costSource, @durationMs
      )
    `).run(
      {
        at: input.at,
        requestId: input.requestId ?? null,
        responseId: input.responseId ?? null,
        provider: input.provider,
        model: input.model,
        api: input.api,
        status: input.status,
        sessionId: input.sessionId ?? null,
        rootSessionId: input.rootSessionId ?? null,
        parentSessionId: input.parentSessionId ?? null,
        agentId: input.agentId ?? null,
        agentName: input.agentName ?? null,
        parentAgentId: input.parentAgentId ?? null,
        jobId: input.jobId ?? null,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheWriteTokens: input.cacheWriteTokens,
        totalTokens: input.totalTokens,
        tokenSource: input.tokenSource,
        actualCost: input.actualCost ?? null,
        estimatedCost: input.estimatedCost ?? null,
        currency: input.currency ?? null,
        costSource: input.costSource,
        durationMs: input.durationMs ?? null,
      },
    );
    this.#trim("model_usage", this.#maxUsageRows);
  }

  usage(query: ModelUsageQuery = {}, maximum = 100): ModelUsageRecord[] {
    this.#assertOpen();
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const equals: Array<[keyof Pick<ModelUsageQuery, "provider" | "model" | "sessionId" | "agentId" | "jobId">, string]> = [
      ["provider", "provider"], ["model", "model"], ["sessionId", "session_id"], ["agentId", "agent_id"], ["jobId", "job_id"],
    ];
    for (const [key, column] of equals) {
      const value = query[key];
      if (value !== undefined) { clauses.push(`${column} = ?`); parameters.push(value); }
    }
    if (query.since !== undefined) { clauses.push("at >= ?"); parameters.push(query.since); }
    if (query.until !== undefined) { clauses.push("at <= ?"); parameters.push(query.until); }
    parameters.push(Math.min(this.#maxUsageRows, maximum));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db.prepare(`
      SELECT sequence, at, request_id, response_id, provider, model, api, status,
             session_id, root_session_id, parent_session_id, agent_id, agent_name, parent_agent_id, job_id,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, token_source,
             actual_cost, estimated_cost, currency, cost_source, duration_ms
      FROM model_usage ${where}
      ORDER BY sequence DESC
      LIMIT ?
    `).all(...parameters) as Record<string, unknown>[];
    return rows.map((row) => ({
      sequence: rowInteger(row, "sequence"),
      at: rowString(row, "at"),
      ...(rowOptionalString(row, "request_id") ? { requestId: rowOptionalString(row, "request_id")! } : {}),
      ...(rowOptionalString(row, "response_id") ? { responseId: rowOptionalString(row, "response_id")! } : {}),
      provider: rowString(row, "provider"),
      model: rowString(row, "model"),
      api: rowString(row, "api"),
      status: rowString(row, "status") as ModelUsageRecord["status"],
      ...(rowOptionalString(row, "session_id") ? { sessionId: rowOptionalString(row, "session_id")! } : {}),
      ...(rowOptionalString(row, "root_session_id") ? { rootSessionId: rowOptionalString(row, "root_session_id")! } : {}),
      ...(rowOptionalString(row, "parent_session_id") ? { parentSessionId: rowOptionalString(row, "parent_session_id")! } : {}),
      ...(rowOptionalString(row, "agent_id") ? { agentId: rowOptionalString(row, "agent_id")! } : {}),
      ...(rowOptionalString(row, "agent_name") ? { agentName: rowOptionalString(row, "agent_name")! } : {}),
      ...(rowOptionalString(row, "parent_agent_id") ? { parentAgentId: rowOptionalString(row, "parent_agent_id")! } : {}),
      ...(rowOptionalString(row, "job_id") ? { jobId: rowOptionalString(row, "job_id")! } : {}),
      inputTokens: rowInteger(row, "input_tokens"),
      outputTokens: rowInteger(row, "output_tokens"),
      cacheReadTokens: rowInteger(row, "cache_read_tokens"),
      cacheWriteTokens: rowInteger(row, "cache_write_tokens"),
      totalTokens: rowInteger(row, "total_tokens"),
      tokenSource: parseTokenSource(row.token_source),
      ...(rowOptionalNumber(row, "actual_cost") === undefined ? {} : { actualCost: rowOptionalNumber(row, "actual_cost")! }),
      ...(rowOptionalNumber(row, "estimated_cost") === undefined ? {} : { estimatedCost: rowOptionalNumber(row, "estimated_cost")! }),
      ...(rowOptionalString(row, "currency") ? { currency: rowOptionalString(row, "currency")! } : {}),
      costSource: parseCostSource(row.cost_source),
      ...(rowOptionalNumber(row, "duration_ms") === undefined ? {} : { durationMs: rowOptionalNumber(row, "duration_ms")! }),
    }));
  }

  logs(query: ObservabilityLogQuery = {}): ObservabilityLogRecord[] {
    this.#assertOpen();
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.level !== undefined) {
      clauses.push("level = ?");
      parameters.push(query.level);
    }
    if (query.component !== undefined) {
      clauses.push("component = ?");
      parameters.push(query.component);
    }
    if (query.traceId !== undefined) {
      clauses.push("trace_id = ?");
      parameters.push(query.traceId);
    }
    parameters.push(query.limit ?? 100);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db.prepare(`
      SELECT sequence, at, level, component, message, fields_json, trace_id, span_id
      FROM logs ${where}
      ORDER BY sequence DESC
      LIMIT ?
    `).all(...parameters) as Record<string, unknown>[];
    return rows.map((row) => ({
      sequence: rowInteger(row, "sequence"),
      at: rowString(row, "at"),
      level: parseLevel(row.level),
      component: rowString(row, "component"),
      message: rowString(row, "message"),
      fields: parseObjectJson<ObservabilityFields>(rowString(row, "fields_json"), "fields_json"),
      ...(rowOptionalString(row, "trace_id") ? { traceId: rowOptionalString(row, "trace_id")! } : {}),
      ...(rowOptionalString(row, "span_id") ? { spanId: rowOptionalString(row, "span_id")! } : {}),
    }));
  }

  spans(query: ObservabilitySpanQuery = {}): ObservabilitySpanRecord[] {
    this.#assertOpen();
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.traceId !== undefined) {
      clauses.push("trace_id = ?");
      parameters.push(query.traceId);
    }
    if (query.component !== undefined) {
      clauses.push("component = ?");
      parameters.push(query.component);
    }
    if (query.name !== undefined) {
      clauses.push("name = ?");
      parameters.push(query.name);
    }
    if (query.status !== undefined) {
      clauses.push("status = ?");
      parameters.push(query.status);
    }
    parameters.push(query.limit ?? 100);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db.prepare(`
      SELECT sequence, trace_id, span_id, parent_span_id, name, component,
             started_at, ended_at, duration_ms, status, attributes_json, error
      FROM spans ${where}
      ORDER BY sequence DESC
      LIMIT ?
    `).all(...parameters) as Record<string, unknown>[];
    return rows.map((row) => ({
      sequence: rowInteger(row, "sequence"),
      traceId: rowString(row, "trace_id"),
      spanId: rowString(row, "span_id"),
      ...(rowOptionalString(row, "parent_span_id") ? { parentSpanId: rowOptionalString(row, "parent_span_id")! } : {}),
      name: rowString(row, "name"),
      component: rowString(row, "component"),
      startedAt: rowString(row, "started_at"),
      endedAt: rowString(row, "ended_at"),
      durationMs: rowNumber(row, "duration_ms"),
      status: parseSpanStatus(row.status),
      attributes: parseObjectJson<ObservabilityFields>(rowString(row, "attributes_json"), "attributes_json"),
      ...(rowOptionalString(row, "error") ? { error: rowOptionalString(row, "error")! } : {}),
    }));
  }

  metrics(name?: string): ObservabilityMetricSnapshot[] {
    this.#assertOpen();
    const rows = (name === undefined
      ? this.#db.prepare(`
          SELECT name, kind, labels_json, value, count, sum, min, max, updated_at
          FROM metrics ORDER BY name, kind, labels_json
        `).all()
      : this.#db.prepare(`
          SELECT name, kind, labels_json, value, count, sum, min, max, updated_at
          FROM metrics WHERE name = ? ORDER BY kind, labels_json
        `).all(name)) as Record<string, unknown>[];

    return rows.map((row) => {
      const kind = parseMetricKind(row.kind);
      const labels = parseObjectJson<ObservabilityLabels>(rowString(row, "labels_json"), "labels_json");
      if (!Object.values(labels).every((value) => typeof value === "string")) {
        throw new Error("observability database labels_json is invalid");
      }
      const base = {
        name: rowString(row, "name"),
        kind,
        labels,
        updatedAt: rowString(row, "updated_at"),
      };
      if (kind === "counter" || kind === "gauge") {
        return { ...base, value: rowNumber(row, "value") };
      }
      const count = rowInteger(row, "count");
      const sum = rowNumber(row, "sum");
      const min = rowNumber(row, "min");
      const max = rowNumber(row, "max");
      return { ...base, count, sum, min, max, average: count === 0 ? 0 : sum / count };
    });
  }

  logCount(): number {
    return this.#count("logs");
  }

  spanCount(): number {
    return this.#count("spans");
  }

  metricSeriesCount(): number {
    return this.#count("metrics");
  }

  usageCount(): number {
    return this.#count("model_usage");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #count(table: "logs" | "spans" | "metrics" | "model_usage"): number {
    this.#assertOpen();
    const row = this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown> | undefined;
    if (!row) return 0;
    return rowInteger(row, "count");
  }

  #trim(table: "logs" | "spans" | "model_usage", maxRows: number): void {
    this.#db.prepare(`
      DELETE FROM ${table}
      WHERE sequence IN (
        SELECT sequence FROM ${table}
        ORDER BY sequence DESC
        LIMIT -1 OFFSET ?
      )
    `).run(maxRows);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Observability database is closed");
  }
}
