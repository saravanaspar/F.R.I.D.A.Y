import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type RemoteMcpAuth =
  | { kind: "none" }
  | { kind: "bearer"; credentialRef: string }
  | { kind: "oauth"; credentialRef: string; clientId?: string; scopes?: string };

export interface RemoteMcpServerConfig {
  id: string;
  label: string;
  url: string;
  auth: RemoteMcpAuth;
  builtIn: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface McpState {
  schema: 1;
  servers: Record<string, RemoteMcpServerConfig>;
}

export const MCP_STATE_FILE_NAME = "mcp_state.json";

export function getMcpStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_STATE_DIR?.trim() || environment.FRIDAY_HOME?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "mcp");
}

function pathFor(stateDir: string): string {
  return join(stateDir, MCP_STATE_FILE_NAME);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function parseAuth(value: unknown): RemoteMcpAuth | undefined {
  const record = objectRecord(value);
  if (!record || (record.kind !== "none" && record.kind !== "bearer" && record.kind !== "oauth")) return undefined;
  if (record.kind === "none") return { kind: "none" };
  if (typeof record.credentialRef !== "string" || !record.credentialRef.trim()) return undefined;
  if (record.kind === "bearer") return { kind: "bearer", credentialRef: record.credentialRef };
  if (record.clientId !== undefined && typeof record.clientId !== "string") return undefined;
  if (record.scopes !== undefined && typeof record.scopes !== "string") return undefined;
  return {
    kind: "oauth",
    credentialRef: record.credentialRef,
    ...(record.clientId ? { clientId: record.clientId } : {}),
    ...(record.scopes ? { scopes: record.scopes } : {}),
  };
}

function parseServer(id: string, value: unknown): RemoteMcpServerConfig | undefined {
  const record = objectRecord(value);
  if (!record || record.id !== id || !validId(record.id) || typeof record.label !== "string" || typeof record.url !== "string") return undefined;
  const auth = parseAuth(record.auth);
  if (!auth || record.builtIn !== false) return undefined;
  if (record.createdAt !== undefined && (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)))) return undefined;
  if (record.updatedAt !== undefined && (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt)))) return undefined;
  return {
    id,
    label: record.label,
    url: record.url,
    auth,
    builtIn: false,
    ...(typeof record.createdAt === "string" ? { createdAt: new Date(record.createdAt).toISOString() } : {}),
    ...(typeof record.updatedAt === "string" ? { updatedAt: new Date(record.updatedAt).toISOString() } : {}),
  };
}

export function loadMcpServers(stateDir: string): readonly RemoteMcpServerConfig[] {
  const path = pathFor(stateDir);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse MCP state: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = objectRecord(parsed);
  const rawServers = root?.schema === 1 ? objectRecord(root.servers) : undefined;
  if (!rawServers) throw new Error("Unsupported or malformed MCP state");
  const servers: RemoteMcpServerConfig[] = [];
  for (const [id, raw] of Object.entries(rawServers)) {
    const server = parseServer(id, raw);
    if (!server) throw new Error(`Malformed MCP server state: ${id}`);
    servers.push(server);
  }
  return servers.sort((a, b) => a.id.localeCompare(b.id));
}

export function saveMcpServers(stateDir: string, servers: readonly RemoteMcpServerConfig[]): void {
  const path = pathFor(stateDir);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const records = Object.fromEntries(servers.filter((server) => !server.builtIn).map((server) => [server.id, server]));
  const state: McpState = { schema: 1, servers: records };
  mkdirSync(stateDir, { recursive: true });
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
