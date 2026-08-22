import { reportUnlessExpectedAbort } from "@friday/operational-errors";
import type { RemoteMcpServerConfig } from "./state.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_TOOL_PAGES = 20;
const MAX_TOOLS = 1_000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type ProtocolEra = "modern" | "legacy";

export interface McpWireTool {
  name: string;
  description?: string;
  inputSchema: JsonValue;
}

export interface McpWireCallResult {
  isError?: boolean;
  content?: JsonValue;
}

export interface McpTokenProvider {
  token(forceRefresh?: boolean): Promise<string | undefined>;
}

export interface McpHttpConnectionOptions {
  server: RemoteMcpServerConfig;
  tokenProvider: McpTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function assertSafeEndpoint(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password) throw new Error("MCP endpoint URL must not contain credentials");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Remote MCP endpoints must use HTTPS; HTTP is allowed only on loopback");
  }
  if (url.hash) throw new Error("MCP endpoint URL must not include a fragment");
  return url;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && value !== null && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`MCP request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`MCP response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function parseSse(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try { messages.push(JSON.parse(data) as unknown); } catch { throw new Error("MCP server returned malformed SSE JSON"); }
  }
  return messages;
}

function parsePayload(response: Response, text: string): unknown[] {
  if (!text.trim()) return [];
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) return parseSse(text);
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value : [value];
  } catch {
    throw new Error("MCP server returned malformed JSON");
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requestName(method: string, params: JsonValue): string | undefined {
  if (method !== "tools/call" && method !== "resources/read" && method !== "prompts/get") return undefined;
  const record = objectRecord(params);
  const value = method === "resources/read" ? record?.uri : record?.name;
  return typeof value === "string" && value ? value : undefined;
}

function modernParams(params: JsonValue): JsonValue {
  const record = objectRecord(params);
  if (!record) throw new Error("Modern MCP request params must be an object");
  const existingMeta = objectRecord(record._meta) ?? {};
  return {
    ...record,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientInfo": { name: "friday", version: "0.0.1" },
      "io.modelcontextprotocol/clientCapabilities": {},
      ...existingMeta,
    },
  } as JsonValue;
}

class McpHttpStatusError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

class McpProtocolError extends Error {
  constructor(readonly code: number | undefined, message: string) { super(message); }
}

export class McpSessionExpiredError extends Error {}

function isDefinitiveLegacyProbe(error: unknown): boolean {
  if (error instanceof McpHttpStatusError) return error.status === 400 || error.status === 404 || error.status === 405;
  if (error instanceof McpProtocolError) return error.code === -32601 || error.code === -32022;
  return false;
}

export class McpHttpConnection {
  readonly #server: RemoteMcpServerConfig;
  readonly #url: URL;
  readonly #tokenProvider: McpTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #sessionId: string | undefined;
  #protocolVersion = LEGACY_PROTOCOL_VERSION;
  #era: ProtocolEra | undefined;
  #requestId = 0;
  #connected = false;

  constructor(options: McpHttpConnectionOptions) {
    this.#server = options.server;
    this.#url = assertSafeEndpoint(options.server.url);
    this.#tokenProvider = options.tokenProvider;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get connected(): boolean { return this.#connected; }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#connected) return;
    signal?.throwIfAborted();

    try {
      const result = await this.#requestWithEra("modern", "server/discover", {}, signal, false);
      const record = objectRecord(result);
      const supported = Array.isArray(record?.supportedVersions)
        ? record.supportedVersions.filter((value): value is string => typeof value === "string")
        : [];
      if (supported.includes(MODERN_PROTOCOL_VERSION)) {
        this.#era = "modern";
        this.#protocolVersion = MODERN_PROTOCOL_VERSION;
        this.#sessionId = undefined;
        this.#connected = true;
        return;
      }
    } catch (error) {
      if (!isDefinitiveLegacyProbe(error)) throw error;
    }

    this.#era = "legacy";
    this.#protocolVersion = LEGACY_PROTOCOL_VERSION;
    this.#sessionId = undefined;
    const result = await this.#requestWithEra("legacy", "initialize", {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "friday", version: "0.0.1" },
    }, signal, false);
    const record = objectRecord(result);
    if (!record || typeof record.protocolVersion !== "string") {
      this.#era = undefined;
      throw new Error("MCP initialize response is malformed");
    }
    this.#protocolVersion = record.protocolVersion;
    this.#connected = true;
    try {
      await this.#notify("notifications/initialized", {}, signal);
    } catch (error) {
      this.#connected = false;
      this.#era = undefined;
      throw error;
    }
  }

  async listTools(signal?: AbortSignal): Promise<readonly McpWireTool[]> {
    await this.connect(signal);
    const tools: McpWireTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.#request("tools/list", cursor ? { cursor } : {}, signal, true);
      const record = objectRecord(result);
      if (!record || !Array.isArray(record.tools)) throw new Error("MCP tools/list response is malformed");
      for (const raw of record.tools) {
        const tool = objectRecord(raw);
        if (!tool || typeof tool.name !== "string" || !isJsonValue(tool.inputSchema)) {
          throw new Error("MCP server returned a malformed tool descriptor");
        }
        tools.push({
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
        });
        if (tools.length > MAX_TOOLS) throw new Error(`MCP server advertised more than ${MAX_TOOLS} tools`);
      }
      cursor = typeof record.nextCursor === "string" && record.nextCursor ? record.nextCursor : undefined;
      if (!cursor) return tools;
    }
    throw new Error(`MCP tools/list exceeded ${MAX_TOOL_PAGES} pages`);
  }

  async callTool(name: string, args: JsonValue | undefined, signal?: AbortSignal): Promise<McpWireCallResult> {
    await this.connect(signal);
    const argumentsValue = args ?? {};
    if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) {
      throw new Error("MCP tool arguments must be a JSON object");
    }
    const result = await this.#request("tools/call", { name, arguments: argumentsValue }, signal, true);
    const record = objectRecord(result);
    if (!record || (record.content !== undefined && !isJsonValue(record.content))) {
      throw new Error("MCP tools/call response is malformed");
    }
    if (record.resultType === "input_required") {
      throw new Error("MCP tool requires a multi-round-trip input flow that FRIDAY does not support yet");
    }
    return { isError: record.isError === true, content: (record.content as JsonValue | undefined) ?? [] };
  }

  async close(signal?: AbortSignal): Promise<void> {
    if (this.#era !== "legacy" || !this.#sessionId) {
      this.#sessionId = undefined;
      this.#connected = false;
      this.#era = undefined;
      return;
    }
    const headers = await this.#headers("legacy", false, undefined, undefined);
    const bound = combineSignal(signal, Math.min(this.#timeoutMs, 5_000));
    try {
      const response = await this.#fetch(this.#url, { method: "DELETE", headers, redirect: "error", signal: bound.signal });
      if (!response.ok && response.status !== 404 && response.status !== 405) await readBounded(response);
    } catch (error) {
      reportUnlessExpectedAbort({ component: "mcp", operation: "close remote protocol session", error }, bound.signal);
    } finally {
      bound.cleanup();
      this.#sessionId = undefined;
      this.#connected = false;
      this.#era = undefined;
    }
  }

  async #headers(
    era: ProtocolEra,
    includeContentType: boolean,
    method: string | undefined,
    name: string | undefined,
    forceRefresh = false,
  ): Promise<Headers> {
    const headers = new Headers({ Accept: "application/json, text/event-stream" });
    if (includeContentType) headers.set("Content-Type", "application/json");
    if (era === "legacy") {
      if (this.#sessionId) headers.set("Mcp-Session-Id", this.#sessionId);
      if (this.#connected) headers.set("MCP-Protocol-Version", this.#protocolVersion);
    } else {
      headers.set("MCP-Protocol-Version", MODERN_PROTOCOL_VERSION);
      if (method) headers.set("Mcp-Method", method);
      if (name) headers.set("Mcp-Name", name);
    }
    const token = await this.#tokenProvider.token(forceRefresh);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return headers;
  }

  async #post(
    era: ProtocolEra,
    method: string,
    params: JsonValue,
    body: string,
    signal: AbortSignal,
    forceRefresh = false,
  ): Promise<Response> {
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) throw new Error(`MCP request exceeded ${MAX_REQUEST_BYTES} bytes`);
    const headers = await this.#headers(era, true, method, requestName(method, params), forceRefresh);
    return this.#fetch(this.#url, { method: "POST", headers, body, redirect: "error", signal });
  }

  async #send(
    era: ProtocolEra,
    method: string,
    params: JsonValue,
    payload: unknown,
    signal: AbortSignal | undefined,
    expectedId?: number,
  ): Promise<unknown> {
    const body = JSON.stringify(payload);
    const bound = combineSignal(signal, this.#timeoutMs);
    try {
      let response = await this.#post(era, method, params, body, bound.signal, false);
      if (response.status === 401 && this.#server.auth.kind === "oauth") {
        await response.body?.cancel();
        response = await this.#post(era, method, params, body, bound.signal, true);
      }
      if (era === "legacy" && response.status === 404 && this.#sessionId) {
        await response.body?.cancel();
        throw new McpSessionExpiredError(`MCP session expired for ${this.#server.id}`);
      }
      const text = await readBounded(response);
      if (!response.ok) {
        throw new McpHttpStatusError(
          response.status,
          `MCP ${this.#server.id} request failed with HTTP ${response.status}${text ? `: ${text.slice(0, 512)}` : ""}`,
        );
      }
      if (era === "legacy") {
        const sessionId = response.headers.get("mcp-session-id")?.trim();
        if (sessionId) {
          if (sessionId.length > 512 || /[\r\n]/.test(sessionId)) throw new Error("MCP server returned an invalid session id");
          this.#sessionId = sessionId;
        }
      }
      const messages = parsePayload(response, text);
      if (expectedId === undefined) return undefined;
      for (const message of messages) {
        const record = objectRecord(message);
        if (!record || record.id !== expectedId) continue;
        if (record.error !== undefined) {
          const error = objectRecord(record.error);
          const code = typeof error?.code === "number" ? error.code : undefined;
          throw new McpProtocolError(
            code,
            `MCP protocol error${code !== undefined ? ` ${code}` : ""}: ${typeof error?.message === "string" ? error.message : "unknown error"}`,
          );
        }
        if (!("result" in record)) throw new Error("MCP response is missing result");
        return record.result;
      }
      throw new Error(`MCP response did not contain JSON-RPC id ${expectedId}`);
    } finally {
      bound.cleanup();
    }
  }

  async #requestWithEra(
    era: ProtocolEra,
    method: string,
    params: JsonValue,
    signal: AbortSignal | undefined,
    retrySession: boolean,
  ): Promise<unknown> {
    const id = ++this.#requestId;
    const wireParams = era === "modern" ? modernParams(params) : params;
    try {
      return await this.#send(era, method, wireParams, { jsonrpc: "2.0", id, method, params: wireParams }, signal, id);
    } catch (error) {
      if (era !== "legacy" || !retrySession || !(error instanceof McpSessionExpiredError)) throw error;
      this.#sessionId = undefined;
      this.#connected = false;
      this.#era = undefined;
      await this.connect(signal);
      return this.#request(method, params, signal, false);
    }
  }

  async #request(method: string, params: JsonValue, signal: AbortSignal | undefined, retrySession: boolean): Promise<unknown> {
    if (!this.#era) throw new Error("MCP connection has not negotiated a protocol era");
    return this.#requestWithEra(this.#era, method, params, signal, retrySession);
  }

  async #notify(method: string, params: JsonValue, signal?: AbortSignal): Promise<void> {
    if (!this.#era) throw new Error("MCP connection has not negotiated a protocol era");
    const wireParams = this.#era === "modern" ? modernParams(params) : params;
    await this.#send(this.#era, method, wireParams, { jsonrpc: "2.0", method, params: wireParams }, signal);
  }
}
