import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { reportOperationalError } from "@friday/operational-errors";

export interface WebhookRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface WebhookResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | Buffer | undefined;
}

export interface WebhookServerOptions {
  readonly host?: string | undefined;
  readonly port: number;
  readonly path: string;
  readonly maxBodyBytes?: number | undefined;
}

export type WebhookHandler = (request: WebhookRequest) => WebhookResponse | Promise<WebhookResponse>;

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("/")) throw new Error("Webhook path must begin with /");
  if (trimmed.includes("\0") || trimmed.includes("?")) throw new Error("Webhook path must not contain NUL or query text");
  return trimmed;
}

function writeResponse(response: ServerResponse, result: WebhookResponse): void {
  response.statusCode = result.status;
  for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
  response.end(result.body ?? "");
}

export class LocalWebhookServer {
  readonly #host: string;
  readonly #port: number;
  readonly #path: string;
  readonly #maxBodyBytes: number;
  readonly #handler: WebhookHandler;
  #server: Server | undefined;
  #boundPort: number | undefined;

  constructor(options: WebhookServerOptions, handler: WebhookHandler) {
    this.#host = options.host?.trim() || "127.0.0.1";
    this.#port = options.port;
    this.#path = normalizePath(options.path);
    this.#maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this.#handler = handler;
    if (!Number.isInteger(this.#port) || this.#port < 0 || this.#port > 65535) throw new Error("Webhook port must be between 0 and 65535");
    if (!Number.isInteger(this.#maxBodyBytes) || this.#maxBodyBytes < 1 || this.#maxBodyBytes > 16 * 1024 * 1024) {
      throw new Error("Webhook maxBodyBytes is invalid");
    }
  }

  get port(): number | undefined {
    return this.#boundPort;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((request, response) => {
      void this.#accept(request, response);
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#port, this.#host, () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Webhook server did not expose a TCP address");
      this.#boundPort = address.port;
    } catch (error) {
      this.#server = undefined;
      this.#boundPort = undefined;
      await new Promise<void>((resolve, reject) => server.close((closeError) => {
        if (closeError && (closeError as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(closeError);
        else resolve();
      })).catch((closeError: unknown) => {
        reportOperationalError({ component: "channels.webhook", operation: "close server after failed startup", error: closeError });
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#boundPort = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.closeAllConnections();
      }, 2_000);
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async #accept(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const parsed = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (parsed.pathname !== this.#path) {
        writeResponse(response, { status: 404, body: "not found" });
        return;
      }
      let total = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += value.byteLength;
        if (total > this.#maxBodyBytes) {
          writeResponse(response, { status: 413, body: "payload too large" });
          request.destroy();
          return;
        }
        chunks.push(value);
      }
      const result = await this.#handler({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      writeResponse(response, result);
    } catch (error) {
      reportOperationalError({ component: "channels.webhook", operation: "handle inbound request", error });
      if (!response.headersSent) writeResponse(response, { status: 500, body: "internal error" });
      else response.end();
    }
  }
}
