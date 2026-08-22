import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
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
import {
  channelPrincipalAllowed,
  fetchWithTimeout,
  requireHttpUrl,
  splitChannelMessage,
  withSecretText,
  type ChannelAccessPolicy,
  type SecretConsumer,
} from "./shared.js";

export interface TeamsChannelConfig extends ChannelAccessPolicy {
  readonly accountId?: string | undefined;
  readonly clientId: string;
  readonly clientSecretRef: string;
  readonly tenantId: string;
  readonly listenHost?: string | undefined;
  readonly listenPort?: number | undefined;
  readonly webhookPath?: string | undefined;
  readonly openIdMetadataUrl?: string | undefined;
  readonly tokenUrl?: string | undefined;
}

export interface TeamsTransportDependencies {
  readonly fetch?: typeof fetch | undefined;
}

interface BotFrameworkActivity {
  type?: string;
  id?: string;
  timestamp?: string;
  serviceUrl?: string;
  channelId?: string;
  text?: string;
  replyToId?: string;
  conversation?: { id?: string; conversationType?: string; name?: string };
  from?: { id?: string; name?: string; aadObjectId?: string; role?: string };
  recipient?: { id?: string };
  channelData?: { tenant?: { id?: string }; channel?: { id?: string } };
}

interface JwtHeader { alg?: string; kid?: string; }
interface JwtPayload { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; serviceUrl?: string; }
interface OpenIdMetadata { issuer?: string; jwks_uri?: string; }
interface JsonWebKeySet {
  keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>;
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function audienceMatches(value: string | string[] | undefined, expected: string): boolean {
  return typeof value === "string" ? value === expected : Array.isArray(value) && value.includes(expected);
}

export class TeamsChannelTransport implements ChannelTransport {
  readonly channel = "teams" as const;
  readonly accountId: string;
  readonly #config: TeamsChannelConfig;
  readonly #secrets: SecretConsumer;
  readonly #fetch: typeof fetch;
  readonly #server: LocalWebhookServer;
  readonly #serviceUrls = new Map<string, string>();
  #handler: ChannelInboundHandler | undefined;
  #state: ChannelTransportStatus["state"] = "stopped";
  #detail: string | undefined;
  #metadataCache: { metadata: OpenIdMetadata; jwks: JsonWebKeySet; expiresAt: number } | undefined;

  constructor(config: TeamsChannelConfig, secrets: SecretConsumer, dependencies: TeamsTransportDependencies = {}) {
    this.#config = config;
    this.#secrets = secrets;
    this.#fetch = dependencies.fetch ?? fetch;
    this.accountId = config.accountId?.trim() || "default";
    if (!config.clientId.trim() || !config.tenantId.trim()) throw new Error("Teams clientId and tenantId are required");
    const metadata = requireHttpUrl(config.openIdMetadataUrl ?? "https://login.botframework.com/v1/.well-known/openidconfiguration", "Teams OpenID metadata URL");
    requireHttpUrl(config.tokenUrl ?? "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", "Teams token URL");
    this.#server = new LocalWebhookServer({
      host: config.listenHost ?? "127.0.0.1",
      port: config.listenPort ?? 3978,
      path: config.webhookPath ?? "/api/messages",
      maxBodyBytes: 1024 * 1024,
    }, async (request) => {
      if (request.method !== "POST") return { status: 405 };
      let activity: BotFrameworkActivity;
      try { activity = JSON.parse(request.body.toString("utf8")) as BotFrameworkActivity; } catch {
        // friday-expected-control-flow: malformed remote input is rejected with HTTP 400.
        return { status: 400 };
      }
      const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
      if (!authorization?.startsWith("Bearer ") || !(await this.#verifyJwt(authorization.slice(7), activity.serviceUrl))) return { status: 401 };
      try {
        await this.#handleActivity(activity);
      } catch (error) {
        reportOperationalError({ component: "channels.teams", operation: "durably handle inbound activity", error });
        return { status: 500 };
      }
      return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    });
    void metadata;
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
      this.#detail = "Teams webhook startup failed";
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
    const serviceUrl = this.#serviceUrls.get(target.conversationId);
    if (!serviceUrl) throw new Error("Teams conversation has no trusted serviceUrl yet; receive a message in that conversation first");
    const token = await this.#accessToken();
    const ids: string[] = [];
    for (const chunk of splitChannelMessage(text, 12000)) {
      const response = await fetchWithTimeout(this.#fetch, `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(target.conversationId)}/activities`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "message", text: chunk }),
      });
      if (!response.ok) throw new Error(`Teams send failed with status ${response.status}`);
      const payload = await response.json() as { id?: string };
      if (payload.id) ids.push(payload.id);
    }
    return Object.freeze({ channel: this.channel, accountId: this.accountId, conversationId: target.conversationId, messageIds: Object.freeze(ids) });
  }

  async #handleActivity(activity: BotFrameworkActivity): Promise<void> {
    if (!this.#handler || activity.type !== "message" || !activity.id || !activity.conversation?.id || !activity.from?.id) return;
    if (activity.recipient?.id && activity.from.id === activity.recipient.id) return;
    if (activity.channelData?.tenant?.id && activity.channelData.tenant.id !== this.#config.tenantId) return;
    if (!activity.serviceUrl) return;
    const serviceUrl = requireHttpUrl(activity.serviceUrl, "Teams serviceUrl").toString().replace(/\/$/, "");
    const conversationId = activity.conversation.id;
    const principal: ChannelPrincipal = { channel: this.channel, accountId: this.accountId, conversationId, senderId: activity.from.aadObjectId ?? activity.from.id };
    const type = activity.conversation.conversationType === "personal" ? "dm" as const : "group" as const;
    if (!channelPrincipalAllowed(principal, type, this.#config)) return;
    const text = activity.text?.trim() ?? "";
    if (!text) return;
    this.#serviceUrls.set(conversationId, serviceUrl);
    await this.#handler({
      id: activity.id,
      principal,
      chatType: type,
      text,
      timestamp: activity.timestamp ? Date.parse(activity.timestamp) || Date.now() : Date.now(),
      ...(activity.from.name === undefined ? {} : { senderName: activity.from.name }),
      ...(activity.conversation.name === undefined ? {} : { conversationName: activity.conversation.name }),
      ...(activity.replyToId === undefined ? {} : { replyToMessageId: activity.replyToId }),
      attachments: [],
    });
  }

  async #accessToken(): Promise<string> {
    return await withSecretText(this.#secrets, this.#config.clientSecretRef, async (secret) => {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.#config.clientId,
        client_secret: secret,
        scope: "https://api.botframework.com/.default",
      });
      const response = await fetchWithTimeout(this.#fetch, this.#config.tokenUrl ?? "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const payload = await response.json() as { access_token?: string };
      if (!response.ok || !payload.access_token) throw new Error("Teams access-token request failed");
      return payload.access_token;
    });
  }

  async #verifyJwt(token: string, serviceUrl: string | undefined): Promise<boolean> {
    try {
      const parts = token.split(".");
      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return false;
      const header = decodeJwtPart<JwtHeader>(parts[0]);
      const payload = decodeJwtPart<JwtPayload>(parts[1]);
      if (header.alg !== "RS256" || !header.kid || !audienceMatches(payload.aud, this.#config.clientId)) return false;
      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp !== "number" || payload.exp <= now || (typeof payload.nbf === "number" && payload.nbf > now + 60)) return false;
      const cache = await this.#openId();
      if (payload.iss !== cache.metadata.issuer && payload.iss !== "https://api.botframework.com") return false;
      // Bot Framework requires the signed serviceUrl claim to be present and to
      // match the Activity body. Without this check a valid Connector token
      // could be paired with an attacker-controlled callback URL.
      if (!payload.serviceUrl || !serviceUrl) return false;
      if (payload.serviceUrl.replace(/\/$/, "") !== serviceUrl.replace(/\/$/, "")) return false;
      const jwk = cache.jwks.keys?.find((key) => key.kid === header.kid);
      if (!jwk) return false;
      const publicKey = createPublicKey({ key: jwk, format: "jwk" });
      return verifySignature("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"));
    } catch (error) {
      reportOperationalError({ component: "channels.teams", operation: "verify inbound connector token", error, severity: "warn" });
      return false;
    }
  }

  async #openId(): Promise<{ metadata: OpenIdMetadata; jwks: JsonWebKeySet }> {
    if (this.#metadataCache && this.#metadataCache.expiresAt > Date.now()) return this.#metadataCache;
    const metadataResponse = await fetchWithTimeout(this.#fetch, this.#config.openIdMetadataUrl ?? "https://login.botframework.com/v1/.well-known/openidconfiguration");
    const metadata = await metadataResponse.json() as OpenIdMetadata;
    if (!metadataResponse.ok || !metadata.jwks_uri || !metadata.issuer) throw new Error("Teams OpenID metadata failed");
    const jwksUrl = requireHttpUrl(metadata.jwks_uri, "Teams JWKS URL").toString();
    const jwksResponse = await fetchWithTimeout(this.#fetch, jwksUrl);
    const jwks = await jwksResponse.json() as JsonWebKeySet;
    if (!jwksResponse.ok || !Array.isArray(jwks.keys)) throw new Error("Teams JWKS request failed");
    this.#metadataCache = { metadata, jwks, expiresAt: Date.now() + 60 * 60 * 1000 };
    return this.#metadataCache;
  }
}
