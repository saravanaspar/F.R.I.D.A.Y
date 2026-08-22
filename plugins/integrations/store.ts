import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  IntegrationConnection,
  IntegrationJsonValue,
  IntegrationSettings,
} from "./contract.js";

export interface IntegrationsState {
  schema: 1;
  connections: Record<string, IntegrationConnection>;
}

export const INTEGRATIONS_STATE_FILE_NAME = "integrations_state.json";

export function getIntegrationsStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_STATE_DIR?.trim() || environment.FRIDAY_HOME?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "integrations");
}

export function getIntegrationsStatePath(stateDir: string): string {
  return join(stateDir, INTEGRATIONS_STATE_FILE_NAME);
}

export function createEmptyIntegrationsState(): IntegrationsState {
  return { schema: 1, connections: {} };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isJsonValue(value: unknown): value is IntegrationJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry));
  const record = objectRecord(value);
  return record !== undefined && Object.values(record).every((entry) => isJsonValue(entry));
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function parseSettings(value: unknown): IntegrationSettings | undefined {
  const record = objectRecord(value);
  if (!record || !Object.values(record).every((entry) => isJsonValue(entry))) return undefined;
  return record as IntegrationSettings;
}

function parseConnection(id: string, value: unknown): IntegrationConnection | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const settings = parseSettings(record.settings);
  if (
    record.id !== id ||
    typeof record.provider !== "string" ||
    typeof record.name !== "string" ||
    (record.credentialRef !== undefined && typeof record.credentialRef !== "string") ||
    !settings ||
    typeof record.enabled !== "boolean" ||
    !isIsoTimestamp(record.createdAt) ||
    !isIsoTimestamp(record.updatedAt)
  ) {
    return undefined;
  }
  return {
    id,
    provider: record.provider,
    name: record.name,
    ...(record.credentialRef === undefined ? {} : { credentialRef: record.credentialRef }),
    settings,
    enabled: record.enabled,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

export function loadIntegrationsState(stateDir: string): IntegrationsState {
  const path = getIntegrationsStatePath(stateDir);
  if (!existsSync(path)) return createEmptyIntegrationsState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse integrations state: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = objectRecord(parsed);
  if (!record || record.schema !== 1) throw new Error("Unsupported or malformed integrations state");
  const rawConnections = objectRecord(record.connections);
  if (!rawConnections) throw new Error("Malformed integrations state: connections must be an object");
  const connections: Record<string, IntegrationConnection> = {};
  for (const [id, raw] of Object.entries(rawConnections)) {
    const connection = parseConnection(id, raw);
    if (!connection) throw new Error(`Malformed integration connection: ${id}`);
    connections[id] = connection;
  }
  return { schema: 1, connections };
}

export function saveIntegrationsState(stateDir: string, state: IntegrationsState): string {
  const path = getIntegrationsStatePath(stateDir);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(stateDir, { recursive: true });
  try {
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode });
    renameSync(tempPath, path);
    chmodSync(path, mode);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return path;
}
