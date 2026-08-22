import * as channels from "@friday/channels";
import { createHash } from "node:crypto";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EVENTS_CAPABILITY } from "../events/contract.js";
import {
  SCHEDULED_ACTION_CONTRIBUTION,
  type JsonObject,
  type JsonValue,
} from "../scheduler/contract.js";
import { SYSTEM_STATUS_CONTRIBUTION } from "../system/contract.js";
import { TURN_INGRESS_HOOK } from "../turn-loop/contract.js";
import { VAULT_CAPABILITY } from "../vault/contract.js";
import { VAULT_TRUSTED_CAPABILITY } from "../vault/trusted-contract.js";
import {
  isLifecycleRestartEnvironment,
  LIFECYCLE_HANDOFF_CONTRIBUTION,
} from "../lifecycle/contract.js";
import { CHANNELS_CAPABILITY, type ChannelsService } from "./contract.js";
import { readSavedChannels, type SavedChannelConfig } from "./config.js";
import {
  CHANNELS_TRUSTED_CAPABILITY,
  type ChannelsTrustedService,
} from "./trusted-contract.js";


const CHANNEL_INGRESS_EVENT = "channel.ingress.accepted";
const CHANNEL_INGRESS_CONSUMER = "channels.turn-ingress.v1";

function ingressEventId(message: channels.ChannelInboundMessage): string {
  const key = JSON.stringify([
    message.principal.channel,
    message.principal.accountId,
    message.principal.conversationId,
    message.principal.threadId ?? "",
    message.id,
  ]);
  return `channel-ingress:${createHash("sha256").update(key).digest("hex")}`;
}

function ingressPayload(message: channels.ChannelInboundMessage) {
  return {
    id: message.id,
    principal: {
      channel: message.principal.channel,
      accountId: message.principal.accountId,
      conversationId: message.principal.conversationId,
      senderId: message.principal.senderId,
      ...(message.principal.threadId === undefined ? {} : { threadId: message.principal.threadId }),
    },
    text: message.text,
    timestamp: message.timestamp,
    attachments: message.attachments.map((attachment) => ({
      kind: attachment.kind,
      externalId: attachment.externalId,
      ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
      ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
      ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
      ...(attachment.downloadUrl === undefined ? {} : { downloadUrl: attachment.downloadUrl }),
    })),
  };
}

function persistedIngress(data: unknown): ReturnType<typeof ingressPayload> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("persisted channel ingress payload is invalid");
  const raw = data as Record<string, unknown>;
  const principal = raw.principal;
  if (!principal || typeof principal !== "object" || Array.isArray(principal)) throw new Error("persisted channel ingress principal is invalid");
  const p = principal as Record<string, unknown>;
  for (const [name, value] of Object.entries({ id: raw.id, text: raw.text, channel: p.channel, accountId: p.accountId, conversationId: p.conversationId, senderId: p.senderId })) {
    if (typeof value !== "string" || !value) throw new Error(`persisted channel ingress ${name} is invalid`);
  }
  if (typeof raw.timestamp !== "number" || !Number.isFinite(raw.timestamp)) throw new Error("persisted channel ingress timestamp is invalid");
  if (!Array.isArray(raw.attachments)) throw new Error("persisted channel ingress attachments are invalid");
  return raw as unknown as ReturnType<typeof ingressPayload>;
}

function envConfigured(name: string): boolean {
  return process.env[name] !== undefined && process.env[name]!.trim() !== "";
}

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

function envList(name: string): readonly string[] {
  return Object.freeze((process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}


function savedString(config: SavedChannelConfig | undefined, name: string): string | undefined {
  const value = config?.settings?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function savedNumber(config: SavedChannelConfig | undefined, name: string): number | undefined {
  const value = config?.settings?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function savedBoolean(config: SavedChannelConfig | undefined, name: string): boolean | undefined {
  const value = config?.settings?.[name];
  return typeof value === "boolean" ? value : undefined;
}

function savedSecretRef(config: SavedChannelConfig | undefined, name: string, fallback: string): string {
  return config?.secretRefs?.[name] ?? fallback;
}

function savedAccess(config: SavedChannelConfig | undefined) {
  return {
    allowedSenderIds: config?.allowedSenderIds ?? [],
    allowedConversationIds: config?.allowedConversationIds ?? [],
    allowAll: config?.allowAll === true,
  };
}

function objectRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function scheduledString(value: JsonValue | undefined, label: string, maximum = 16_000): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.replaceAll("\u0000", "\ufffd").trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return normalized;
}

function reminderPayload(value: JsonValue): {
  target: { channel: string; accountId: string; conversationId: string; threadId?: string | undefined };
  text: string;
} {
  const payload = objectRecord(value);
  const target = payload ? objectRecord(payload.target ?? null) : undefined;
  if (!payload || !target) throw new Error("scheduled channel reminder payload is invalid");
  const channel = scheduledString(target.channel, "scheduled reminder target.channel", 64);
  const accountId = scheduledString(target.accountId, "scheduled reminder target.accountId", 256);
  const conversationId = scheduledString(target.conversationId, "scheduled reminder target.conversationId", 256);
  const threadId = target.threadId === undefined ? undefined : scheduledString(target.threadId, "scheduled reminder target.threadId", 256);
  return {
    target: { channel, accountId, conversationId, ...(threadId === undefined ? {} : { threadId }) },
    text: scheduledString(payload.text, "scheduled reminder text"),
  };
}

export interface ChannelsPluginOptions {
  readonly telegram?: channels.TelegramChannelConfig | false | undefined;
  readonly whatsapp?: channels.WhatsAppChannelConfig | false | undefined;
  readonly discord?: channels.DiscordChannelConfig | false | undefined;
  readonly slack?: channels.SlackChannelConfig | false | undefined;
  readonly teams?: channels.TeamsChannelConfig | false | undefined;
  readonly googleChat?: channels.GoogleChatChannelConfig | false | undefined;
  readonly signal?: channels.SignalChannelConfig | false | undefined;
  readonly email?: channels.EmailChannelConfig | false | undefined;
  readonly sms?: channels.SmsChannelConfig | false | undefined;
  readonly cliAccountId?: string | undefined;
  readonly autoStart?: boolean | undefined;
}

export function createChannelsPlugin(options: ChannelsPluginOptions = {}): FridayPlugin {
  return definePlugin({ id: "channels", requires: [EVENTS_CAPABILITY, VAULT_CAPABILITY, VAULT_TRUSTED_CAPABILITY], provides: [CHANNELS_CAPABILITY, CHANNELS_TRUSTED_CAPABILITY] }, async (ctx) => {
    const events = ctx.services.require(EVENTS_CAPABILITY);
    const vault = ctx.services.require(VAULT_CAPABILITY);
    const trustedVault = ctx.services.require(VAULT_TRUSTED_CAPABILITY);
    const secretConsumer: channels.SecretConsumer = {
      consume: (ref, consumer) => trustedVault.consume(ref, consumer),
    };
    const saved = await readSavedChannels();
    const hub = new channels.ChannelHub({
      credentialVault: {
        normalizeRef: (ref) => vault.normalizeRef(ref),
        exists: (ref) => vault.exists(ref),
        create: (input) => trustedVault.create(input),
        rotate: (ref, secret) => trustedVault.rotate(ref, secret),
      },
    });

    const cli = new channels.CliChannelTransport(options.cliAccountId ?? "local");
    hub.registerTransport(cli);

    const telegramSaved = saved.channels.telegram;
    const telegramConfig = options.telegram === undefined
      ? envConfigured("FRIDAY_TELEGRAM_ENABLED")
        ? envFlag("FRIDAY_TELEGRAM_ENABLED")
          ? {
              accountId: envString("FRIDAY_TELEGRAM_ACCOUNT_ID") ?? "default",
              credentialRef: envString("FRIDAY_TELEGRAM_TOKEN_REF") ?? "vault://channels/telegram/default/bot-token",
              allowedSenderIds: envList("FRIDAY_TELEGRAM_ALLOWED_USERS"),
              allowedConversationIds: envList("FRIDAY_TELEGRAM_ALLOWED_CHATS"),
              allowAll: envFlag("FRIDAY_TELEGRAM_ALLOW_ALL_USERS"),
              requireMention: envFlag("FRIDAY_TELEGRAM_REQUIRE_MENTION"),
            } satisfies channels.TelegramChannelConfig
          : false
        : telegramSaved?.enabled
          ? {
              accountId: telegramSaved.accountId ?? "default",
              credentialRef: savedSecretRef(telegramSaved, "botToken", "vault://channels/telegram/default/bot-token"),
              ...savedAccess(telegramSaved),
              requireMention: telegramSaved.requireMention === true,
            } satisfies channels.TelegramChannelConfig
          : false
      : options.telegram;
    if (telegramConfig) hub.registerTransport(new channels.TelegramChannelTransport(telegramConfig, secretConsumer));

    const whatsappSaved = saved.channels.whatsapp;
    const whatsappConfig = options.whatsapp === undefined
      ? envConfigured("FRIDAY_WHATSAPP_ENABLED")
        ? envFlag("FRIDAY_WHATSAPP_ENABLED")
          ? {
              accountId: envString("FRIDAY_WHATSAPP_ACCOUNT_ID") ?? "default",
              allowedSenderIds: envList("FRIDAY_WHATSAPP_ALLOWED_USERS"),
              allowedConversationIds: envList("FRIDAY_WHATSAPP_ALLOWED_CHATS"),
              allowAll: envFlag("FRIDAY_WHATSAPP_ALLOW_ALL_USERS"),
              ...(envNumber("FRIDAY_WHATSAPP_BRIDGE_PORT") === undefined ? {} : { bridgePort: envNumber("FRIDAY_WHATSAPP_BRIDGE_PORT") }),
            } satisfies channels.WhatsAppChannelConfig
          : false
        : whatsappSaved?.enabled
          ? { accountId: whatsappSaved.accountId ?? "default", ...savedAccess(whatsappSaved), ...(savedNumber(whatsappSaved, "bridgePort") === undefined ? {} : { bridgePort: savedNumber(whatsappSaved, "bridgePort") }) } satisfies channels.WhatsAppChannelConfig
          : false
      : options.whatsapp;
    if (whatsappConfig) hub.registerTransport(new channels.WhatsAppChannelTransport(whatsappConfig));

    const discordSaved = saved.channels.discord;
    const discordConfig = options.discord === undefined
      ? envConfigured("FRIDAY_DISCORD_ENABLED")
        ? envFlag("FRIDAY_DISCORD_ENABLED")
          ? {
              accountId: envString("FRIDAY_DISCORD_ACCOUNT_ID") ?? "default",
              credentialRef: envString("FRIDAY_DISCORD_TOKEN_REF") ?? "vault://channels/discord/default/bot-token",
              allowedSenderIds: envList("FRIDAY_DISCORD_ALLOWED_USERS"),
              allowedConversationIds: envList("FRIDAY_DISCORD_ALLOWED_CHANNELS"),
              allowAll: envFlag("FRIDAY_DISCORD_ALLOW_ALL_USERS"),
              requireMention: envFlag("FRIDAY_DISCORD_REQUIRE_MENTION"),
            } satisfies channels.DiscordChannelConfig
          : false
        : discordSaved?.enabled
          ? { accountId: discordSaved.accountId ?? "default", credentialRef: savedSecretRef(discordSaved, "botToken", "vault://channels/discord/default/bot-token"), ...savedAccess(discordSaved), requireMention: discordSaved.requireMention === true } satisfies channels.DiscordChannelConfig
          : false
      : options.discord;
    if (discordConfig) hub.registerTransport(new channels.DiscordChannelTransport(discordConfig, secretConsumer));

    const slackSaved = saved.channels.slack;
    const slackConfig = options.slack === undefined
      ? envConfigured("FRIDAY_SLACK_ENABLED")
        ? envFlag("FRIDAY_SLACK_ENABLED")
          ? {
              accountId: envString("FRIDAY_SLACK_ACCOUNT_ID") ?? "default",
              botTokenRef: envString("FRIDAY_SLACK_BOT_TOKEN_REF") ?? "vault://channels/slack/default/bot-token",
              appTokenRef: envString("FRIDAY_SLACK_APP_TOKEN_REF") ?? "vault://channels/slack/default/app-token",
              allowedSenderIds: envList("FRIDAY_SLACK_ALLOWED_USERS"),
              allowedConversationIds: envList("FRIDAY_SLACK_ALLOWED_CHANNELS"),
              allowAll: envFlag("FRIDAY_SLACK_ALLOW_ALL_USERS"),
              requireMention: envFlag("FRIDAY_SLACK_REQUIRE_MENTION"),
            } satisfies channels.SlackChannelConfig
          : false
        : slackSaved?.enabled
          ? { accountId: slackSaved.accountId ?? "default", botTokenRef: savedSecretRef(slackSaved, "botToken", "vault://channels/slack/default/bot-token"), appTokenRef: savedSecretRef(slackSaved, "appToken", "vault://channels/slack/default/app-token"), ...savedAccess(slackSaved), requireMention: slackSaved.requireMention === true } satisfies channels.SlackChannelConfig
          : false
      : options.slack;
    if (slackConfig) hub.registerTransport(new channels.SlackChannelTransport(slackConfig, secretConsumer));

    const signalSaved = saved.channels.signal;
    const signalConfig = options.signal === undefined
      ? envConfigured("FRIDAY_SIGNAL_ENABLED")
        ? envFlag("FRIDAY_SIGNAL_ENABLED") && envString("FRIDAY_SIGNAL_ACCOUNT")
          ? { accountId: envString("FRIDAY_SIGNAL_ACCOUNT_ID") ?? "default", account: envString("FRIDAY_SIGNAL_ACCOUNT")!, httpUrl: envString("FRIDAY_SIGNAL_HTTP_URL") ?? "http://127.0.0.1:8080", allowedSenderIds: envList("FRIDAY_SIGNAL_ALLOWED_USERS"), allowedConversationIds: envList("FRIDAY_SIGNAL_ALLOWED_GROUPS").map((value) => value.startsWith("group:") ? value : `group:${value}`), allowAll: envFlag("FRIDAY_SIGNAL_ALLOW_ALL_USERS") } satisfies channels.SignalChannelConfig
          : false
        : signalSaved?.enabled && savedString(signalSaved, "account")
          ? { accountId: signalSaved.accountId ?? "default", account: savedString(signalSaved, "account")!, httpUrl: savedString(signalSaved, "httpUrl") ?? "http://127.0.0.1:8080", ...savedAccess(signalSaved) } satisfies channels.SignalChannelConfig
          : false
      : options.signal;
    if (signalConfig) hub.registerTransport(new channels.SignalChannelTransport(signalConfig));

    const emailSaved = saved.channels.email;
    const emailConfig = options.email === undefined
      ? envConfigured("FRIDAY_EMAIL_ENABLED")
        ? envFlag("FRIDAY_EMAIL_ENABLED") && envString("FRIDAY_EMAIL_ADDRESS") && envString("FRIDAY_EMAIL_IMAP_HOST") && envString("FRIDAY_EMAIL_SMTP_HOST")
          ? { accountId: envString("FRIDAY_EMAIL_ACCOUNT_ID") ?? "default", address: envString("FRIDAY_EMAIL_ADDRESS")!, passwordRef: envString("FRIDAY_EMAIL_PASSWORD_REF") ?? "vault://channels/email/default/password", imapHost: envString("FRIDAY_EMAIL_IMAP_HOST")!, smtpHost: envString("FRIDAY_EMAIL_SMTP_HOST")!, ...(envNumber("FRIDAY_EMAIL_IMAP_PORT") === undefined ? {} : { imapPort: envNumber("FRIDAY_EMAIL_IMAP_PORT") }), ...(envNumber("FRIDAY_EMAIL_SMTP_PORT") === undefined ? {} : { smtpPort: envNumber("FRIDAY_EMAIL_SMTP_PORT") }), ...(envNumber("FRIDAY_EMAIL_POLL_INTERVAL_MS") === undefined ? {} : { pollIntervalMs: envNumber("FRIDAY_EMAIL_POLL_INTERVAL_MS") }), allowedSenderIds: envList("FRIDAY_EMAIL_ALLOWED_USERS").map((value) => value.toLowerCase()), allowAll: envFlag("FRIDAY_EMAIL_ALLOW_ALL_USERS") } satisfies channels.EmailChannelConfig
          : false
        : emailSaved?.enabled && savedString(emailSaved, "address") && savedString(emailSaved, "imapHost") && savedString(emailSaved, "smtpHost")
          ? { accountId: emailSaved.accountId ?? "default", address: savedString(emailSaved, "address")!, passwordRef: savedSecretRef(emailSaved, "password", "vault://channels/email/default/password"), imapHost: savedString(emailSaved, "imapHost")!, smtpHost: savedString(emailSaved, "smtpHost")!, ...(savedNumber(emailSaved, "imapPort") === undefined ? {} : { imapPort: savedNumber(emailSaved, "imapPort") }), ...(savedNumber(emailSaved, "smtpPort") === undefined ? {} : { smtpPort: savedNumber(emailSaved, "smtpPort") }), ...(savedBoolean(emailSaved, "imapTls") === undefined ? {} : { imapTls: savedBoolean(emailSaved, "imapTls") }), ...(savedString(emailSaved, "smtpTls") === undefined ? {} : { smtpTls: savedString(emailSaved, "smtpTls") as "ssl" | "starttls" | "plain" }), ...savedAccess(emailSaved) } satisfies channels.EmailChannelConfig
          : false
      : options.email;
    if (emailConfig) hub.registerTransport(new channels.EmailChannelTransport(emailConfig, secretConsumer));

    const teamsSaved = saved.channels.teams;
    const teamsConfig = options.teams === undefined
      ? envConfigured("FRIDAY_TEAMS_ENABLED")
        ? envFlag("FRIDAY_TEAMS_ENABLED") && envString("FRIDAY_TEAMS_CLIENT_ID") && envString("FRIDAY_TEAMS_TENANT_ID")
          ? { accountId: envString("FRIDAY_TEAMS_ACCOUNT_ID") ?? "default", clientId: envString("FRIDAY_TEAMS_CLIENT_ID")!, clientSecretRef: envString("FRIDAY_TEAMS_CLIENT_SECRET_REF") ?? "vault://channels/teams/default/client-secret", tenantId: envString("FRIDAY_TEAMS_TENANT_ID")!, ...(envString("FRIDAY_TEAMS_LISTEN_HOST") === undefined ? {} : { listenHost: envString("FRIDAY_TEAMS_LISTEN_HOST") }), ...(envNumber("FRIDAY_TEAMS_LISTEN_PORT") === undefined ? {} : { listenPort: envNumber("FRIDAY_TEAMS_LISTEN_PORT") }), ...(envString("FRIDAY_TEAMS_WEBHOOK_PATH") === undefined ? {} : { webhookPath: envString("FRIDAY_TEAMS_WEBHOOK_PATH") }), allowedSenderIds: envList("FRIDAY_TEAMS_ALLOWED_USERS"), allowedConversationIds: envList("FRIDAY_TEAMS_ALLOWED_CHATS"), allowAll: envFlag("FRIDAY_TEAMS_ALLOW_ALL_USERS") } satisfies channels.TeamsChannelConfig
          : false
        : teamsSaved?.enabled && savedString(teamsSaved, "clientId") && savedString(teamsSaved, "tenantId")
          ? { accountId: teamsSaved.accountId ?? "default", clientId: savedString(teamsSaved, "clientId")!, clientSecretRef: savedSecretRef(teamsSaved, "clientSecret", "vault://channels/teams/default/client-secret"), tenantId: savedString(teamsSaved, "tenantId")!, ...(savedString(teamsSaved, "listenHost") === undefined ? {} : { listenHost: savedString(teamsSaved, "listenHost") }), ...(savedNumber(teamsSaved, "listenPort") === undefined ? {} : { listenPort: savedNumber(teamsSaved, "listenPort") }), ...(savedString(teamsSaved, "webhookPath") === undefined ? {} : { webhookPath: savedString(teamsSaved, "webhookPath") }), ...savedAccess(teamsSaved) } satisfies channels.TeamsChannelConfig
          : false
      : options.teams;
    if (teamsConfig) hub.registerTransport(new channels.TeamsChannelTransport(teamsConfig, secretConsumer));

    const googleSaved = saved.channels["google-chat"];
    const googleChatConfig = options.googleChat === undefined
      ? envConfigured("FRIDAY_GOOGLE_CHAT_ENABLED")
        ? envFlag("FRIDAY_GOOGLE_CHAT_ENABLED") && envString("FRIDAY_GOOGLE_CHAT_AUDIENCE")
          ? { accountId: envString("FRIDAY_GOOGLE_CHAT_ACCOUNT_ID") ?? "default", serviceAccountRef: envString("FRIDAY_GOOGLE_CHAT_SERVICE_ACCOUNT_REF") ?? "vault://channels/google-chat/default/service-account", audience: envString("FRIDAY_GOOGLE_CHAT_AUDIENCE")!, ...(envString("FRIDAY_GOOGLE_CHAT_EXPECTED_SERVICE_ACCOUNT_EMAIL") === undefined ? {} : { expectedServiceAccountEmail: envString("FRIDAY_GOOGLE_CHAT_EXPECTED_SERVICE_ACCOUNT_EMAIL") }), ...(envString("FRIDAY_GOOGLE_CHAT_LISTEN_HOST") === undefined ? {} : { listenHost: envString("FRIDAY_GOOGLE_CHAT_LISTEN_HOST") }), ...(envNumber("FRIDAY_GOOGLE_CHAT_LISTEN_PORT") === undefined ? {} : { listenPort: envNumber("FRIDAY_GOOGLE_CHAT_LISTEN_PORT") }), ...(envString("FRIDAY_GOOGLE_CHAT_WEBHOOK_PATH") === undefined ? {} : { webhookPath: envString("FRIDAY_GOOGLE_CHAT_WEBHOOK_PATH") }), allowedSenderIds: envList("FRIDAY_GOOGLE_CHAT_ALLOWED_USERS"), allowedConversationIds: envList("FRIDAY_GOOGLE_CHAT_ALLOWED_SPACES"), allowAll: envFlag("FRIDAY_GOOGLE_CHAT_ALLOW_ALL_USERS") } satisfies channels.GoogleChatChannelConfig
          : false
        : googleSaved?.enabled && savedString(googleSaved, "audience")
          ? { accountId: googleSaved.accountId ?? "default", serviceAccountRef: savedSecretRef(googleSaved, "serviceAccount", "vault://channels/google-chat/default/service-account"), audience: savedString(googleSaved, "audience")!, ...(savedString(googleSaved, "expectedServiceAccountEmail") === undefined ? {} : { expectedServiceAccountEmail: savedString(googleSaved, "expectedServiceAccountEmail") }), ...(savedString(googleSaved, "listenHost") === undefined ? {} : { listenHost: savedString(googleSaved, "listenHost") }), ...(savedNumber(googleSaved, "listenPort") === undefined ? {} : { listenPort: savedNumber(googleSaved, "listenPort") }), ...(savedString(googleSaved, "webhookPath") === undefined ? {} : { webhookPath: savedString(googleSaved, "webhookPath") }), ...savedAccess(googleSaved) } satisfies channels.GoogleChatChannelConfig
          : false
      : options.googleChat;
    if (googleChatConfig) hub.registerTransport(new channels.GoogleChatChannelTransport(googleChatConfig, secretConsumer));

    const smsSaved = saved.channels.sms;
    const smsConfig = options.sms === undefined
      ? envConfigured("FRIDAY_SMS_ENABLED")
        ? envFlag("FRIDAY_SMS_ENABLED") && envString("FRIDAY_SMS_ACCOUNT_SID") && envString("FRIDAY_SMS_FROM_NUMBER") && envString("FRIDAY_SMS_PUBLIC_WEBHOOK_URL")
          ? { accountId: envString("FRIDAY_SMS_ACCOUNT_ID") ?? "default", accountSid: envString("FRIDAY_SMS_ACCOUNT_SID")!, authTokenRef: envString("FRIDAY_SMS_AUTH_TOKEN_REF") ?? "vault://channels/sms/default/auth-token", fromNumber: envString("FRIDAY_SMS_FROM_NUMBER")!, publicWebhookUrl: envString("FRIDAY_SMS_PUBLIC_WEBHOOK_URL")!, ...(envString("FRIDAY_SMS_LISTEN_HOST") === undefined ? {} : { listenHost: envString("FRIDAY_SMS_LISTEN_HOST") }), ...(envNumber("FRIDAY_SMS_LISTEN_PORT") === undefined ? {} : { listenPort: envNumber("FRIDAY_SMS_LISTEN_PORT") }), allowedSenderIds: envList("FRIDAY_SMS_ALLOWED_USERS"), allowAll: envFlag("FRIDAY_SMS_ALLOW_ALL_USERS") } satisfies channels.SmsChannelConfig
          : false
        : smsSaved?.enabled && savedString(smsSaved, "accountSid") && savedString(smsSaved, "fromNumber") && savedString(smsSaved, "publicWebhookUrl")
          ? { accountId: smsSaved.accountId ?? "default", accountSid: savedString(smsSaved, "accountSid")!, authTokenRef: savedSecretRef(smsSaved, "authToken", "vault://channels/sms/default/auth-token"), fromNumber: savedString(smsSaved, "fromNumber")!, publicWebhookUrl: savedString(smsSaved, "publicWebhookUrl")!, ...(savedString(smsSaved, "listenHost") === undefined ? {} : { listenHost: savedString(smsSaved, "listenHost") }), ...(savedNumber(smsSaved, "listenPort") === undefined ? {} : { listenPort: savedNumber(smsSaved, "listenPort") }), ...savedAccess(smsSaved) } satisfies channels.SmsChannelConfig
          : false
      : options.sms;
    if (smsConfig) hub.registerTransport(new channels.SmsChannelTransport(smsConfig, secretConsumer));

    // Provider acknowledgement is allowed only after the sanitized inbound message
    // is durable. Model/tool execution happens through a durable Events consumer, so
    // a process crash after ACK cannot silently lose the user's message.
    const unsubscribeTurnIngress = hub.subscribeAdmission((message) => {
      if (message.classification !== "message") return;
      const eventId = ingressEventId(message);
      // Provider retries may reconstruct a delivery with a fresh local timestamp even
      // though the provider message id and immutable content are the same. Once this
      // provider identity has been admitted, treat later deliveries as the same inbox
      // item instead of turning harmless timestamp drift into a permanent NACK loop.
      const alreadyAdmitted = events.get(eventId);
      if (alreadyAdmitted) {
        if (alreadyAdmitted.type !== CHANNEL_INGRESS_EVENT || alreadyAdmitted.source !== "channels") {
          throw new Error(`Channel ingress event identity is already owned by another event: ${eventId}`);
        }
        return;
      }
      try {
        events.publish({
          id: eventId,
          type: CHANNEL_INGRESS_EVENT,
          source: "channels",
          subject: `channel:${message.principal.channel}:${message.principal.accountId}`,
          occurredAt: new Date(message.timestamp).toISOString(),
          data: ingressPayload(message),
        });
      } catch (error) {
        // During the verified predecessor/successor overlap, both runtimes can observe
        // the same provider retry. If the other process won the durable insert race,
        // acknowledging this copy is safe because the inbox item now exists.
        const raced = events.get(eventId);
        if (raced?.type === CHANNEL_INGRESS_EVENT && raced.source === "channels") return;
        throw error;
      }
    });
    ctx.effect(unsubscribeTurnIngress);

    const unregisterIngressConsumer = events.registerConsumer({
      id: CHANNEL_INGRESS_CONSUMER,
      types: [CHANNEL_INGRESS_EVENT],
      startAt: "beginning",
    }, async ({ event, signal }) => {
      signal?.throwIfAborted();
      const message = persistedIngress(event.data);
      await ctx.emit(TURN_INGRESS_HOOK, {
        id: message.id,
        principal: {
          authority: message.principal.channel === "cli" ? "local" : "channel",
          ...message.principal,
        },
        text: message.text,
        attachments: message.attachments,
        timestamp: message.timestamp,
        reply: async (text) => {
          await hub.send({
            channel: message.principal.channel,
            accountId: message.principal.accountId,
            conversationId: message.principal.conversationId,
            ...(message.principal.threadId === undefined ? {} : { threadId: message.principal.threadId }),
          }, text);
        },
      });
    });
    ctx.effect(unregisterIngressConsumer);

    const safe: ChannelsService = Object.freeze({
      list: () => hub.list(),
      subscribe: (listener: Parameters<ChannelsService["subscribe"]>[0]) => hub.subscribe(listener),
    });
    const trusted: ChannelsTrustedService = Object.freeze({
      start: () => hub.startAll(),
      stop: () => hub.stopAll(),
      send: (target: Parameters<ChannelsTrustedService["send"]>[0], text: string) => hub.send(target, text),
      fetchAttachment: (target: Parameters<ChannelsTrustedService["fetchAttachment"]>[0], attachment: Parameters<ChannelsTrustedService["fetchAttachment"]>[1], maxBytes?: number) => hub.fetchAttachment(target, attachment as never, maxBytes),
      requestCredentialCapture: (request: Parameters<ChannelsTrustedService["requestCredentialCapture"]>[0]) => hub.requestCredentialCapture(request),
      waitForCredentialCapture: (requestId: string) => hub.waitForCredentialCapture(requestId),
      cancelCredentialCapture: (requestId: string) => hub.cancelCredentialCapture(requestId),
      pendingCredentialCaptures: () => hub.pendingCredentialCaptures(),
      requestApproval: (request: Parameters<ChannelsTrustedService["requestApproval"]>[0]) => hub.requestApproval(request),
      cancelApproval: (requestId: string) => hub.cancelApproval(requestId),
      pendingApprovals: () => hub.pendingApprovals(),
      requestPrompt: (request: Parameters<ChannelsTrustedService["requestPrompt"]>[0]) => hub.requestPrompt(request),
      cancelPrompt: (requestId: string) => hub.cancelPrompt(requestId),
      pendingPrompts: () => hub.pendingPrompts(),
      watchCancellation: (request: Parameters<ChannelsTrustedService["watchCancellation"]>[0]) => hub.watchCancellation(request),
      ingestLocal: (text: string, ingestOptions: Parameters<ChannelsTrustedService["ingestLocal"]>[1] = {}) => hub.ingest({
        id: `cli-${Date.now()}`,
        principal: {
          channel: "cli",
          accountId: cli.accountId,
          conversationId: ingestOptions.conversationId ?? "terminal",
          senderId: ingestOptions.senderId ?? "local-user",
          ...(ingestOptions.threadId === undefined ? {} : { threadId: ingestOptions.threadId }),
        },
        chatType: ingestOptions.threadId ? "thread" : "dm",
        text,
        timestamp: Date.now(),
        attachments: [],
      }),
    });

    ctx.contribute(SCHEDULED_ACTION_CONTRIBUTION, {
      id: "channels.reminder",
      label: "Reminder to this conversation",
      description: "Send reminder text back to the same conversation that requested the schedule. The destination is host-bound and cannot be chosen by the model.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          message: { type: "string", description: "Reminder text to send when the schedule fires" },
        },
        required: ["message"],
        additionalProperties: false,
      }) as JsonObject,
      prepare(input, context) {
        return {
          target: {
            channel: context.origin.channel,
            accountId: context.origin.accountId,
            conversationId: context.origin.conversationId,
            ...(context.origin.threadId === undefined ? {} : { threadId: context.origin.threadId }),
          },
          text: scheduledString(input.message, "reminder message"),
        };
      },
      permission(payload) {
        const reminder = reminderPayload(payload);
        const local = reminder.target.channel === "cli";
        return {
          id: "channels.send.scheduled",
          effect: local ? "system-write" : "external-write",
          resource: `channel:${reminder.target.channel}:${reminder.target.accountId}:${reminder.target.conversationId}`,
          network: !local,
        };
      },
      async execute(payload, execution) {
        execution.signal?.throwIfAborted();
        const reminder = reminderPayload(payload);
        await trusted.send(reminder.target, reminder.text);
      },
    });
    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "channels",
      label: "Channels",
      snapshot: () => safe.list() as unknown as JsonValue,
    });

    ctx.effect(() => hub.stopAll());
    ctx.services.provide(CHANNELS_CAPABILITY, safe);
    ctx.services.provide(CHANNELS_TRUSTED_CAPABILITY, trusted);
    if (options.autoStart === true) {
      ctx.contribute(LIFECYCLE_HANDOFF_CONTRIBUTION, {
        id: "channels.transports",
        activate: () => hub.startAll(),
        quiesce: () => hub.stopAll(),
      });
    }
    if (options.autoStart === true && !isLifecycleRestartEnvironment()) {
      ctx.afterReady(() => hub.startAll());
    }
  });
}

export default createChannelsPlugin({ autoStart: true });
