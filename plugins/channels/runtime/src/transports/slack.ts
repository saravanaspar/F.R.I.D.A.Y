import { reportOperationalError, reportUnlessExpectedAbort } from "@friday/operational-errors";
import type {
  ChannelInboundHandler,
  ChannelPrincipal,
  ChannelSendResult,
  ChannelProtectedAction,
  ChannelProtectedQuestion,
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

export interface SlackChannelConfig extends ChannelAccessPolicy {
  readonly accountId?: string | undefined;
  readonly botTokenRef: string;
  readonly appTokenRef: string;
  readonly requireMention?: boolean | undefined;
}

interface WebSocketLike {
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void;
  removeEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SlackTransportDependencies {
  readonly fetch?: typeof fetch | undefined;
  readonly websocketFactory?: ((url: string) => WebSocketLike) | undefined;
}

interface SlackEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: {
    event?: SlackEvent;
    type?: string;
    user?: { id?: string };
    channel?: { id?: string; name?: string };
    actions?: Array<{ action_id?: string; value?: string }>;
    message?: { ts?: string; thread_ts?: string };
  };
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: Array<{ id?: string }>;
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const Constructor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Constructor) throw new Error("Slack Socket Mode requires WebSocket support in the Node runtime");
  return new Constructor(url);
}

function dataText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return undefined;
}

export class SlackChannelTransport implements ChannelTransport {
  readonly channel = "slack" as const;
  readonly accountId: string;
  readonly #config: SlackChannelConfig;
  readonly #secrets: SecretConsumer;
  readonly #fetch: typeof fetch;
  readonly #websocketFactory: (url: string) => WebSocketLike;
  #handler: ChannelInboundHandler | undefined;
  #controller: AbortController | undefined;
  #runPromise: Promise<void> | undefined;
  #socket: WebSocketLike | undefined;
  #state: ChannelTransportStatus["state"] = "stopped";
  #detail: string | undefined;
  #botUserId: string | undefined;

  constructor(config: SlackChannelConfig, secrets: SecretConsumer, dependencies: SlackTransportDependencies = {}) {
    this.#config = config;
    this.#secrets = secrets;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#websocketFactory = dependencies.websocketFactory ?? defaultWebSocketFactory;
    this.accountId = config.accountId?.trim() || "default";
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    if (this.#state === "running" || this.#state === "starting") return;
    this.#state = "starting";
    this.#handler = handler;
    this.#detail = undefined;
    this.#controller = new AbortController();
    let auth: { ok?: boolean; user_id?: string };
    try {
      auth = await this.#webApi<{ ok?: boolean; user_id?: string }>("auth.test", {});
      if (auth.ok !== true || !auth.user_id) throw new Error("Slack auth.test failed");
    } catch (error) {
      this.#controller.abort();
      this.#controller = undefined;
      this.#handler = undefined;
      this.#state = "error";
      this.#detail = "Slack authentication failed";
      throw error;
    }
    this.#botUserId = auth.user_id;
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    this.#runPromise = this.#run(this.#controller.signal, () => readyResolve?.()).catch((error: unknown) => {
      reportUnlessExpectedAbort({ component: "channels.slack", operation: "socket loop terminated", error }, this.#controller?.signal);
      if (this.#state !== "stopped") {
        this.#state = "error";
        this.#detail = "Slack Socket Mode connection stopped";
      }
    });
    try {
      await Promise.race([
        ready,
        delay(15_000, this.#controller.signal).then(() => { throw new Error("Slack Socket Mode readiness timed out"); }),
      ]);
      this.#state = "running";
    } catch (error) {
      await this.stop().catch((cleanupError: unknown) => {
        reportOperationalError({ component: "channels.slack", operation: "cleanup failed startup", error: cleanupError });
      });
      this.#state = "error";
      this.#detail = "Slack startup failed";
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#state = "stopped";
    this.#controller?.abort();
    this.#socket?.close(1000, "FRIDAY shutdown");
    await this.#runPromise?.catch((error: unknown) => {
      reportUnlessExpectedAbort({ component: "channels.slack", operation: "stop socket loop", error }, this.#controller?.signal);
    });
    this.#controller = undefined;
    this.#runPromise = undefined;
    this.#socket = undefined;
    this.#handler = undefined;
    this.#detail = undefined;
  }

  status(): ChannelTransportStatus {
    return Object.freeze({ channel: this.channel, accountId: this.accountId, state: this.#state, ...(this.#detail === undefined ? {} : { detail: this.#detail }) });
  }

  async send(target: ChannelTarget, text: string): Promise<ChannelSendResult> {
    const messageIds: string[] = [];
    for (const chunk of splitChannelMessage(text, 3900)) {
      const result = await this.#webApi<{ ok?: boolean; ts?: string }>("chat.postMessage", {
        channel: target.conversationId,
        text: chunk,
        ...(target.threadId === undefined ? {} : { thread_ts: target.threadId }),
      });
      if (result.ok !== true) throw new Error("Slack chat.postMessage failed");
      if (result.ts) messageIds.push(result.ts);
    }
    return Object.freeze({ channel: this.channel, accountId: this.accountId, conversationId: target.conversationId, messageIds: Object.freeze(messageIds) });
  }

  async sendProtectedAction(target: ChannelTarget, text: string, action: ChannelProtectedAction): Promise<ChannelSendResult> {
    const result = await this.#webApi<{ ok?: boolean; ts?: string }>("chat.postMessage", {
      channel: target.conversationId,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }, { type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: action.approveLabel ?? "Approve" }, style: "primary", action_id: `friday:${action.requestId}:approve`, value: action.requestId },
        { type: "button", text: { type: "plain_text", text: action.denyLabel ?? "Deny" }, style: "danger", action_id: `friday:${action.requestId}:deny`, value: action.requestId },
      ] }],
      ...(target.threadId === undefined ? {} : { thread_ts: target.threadId }),
    });
    if (result.ok !== true) throw new Error("Slack chat.postMessage failed");
    return Object.freeze({ channel: this.channel, accountId: this.accountId, conversationId: target.conversationId, messageIds: Object.freeze(result.ts ? [result.ts] : []) });
  }

  async sendProtectedQuestion(target: ChannelTarget, text: string, question: ChannelProtectedQuestion): Promise<ChannelSendResult> {
    const result = await this.#webApi<{ ok?: boolean; ts?: string }>("chat.postMessage", {
      channel: target.conversationId,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }, { type: "actions", elements: question.choices.map((choice, index) => ({
        type: "button",
        text: { type: "plain_text", text: choice.label },
        action_id: `fridayq:${question.requestId}:${index}`,
        value: question.requestId,
      })) }],
      ...(target.threadId === undefined ? {} : { thread_ts: target.threadId }),
    });
    if (result.ok !== true) throw new Error("Slack chat.postMessage failed");
    return Object.freeze({ channel: this.channel, accountId: this.accountId, conversationId: target.conversationId, messageIds: Object.freeze(result.ts ? [result.ts] : []) });
  }

  async #run(signal: AbortSignal, onFirstOpen: () => void): Promise<void> {
    let first = false;
    let backoff = 500;
    while (!signal.aborted) {
      try {
        await this.#connect(signal, () => {
          if (!first) { first = true; onFirstOpen(); }
        });
        backoff = 500;
      } catch (error) {
        if (signal.aborted) return;
        reportOperationalError({ component: "channels.slack", operation: "connect socket mode", error });
      }
      if (!signal.aborted) {
        await delay(backoff, signal).catch((error: unknown) => {
          reportUnlessExpectedAbort({ component: "channels.slack", operation: "reconnect delay", error }, signal);
        });
        backoff = Math.min(10_000, backoff * 2);
      }
    }
  }

  async #connect(signal: AbortSignal, onOpen: () => void): Promise<void> {
    const url = await withSecretText(this.#secrets, this.#config.appTokenRef, async (token) => {
      const response = await fetchWithTimeout(this.#fetch, "https://slack.com/api/apps.connections.open", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
        body: "",
      });
      const body = await response.json() as { ok?: boolean; url?: string };
      if (!response.ok || body.ok !== true || !body.url) throw new Error("Slack apps.connections.open failed");
      return body.url;
    });
    const socket = this.#websocketFactory(url);
    this.#socket = socket;
    let closedResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => { closedResolve = resolve; });
    const onSocketOpen = () => onOpen();
    const onMessage = (event: { data?: unknown }) => {
      void (async () => {
        const text = dataText(event.data);
        if (!text) return;
        let envelope: SlackEnvelope;
        try { envelope = JSON.parse(text) as SlackEnvelope; } catch (error) {
          reportOperationalError({ component: "channels.slack", operation: "parse gateway envelope", error, severity: "warn" });
          return;
        }
        // Socket Mode ACK is intentionally delayed until the channel handler has
        // durably admitted the event. If admission fails Slack may redeliver it.
        if (envelope.type === "events_api" && envelope.payload?.event) {
          await this.#handleEvent(envelope.payload.event);
        }
        if (envelope.type === "interactive") await this.#handleInteractive(envelope.payload);
        if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        if (envelope.type === "disconnect") socket.close(4000, "Slack requested reconnect");
      })().catch((error: unknown) => {
        reportOperationalError({ component: "channels.slack", operation: "durably handle inbound envelope", error });
      });
    };
    const onClose = () => closedResolve?.();
    const onError = () => socket.close();
    const onAbort = () => socket.close(1000, "aborted");
    socket.addEventListener("open", onSocketOpen, { once: true });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    try { await closed; } finally {
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      if (this.#socket === socket) this.#socket = undefined;
    }
  }

  async #handleEvent(event: SlackEvent): Promise<void> {
    if (!this.#handler || !event.channel || !event.user || !event.ts || event.bot_id || (event.subtype && event.subtype !== "file_share")) return;
    if (this.#botUserId && event.user === this.#botUserId) return;
    if (event.type !== "message" && event.type !== "app_mention") return;
    const isDm = event.channel_type === "im" || event.channel.startsWith("D");
    const type = isDm ? "dm" as const : (event.thread_ts && event.thread_ts !== event.ts ? "thread" as const : "group" as const);
    const principal: ChannelPrincipal = {
      channel: this.channel,
      accountId: this.accountId,
      conversationId: event.channel,
      senderId: event.user,
      ...(event.thread_ts && event.thread_ts !== event.ts ? { threadId: event.thread_ts } : {}),
    };
    if (!channelPrincipalAllowed(principal, type, this.#config)) return;
    const hasUnsupportedAttachment = (event.files?.length ?? 0) > 0;
    const text = [event.text?.trim(), hasUnsupportedAttachment ? "[attachment received; Slack media retrieval is not enabled]" : ""].filter(Boolean).join("\n");
    if (!text) return;
    const protectedReply = /^(?:<@!?\w+>\s*)?(?:approve|deny|cancel)\s+[A-Z0-9]{6}$/i.test(text);
    if (this.#config.requireMention === true && !isDm && event.type !== "app_mention" && !(this.#botUserId && text.includes(`<@${this.#botUserId}>`)) && !protectedReply) return;
    await this.#handler({ id: event.ts, principal, chatType: type, text, timestamp: Number(event.ts.split(".")[0]) * 1000 || Date.now(), attachments: [] });
  }

  async #handleInteractive(payload: SlackEnvelope["payload"]): Promise<void> {
    const action = payload?.actions?.[0];
    const userId = payload?.user?.id;
    const conversationId = payload?.channel?.id;
    const match = /^friday:([0-9a-f-]{36}):(approve|deny)$/.exec(action?.action_id ?? "");
    const questionMatch = /^fridayq:([0-9a-f-]{36}):(\d)$/.exec(action?.action_id ?? "");
    if (!action || (!match && !questionMatch) || !userId || !conversationId || !this.#handler) return;
    const threadId = payload?.message?.thread_ts;
    const isDm = conversationId.startsWith("D");
    const type = threadId ? "thread" as const : (isDm ? "dm" as const : "group" as const);
    const principal: ChannelPrincipal = { channel: this.channel, accountId: this.accountId, conversationId, senderId: userId, ...(threadId === undefined ? {} : { threadId }) };
    if (!channelPrincipalAllowed(principal, type, this.#config)) return;
    const protectedAction = match
      ? { requestId: match[1]!, decision: match[2] as "approve" | "deny" } as const
      : { requestId: questionMatch![1]!, selection: Number(questionMatch![2]) } as const;
    await this.#handler({ id: `interactive-${protectedAction.requestId}`, principal, chatType: type, text: "", timestamp: Date.now(), attachments: [], protectedAction });
  }

  async #webApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
    return await withSecretText(this.#secrets, this.#config.botTokenRef, async (token) => {
      const response = await fetchWithTimeout(this.#fetch, `https://slack.com/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Slack ${method} request failed with status ${response.status}`);
      return await response.json() as T;
    });
  }
}
