import { reportOperationalError, reportUnlessExpectedAbort } from "@friday/operational-errors";
import type {
  ChannelAttachment,
  ChannelChatType,
  ChannelInboundHandler,
  ChannelPrincipal,
  ChannelSendResult,
  ChannelTarget,
  ChannelTransport,
  ChannelTransportStatus,
} from "../types.js";
import { channelPrincipalAllowed, delay, fetchWithTimeout, splitChannelMessage, type ChannelAccessPolicy, type SecretConsumer } from "./shared.js";

export interface TelegramChannelConfig extends ChannelAccessPolicy {
  readonly accountId?: string | undefined;
  readonly credentialRef: string;
  readonly pollTimeoutSeconds?: number | undefined;
  readonly requireMention?: boolean | undefined;
  readonly mentionPatterns?: readonly string[] | undefined;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  text?: string;
  caption?: string;
  reply_to_message?: { message_id?: number };
  photo?: Array<{ file_id: string; file_size?: number }>;
  audio?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
  voice?: { file_id: string; file_size?: number; mime_type?: string };
  video?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
  document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
  sticker?: { file_id: string; file_size?: number; emoji?: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function userName(user: TelegramUser | undefined): string | undefined {
  if (!user) return undefined;
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || user.username;
}

function chatType(chat: TelegramChat, threadId: string | undefined): ChannelChatType {
  if (threadId) return "thread";
  if (chat.type === "private") return "dm";
  if (chat.type === "channel") return "channel";
  return "group";
}

function attachment(kind: ChannelAttachment["kind"], value: { file_id: string; file_size?: number; mime_type?: string; file_name?: string }): ChannelAttachment {
  return Object.freeze({
    kind,
    externalId: value.file_id,
    ...(value.mime_type === undefined ? {} : { mimeType: value.mime_type }),
    ...(value.file_name === undefined ? {} : { fileName: value.file_name }),
    ...(value.file_size === undefined ? {} : { sizeBytes: value.file_size }),
  });
}

export class TelegramChannelTransport implements ChannelTransport {
  readonly channel = "telegram" as const;
  readonly accountId: string;
  readonly #config: TelegramChannelConfig;
  readonly #secrets: SecretConsumer;
  #handler: ChannelInboundHandler | undefined;
  #controller: AbortController | undefined;
  #pollPromise: Promise<void> | undefined;
  #state: ChannelTransportStatus["state"] = "stopped";
  #detail: string | undefined;
  #offset = 0;
  #botUsername: string | undefined;
  readonly #mentionPatterns: readonly RegExp[];

  constructor(config: TelegramChannelConfig, secrets: SecretConsumer) {
    this.#config = config;
    this.#secrets = secrets;
    this.accountId = config.accountId?.trim() || "default";
    this.#mentionPatterns = Object.freeze((config.mentionPatterns ?? []).map((pattern) => new RegExp(pattern, "i")));
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    if (this.#state === "running" || this.#state === "starting") return;
    this.#handler = handler;
    this.#state = "starting";
    this.#detail = undefined;
    try {
      const me = await this.#request<TelegramUser>("getMe", {});
      this.#botUsername = me.username;
      this.#controller = new AbortController();
      this.#state = "running";
      this.#pollPromise = this.#poll(this.#controller.signal).catch((error: unknown) => {
        reportUnlessExpectedAbort({ component: "channels.telegram", operation: "polling loop terminated", error }, this.#controller?.signal);
        if (this.#state !== "stopped") {
          this.#state = "error";
          this.#detail = "Telegram polling stopped after repeated transport errors";
        }
      });
    } catch (error) {
      reportOperationalError({ component: "channels.telegram", operation: "start transport", error });
      this.#state = "error";
      this.#detail = "Telegram startup failed";
      throw new Error("Telegram channel startup failed", { cause: error });
    }
  }

  async stop(): Promise<void> {
    this.#state = "stopped";
    this.#controller?.abort();
    await this.#pollPromise?.catch((error: unknown) => {
      reportUnlessExpectedAbort({ component: "channels.telegram", operation: "stop polling", error }, this.#controller?.signal);
    });
    this.#controller = undefined;
    this.#pollPromise = undefined;
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
    const ids: string[] = [];
    for (const chunk of splitChannelMessage(text, 3900)) {
      const result = await this.#request<{ message_id: number }>("sendMessage", {
        chat_id: target.conversationId,
        text: chunk,
        ...(target.threadId === undefined ? {} : { message_thread_id: Number(target.threadId) || target.threadId }),
      });
      ids.push(String(result.message_id));
    }
    return Object.freeze({
      channel: this.channel,
      accountId: this.accountId,
      conversationId: target.conversationId,
      messageIds: Object.freeze(ids),
    });
  }

  async #poll(signal: AbortSignal): Promise<void> {
    let backoff = 500;
    while (!signal.aborted) {
      try {
        const updates = await this.#request<TelegramUpdate[]>("getUpdates", {
          offset: this.#offset,
          timeout: Math.min(50, Math.max(1, this.#config.pollTimeoutSeconds ?? 25)),
          allowed_updates: ["message", "edited_message", "channel_post"],
        }, signal);
        backoff = 500;
        for (const update of updates) {
          const message = update.message ?? update.edited_message ?? update.channel_post;
          if (message) await this.#handleMessage(message);
          // Checkpoint only after durable admission/intentional filtering.
          this.#offset = Math.max(this.#offset, update.update_id + 1);
        }
        // Telegram normally holds getUpdates until either an update arrives or
        // the long-poll timeout expires. If an upstream proxy/mock returns an
        // empty batch immediately, yield to the event loop so timers, aborts,
        // and shutdown can still make progress instead of spinning a CPU core.
        if (updates.length === 0 && !signal.aborted) {
          await delay(25, signal).catch((error: unknown) => {
            reportUnlessExpectedAbort({ component: "channels.telegram", operation: "empty-poll yield", error }, signal);
          });
        }
      } catch (error) {
        if (signal.aborted) return;
        reportOperationalError({ component: "channels.telegram", operation: "poll updates", error });
        await delay(backoff, signal).catch((delayError: unknown) => {
          reportUnlessExpectedAbort({ component: "channels.telegram", operation: "poll retry delay", error: delayError }, signal);
        });
        backoff = Math.min(10_000, backoff * 2);
      }
    }
  }

  async #handleMessage(message: TelegramMessage): Promise<void> {
    if (!this.#handler) return;
    const threadId = message.message_thread_id === undefined ? undefined : String(message.message_thread_id);
    const sender = message.from;
    const senderChat = message.sender_chat;
    const senderId = sender ? String(sender.id) : senderChat ? String(senderChat.id) : "";
    if (!senderId) return;
    const principal: ChannelPrincipal = {
      channel: this.channel,
      accountId: this.accountId,
      conversationId: String(message.chat.id),
      senderId,
      ...(threadId === undefined ? {} : { threadId }),
    };
    const type = chatType(message.chat, threadId);
    if (!channelPrincipalAllowed(principal, type, this.#config)) return;

    const text = message.text ?? message.caption ?? this.#attachmentPlaceholder(message);
    if (!text) return;
    if (this.#config.requireMention === true && type !== "dm" && !this.#isMentioned(text)) return;

    await this.#handler({
      id: String(message.message_id),
      principal,
      chatType: type,
      text,
      timestamp: message.date * 1000,
      ...(userName(sender) === undefined ? {} : { senderName: userName(sender) }),
      ...((message.chat.title ?? message.chat.username) === undefined ? {} : { conversationName: message.chat.title ?? message.chat.username }),
      ...(message.reply_to_message?.message_id === undefined ? {} : { replyToMessageId: String(message.reply_to_message.message_id) }),
      attachments: this.#attachments(message),
    });
  }

  #isMentioned(text: string): boolean {
    if (this.#botUsername && new RegExp(`(^|\\s)@${escapeRegExp(this.#botUsername)}(?=\\s|$|[,:;.!?])`, "i").test(text)) return true;
    return this.#mentionPatterns.some((pattern) => pattern.test(text));
  }

  #attachmentPlaceholder(message: TelegramMessage): string {
    if (message.photo?.length) return "[image]";
    if (message.voice) return "[voice]";
    if (message.audio) return "[audio]";
    if (message.video) return "[video]";
    if (message.document) return "[document]";
    if (message.sticker) return message.sticker.emoji ? `[sticker ${message.sticker.emoji}]` : "[sticker]";
    return "";
  }

  #attachments(message: TelegramMessage): readonly ChannelAttachment[] {
    const values: ChannelAttachment[] = [];
    const photo = message.photo?.at(-1);
    if (photo) values.push(attachment("image", photo));
    if (message.voice) values.push(attachment("audio", message.voice));
    if (message.audio) values.push(attachment("audio", message.audio));
    if (message.video) values.push(attachment("video", message.video));
    if (message.document) values.push(attachment("document", message.document));
    if (message.sticker) values.push(attachment("sticker", message.sticker));
    return Object.freeze(values);
  }

  async fetchAttachment(attachment: ChannelAttachment, maxBytes: number) {
    const fileId = attachment.externalId.trim();
    if (!fileId) throw new Error("Telegram attachment file id is missing");
    const file = await this.#request<{ file_path?: string }>("getFile", { file_id: fileId });
    const filePath = file.file_path?.trim();
    if (!filePath || filePath.includes("..") || filePath.startsWith("/")) {
      throw new Error("Telegram returned an invalid attachment path");
    }
    let bytes: Uint8Array | undefined;
    await this.#secrets.consume(this.#config.credentialRef, async (secret) => {
      const token = Buffer.from(secret).toString("utf8");
      const response = await fetchWithTimeout(fetch, `https://api.telegram.org/file/bot${token}/${filePath}`, { redirect: "error" }, 30_000);
      if (!response.ok) throw new Error(`Telegram attachment download failed with HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error("Telegram attachment exceeds the configured size limit");
      const downloaded = new Uint8Array(await response.arrayBuffer());
      if (downloaded.byteLength > maxBytes) throw new Error("Telegram attachment exceeds the configured size limit");
      bytes = downloaded;
    });
    if (!bytes) throw new Error("Telegram attachment download produced no data");
    return Object.freeze({ bytes, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}), ...(attachment.fileName ? { fileName: attachment.fileName } : {}) });
  }

  async #request<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let result: T | undefined;
    let failed = false;
    let failure: unknown;
    await this.#secrets.consume(this.#config.credentialRef, async (secret) => {
      const token = Buffer.from(secret).toString("utf8");
      try {
        const response = await fetchWithTimeout(fetch, `https://api.telegram.org/bot${token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        }, method === "getUpdates" ? 60_000 : 15_000);
        const payload = await response.json() as TelegramApiResponse<T>;
        if (!response.ok || payload.ok !== true || payload.result === undefined) {
          failed = true;
          failure = new Error(`Telegram API returned HTTP ${response.status}`);
          return;
        }
        result = payload.result;
      } catch (error) {
        failed = true;
        failure = error;
      }
    });
    if (failed || result === undefined) throw new Error(`Telegram ${method} request failed`, { cause: failure });
    return result;
  }
}
