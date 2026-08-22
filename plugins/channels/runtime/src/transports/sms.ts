import { createHmac, timingSafeEqual } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import type {
  ChannelAttachment,
  ChannelInboundHandler,
  ChannelPrincipal,
  ChannelSendResult,
  ChannelTarget,
  ChannelTransport,
  ChannelTransportStatus,
} from "../types.js";
import { LocalWebhookServer } from "./webhook-server.js";
import { channelPrincipalAllowed, fetchWithTimeout, requireHttpUrl, splitChannelMessage, withSecretText, type ChannelAccessPolicy, type SecretConsumer } from "./shared.js";

export interface SmsChannelConfig extends ChannelAccessPolicy {
  readonly accountId?: string | undefined;
  readonly accountSid: string;
  readonly authTokenRef: string;
  readonly fromNumber: string;
  readonly publicWebhookUrl: string;
  readonly listenHost?: string | undefined;
  readonly listenPort?: number | undefined;
  readonly webhookPath?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
}

export interface SmsTransportDependencies {
  readonly fetch?: typeof fetch | undefined;
}

function twilioSignature(url: string, params: URLSearchParams, authToken: string): string {
  const grouped = new Map<string, string[]>();
  for (const [key, value] of params) {
    const values = grouped.get(key) ?? [];
    values.push(value);
    grouped.set(key, values);
  }
  let source = url;
  for (const key of [...grouped.keys()].sort()) {
    for (const value of grouped.get(key) ?? []) source += key + value;
  }
  return createHmac("sha1", authToken).update(source).digest("base64");
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export class SmsChannelTransport implements ChannelTransport {
  readonly channel = "sms" as const;
  readonly accountId: string;
  readonly #config: SmsChannelConfig;
  readonly #secrets: SecretConsumer;
  readonly #fetch: typeof fetch;
  readonly #publicWebhookUrl: string;
  readonly #server: LocalWebhookServer;
  #handler: ChannelInboundHandler | undefined;
  #state: ChannelTransportStatus["state"] = "stopped";
  #detail: string | undefined;

  constructor(config: SmsChannelConfig, secrets: SecretConsumer, dependencies: SmsTransportDependencies = {}) {
    this.#config = config;
    this.#secrets = secrets;
    this.#fetch = dependencies.fetch ?? fetch;
    this.accountId = config.accountId?.trim() || "default";
    if (!/^AC[a-zA-Z0-9]{16,}$/.test(config.accountSid)) throw new Error("Twilio account SID is invalid");
    if (!config.fromNumber.trim()) throw new Error("SMS fromNumber is required");
    this.#publicWebhookUrl = requireHttpUrl(config.publicWebhookUrl, "SMS public webhook URL").toString();
    const publicPath = new URL(this.#publicWebhookUrl).pathname;
    const path = config.webhookPath ?? publicPath;
    if (path !== publicPath) throw new Error("SMS webhookPath must match publicWebhookUrl path for Twilio signature validation");
    this.#server = new LocalWebhookServer({ host: config.listenHost ?? "127.0.0.1", port: config.listenPort ?? 3980, path, maxBodyBytes: 1024 * 1024 }, async (request) => {
      if (request.method !== "POST") return { status: 405 };
      const signature = Array.isArray(request.headers["x-twilio-signature"]) ? request.headers["x-twilio-signature"][0] : request.headers["x-twilio-signature"];
      const params = new URLSearchParams(request.body.toString("utf8"));
      const valid = await withSecretText(this.#secrets, this.#config.authTokenRef, async (secret) => Boolean(signature) && secureEqual(signature!, twilioSignature(this.#publicWebhookUrl, params, secret)));
      if (!valid) return { status: 403 };
      try {
        await this.#handle(params);
      } catch (error) {
        reportOperationalError({ component: "channels.sms", operation: "durably handle inbound message", error });
        return { status: 500 };
      }
      return { status: 200, headers: { "content-type": "application/xml; charset=utf-8" }, body: "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>" };
    });
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    if (this.#state === "running" || this.#state === "starting") return;
    this.#state = "starting";
    this.#detail = undefined;
    this.#handler = handler;
    try { await this.#server.start(); this.#state = "running"; }
    catch (error) { this.#state = "error"; this.#detail = "SMS webhook startup failed"; this.#handler = undefined; throw error; }
  }

  async stop(): Promise<void> {
    this.#state = "stopped";
    await this.#server.stop();
    this.#handler = undefined;
    this.#detail = undefined;
  }

  status(): ChannelTransportStatus {
    return Object.freeze({ channel: this.channel, accountId: this.accountId, state: this.#state, ...(this.#detail === undefined ? {} : { detail: this.#detail }) });
  }

  async send(target: ChannelTarget, text: string): Promise<ChannelSendResult> {
    const ids: string[] = [];
    for (const chunk of splitChannelMessage(text, 1500)) {
      const payload = await withSecretText(this.#secrets, this.#config.authTokenRef, async (secret) => {
        const body = new URLSearchParams({ To: target.conversationId, From: this.#config.fromNumber, Body: chunk });
        const response = await fetchWithTimeout(this.#fetch, `${this.#config.apiBaseUrl?.replace(/\/$/, "") || "https://api.twilio.com/2010-04-01"}/Accounts/${encodeURIComponent(this.#config.accountSid)}/Messages.json`, {
          method: "POST",
          headers: { authorization: `Basic ${Buffer.from(`${this.#config.accountSid}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        const result = await response.json() as { sid?: string };
        if (!response.ok) throw new Error(`SMS send failed with status ${response.status}`);
        return result;
      });
      if (payload.sid) ids.push(payload.sid);
    }
    return Object.freeze({ channel: this.channel, accountId: this.accountId, conversationId: target.conversationId, messageIds: Object.freeze(ids) });
  }

  async #handle(params: URLSearchParams): Promise<void> {
    if (!this.#handler) return;
    const id = params.get("MessageSid") ?? params.get("SmsSid") ?? "";
    const sender = params.get("From")?.trim() ?? "";
    const recipient = params.get("To")?.trim() ?? "";
    const text = params.get("Body")?.trim() ?? "";
    if (!id || !sender || recipient !== this.#config.fromNumber) return;
    const principal: ChannelPrincipal = { channel: this.channel, accountId: this.accountId, conversationId: sender, senderId: sender };
    if (!channelPrincipalAllowed(principal, "dm", this.#config)) return;
    const attachments: ChannelAttachment[] = [];
    const count = Math.min(10, Math.max(0, Number(params.get("NumMedia") ?? 0) || 0));
    for (let index = 0; index < count; index += 1) {
      const url = params.get(`MediaUrl${index}`);
      if (!url) continue;
      const mimeType = params.get(`MediaContentType${index}`) ?? undefined;
      attachments.push(Object.freeze({
        kind: mimeType?.startsWith("image/") ? "image" : mimeType?.startsWith("audio/") ? "audio" : mimeType?.startsWith("video/") ? "video" : "document",
        externalId: url,
        downloadUrl: url,
        ...(mimeType === undefined ? {} : { mimeType }),
      }));
    }
    const body = text || (attachments.length > 0 ? `[${attachments[0]?.kind ?? "attachment"}]` : "");
    if (!body) return;
    await this.#handler({ id, principal, chatType: "dm", text: body, timestamp: Date.now(), attachments: Object.freeze(attachments) });
  }
}
