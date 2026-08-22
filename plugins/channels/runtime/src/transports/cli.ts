import type {
  ChannelInboundHandler,
  ChannelSendResult,
  ChannelTarget,
  ChannelTransport,
  ChannelTransportStatus,
} from "../types.js";

/**
 * Host-local output transport.
 *
 * Runtime FRIDAY intentionally does not consume stdin as conversational ingress.
 * `friday` is a foreground daemon/log process; interactive local administration
 * belongs to `friday setup`. Tests and trusted host code may still inject local
 * turns explicitly through ingest()/ChannelsTrustedService.ingestLocal().
 */
export class CliChannelTransport implements ChannelTransport {
  readonly channel = "cli" as const;
  readonly accountId: string;
  #state: ChannelTransportStatus["state"] = "stopped";
  #handler: ChannelInboundHandler | undefined;
  readonly #write: (text: string) => void;

  constructor(
    accountId = "local",
    write: (text: string) => void = (text) => process.stdout.write(text),
    _interactive = false,
  ) {
    this.accountId = accountId;
    this.#write = write;
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    this.#handler = handler;
    this.#state = "running";
  }

  async stop(): Promise<void> {
    this.#handler = undefined;
    this.#state = "stopped";
  }

  setInputPrivacy(_privacy: "normal" | "secret"): void {
    // There is no stdin reader in runtime mode. Protected input is handled by
    // the actual originating channel or by the standalone setup UI.
  }

  async ingest(text: string, options: { conversationId?: string; senderId?: string; threadId?: string } = {}): Promise<void> {
    if (!this.#handler) throw new Error("CLI channel is not running");
    await this.#handler({
      id: `cli-${Date.now()}`,
      principal: {
        channel: "cli",
        accountId: this.accountId,
        conversationId: options.conversationId ?? "terminal",
        senderId: options.senderId ?? "local-user",
        ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      },
      chatType: options.threadId ? "thread" : "dm",
      text,
      timestamp: Date.now(),
      attachments: [],
    });
  }

  async send(target: ChannelTarget, text: string): Promise<ChannelSendResult> {
    this.#write(`${text}\n`);
    return Object.freeze({
      channel: this.channel,
      accountId: this.accountId,
      conversationId: target.conversationId,
      messageIds: Object.freeze([`cli-${Date.now()}`]),
    });
  }

  status(): ChannelTransportStatus {
    return Object.freeze({ channel: this.channel, accountId: this.accountId, state: this.#state });
  }
}
