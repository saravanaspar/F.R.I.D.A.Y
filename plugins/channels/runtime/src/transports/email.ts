import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { reportOperationalError, reportUnlessExpectedAbort } from "@friday/operational-errors";
import type {
  ChannelInboundHandler,
  ChannelPrincipal,
  ChannelSendResult,
  ChannelTarget,
  ChannelTransport,
  ChannelTransportStatus,
} from "../types.js";
import {
  channelPrincipalAllowed,
  delay,
  withSecretText,
  type ChannelAccessPolicy,
  type SecretConsumer,
} from "./shared.js";
import { accountStatePath, readPrivateJson, writePrivateJson } from "../state.js";

export interface EmailChannelConfig extends ChannelAccessPolicy {
  readonly accountId?: string | undefined;
  readonly address: string;
  readonly passwordRef: string;
  readonly imapHost: string;
  readonly imapPort?: number | undefined;
  readonly imapTls?: boolean | undefined;
  readonly mailbox?: string | undefined;
  readonly smtpHost: string;
  readonly smtpPort?: number | undefined;
  readonly smtpTls?: "ssl" | "starttls" | "plain" | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly pythonPath?: string | undefined;
  readonly bridgePath?: string | undefined;
  readonly replySubject?: string | undefined;
}

interface EmailBridgeMessage {
  uid?: number;
  messageId?: string;
  threadId?: string;
  inReplyTo?: string | null;
  fromAddress?: string;
  fromName?: string | null;
  subject?: string;
  date?: string;
  text?: string;
  attachments?: Array<{ externalId?: string; fileName?: string; mimeType?: string; sizeBytes?: number }>;
}

interface EmailBridgeResponse {
  ok?: boolean;
  maxUid?: number;
  uidValidity?: string;
  messageId?: string;
  messages?: EmailBridgeMessage[];
}

interface EmailBridgeRequest extends Record<string, unknown> {
  command: "status" | "poll" | "send";
  password: string;
}

export interface EmailTransportDependencies {
  readonly runBridge?: ((request: EmailBridgeRequest) => Promise<EmailBridgeResponse>) | undefined;
}

function defaultBridgePath(): string {
  const bundled = process.env.FRIDAY_BUNDLED_ROOT?.trim();
  if (bundled) return join(bundled, "channels", "email", "email_bridge.py");
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "bridge", "email", "email_bridge.py");
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export class EmailChannelTransport implements ChannelTransport {
  readonly channel = "email" as const;
  readonly accountId: string;
  readonly #config: EmailChannelConfig;
  readonly #secrets: SecretConsumer;
  readonly #runBridge: (request: EmailBridgeRequest) => Promise<EmailBridgeResponse>;
  readonly #pollIntervalMs: number;
  #handler: ChannelInboundHandler | undefined;
  #controller: AbortController | undefined;
  #pollPromise: Promise<void> | undefined;
  #state: ChannelTransportStatus["state"] = "stopped";
  #detail: string | undefined;
  #lastUid = 0;
  #uidValidity: string | undefined;
  readonly #checkpointPath: string;
  readonly #mailboxFingerprint: string;

  constructor(config: EmailChannelConfig, secrets: SecretConsumer, dependencies: EmailTransportDependencies = {}) {
    this.#config = config;
    this.#secrets = secrets;
    this.accountId = config.accountId?.trim() || "default";
    if (!normalizeEmail(config.address) || !config.address.includes("@")) throw new Error("Email address is invalid");
    if (!config.imapHost.trim() || !config.smtpHost.trim()) throw new Error("Email IMAP and SMTP hosts are required");
    this.#pollIntervalMs = Math.max(100, Math.min(300_000, config.pollIntervalMs ?? 15_000));
    this.#runBridge = dependencies.runBridge ?? ((request) => this.#spawnBridge(request));
    this.#checkpointPath = accountStatePath("email", this.accountId, "uid.v2.json");
    this.#mailboxFingerprint = createHash("sha256").update(JSON.stringify({ address: normalizeEmail(config.address), imapHost: config.imapHost.trim().toLowerCase(), imapPort: config.imapPort ?? 993, imapTls: config.imapTls !== false, mailbox: config.mailbox?.trim() || "INBOX" })).digest("hex");
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    if (this.#state === "running" || this.#state === "starting") return;
    this.#state = "starting";
    this.#detail = undefined;
    this.#handler = handler;
    const status = await this.#bridge("status", {});
    if (status.ok !== true) {
      this.#state = "error";
      throw new Error("Email IMAP startup check failed");
    }
    const statusMaxUid = status.maxUid;
    if (typeof status.uidValidity !== "string" || !/^\d+$/.test(status.uidValidity) || typeof statusMaxUid !== "number" || !Number.isSafeInteger(statusMaxUid) || statusMaxUid < 0) {
      this.#state = "error";
      throw new Error("Email IMAP startup status is missing a valid UIDVALIDITY/maxUid");
    }
    let checkpoint: { uidValidity: string; lastUid: number; fingerprint: string } | undefined;
    try { checkpoint = this.#readCheckpoint(); }
    catch (error) { reportOperationalError({ component: "channels.email", operation: "load UID checkpoint", error, severity: "warn" }); }
    if (status.uidValidity && checkpoint && checkpoint.uidValidity === status.uidValidity && checkpoint.fingerprint === this.#mailboxFingerprint) {
      this.#uidValidity = checkpoint.uidValidity;
      this.#lastUid = checkpoint.lastUid;
    } else {
      this.#uidValidity = status.uidValidity;
      this.#lastUid = statusMaxUid;
      if (this.#uidValidity) this.#writeCheckpoint();
    }
    this.#controller = new AbortController();
    this.#state = "running";
    this.#pollPromise = this.#poll(this.#controller.signal).catch((error: unknown) => {
      reportUnlessExpectedAbort({ component: "channels.email", operation: "polling loop terminated", error }, this.#controller?.signal);
      if (this.#state !== "stopped") {
        this.#state = "error";
        this.#detail = "Email polling stopped";
      }
    });
  }

  async stop(): Promise<void> {
    this.#state = "stopped";
    this.#controller?.abort();
    await this.#pollPromise?.catch((error: unknown) => {
      reportUnlessExpectedAbort({ component: "channels.email", operation: "stop polling", error }, this.#controller?.signal);
    });
    this.#controller = undefined;
    this.#pollPromise = undefined;
    this.#handler = undefined;
    this.#detail = undefined;
  }

  status(): ChannelTransportStatus {
    return Object.freeze({ channel: this.channel, accountId: this.accountId, state: this.#state, ...(this.#detail === undefined ? {} : { detail: this.#detail }) });
  }

  async send(target: ChannelTarget, text: string): Promise<ChannelSendResult> {
    const result = await this.#bridge("send", {
      to: normalizeEmail(target.conversationId),
      text,
      subject: this.#config.replySubject?.trim() || "FRIDAY",
      ...(target.threadId === undefined ? {} : { inReplyTo: target.threadId }),
    });
    if (result.ok !== true) throw new Error("Email send failed");
    return Object.freeze({
      channel: this.channel,
      accountId: this.accountId,
      conversationId: target.conversationId,
      messageIds: Object.freeze(result.messageId ? [result.messageId] : []),
    });
  }

  async #poll(signal: AbortSignal): Promise<void> {
    let backoff = this.#pollIntervalMs;
    while (!signal.aborted) {
      try {
        await delay(this.#pollIntervalMs, signal);
        const result = await this.#bridge("poll", { afterUid: this.#lastUid, maxMessages: 8, maxMessageBytes: 5 * 1024 * 1024 });
        if (result.ok !== true) throw new Error("Email poll failed");
        if (typeof result.uidValidity !== "string" || !/^\d+$/.test(result.uidValidity) || typeof result.maxUid !== "number" || !Number.isSafeInteger(result.maxUid) || result.maxUid < 0) {
          throw new Error("Email poll status is missing a valid UIDVALIDITY/maxUid");
        }
        if (result.uidValidity !== this.#uidValidity) {
          // UID namespaces are mailbox-specific. Rewind once when a mailbox is
          // recreated so messages in the new namespace cannot be skipped.
          this.#uidValidity = result.uidValidity;
          this.#lastUid = 0;
          this.#writeCheckpoint();
          continue;
        }
        // Advance the IMAP checkpoint only after every returned message has been
        // durably admitted (or intentionally filtered) by the channel handler. If
        // admission fails, retain the previous UID so IMAP redelivers the batch.
        for (const message of result.messages ?? []) await this.#handle(message);
        this.#lastUid = Math.max(this.#lastUid, result.maxUid);
        this.#writeCheckpoint();
        backoff = this.#pollIntervalMs;
      } catch (error) {
        if (signal.aborted) return;
        reportOperationalError({ component: "channels.email", operation: "poll mailbox", error });
        await delay(backoff, signal).catch((delayError: unknown) => {
          reportUnlessExpectedAbort({ component: "channels.email", operation: "poll retry delay", error: delayError }, signal);
        });
        backoff = Math.min(60_000, Math.max(this.#pollIntervalMs, backoff * 2));
      }
    }
  }

  async #handle(message: EmailBridgeMessage): Promise<void> {
    if (!this.#handler || !message.messageId || !message.fromAddress) return;
    const sender = normalizeEmail(message.fromAddress);
    if (!sender || sender === normalizeEmail(this.#config.address)) return;
    const principal: ChannelPrincipal = {
      channel: this.channel,
      accountId: this.accountId,
      conversationId: sender,
      senderId: sender,
      ...(message.threadId ? { threadId: message.threadId } : {}),
    };
    const type = message.threadId && message.threadId !== message.messageId ? "thread" as const : "dm" as const;
    if (!channelPrincipalAllowed(principal, type, this.#config)) return;
    const hasUnsupportedAttachment = (message.attachments?.length ?? 0) > 0;
    const text = [message.text?.trim(), hasUnsupportedAttachment ? "[attachment received; email media retrieval is not enabled]" : ""].filter(Boolean).join("\n");
    if (!text) return;
    const parsedDate = Date.parse(message.date ?? "");
    await this.#handler({
      id: message.messageId,
      principal,
      chatType: type,
      text,
      timestamp: Number.isFinite(parsedDate) ? parsedDate : Date.now(),
      ...(message.fromName ? { senderName: message.fromName } : {}),
      ...(message.subject ? { conversationName: message.subject } : {}),
      ...(message.inReplyTo ? { replyToMessageId: message.inReplyTo } : {}),
      attachments: Object.freeze([]),
    });
  }

  #readCheckpoint(): { uidValidity: string; lastUid: number; fingerprint: string } | undefined {
    const parsed = readPrivateJson<{ uidValidity?: unknown; lastUid?: unknown; fingerprint?: unknown }>(this.#checkpointPath, 16 * 1024);
    if (!parsed) return undefined;
    const lastUid = typeof parsed.lastUid === "number" ? parsed.lastUid : -1;
    if (!Number.isSafeInteger(lastUid) || lastUid < 0 || typeof parsed.uidValidity !== "string" || !/^\d+$/.test(parsed.uidValidity) || typeof parsed.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(parsed.fingerprint)) throw new Error("Email UID checkpoint is malformed");
    return { uidValidity: parsed.uidValidity, lastUid, fingerprint: parsed.fingerprint };
  }

  #writeCheckpoint(): void {
    if (!this.#uidValidity) return;
    writePrivateJson(this.#checkpointPath, { uidValidity: this.#uidValidity, lastUid: this.#lastUid, fingerprint: this.#mailboxFingerprint }, 16 * 1024);
  }

  async #bridge(command: EmailBridgeRequest["command"], extra: Record<string, unknown>): Promise<EmailBridgeResponse> {
    return await withSecretText(this.#secrets, this.#config.passwordRef, async (password) => this.#runBridge({
      command,
      password,
      address: this.#config.address,
      imapHost: this.#config.imapHost,
      imapPort: this.#config.imapPort ?? 993,
      imapTls: this.#config.imapTls ?? true,
      mailbox: this.#config.mailbox ?? "INBOX",
      smtpHost: this.#config.smtpHost,
      smtpPort: this.#config.smtpPort ?? 587,
      smtpTls: this.#config.smtpTls ?? "starttls",
      ...extra,
    }));
  }

  async #spawnBridge(request: EmailBridgeRequest): Promise<EmailBridgeResponse> {
    const bridge = this.#config.bridgePath ?? defaultBridgePath();
    if (!existsSync(bridge)) throw new Error("Email bridge source is missing");
    const python = this.#config.pythonPath?.trim() || "python3";
    return await new Promise<EmailBridgeResponse>((resolve, reject) => {
      const child = spawn(python, [bridge], {
        stdio: ["pipe", "pipe", "pipe"],
        env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TMPDIR"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Email bridge timed out"));
      }, 35_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill("SIGKILL"); });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-65_536); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (stderr.trim()) {
          reportOperationalError({
            component: "channels.email",
            operation: "email bridge stderr",
            error: new Error(stderr.trim().slice(0, 2_048)),
            severity: code === 0 ? "warn" : "error",
          });
        }
        try {
          const payload = JSON.parse(stdout.trim() || "{}") as EmailBridgeResponse;
          if (code !== 0 || payload.ok !== true) reject(new Error("Email bridge operation failed"));
          else resolve(payload);
        } catch (error) {
          reject(new Error("Email bridge returned invalid JSON", { cause: error }));
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}
