import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  readSavedChannels,
  updateSavedChannel,
  type ConfigurableChannelId,
  type SavedChannelConfig,
} from "../plugins/channels/config.js";
import type { OnboardingIO } from "./onboarding.js";

interface VaultStoreLike {
  exists(ref: string): boolean;
  create(input: { ref: string; kind: string; secret: Uint8Array }): unknown;
  rotate(ref: string, secret: Uint8Array): unknown;
}

const CHANNELS: readonly { readonly id: ConfigurableChannelId; readonly label: string }[] = Object.freeze([
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "signal", label: "Signal" },
  { id: "email", label: "Email" },
  { id: "teams", label: "Microsoft Teams" },
  { id: "google-chat", label: "Google Chat" },
  { id: "sms", label: "SMS / Twilio" },
]);

function text(value: string, label: string, maximum = 4_096): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maximum || /[\r\n\0]/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function optionalText(value: string, maximum = 4_096): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum || /[\r\n\0]/.test(normalized)) throw new Error("value is invalid");
  return normalized;
}

function csv(value: string): readonly string[] {
  return Object.freeze([...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]);
}

function yes(value: string, current = false): boolean {
  const answer = value.trim().toLowerCase();
  if (!answer) return current;
  if (["y", "yes", "true", "1", "on"].includes(answer)) return true;
  if (["n", "no", "false", "0", "off"].includes(answer)) return false;
  throw new Error("expected yes or no");
}

async function askConfirm(io: OnboardingIO, message: string, current = false): Promise<boolean> {
  if (io.confirm) return io.confirm(message, current);
  return yes(await io.question(`${message} [${current ? "Y/n" : "y/N"}] `), current);
}

async function prompt(io: OnboardingIO, label: string, current?: string): Promise<string> {
  const answer = await io.question(`${label}${current ? ` [${current}]` : ""}: `);
  return answer.trim() || current || "";
}

async function promptNumber(io: OnboardingIO, label: string, current?: number): Promise<number | undefined> {
  const raw = await prompt(io, label, current === undefined ? undefined : String(current));
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${label} must be a valid port`);
  return value;
}

function strictToken(value: string, label: string): string {
  const token = value.trim();
  if (!token || token.length > 32_768 || /\s/.test(token) || /[`'"]/.test(token) || /^(?:api[_ -]?key|token|secret|password|bearer)\s*[:=]/i.test(token)) {
    throw new Error(`Send only the ${label} value; do not include labels, quotes, code fences, spaces, or comments`);
  }
  return token;
}

async function storeSecret(
  io: OnboardingIO,
  vault: VaultStoreLike,
  ref: string,
  kind: string,
  label: string,
  options: { readonly tokenOnly?: boolean | undefined; readonly bytes?: Uint8Array | undefined } = {},
): Promise<void> {
  let bytes: Buffer;
  if (options.bytes) {
    bytes = Buffer.from(options.bytes);
  } else {
    io.write([
      `${label} capture`,
      `Send ONLY the ${label} value.`,
      "Do not include a label, quotes, code fences, comments, or other text.",
      "The secret is stored directly in Vault and never written to channel configuration.",
    ].join("\n") + "\n");
    const raw = io.secretQuestion ? await io.secretQuestion(`${label} (input hidden): `) : await io.question(`${label}: `);
    const secret = options.tokenOnly === false ? raw : strictToken(raw, label);
    if (!secret || secret.length > 64_000 || /\0/.test(secret)) throw new Error(`${label} is invalid`);
    bytes = Buffer.from(secret, "utf8");
  }
  try {
    if (vault.exists(ref)) vault.rotate(ref, bytes);
    else vault.create({ ref, kind, secret: bytes });
    io.write(`${label} stored in Vault ✓\n`);
  } finally {
    bytes.fill(0);
  }
}

async function accessPolicy(io: OnboardingIO, current?: SavedChannelConfig): Promise<Pick<SavedChannelConfig, "allowAll" | "allowedSenderIds" | "allowedConversationIds">> {
  io.write("Inbound access is default-deny. Add sender IDs now, or configure trusted identities after FRIDAY starts.\n");
  const senders = csv(await prompt(io, "Allowed sender IDs (comma separated; blank = none)", current?.allowedSenderIds?.join(",") ?? ""));
  const conversations = csv(await prompt(io, "Allowed group/channel IDs (comma separated; blank = none)", current?.allowedConversationIds?.join(",") ?? ""));
  const allowAll = await askConfirm(io, "Allow all transport ingress?", current?.allowAll === true);
  return { allowedSenderIds: senders, allowedConversationIds: conversations, allowAll };
}

async function configureOne(
  id: ConfigurableChannelId,
  io: OnboardingIO,
  home: string,
  vault: VaultStoreLike,
  current?: SavedChannelConfig,
): Promise<SavedChannelConfig | undefined> {
  const status = current?.enabled ? "enabled" : current ? "disabled" : "not configured";
  const choice = io.select
    ? await io.select({
        message: `${id} · ${status}`,
        searchable: false,
        initialValue: current?.enabled ? "enable" : "back",
        maxItems: 4,
        choices: [
          { value: "enable", label: current?.enabled ? "Edit configuration" : "Enable channel", hint: "configure credentials and access" },
          { value: "disable", label: "Disable", hint: "keep configuration for later" },
          { value: "remove", label: "Remove configuration", hint: "delete saved channel settings" },
          { value: "back", label: "Back" },
        ],
      })
    : (await io.question(`${id} is ${status}. [enable/disable/remove/back] [${current?.enabled ? "enable" : "back"}]: `)).trim().toLowerCase() || (current?.enabled ? "enable" : "back");
  if (choice === "back" || choice === "b") return current;
  if (choice === "remove" || choice === "r") return undefined;
  if (choice === "disable" || choice === "d") return Object.freeze({ ...(current ?? { enabled: false }), enabled: false });
  if (choice !== "enable" && choice !== "e") throw new Error("channel choice must be enable, disable, remove, or back");

  const accountId = await prompt(io, "FRIDAY account id", current?.accountId ?? "default");
  const access = await accessPolicy(io, current);
  const settings: Record<string, string | number | boolean> = { ...(current?.settings ?? {}) };
  const secretRefs: Record<string, string> = { ...(current?.secretRefs ?? {}) };
  let requireMention = current?.requireMention === true;

  if (id === "telegram" || id === "discord") {
    requireMention = await askConfirm(io, "Require mention in groups?", requireMention);
    const ref = `vault://channels/${id}/${accountId}/bot-token`;
    secretRefs.botToken = ref;
    if (!vault.exists(ref) || await askConfirm(io, `Replace existing ${id} bot token?`, false)) {
      await storeSecret(io, vault, ref, "bot-token", `${id} bot token`);
    }
  } else if (id === "slack") {
    requireMention = await askConfirm(io, "Require mention in channels?", requireMention);
    const botRef = `vault://channels/slack/${accountId}/bot-token`;
    const appRef = `vault://channels/slack/${accountId}/app-token`;
    secretRefs.botToken = botRef;
    secretRefs.appToken = appRef;
    if (!vault.exists(botRef) || await askConfirm(io, "Replace existing Slack bot token?", false)) await storeSecret(io, vault, botRef, "bot-token", "Slack bot token");
    if (!vault.exists(appRef) || await askConfirm(io, "Replace existing Slack app token?", false)) await storeSecret(io, vault, appRef, "app-token", "Slack app token");
  } else if (id === "whatsapp") {
    const port = await promptNumber(io, "Loopback bridge port", typeof settings.bridgePort === "number" ? settings.bridgePort : 8765);
    if (port !== undefined) settings.bridgePort = port;
    io.write("WhatsApp uses its private local session directory; no chat secret is stored in runtime.env.\n");
  } else if (id === "signal") {
    settings.account = text(await prompt(io, "signal-cli account (phone number)", typeof settings.account === "string" ? settings.account : undefined), "Signal account");
    settings.httpUrl = text(await prompt(io, "signal-cli loopback HTTP URL", typeof settings.httpUrl === "string" ? settings.httpUrl : "http://127.0.0.1:8080"), "Signal URL");
  } else if (id === "email") {
    settings.address = text(await prompt(io, "Email address", typeof settings.address === "string" ? settings.address : undefined), "Email address");
    settings.imapHost = text(await prompt(io, "IMAP host", typeof settings.imapHost === "string" ? settings.imapHost : undefined), "IMAP host");
    const imapPort = await promptNumber(io, "IMAP port", typeof settings.imapPort === "number" ? settings.imapPort : 993); if (imapPort) settings.imapPort = imapPort;
    settings.smtpHost = text(await prompt(io, "SMTP host", typeof settings.smtpHost === "string" ? settings.smtpHost : undefined), "SMTP host");
    const smtpPort = await promptNumber(io, "SMTP port", typeof settings.smtpPort === "number" ? settings.smtpPort : 587); if (smtpPort) settings.smtpPort = smtpPort;
    settings.smtpTls = text(await prompt(io, "SMTP TLS mode (ssl/starttls/plain)", typeof settings.smtpTls === "string" ? settings.smtpTls : "starttls"), "SMTP TLS mode");
    if (!["ssl", "starttls", "plain"].includes(String(settings.smtpTls))) throw new Error("SMTP TLS mode must be ssl, starttls, or plain");
    const ref = `vault://channels/email/${accountId}/password`; secretRefs.password = ref;
    if (!vault.exists(ref) || await askConfirm(io, "Replace existing email password/app-password?", false)) await storeSecret(io, vault, ref, "password", "Email password", { tokenOnly: false });
  } else if (id === "teams") {
    settings.clientId = text(await prompt(io, "Microsoft application/client id", typeof settings.clientId === "string" ? settings.clientId : undefined), "Teams client id");
    settings.tenantId = text(await prompt(io, "Microsoft tenant id", typeof settings.tenantId === "string" ? settings.tenantId : undefined), "Teams tenant id");
    const port = await promptNumber(io, "Loopback listener port", typeof settings.listenPort === "number" ? settings.listenPort : 3978); if (port) settings.listenPort = port;
    const ref = `vault://channels/teams/${accountId}/client-secret`; secretRefs.clientSecret = ref;
    if (!vault.exists(ref) || await askConfirm(io, "Replace existing Teams client secret?", false)) await storeSecret(io, vault, ref, "client-secret", "Teams client secret");
  } else if (id === "google-chat") {
    settings.audience = text(await prompt(io, "Google Chat audience", typeof settings.audience === "string" ? settings.audience : undefined), "Google Chat audience");
    const path = await prompt(io, "Service-account JSON file path (leave blank to keep existing Vault value)", "");
    const ref = `vault://channels/google-chat/${accountId}/service-account`; secretRefs.serviceAccount = ref;
    if (path) {
      const bytes = Buffer.from(await readFile(resolve(path)));
      try {
        const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("service-account file is not a JSON object");
        await storeSecret(io, vault, ref, "service-account", "Google service account", { tokenOnly: false, bytes });
      } finally { bytes.fill(0); }
    } else if (!vault.exists(ref)) {
      throw new Error("Google Chat requires a service-account JSON file on first configuration");
    }
  } else if (id === "sms") {
    settings.accountSid = text(await prompt(io, "Twilio account SID", typeof settings.accountSid === "string" ? settings.accountSid : undefined), "Twilio account SID");
    settings.fromNumber = text(await prompt(io, "Twilio from number", typeof settings.fromNumber === "string" ? settings.fromNumber : undefined), "Twilio from number");
    settings.publicWebhookUrl = text(await prompt(io, "Public webhook URL", typeof settings.publicWebhookUrl === "string" ? settings.publicWebhookUrl : undefined), "Twilio public webhook URL");
    const port = await promptNumber(io, "Loopback listener port", typeof settings.listenPort === "number" ? settings.listenPort : 8788); if (port) settings.listenPort = port;
    const ref = `vault://channels/sms/${accountId}/auth-token`; secretRefs.authToken = ref;
    if (!vault.exists(ref) || await askConfirm(io, "Replace existing Twilio auth token?", false)) await storeSecret(io, vault, ref, "auth-token", "Twilio auth token");
  }

  const configured = Object.freeze({ enabled: true, accountId, ...access, requireMention, settings: Object.freeze(settings), secretRefs: Object.freeze(secretRefs) });
  io.write(`${id} ready to save. The runtime will validate the transport when FRIDAY starts.\n`);
  return configured;
}

export async function maybeManageChannels(
  io: OnboardingIO,
  home: string,
  force?: boolean,
  requireEnabled = false,
): Promise<void> {
  const current = await readSavedChannels(home);
  const configuredCount = Object.values(current.channels).filter((channel) => channel?.enabled).length;
  if (!io.isInteractive) {
    if (requireEnabled && configuredCount === 0) {
      throw new Error("First-run setup requires at least one enabled ingress channel; run `friday setup` interactively to configure one");
    }
    // A non-interactive invocation can validate pre-provisioned channel state but
    // cannot safely collect credentials or access policy. Never fall through to
    // the interactive channel editor just because force=true.
    return;
  }
  // An explicitly non-forced first run may rely on a channel that was securely
  // pre-provisioned before onboarding. The invariant is "at least one enabled
  // ingress", not "force the editor to reopen an already valid channel".
  if (requireEnabled && configuredCount > 0 && force !== true) return;
  if (!requireEnabled && force !== true && !await askConfirm(io, configuredCount ? "Manage channels now?" : "Configure an ingress channel now?", false)) return;
  const vaultModule = await import("@friday/vault");
  const environment: NodeJS.ProcessEnv = { ...process.env, FRIDAY_HOME: home };
  const vault = new vaultModule.VaultStore({ stateDir: vaultModule.getVaultStateDir(environment), workspaceRoot: process.cwd() });

  for (;;) {
    const state = await readSavedChannels(home);
    let selectedId: ConfigurableChannelId | undefined;
    if (io.select) {
      const selected = await io.select({
        message: "Ingress channels",
        searchable: false,
        maxItems: 10,
        choices: [
          ...CHANNELS.map((item) => {
            const config = state.channels[item.id];
            const status = config?.enabled ? "enabled" : config ? "disabled" : "not configured";
            return { value: item.id, label: item.label, hint: status };
          }),
          { value: "__done__", label: "Done", hint: "return to setup" },
        ],
      });
      if (selected === "__done__") {
        const enabled = Object.values((await readSavedChannels(home)).channels).filter((channel) => channel?.enabled).length;
        if (requireEnabled && enabled === 0) {
          if (io.warning) io.warning("At least one ingress channel must be enabled before setup can finish.");
          else io.write("At least one ingress channel must be enabled before setup can finish.\n");
          continue;
        }
        break;
      }
      selectedId = selected as ConfigurableChannelId;
    } else {
      io.write("\nChannels\n  0. Done\n");
      CHANNELS.forEach((item, index) => {
        const config = state.channels[item.id];
        const status = config?.enabled ? "enabled" : config ? "disabled" : "not configured";
        io.write(`  ${index + 1}. ${item.label} — ${status}\n`);
      });
      const raw = (await io.question("Select a channel to configure [0]: ")).trim() || "0";
      const index = Number(raw);
      if (index === 0) {
        const enabled = Object.values((await readSavedChannels(home)).channels).filter((channel) => channel?.enabled).length;
        if (requireEnabled && enabled === 0) {
          io.write("At least one ingress channel must be enabled before setup can finish.\n");
          continue;
        }
        break;
      }
      if (!Number.isInteger(index) || index < 1 || index > CHANNELS.length) throw new Error("invalid channel selection");
      selectedId = CHANNELS[index - 1]!.id;
    }
    if (!selectedId) throw new Error("invalid channel selection");
    const next = await configureOne(selectedId, io, home, vault, state.channels[selectedId]);
    await updateSavedChannel(selectedId, next, home);
  }
  const enabled = Object.values((await readSavedChannels(home)).channels).filter((channel) => channel?.enabled).length;
  if (requireEnabled && enabled === 0) throw new Error("At least one ingress channel must be enabled before setup can finish");
  io.write("Channel configuration complete. Network identities still require a trusted Permissions identity before privileged actions are allowed.\n");
}
