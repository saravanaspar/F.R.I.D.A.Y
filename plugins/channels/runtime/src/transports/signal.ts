import { reportOperationalError, reportUnlessExpectedAbort } from "@friday/operational-errors";
import type {
  ChannelInboundHandler,
  ChannelPrincipal,
  ChannelSendResult,
  ChannelTarget,
  ChannelTransport,
  ChannelTransportStatus,
} from "../types.js";
import { channelPrincipalAllowed, delay, fetchWithTimeout, requireHttpUrl, splitChannelMessage, type ChannelAccessPolicy } from "./shared.js";

export interface SignalChannelConfig extends ChannelAccessPolicy {
  readonly accountId?: string | undefined;
  readonly account: string;
  readonly httpUrl?: string | undefined;
}

export interface SignalTransportDependencies {
  readonly fetch?: typeof fetch | undefined;
}

interface SignalNotification {
  method?: string;
  params?: {
    account?: string;
    envelope?: SignalEnvelope;
    result?: { account?: string; envelope?: SignalEnvelope };
  };
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: {
    timestamp?: number;
    message?: string;
    groupInfo?: { groupId?: string; type?: string };
    attachments?: Array<{ id?: string; contentType?: string; filename?: string; size?: number }>;
  };
  syncMessage?: unknown;
}

export class SignalChannelTransport implements ChannelTransport {
  readonly channel = "signal" as const;
  readonly accountId: string;
  readonly #config: SignalChannelConfig;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  #handler: ChannelInboundHandler | undefined;
  #controller: AbortController | undefined;
  #runPromise: Promise<void> | undefined;
  #state: ChannelTransportStatus["state"] = "stopped";
  #detail: string | undefined;

  constructor(config: SignalChannelConfig, dependencies: SignalTransportDependencies = {}) {
    this.#config = config;
    this.#fetch = dependencies.fetch ?? fetch;
    this.accountId = config.accountId?.trim() || "default";
    const parsed = requireHttpUrl(config.httpUrl?.trim() || "http://127.0.0.1:8080", "Signal HTTP URL", { allowHttpLoopback: true });
    if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) throw new Error("Signal HTTP endpoint must be loopback; tunnel remote signal-cli to localhost");
    this.#baseUrl = parsed.toString().replace(/\/$/, "");
    if (!config.account.trim()) throw new Error("Signal account is required");
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    if (this.#state === "running" || this.#state === "starting") return;
    this.#state = "starting";
    this.#handler = handler;
    this.#detail = undefined;
    const health = await fetchWithTimeout(this.#fetch, `${this.#baseUrl}/api/v1/check`);
    if (!health.ok) {
      this.#state = "error";
      throw new Error("Signal daemon health check failed");
    }
    this.#controller = new AbortController();
    this.#state = "running";
    this.#runPromise = this.#run(this.#controller.signal).catch((error: unknown) => {
      reportUnlessExpectedAbort({ component: "channels.signal", operation: "receive loop terminated", error }, this.#controller?.signal);
      if (this.#state !== "stopped") {
        this.#state = "error";
        this.#detail = "Signal event stream stopped";
      }
    });
  }

  async stop(): Promise<void> {
    this.#state = "stopped";
    this.#controller?.abort();
    await this.#runPromise?.catch((error: unknown) => {
      reportUnlessExpectedAbort({ component: "channels.signal", operation: "stop receive loop", error }, this.#controller?.signal);
    });
    this.#controller = undefined;
    this.#runPromise = undefined;
    this.#handler = undefined;
    this.#detail = undefined;
  }

  status(): ChannelTransportStatus {
    return Object.freeze({ channel: this.channel, accountId: this.accountId, state: this.#state, ...(this.#detail === undefined ? {} : { detail: this.#detail }) });
  }

  async send(target: ChannelTarget, text: string): Promise<ChannelSendResult> {
    const ids: string[] = [];
    for (const chunk of splitChannelMessage(text, 4000)) {
      const isGroup = target.conversationId.startsWith("group:");
      const params: Record<string, unknown> = {
        account: this.#config.account,
        message: chunk,
        ...(isGroup ? { groupId: target.conversationId.slice("group:".length) } : { recipient: [target.conversationId] }),
      };
      const response = await fetchWithTimeout(this.#fetch, `${this.#baseUrl}/api/v1/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: `friday-${Date.now()}-${ids.length}`, method: "send", params }),
      });
      const payload = await response.json() as { result?: { timestamp?: number }; error?: unknown };
      if (!response.ok || payload.error) throw new Error("Signal send failed");
      if (payload.result?.timestamp !== undefined) ids.push(String(payload.result.timestamp));
    }
    return Object.freeze({ channel: this.channel, accountId: this.accountId, conversationId: target.conversationId, messageIds: Object.freeze(ids) });
  }

  async #run(signal: AbortSignal): Promise<void> {
    let backoff = 500;
    while (!signal.aborted) {
      try {
        await this.#consumeEvents(signal);
        backoff = 500;
      } catch (error) {
        if (signal.aborted) return;
        reportOperationalError({ component: "channels.signal", operation: "receive messages", error });
        await delay(backoff, signal).catch((delayError: unknown) => {
          reportUnlessExpectedAbort({ component: "channels.signal", operation: "receive retry delay", error: delayError }, signal);
        });
        backoff = Math.min(10_000, backoff * 2);
      }
    }
  }

  async #consumeEvents(signal: AbortSignal): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/api/v1/events`, { signal, headers: { accept: "text/event-stream" } });
    if (!response.ok || !response.body) throw new Error("Signal event stream failed");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data) await this.#handleData(data);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async #handleData(data: string): Promise<void> {
    if (!this.#handler) return;
    let notification: SignalNotification;
    try { notification = JSON.parse(data) as SignalNotification; } catch (error) {
      reportOperationalError({ component: "channels.signal", operation: "parse receive notification", error, severity: "warn" });
      return;
    }
    if (notification.method !== "receive") return;
    const envelope = notification.params?.envelope ?? notification.params?.result?.envelope;
    const account = notification.params?.account ?? notification.params?.result?.account;
    if (account && account !== this.#config.account) return;
    if (!envelope || envelope.syncMessage) return;
    const message = envelope.dataMessage;
    const sender = envelope.sourceNumber ?? envelope.source ?? envelope.sourceUuid;
    if (!message || !sender) return;
    const groupId = message.groupInfo?.groupId;
    const conversationId = groupId ? `group:${groupId}` : sender;
    const type = groupId ? "group" as const : "dm" as const;
    const principal: ChannelPrincipal = { channel: this.channel, accountId: this.accountId, conversationId, senderId: sender };
    if (!channelPrincipalAllowed(principal, type, this.#config)) return;
    const hasUnsupportedAttachment = (message.attachments?.length ?? 0) > 0;
    const text = [message.message?.trim(), hasUnsupportedAttachment ? "[attachment received; Signal media retrieval is not enabled]" : ""].filter(Boolean).join("\n");
    if (!text) return;
    await this.#handler({
      id: String(message.timestamp ?? envelope.timestamp ?? Date.now()),
      principal,
      chatType: type,
      text,
      timestamp: message.timestamp ?? envelope.timestamp ?? Date.now(),
      ...(envelope.sourceName === undefined ? {} : { senderName: envelope.sourceName }),
      attachments: Object.freeze([]),
    });
  }
}
