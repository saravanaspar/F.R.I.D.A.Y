import { reportOperationalError, reportUnlessExpectedAbort } from "@friday/operational-errors";
import type {
  ChannelAttachment,
  ChannelInboundHandler,
  ChannelPrincipal,
  ChannelSendResult,
  ChannelTarget,
  ChannelTransport,
  ChannelTransportStatus,
} from "../types.js";
import {
  channelPrincipalAllowed,
  fetchWithTimeout,
  delay,
  splitChannelMessage,
  withSecretText,
  type ChannelAccessPolicy,
  type SecretConsumer,
} from "./shared.js";

export interface DiscordChannelConfig extends ChannelAccessPolicy {
  readonly accountId?: string | undefined;
  readonly credentialRef: string;
  readonly gatewayUrl?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly requireMention?: boolean | undefined;
  readonly mentionPatterns?: readonly string[] | undefined;
}

interface WebSocketEventMap {
  open: { readonly type?: string };
  close: { readonly code?: number; readonly reason?: string };
  error: { readonly error?: unknown };
  message: { readonly data: unknown };
}

interface WebSocketLike {
  readonly readyState: number;
  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void, options?: { once?: boolean }): void;
  removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface DiscordTransportDependencies {
  readonly fetch?: typeof fetch | undefined;
  readonly websocketFactory?: ((url: string) => WebSocketLike) | undefined;
}

interface DiscordGatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

interface DiscordMessage {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  content?: string;
  author?: { id?: string; username?: string; global_name?: string; bot?: boolean };
  referenced_message?: { id?: string } | null;
  attachments?: Array<{ id?: string; filename?: string; content_type?: string; size?: number; url?: string }>;
}

function asText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return undefined;
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const Constructor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Constructor) throw new Error("Discord requires WebSocket support in the Node runtime");
  return new Constructor(url);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MIN_DISCORD_HEARTBEAT_INTERVAL_MS = 100;
const MAX_DISCORD_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export function normalizeDiscordHeartbeatInterval(value: unknown): number | undefined {
  const interval = Number(value);
  if (
    !Number.isSafeInteger(interval) ||
    interval < MIN_DISCORD_HEARTBEAT_INTERVAL_MS ||
    interval > MAX_DISCORD_HEARTBEAT_INTERVAL_MS
  ) {
    return undefined;
  }
  return interval;
}

export class DiscordChannelTransport implements ChannelTransport {
  readonly channel = "discord" as const;
  readonly accountId: string;
  readonly #config: DiscordChannelConfig;
  readonly #secrets: SecretConsumer;
  readonly #fetch: typeof fetch;
  readonly #websocketFactory: (url: string) => WebSocketLike;
  readonly #mentionPatterns: readonly RegExp[];
  #controller: AbortController | undefined;
  #runPromise: Promise<void> | undefined;
  #handler: ChannelInboundHandler | undefined;
  #socket: WebSocketLike | undefined;
  #state: ChannelTransportStatus["state"] = "stopped";
  #detail: string | undefined;
  #botUserId: string | undefined;

  constructor(config: DiscordChannelConfig, secrets: SecretConsumer, dependencies: DiscordTransportDependencies = {}) {
    this.#config = config;
    this.#secrets = secrets;
    this.accountId = config.accountId?.trim() || "default";
    this.#fetch = dependencies.fetch ?? fetch;
    this.#websocketFactory = dependencies.websocketFactory ?? defaultWebSocketFactory;
    this.#mentionPatterns = Object.freeze((config.mentionPatterns ?? []).map((pattern) => new RegExp(pattern, "i")));
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    if (this.#state === "running" || this.#state === "starting") return;
    this.#state = "starting";
    this.#detail = undefined;
    this.#handler = handler;
    this.#controller = new AbortController();
    let readyResolve: (() => void) | undefined;
    let readyReject: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    this.#runPromise = this.#run(this.#controller.signal, () => readyResolve?.()).catch((error) => {
      reportUnlessExpectedAbort({ component: "channels.discord", operation: "gateway loop terminated", error }, this.#controller?.signal);
      if (this.#state !== "stopped") {
        this.#state = "error";
        this.#detail = "Discord Gateway connection stopped";
        readyReject?.(error instanceof Error ? error : new Error("Discord Gateway connection failed"));
      }
    });
    try {
      await Promise.race([
        ready,
        delay(15_000, this.#controller.signal).then(() => { throw new Error("Discord Gateway readiness timed out"); }),
      ]);
      this.#state = "running";
    } catch (error) {
      await this.stop().catch((cleanupError: unknown) => {
        reportOperationalError({ component: "channels.discord", operation: "cleanup failed startup", error: cleanupError });
      });
      this.#state = "error";
      this.#detail = "Discord startup failed";
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#state = "stopped";
    this.#controller?.abort();
    this.#socket?.close(1000, "FRIDAY shutdown");
    await this.#runPromise?.catch((error: unknown) => {
      reportUnlessExpectedAbort({ component: "channels.discord", operation: "stop gateway loop", error }, this.#controller?.signal);
    });
    this.#controller = undefined;
    this.#runPromise = undefined;
    this.#socket = undefined;
    this.#handler = undefined;
    this.#detail = undefined;
  }

  status(): ChannelTransportStatus {
    return Object.freeze({
      channel: this.channel,
      accountId: this.accountId,
      state: this.#state,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
    });
  }

  async send(target: ChannelTarget, text: string): Promise<ChannelSendResult> {
    const messageIds: string[] = [];
    for (const chunk of splitChannelMessage(text, 1900)) {
      const result = await this.#api<{ id?: string }>(`/channels/${encodeURIComponent(target.conversationId)}/messages`, {
        method: "POST",
        body: { content: chunk },
      });
      if (result.id) messageIds.push(result.id);
    }
    return Object.freeze({
      channel: this.channel,
      accountId: this.accountId,
      conversationId: target.conversationId,
      messageIds: Object.freeze(messageIds),
    });
  }

  async #run(signal: AbortSignal, onFirstReady: () => void): Promise<void> {
    let firstReady = false;
    let backoff = 500;
    while (!signal.aborted) {
      try {
        await this.#connect(signal, () => {
          if (!firstReady) {
            firstReady = true;
            onFirstReady();
          }
        });
        backoff = 500;
      } catch (error) {
        if (signal.aborted) return;
        reportOperationalError({ component: "channels.discord", operation: "connect gateway", error });
      }
      if (!signal.aborted) {
        await delay(backoff, signal).catch((error: unknown) => {
          reportUnlessExpectedAbort({ component: "channels.discord", operation: "reconnect delay", error }, signal);
        });
        backoff = Math.min(10_000, backoff * 2);
      }
    }
  }

  async #connect(signal: AbortSignal, onReady: () => void): Promise<void> {
    const gateway = this.#config.gatewayUrl?.trim() || "wss://gateway.discord.gg/?v=10&encoding=json";
    const socket = this.#websocketFactory(gateway);
    this.#socket = socket;
    let heartbeat: NodeJS.Timeout | undefined;
    let sequence: number | null = null;
    let closedResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => { closedResolve = resolve; });

    const identify = async () => {
      await withSecretText(this.#secrets, this.#config.credentialRef, async (token) => {
        socket.send(JSON.stringify({
          op: 2,
          d: {
            token,
            intents: 37377,
            properties: { os: process.platform, browser: "friday", device: "friday" },
          },
        }));
      });
    };

    const onMessage = (event: WebSocketEventMap["message"]) => {
      const text = asText(event.data);
      if (!text) return;
      let payload: DiscordGatewayPayload;
      try { payload = JSON.parse(text) as DiscordGatewayPayload; } catch (error) {
        reportOperationalError({ component: "channels.discord", operation: "parse gateway payload", error, severity: "warn" });
        return;
      }
      if (typeof payload.s === "number") sequence = payload.s;
      if (payload.op === 10) {
        const interval = normalizeDiscordHeartbeatInterval(
          (payload.d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval,
        );
        if (interval === undefined) {
          socket.close(4000, "invalid heartbeat interval");
          return;
        }
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          try { socket.send(JSON.stringify({ op: 1, d: sequence })); } catch (error) {
            reportOperationalError({ component: "channels.discord", operation: "send heartbeat", error, severity: "warn" });
          }
        }, interval);
        void identify().catch((error: unknown) => {
          reportOperationalError({ component: "channels.discord", operation: "identify gateway session", error });
          socket.close(4001, "identify failed");
        });
        return;
      }
      if (payload.op === 7 || payload.op === 9) {
        socket.close(4002, "gateway reconnect");
        return;
      }
      if (payload.op !== 0) return;
      if (payload.t === "READY") {
        const ready = payload.d as { user?: { id?: string } } | undefined;
        this.#botUserId = ready?.user?.id;
        onReady();
        return;
      }
      if (payload.t === "MESSAGE_CREATE") {
        void this.#handleMessage(payload.d as DiscordMessage).catch((error: unknown) => {
          reportOperationalError({ component: "channels.discord", operation: "handle inbound message", error });
        });
      }
    };
    const onClose = () => closedResolve?.();
    const onError = () => socket.close();
    const onAbort = () => socket.close(1000, "aborted");
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await closed;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      if (this.#socket === socket) this.#socket = undefined;
    }
  }

  async #handleMessage(message: DiscordMessage): Promise<void> {
    if (!this.#handler || !message.id || !message.channel_id || !message.author?.id || message.author.bot === true) return;
    if (this.#botUserId && message.author.id === this.#botUserId) return;
    const type = message.guild_id ? "group" as const : "dm" as const;
    const principal: ChannelPrincipal = {
      channel: this.channel,
      accountId: this.accountId,
      conversationId: message.channel_id,
      senderId: message.author.id,
    };
    if (!channelPrincipalAllowed(principal, type, this.#config)) return;
    const content = message.content?.trim() ?? "";
    if (this.#config.requireMention === true && type !== "dm" && !this.#mentioned(content)) return;
    const attachments: readonly ChannelAttachment[] = Object.freeze((message.attachments ?? []).map((item) => Object.freeze({
      kind: item.content_type?.startsWith("image/") ? "image" as const
        : item.content_type?.startsWith("audio/") ? "audio" as const
        : item.content_type?.startsWith("video/") ? "video" as const
        : "document" as const,
      externalId: item.id ?? item.filename ?? message.id!,
      ...(item.content_type === undefined ? {} : { mimeType: item.content_type }),
      ...(item.filename === undefined ? {} : { fileName: item.filename }),
      ...(item.size === undefined ? {} : { sizeBytes: item.size }),
      ...(item.url === undefined ? {} : { downloadUrl: item.url }),
    })));
    const text = content || (attachments.length > 0 ? `[${attachments[0]?.kind ?? "attachment"}]` : "");
    if (!text) return;
    await this.#handler({
      id: message.id,
      principal,
      chatType: type,
      text,
      timestamp: Date.now(),
      ...(message.author.global_name ?? message.author.username ? { senderName: message.author.global_name ?? message.author.username } : {}),
      ...(message.referenced_message?.id ? { replyToMessageId: message.referenced_message.id } : {}),
      attachments,
    });
  }

  #mentioned(text: string): boolean {
    if (this.#botUserId && new RegExp(`<@!?${escapeRegExp(this.#botUserId)}>`).test(text)) return true;
    return this.#mentionPatterns.some((pattern) => pattern.test(text));
  }

  async fetchAttachment(attachment: ChannelAttachment, maxBytes: number) {
    const raw = attachment.downloadUrl?.trim();
    if (!raw) throw new Error("Discord attachment has no download URL");
    const url = new URL(raw);
    if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) {
      throw new Error("Discord attachment URL is not an approved Discord CDN URL");
    }
    const response = await fetchWithTimeout(this.#fetch, url, { redirect: "error" });
    if (!response.ok) throw new Error(`Discord attachment download failed with HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error("Discord attachment exceeds the configured size limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Discord attachment exceeds the configured size limit");
    return Object.freeze({ bytes, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}), ...(attachment.fileName ? { fileName: attachment.fileName } : {}) });
  }

  async #api<T>(path: string, input: { method: "GET" | "POST"; body?: unknown }): Promise<T> {
    return await withSecretText(this.#secrets, this.#config.credentialRef, async (token) => {
      const response = await fetchWithTimeout(this.#fetch, `${this.#config.apiBaseUrl?.replace(/\/$/, "") || "https://discord.com/api/v10"}${path}`, {
        method: input.method,
        headers: {
          authorization: `Bot ${token}`,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      if (!response.ok) throw new Error(`Discord API request failed with status ${response.status}`);
      return await response.json() as T;
    });
  }
}
