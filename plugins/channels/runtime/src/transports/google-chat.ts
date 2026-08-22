import { createSign } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import type {
  ChannelInboundHandler,
  ChannelPrincipal,
  ChannelSendResult,
  ChannelTarget,
  ChannelTransport,
  ChannelTransportStatus,
} from "../types.js";
import { LocalWebhookServer } from "./webhook-server.js";
import { channelPrincipalAllowed, fetchWithTimeout, splitChannelMessage, withSecretText, type ChannelAccessPolicy, type SecretConsumer } from "./shared.js";

export interface GoogleChatChannelConfig extends ChannelAccessPolicy {
  readonly accountId?: string | undefined;
  readonly serviceAccountRef: string;
  readonly audience: string;
  readonly expectedServiceAccountEmail?: string | undefined;
  readonly listenHost?: string | undefined;
  readonly listenPort?: number | undefined;
  readonly webhookPath?: string | undefined;
  readonly tokenInfoUrl?: string | undefined;
  readonly chatApiBaseUrl?: string | undefined;
}

export interface GoogleChatTransportDependencies {
  readonly fetch?: typeof fetch | undefined;
}

interface GoogleChatEvent {
  type?: string;
  eventType?: string;
  message?: {
    name?: string;
    text?: string;
    argumentText?: string;
    sender?: { name?: string; displayName?: string; type?: string };
    space?: { name?: string; displayName?: string; type?: string };
    thread?: { name?: string };
  };
  user?: { name?: string; displayName?: string; type?: string };
  space?: { name?: string; displayName?: string; type?: string };
}

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

function encodePart(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function validateSpaceName(value: string): string {
  if (!/^spaces\/[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error("Google Chat conversationId must be a spaces/... resource name");
  return value;
}

export class GoogleChatChannelTransport implements ChannelTransport {
  readonly channel = "google-chat" as const;
  readonly accountId: string;
  readonly #config: GoogleChatChannelConfig;
  readonly #secrets: SecretConsumer;
  readonly #fetch: typeof fetch;
  readonly #server: LocalWebhookServer;
  #handler: ChannelInboundHandler | undefined;
  #state: ChannelTransportStatus["state"] = "stopped";
  #detail: string | undefined;

  constructor(config: GoogleChatChannelConfig, secrets: SecretConsumer, dependencies: GoogleChatTransportDependencies = {}) {
    this.#config = config;
    this.#secrets = secrets;
    this.#fetch = dependencies.fetch ?? fetch;
    this.accountId = config.accountId?.trim() || "default";
    if (!config.audience.trim()) throw new Error("Google Chat audience is required");
    this.#server = new LocalWebhookServer({
      host: config.listenHost ?? "127.0.0.1",
      port: config.listenPort ?? 3979,
      path: config.webhookPath ?? "/google-chat/events",
      maxBodyBytes: 1024 * 1024,
    }, async (request) => {
      if (request.method !== "POST") return { status: 405 };
      const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
      if (!authorization?.startsWith("Bearer ") || !(await this.#verifyBearer(authorization.slice(7)))) return { status: 401 };
      let event: GoogleChatEvent;
      try { event = JSON.parse(request.body.toString("utf8")) as GoogleChatEvent; } catch {
        // friday-expected-control-flow: malformed remote input is rejected with HTTP 400.
        return { status: 400 };
      }
      try {
        await this.#handleEvent(event);
      } catch (error) {
        reportOperationalError({ component: "channels.google-chat", operation: "durably handle inbound event", error });
        return { status: 500 };
      }
      return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    });
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    if (this.#state === "running" || this.#state === "starting") return;
    this.#state = "starting";
    this.#detail = undefined;
    this.#handler = handler;
    try {
      await this.#server.start();
      this.#state = "running";
    } catch (error) {
      this.#state = "error";
      this.#detail = "Google Chat webhook startup failed";
      this.#handler = undefined;
      throw error;
    }
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
    const space = validateSpaceName(target.conversationId);
    const token = await this.#accessToken();
    const ids: string[] = [];
    for (const chunk of splitChannelMessage(text, 3900)) {
      const response = await fetchWithTimeout(this.#fetch, `${this.#config.chatApiBaseUrl?.replace(/\/$/, "") || "https://chat.googleapis.com/v1"}/${space}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: chunk, ...(target.threadId === undefined ? {} : { thread: { name: target.threadId } }) }),
      });
      const payload = await response.json() as { name?: string };
      if (!response.ok) throw new Error(`Google Chat send failed with status ${response.status}`);
      if (payload.name) ids.push(payload.name);
    }
    return Object.freeze({ channel: this.channel, accountId: this.accountId, conversationId: target.conversationId, messageIds: Object.freeze(ids) });
  }

  async #handleEvent(event: GoogleChatEvent): Promise<void> {
    if (!this.#handler) return;
    const eventType = event.type ?? event.eventType;
    if (eventType !== "MESSAGE") return;
    const message = event.message;
    const space = message?.space ?? event.space;
    const sender = message?.sender ?? event.user;
    if (!message?.name || !space?.name || !sender?.name || sender.type === "BOT") return;
    const conversationId = validateSpaceName(space.name);
    const isDm = space.type === "DM" || space.type === "DIRECT_MESSAGE";
    const threadId = message.thread?.name;
    const type = threadId ? "thread" as const : (isDm ? "dm" as const : "group" as const);
    const principal: ChannelPrincipal = { channel: this.channel, accountId: this.accountId, conversationId, senderId: sender.name, ...(threadId === undefined ? {} : { threadId }) };
    if (!channelPrincipalAllowed(principal, type, this.#config)) return;
    const text = (message.argumentText ?? message.text ?? "").trim();
    if (!text) return;
    await this.#handler({
      id: message.name,
      principal,
      chatType: type,
      text,
      timestamp: Date.now(),
      ...(sender.displayName === undefined ? {} : { senderName: sender.displayName }),
      ...(space.displayName === undefined ? {} : { conversationName: space.displayName }),
      attachments: [],
    });
  }

  async #verifyBearer(token: string): Promise<boolean> {
    try {
      const endpoint = this.#config.tokenInfoUrl ?? "https://oauth2.googleapis.com/tokeninfo";
      const url = new URL(endpoint);
      url.searchParams.set("id_token", token);
      const response = await fetchWithTimeout(this.#fetch, url);
      const payload = await response.json() as { aud?: string; iss?: string; email?: string; email_verified?: string | boolean; exp?: string | number };
      if (!response.ok || payload.aud !== this.#config.audience) return false;
      if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") return false;
      if (payload.email_verified === false || payload.email_verified === "false") return false;
      if (Number(payload.exp ?? 0) <= Math.floor(Date.now() / 1000)) return false;
      // For URL-audience Google Chat callbacks the authenticated caller must be
      // Google's Chat service account, not merely any Google-signed identity
      // that can mint an ID token for our audience. Keep an override for test
      // and sovereign/managed deployments, but default to Google's documented
      // Chat issuer identity.
      const expectedEmail = this.#config.expectedServiceAccountEmail?.trim() || "chat@system.gserviceaccount.com";
      if (payload.email !== expectedEmail) return false;
      return true;
    } catch (error) {
      reportOperationalError({ component: "channels.google-chat", operation: "verify inbound identity token", error, severity: "warn" });
      return false;
    }
  }

  async #accessToken(): Promise<string> {
    return await withSecretText(this.#secrets, this.#config.serviceAccountRef, async (raw) => {
      let credentials: ServiceAccountJson;
      try { credentials = JSON.parse(raw) as ServiceAccountJson; } catch { throw new Error("Google Chat service account credential is invalid JSON"); }
      if (!credentials.client_email || !credentials.private_key) throw new Error("Google Chat service account credential is incomplete");
      const tokenUri = credentials.token_uri || "https://oauth2.googleapis.com/token";
      const now = Math.floor(Date.now() / 1000);
      const header = encodePart({ alg: "RS256", typ: "JWT" });
      const payload = encodePart({
        iss: credentials.client_email,
        scope: "https://www.googleapis.com/auth/chat.bot",
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      });
      const signingInput = `${header}.${payload}`;
      const signer = createSign("RSA-SHA256");
      signer.update(signingInput);
      signer.end();
      const assertion = `${signingInput}.${signer.sign(credentials.private_key).toString("base64url")}`;
      const response = await fetchWithTimeout(this.#fetch, tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      });
      const token = await response.json() as { access_token?: string };
      if (!response.ok || !token.access_token) throw new Error("Google Chat access-token request failed");
      return token.access_token;
    });
  }
}
