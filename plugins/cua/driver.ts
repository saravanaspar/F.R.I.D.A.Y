import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const PROTOCOL_VERSION = "2026-07-28";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export interface CuaTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

/** One persistent, session-scoped MCP transport; CUA's window and browser refs live in this process. */
export class CuaDriver {
  #child: ChildProcessWithoutNullStreams | undefined;
  #connecting: Promise<void> | undefined;
  #buffer = "";
  #nextId = 0;
  #pending = new Map<number, Pending>();
  #tools: readonly CuaTool[] | undefined;

  constructor(private readonly executable = process.env.FRIDAY_CUA_DRIVER_BIN?.trim() || "cua-driver") {}

  async #connect(): Promise<void> {
    if (this.#connecting) { await this.#connecting; return; }
    if (this.#child) return;
    if (!this.#connecting) this.#connecting = this.#start().finally(() => { this.#connecting = undefined; });
    await this.#connecting;
  }

  async #start(): Promise<void> {
    const child = spawn(this.executable, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => this.#consume(data));
    // Drain stderr so verbose diagnostics never block the protocol pipe. Do not expose it to the model.
    child.stderr.resume();
    child.on("error", (error: Error) => this.#fail(error));
    child.on("exit", (code, signal) => this.#fail(new Error(`CUA driver exited (${code ?? signal ?? "unknown"})`)));
    try {
      await this.#request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "friday", version: "1.0.4" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  #consume(data: string): void {
    this.#buffer += data;
    if (Buffer.byteLength(this.#buffer) > MAX_MESSAGE_BYTES) {
      this.#fail(new Error("CUA driver response exceeds size limit"));
      this.#child?.kill();
      return;
    }
    let end: number;
    while ((end = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, end).trim();
      this.#buffer = this.#buffer.slice(end + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line) as unknown; }
      catch {
        this.#fail(new Error("CUA driver returned invalid JSON"));
        this.#child?.kill();
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const record = message as Record<string, unknown>;
      if (typeof record.id !== "number") continue;
      const pending = this.#pending.get(record.id);
      if (!pending) continue;
      this.#pending.delete(record.id);
      if (record.error && typeof record.error === "object") {
        const detail = (record.error as Record<string, unknown>).message;
        pending.reject(new Error(typeof detail === "string" ? detail : "CUA driver request failed"));
      } else pending.resolve(record.result);
    }
  }

  #fail(error: Error): void {
    this.#child = undefined;
    this.#tools = undefined;
    this.#buffer = "";
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async #request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const child = this.#child;
    if (!child || !child.stdin.writable) throw new Error("CUA driver is unavailable; install cua-driver and check desktop permissions");
    const id = ++this.#nextId;
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CUA driver ${method} timed out`));
        child.kill();
      }, REQUEST_TIMEOUT_MS);
      const onAbort = (): void => {
        this.#pending.delete(id);
        reject(new Error("CUA driver request aborted"));
        child.kill();
      };
      const settle: Pending = {
        resolve(value) { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject(error) { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); reject(error); },
      };
      this.#pending.set(id, settle);
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) { this.#pending.delete(id); settle.reject(error); }
      });
    });
  }

  async listTools(signal?: AbortSignal): Promise<readonly CuaTool[]> {
    await this.#connect();
    if (this.#tools) return this.#tools;
    const tools: CuaTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.#request("tools/list", cursor ? { cursor } : {}, signal);
      if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) {
        throw new Error("CUA driver returned an invalid tool list");
      }
      const payload = result as { tools: unknown[]; nextCursor?: unknown };
      for (const tool of payload.tools) {
        if (!tool || typeof tool !== "object") throw new Error("CUA driver returned an invalid tool");
        const item = tool as CuaTool;
        if (typeof item.name !== "string" || !item.inputSchema || typeof item.inputSchema !== "object" || Array.isArray(item.inputSchema)) {
          throw new Error("CUA driver returned an invalid tool schema");
        }
        tools.push(item);
        if (tools.length > 500) throw new Error("CUA driver tool list exceeds limit");
      }
      if (payload.nextCursor === undefined) return (this.#tools = Object.freeze(tools));
      if (typeof payload.nextCursor !== "string" || !payload.nextCursor || payload.nextCursor === cursor) break;
      cursor = payload.nextCursor;
    }
    throw new Error("CUA driver tool pagination exceeded limit");
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!(await this.listTools(signal)).some((tool) => tool.name === name)) throw new Error(`CUA driver has no tool named ${name}`);
    return await this.#request("tools/call", { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    child.kill();
    this.#fail(new Error("CUA driver connection closed"));
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  }
}
