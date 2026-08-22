import { randomBytes } from "node:crypto";
import { reportOperationalError, reportUnlessExpectedAbort } from "@friday/operational-errors";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  ChannelAttachment,
  ChannelInboundHandler,
  ChannelPrincipal,
  ChannelSendResult,
  ChannelTarget,
  ChannelTransport,
  ChannelTransportStatus,
} from "../types.js";
import { channelPrincipalAllowed, delay, fetchWithTimeout, splitChannelMessage, type ChannelAccessPolicy } from "./shared.js";

export interface WhatsAppChannelConfig extends ChannelAccessPolicy {
  readonly accountId?: string | undefined;
  readonly bridgePort?: number | undefined;
  readonly sessionDir?: string | undefined;
  readonly bridgeDir?: string | undefined;
}

interface BridgeMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  chatName?: string;
  isGroup?: boolean;
  body?: string;
  timestamp?: number;
  quotedMessageId?: string;
  attachments?: Array<{
    kind?: string;
    externalId?: string;
    mimeType?: string;
    fileName?: string;
    sizeBytes?: number;
  }>;
}

function defaultFridayHome(): string {
  const configured = process.env.FRIDAY_HOME?.trim();
  return configured ? configured : join(homedir(), ".friday");
}

function defaultBridgeDir(): string {
  const bundled = process.env.FRIDAY_BUNDLED_ROOT?.trim();
  if (bundled) return join(bundled, "channels", "whatsapp");
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "bridge", "whatsapp");
}


function childEnvironment(bridgeSecret: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    FRIDAY_WHATSAPP_BRIDGE_SECRET: bridgeSecret,
  };
  for (const name of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function normalizeWhatsAppId(value: string): string {
  const trimmed = value.trim();
  const colon = trimmed.indexOf(":");
  const at = trimmed.indexOf("@");
  if (colon > 0 && at > colon) return `${trimmed.slice(0, colon)}${trimmed.slice(at)}`;
  return trimmed;
}

export class WhatsAppChannelTransport implements ChannelTransport {
  readonly channel = "whatsapp" as const;
  readonly accountId: string;
  readonly #config: WhatsAppChannelConfig;
  readonly #port: number;
  readonly #sessionDir: string;
  readonly #bridgeDir: string;
  #bridgeSecret = "";
  #child: ChildProcess | undefined;
  #controller: AbortController | undefined;
  #pollPromise: Promise<void> | undefined;
  #handler: ChannelInboundHandler | undefined;
  #state: ChannelTransportStatus["state"] = "stopped";
  #detail: string | undefined;

  constructor(config: WhatsAppChannelConfig = {}) {
    this.#config = config;
    this.accountId = config.accountId?.trim() || "default";
    this.#port = config.bridgePort ?? 3301;
    this.#sessionDir = config.sessionDir ?? join(defaultFridayHome(), "channels", "whatsapp", this.accountId, "session");
    this.#bridgeDir = config.bridgeDir ?? defaultBridgeDir();
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    if (this.#state === "running" || this.#state === "starting") return;
    this.#assertBridgeInstalled();
    this.#state = "starting";
    this.#handler = handler;
    this.#bridgeSecret = randomBytes(32).toString("hex");
    this.#controller = new AbortController();
    try {
      await this.#launchBridge(this.#controller.signal);
      this.#state = "running";
      this.#pollPromise = this.#poll(this.#controller.signal).catch((error: unknown) => {
        reportUnlessExpectedAbort({ component: "channels.whatsapp", operation: "bridge polling loop terminated", error }, this.#controller?.signal);
        if (this.#state !== "stopped") {
          this.#state = "error";
          this.#detail = "WhatsApp bridge polling stopped";
        }
      });
    } catch (error) {
      reportOperationalError({ component: "channels.whatsapp", operation: "start bridge", error });
      this.#state = "error";
      this.#detail = "WhatsApp bridge startup failed";
      await this.#stopChild();
      throw new Error("WhatsApp channel startup failed", { cause: error });
    }
  }

  async stop(): Promise<void> {
    this.#state = "stopped";
    this.#controller?.abort();
    await this.#pollPromise?.catch((error: unknown) => {
      reportUnlessExpectedAbort({ component: "channels.whatsapp", operation: "stop polling", error }, this.#controller?.signal);
    });
    await this.#stopChild();
    this.#controller = undefined;
    this.#pollPromise = undefined;
    this.#handler = undefined;
    this.#bridgeSecret = "";
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
    for (const chunk of splitChannelMessage(text, 4096)) {
      const response = await this.#request<{ messageId?: string }>("/send", {
        method: "POST",
        body: { chatId: target.conversationId, message: chunk },
      });
      if (response.messageId) messageIds.push(response.messageId);
    }
    return Object.freeze({
      channel: this.channel,
      accountId: this.accountId,
      conversationId: target.conversationId,
      messageIds: Object.freeze(messageIds),
    });
  }

  #assertBridgeInstalled(): void {
    const entry = join(this.#bridgeDir, "bridge.mjs");
    const baileys = join(this.#bridgeDir, "node_modules", "@whiskeysockets", "baileys", "package.json");
    if (!existsSync(entry)) throw new Error("WhatsApp bridge source is missing");
    if (!existsSync(baileys)) {
      throw new Error("WhatsApp bridge dependencies are not installed; run friday setup whatsapp");
    }
  }

  async #launchBridge(signal: AbortSignal): Promise<void> {
    this.#child = spawn(process.execPath, [join(this.#bridgeDir, "bridge.mjs"), "--port", String(this.#port), "--session", this.#sessionDir], {
      cwd: this.#bridgeDir,
      env: childEnvironment(this.#bridgeSecret),
      stdio: ["ignore", "inherit", "inherit"],
    });
    this.#child.once("exit", () => {
      if (this.#state === "running") {
        this.#state = "error";
        this.#detail = "WhatsApp bridge exited";
      }
    });

    const deadline = Date.now() + 15_000;
    let lastHealthError: unknown;
    while (!signal.aborted && Date.now() < deadline) {
      if (this.#child.exitCode !== null) throw new Error("WhatsApp bridge exited during startup");
      try {
        const health = await this.#request<{ ok?: boolean }>("/health", { method: "GET" });
        if (health.ok === true) return;
      } catch (error) {
        lastHealthError = error;
      }
      await delay(200, signal);
    }
    throw new Error("WhatsApp bridge did not become ready", { cause: lastHealthError });
  }

  async #poll(signal: AbortSignal): Promise<void> {
    let backoff = 500;
    while (!signal.aborted) {
      try {
        const messages = await this.#request<BridgeMessage[]>("/messages", { method: "GET", signal });
        backoff = 500;
        for (const message of messages) {
          // The sidecar keeps the item durably queued until the host has admitted or
          // intentionally ignored it. Failure before this ACK causes redelivery.
          await this.#handle(message);
          await this.#request<{ ok?: boolean }>("/messages/ack", {
            method: "POST",
            body: { messageIds: [message.messageId] },
            signal,
          });
        }
        // The bridge normally holds this request until a message arrives or the
        // long-poll timeout expires. If it returns an empty batch immediately,
        // yield so shutdown/timers cannot be starved by a tight request loop.
        if (messages.length === 0 && !signal.aborted) {
          await delay(25, signal).catch((error: unknown) => {
            reportUnlessExpectedAbort({ component: "channels.whatsapp", operation: "empty-poll yield", error }, signal);
          });
        }
      } catch (error) {
        if (signal.aborted) return;
        reportOperationalError({ component: "channels.whatsapp", operation: "poll bridge", error });
        await delay(backoff, signal).catch((delayError: unknown) => {
          reportUnlessExpectedAbort({ component: "channels.whatsapp", operation: "poll retry delay", error: delayError }, signal);
        });
        backoff = Math.min(10_000, backoff * 2);
      }
    }
  }

  async #handle(message: BridgeMessage): Promise<void> {
    if (!this.#handler) return;
    const conversationId = normalizeWhatsAppId(message.chatId ?? "");
    const senderId = normalizeWhatsAppId(message.senderId ?? "");
    if (!conversationId || !senderId) return;
    const principal: ChannelPrincipal = {
      channel: this.channel,
      accountId: this.accountId,
      conversationId,
      senderId,
    };
    const type = message.isGroup ? "group" as const : "dm" as const;
    if (!channelPrincipalAllowed(principal, type, this.#config)) return;
    const attachments = Object.freeze((message.attachments ?? []).map((item): ChannelAttachment => Object.freeze({
      kind: item.kind === "image" || item.kind === "audio" || item.kind === "video" || item.kind === "document" || item.kind === "sticker" ? item.kind : "other",
      externalId: String(item.externalId ?? message.messageId),
      ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
      ...(item.fileName === undefined ? {} : { fileName: item.fileName }),
      ...(item.sizeBytes === undefined ? {} : { sizeBytes: item.sizeBytes }),
    })));
    const text = message.body?.trim() || (attachments.length > 0 ? `[${attachments[0]?.kind ?? "attachment"}]` : "");
    if (!text) return;
    await this.#handler({
      id: message.messageId,
      principal,
      chatType: type,
      text,
      timestamp: (message.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
      ...(message.senderName === undefined ? {} : { senderName: message.senderName }),
      ...(message.chatName === undefined ? {} : { conversationName: message.chatName }),
      ...(message.quotedMessageId === undefined ? {} : { replyToMessageId: message.quotedMessageId }),
      attachments,
    });
  }

  async #request<T>(path: string, options: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal }): Promise<T> {
    const response = await fetchWithTimeout(fetch, `http://127.0.0.1:${this.#port}${path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.#bridgeSecret}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, path.startsWith("/messages?") ? 35_000 : 15_000);
    if (!response.ok) throw new Error(`WhatsApp bridge request failed with status ${response.status}`);
    return await response.json() as T;
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      delay(2_000).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); }),
    ]);
  }
}
