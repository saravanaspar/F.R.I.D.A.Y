import { clientRequestSigningPayload, clientWebSocketSigningPayload } from "@friday/client-protocol";
import type { DesktopEvent } from "./core.js";

export interface DesktopGatewayOptions {
  readonly baseUrl: string;
  readonly deviceId: string;
  readonly sign: (payload: string) => Promise<string>;
  readonly fetcher?: typeof fetch;
  readonly webSocketFactory?: (url: string) => WebSocket;
}

export interface DesktopGatewayStatus {
  readonly status: "connecting" | "online" | "offline";
  readonly latestSequence: number;
}

export interface DesktopGatewayClient {
  health(): Promise<{ readonly status: string; readonly protocolVersion: number }>;
  request<T>(path: string, body?: Readonly<Record<string, unknown>>): Promise<T>;
  stream(afterSequence: number, onEvent: (event: DesktopEvent) => void, onStatus?: (status: DesktopGatewayStatus) => void): () => void;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("gateway URL is invalid"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("gateway URL must use HTTP or HTTPS");
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) throw new Error("gateway URL must use HTTPS outside loopback");
  return url.toString().replace(/\/$/u, "");
}

function webSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/v1/stream`;
  return url.toString();
}

export function createDesktopGatewayClient(options: DesktopGatewayOptions): DesktopGatewayClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetcher = options.fetcher ?? fetch;
  const webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));

  async function challenge(): Promise<string> {
    const response = await fetcher(`${baseUrl}/v1/auth/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: options.deviceId }) });
    if (!response.ok) throw new Error(`gateway challenge failed (${response.status})`);
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object" || typeof (raw as Record<string, unknown>).challenge !== "string") throw new Error("gateway challenge response is malformed");
    return (raw as Record<string, unknown>).challenge as string;
  }

  return {
    async health() {
      const response = await fetcher(`${baseUrl}/health`, { method: "GET" });
      if (!response.ok) throw new Error(`gateway health failed (${response.status})`);
      return await response.json() as { readonly status: string; readonly protocolVersion: number };
    },
    async request<T>(path: string, body: Readonly<Record<string, unknown>> = {}) {
      if (!path.startsWith("/")) throw new Error("gateway request path must be absolute");
      const authChallenge = await challenge();
      const signature = await options.sign(clientRequestSigningPayload({
        challenge: authChallenge,
        deviceId: options.deviceId,
        method: "POST",
        path,
        body,
      }));
      const response = await fetcher(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, deviceId: options.deviceId, challenge: authChallenge, signature }) });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).message === "string" ? (payload as Record<string, unknown>).message as string : `gateway request failed (${response.status})`;
        throw new Error(message);
      }
      return payload as T;
    },
    stream(afterSequence, onEvent, onStatus) {
      let closed = false;
      let socket: WebSocket | undefined;
      let retry = 250;
      let timer: number | undefined;
      const connect = (): void => {
        if (closed) return;
        onStatus?.({ status: "connecting", latestSequence: afterSequence });
        void challenge().then(async (authChallenge) => {
          const signature = await options.sign(clientWebSocketSigningPayload({ challenge: authChallenge, deviceId: options.deviceId, afterSequence }));
          if (closed) return;
          socket = webSocketFactory(webSocketUrl(baseUrl));
          socket.addEventListener("open", () => {
            socket?.send(JSON.stringify({ kind: "client.authenticate", protocolVersion: 1, requestId: crypto.randomUUID(), deviceId: options.deviceId, challenge: authChallenge, signature, afterSequence }));
          });
          socket.addEventListener("message", (event) => {
            try {
              const parsed: unknown = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
              if (!parsed || typeof parsed !== "object") return;
              const frame = parsed as Record<string, unknown>;
              if (frame.kind === "client.ready") {
                retry = 250;
                const latestSequence = Number.isSafeInteger(frame.latestSequence) ? frame.latestSequence as number : afterSequence;
                onStatus?.({ status: "online", latestSequence });
                return;
              }
              if (frame.kind === "client.error") {
                socket?.close();
                return;
              }
              if (frame.kind !== "event") return;
              const raw = frame.event;
              if (!raw || typeof raw !== "object") return;
              const sequence = (raw as Record<string, unknown>).sequence;
              const type = (raw as Record<string, unknown>).type;
              if (!Number.isSafeInteger(sequence) || typeof type !== "string") return;
              afterSequence = sequence as number;
              onEvent({ sequence: afterSequence, type, data: (raw as Record<string, unknown>).data });
            } catch { /* malformed stream frames are ignored; replay will recover */ }
          });
          socket.addEventListener("close", () => {
            socket = undefined;
            if (closed) return;
            onStatus?.({ status: "offline", latestSequence: afterSequence });
            timer = window.setTimeout(connect, retry);
            retry = Math.min(10_000, retry * 2);
          });
          socket.addEventListener("error", () => socket?.close());
        }).catch(() => {
          if (closed) return;
          onStatus?.({ status: "offline", latestSequence: afterSequence });
          timer = window.setTimeout(connect, retry);
          retry = Math.min(10_000, retry * 2);
        });
      };
      connect();
      return () => { closed = true; if (timer !== undefined) window.clearTimeout(timer); socket?.close(); };
    },
  };
}
