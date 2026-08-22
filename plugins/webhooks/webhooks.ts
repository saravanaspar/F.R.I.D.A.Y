import { createHmac, timingSafeEqual } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { EventJsonValue, EventsService } from "../events/contract.js";
import type { WebhookRateLimit, WebhookRouteInfo, WebhookServerStatus, WebhooksService } from "./contract.js";
import type {
  WebhookHmacRouteInput,
  WebhookIngressRequest,
  WebhookIngressResponse,
  WebhookServerOptions,
  WebhooksTrustedService,
} from "./trusted-contract.js";
import { getWebhooksStateDir, WebhooksDatabase } from "./store.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_AGE_SECONDS = 300;
const DEFAULT_RATE_LIMIT: WebhookRateLimit = Object.freeze({ windowMs: 60_000, maxRequests: 60 });
const DEFAULT_SIGNATURE_HEADER = "x-friday-signature";
const DEFAULT_TIMESTAMP_HEADER = "x-friday-timestamp";
const DEFAULT_NONCE_HEADER = "x-friday-nonce";

interface InternalRoute extends WebhookRouteInfo {
  secretRef: string;
  signatureHeader: string;
  timestampHeader: string;
  nonceHeader: string;
}

export interface WebhooksServiceOptions {
  stateDir?: string | undefined;
  events: Pick<EventsService, "publish">;
  consumeSecret: (ref: string, consumer: (secret: Uint8Array) => void | Promise<void>) => Promise<void>;
  now?: (() => Date) | undefined;
  host?: string | undefined;
  port?: number | undefined;
}

function normalizeIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(normalized)) {
    throw new Error(`${label} must be a bounded identifier`);
  }
  return normalized;
}

function normalizeEventType(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)) throw new Error("Webhook eventType is invalid");
  return normalized;
}

function normalizePath(value: string): string {
  const normalized = value.trim();
  if (!normalized.startsWith("/") || normalized.length > 512 || normalized.includes("\0") || normalized.includes("?")) {
    throw new Error("Webhook path must be an absolute path without query text");
  }
  return normalized;
}

function normalizeHeaderName(value: string | undefined, fallback: string): string {
  const normalized = (value?.trim() || fallback).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(normalized)) throw new Error(`Webhook header name is invalid: ${normalized}`);
  return normalized;
}

function normalizeInteger(value: number | undefined, fallback: number, label: string, min: number, max: number): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) throw new Error(`${label} is invalid`);
  return normalized;
}

function normalizeRoute(input: WebhookHmacRouteInput): InternalRoute {
  const id = normalizeIdentifier(input.id, "Webhook route id");
  const maxBodyBytes = normalizeInteger(input.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, "Webhook maxBodyBytes", 1, MAX_BODY_BYTES);
  const maxAgeSeconds = normalizeInteger(input.maxAgeSeconds, DEFAULT_MAX_AGE_SECONDS, "Webhook maxAgeSeconds", 1, 86_400);
  const windowMs = normalizeInteger(input.rateLimit?.windowMs, DEFAULT_RATE_LIMIT.windowMs, "Webhook rateLimit.windowMs", 1000, 86_400_000);
  const maxRequests = normalizeInteger(input.rateLimit?.maxRequests, DEFAULT_RATE_LIMIT.maxRequests, "Webhook rateLimit.maxRequests", 1, 100_000);
  const secretRef = input.secretRef.trim();
  if (!secretRef) throw new Error("Webhook secretRef is required");
  return Object.freeze({
    id,
    path: normalizePath(input.path),
    auth: "hmac-sha256",
    eventType: normalizeEventType(input.eventType),
    source: input.source ? normalizeIdentifier(input.source, "Webhook source") : `webhook.${id}`,
    secretRef,
    signatureHeader: normalizeHeaderName(input.signatureHeader, DEFAULT_SIGNATURE_HEADER),
    timestampHeader: normalizeHeaderName(input.timestampHeader, DEFAULT_TIMESTAMP_HEADER),
    nonceHeader: normalizeHeaderName(input.nonceHeader, DEFAULT_NONCE_HEADER),
    maxBodyBytes,
    maxAgeSeconds,
    rateLimit: Object.freeze({ windowMs, maxRequests }),
  });
}

function publicRoute(route: InternalRoute): WebhookRouteInfo {
  return Object.freeze({
    id: route.id,
    path: route.path,
    auth: route.auth,
    eventType: route.eventType,
    source: route.source,
    maxBodyBytes: route.maxBodyBytes,
    maxAgeSeconds: route.maxAgeSeconds,
    rateLimit: Object.freeze({ ...route.rateLimit }),
  });
}

function header(request: WebhookIngressRequest, name: string): string | undefined {
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() !== name) continue;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function parseSignature(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) return undefined;
  return Buffer.from(normalized, "hex");
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value || !/^\d{10}$/.test(value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function normalizeNonce(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || !/^[A-Za-z0-9._:-]{8,200}$/.test(normalized)) return undefined;
  return normalized;
}

function isJsonValue(value: unknown): value is EventJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry));
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry));
}

function parseJsonBody(body: Uint8Array): EventJsonValue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  return isJsonValue(parsed) ? parsed : undefined;
}

function writeResponse(response: ServerResponse, result: WebhookIngressResponse): void {
  response.statusCode = result.status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(result.body);
}

function errorResponse(status: number, code: string): WebhookIngressResponse {
  return { status, body: JSON.stringify({ accepted: false, error: code }) };
}

export function createWebhooksService(options: WebhooksServiceOptions): {
  public: WebhooksService;
  trusted: WebhooksTrustedService;
} {
  const now = options.now ?? (() => new Date());
  const database = new WebhooksDatabase({ stateDir: options.stateDir ?? getWebhooksStateDir() });
  const routes = new Map<string, InternalRoute>();
  const paths = new Map<string, InternalRoute>();
  let host = options.host?.trim() || DEFAULT_HOST;
  let configuredPort = normalizeInteger(options.port, DEFAULT_PORT, "Webhook server port", 0, 65535);
  let server: Server | undefined;
  let boundPort: number | undefined;
  let closed = false;

  const status = (): WebhookServerStatus => Object.freeze({
    running: server !== undefined,
    host,
    configuredPort,
    ...(boundPort !== undefined ? { boundPort } : {}),
    routeCount: routes.size,
  });

  const ingest = async (request: WebhookIngressRequest): Promise<WebhookIngressResponse> => {
    if (closed) throw new Error("Webhooks service is closed");
    const parsedPath = new URL(request.path, "http://localhost").pathname;
    const route = paths.get(parsedPath);
    if (!route) return errorResponse(404, "not_found");
    if (request.method.toUpperCase() !== "POST") return errorResponse(405, "method_not_allowed");
    if (request.body.byteLength > route.maxBodyBytes) return errorResponse(413, "payload_too_large");

    const contentType = header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const jsonMediaType = contentType === "application/json" ||
      (contentType?.startsWith("application/") === true && contentType.endsWith("+json"));
    if (!jsonMediaType) return errorResponse(415, "unsupported_media_type");

    const timestampText = header(request, route.timestampHeader);
    const timestampSeconds = parseTimestamp(timestampText);
    const nonce = normalizeNonce(header(request, route.nonceHeader));
    const providedSignature = parseSignature(header(request, route.signatureHeader));
    if (timestampSeconds === undefined || !nonce || !providedSignature) return errorResponse(401, "unauthorized");

    const nowDate = now();
    const nowMs = nowDate.getTime();
    const timestampMs = timestampSeconds * 1000;
    if (!Number.isFinite(nowMs) || Math.abs(nowMs - timestampMs) > route.maxAgeSeconds * 1000) {
      return errorResponse(401, "unauthorized");
    }

    let signatureValid = false;
    await options.consumeSecret(route.secretRef, (secret) => {
      const hmac = createHmac("sha256", secret);
      hmac.update(`${timestampText!.trim()}.${nonce}.`, "utf8");
      hmac.update(request.body);
      const expected = hmac.digest();
      signatureValid = expected.byteLength === providedSignature.byteLength && timingSafeEqual(expected, providedSignature);
    });
    if (!signatureValid) return errorResponse(401, "unauthorized");

    if (!database.claimRateLimit(route.id, nowMs, route.rateLimit.windowMs, route.rateLimit.maxRequests)) {
      return errorResponse(429, "rate_limited");
    }
    if (database.getNonce(route.id, nonce, nowMs)) return errorResponse(409, "replay_detected");

    const data = parseJsonBody(request.body);
    if (data === undefined) return errorResponse(400, "invalid_json");

    let event;
    try {
      event = options.events.publish({
        type: route.eventType,
        source: route.source,
        occurredAt: new Date(timestampMs).toISOString(),
        data,
        metadata: { webhook: { routeId: route.id, nonce } },
        dedupeKey: nonce,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("dedupe collision")) return errorResponse(409, "event_conflict");
      throw error;
    }

    const recorded = database.recordNonce({
      routeId: route.id,
      nonce,
      eventId: event.id,
      seenAt: nowDate.toISOString(),
      expiresAtMs: timestampMs + route.maxAgeSeconds * 1000,
    });
    if (!recorded.inserted) return errorResponse(409, "replay_detected");
    return { status: 202, eventId: event.id, body: JSON.stringify({ accepted: true, eventId: event.id }) };
  };

  const acceptHttp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
      const route = paths.get(path);
      if (!route) {
        writeResponse(response, errorResponse(404, "not_found"));
        return;
      }
      const contentLength = request.headers["content-length"];
      if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > route.maxBodyBytes) {
        writeResponse(response, errorResponse(413, "payload_too_large"));
        request.destroy();
        return;
      }
      let total = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += value.byteLength;
        if (total > route.maxBodyBytes) {
          writeResponse(response, errorResponse(413, "payload_too_large"));
          request.destroy();
          return;
        }
        chunks.push(value);
      }
      const headers: Record<string, string | readonly string[] | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) headers[name] = value;
      writeResponse(response, await ingest({
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers,
        body: Buffer.concat(chunks),
      }));
    } catch (error) {
      reportOperationalError({ component: "webhooks", operation: "handle inbound HTTP request", error });
      if (!response.headersSent) writeResponse(response, errorResponse(500, "internal_error"));
      else response.end();
    }
  };

  const publicService: WebhooksService = Object.freeze({
    routes: () => Object.freeze([...routes.values()].map(publicRoute).sort((a, b) => a.id.localeCompare(b.id))),
    route: (id: string) => {
      const route = routes.get(id.trim());
      return route ? publicRoute(route) : undefined;
    },
    status,
  });

  const trustedService: WebhooksTrustedService = Object.freeze({
    registerHmacRoute(input: WebhookHmacRouteInput) {
      if (closed) throw new Error("Webhooks service is closed");
      const route = normalizeRoute(input);
      if (routes.has(route.id)) throw new Error(`Webhook route id is already registered: ${route.id}`);
      if (paths.has(route.path)) throw new Error(`Webhook path is already registered: ${route.path}`);
      routes.set(route.id, route);
      paths.set(route.path, route);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (routes.get(route.id) === route) routes.delete(route.id);
        if (paths.get(route.path) === route) paths.delete(route.path);
      };
    },
    ingest,
    async start(startOptions: WebhookServerOptions = {}) {
      if (closed) throw new Error("Webhooks service is closed");
      if (server) return status();
      host = startOptions.host?.trim() || host;
      configuredPort = normalizeInteger(startOptions.port, configuredPort, "Webhook server port", 0, 65535);
      const nextServer = createServer((request, response) => { void acceptHttp(request, response); });
      nextServer.headersTimeout = 10_000;
      nextServer.requestTimeout = 30_000;
      nextServer.keepAliveTimeout = 5_000;
      nextServer.maxHeadersCount = 100;
      server = nextServer;
      try {
        await new Promise<void>((resolveStart, reject) => {
          nextServer.once("error", reject);
          nextServer.listen(configuredPort, host, () => resolveStart());
        });
        const address = nextServer.address();
        if (!address || typeof address === "string") throw new Error("Webhook server did not expose a TCP address");
        boundPort = address.port;
        return status();
      } catch (error) {
        server = undefined;
        boundPort = undefined;
        await new Promise<void>((resolveClose, rejectClose) => nextServer.close((closeError) => {
          if (closeError && (closeError as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") rejectClose(closeError);
          else resolveClose();
        })).catch((closeError: unknown) => {
          reportOperationalError({ component: "webhooks", operation: "close server after failed startup", error: closeError });
        });
        throw error;
      }
    },
    async stop() {
      const current = server;
      server = undefined;
      boundPort = undefined;
      if (!current) return;
      await new Promise<void>((resolveStop, reject) => {
        const timer = setTimeout(() => current.closeAllConnections(), 2_000);
        current.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolveStop();
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      const current = server;
      server = undefined;
      boundPort = undefined;
      if (current) {
        await new Promise<void>((resolveStop) => {
          const timer = setTimeout(() => current.closeAllConnections(), 2_000);
          current.close(() => {
            clearTimeout(timer);
            resolveStop();
          });
        });
      }
      database.close();
    },
  });

  return { public: publicService, trusted: trustedService };
}
