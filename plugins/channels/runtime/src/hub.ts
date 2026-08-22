import { randomUUID } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import type {
  ChannelApprovalRequest,
  ChannelCancellationHandle,
  ChannelCancellationRequest,
  ChannelAttachment,
  ChannelHubOptions,
  ChannelInboundMessage,
  ChannelPrincipal,
  ChannelSendResult,
  ChannelTarget,
  ChannelTransport,
  ChannelTransportStatus,
  CredentialCaptureRequest,
  CredentialCaptureCompletion,
  PendingChannelApproval,
  PendingChannelCancellation,
  PendingChannelPrompt,
  ChannelPromptRequest,
  PendingCredentialCapture,
  RawChannelInboundMessage,
} from "./types.js";
import { sanitizeChannelText, sanitizeDisplayText } from "./sanitization.js";

const DEFAULT_CAPTURE_TTL_MS = 5 * 60_000;
const MAX_CAPTURE_TTL_MS = 15 * 60_000;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
const MAX_APPROVAL_TTL_MS = 15 * 60_000;
const DEFAULT_PROMPT_TTL_MS = 5 * 60_000;
const MAX_PROMPT_TTL_MS = 15 * 60_000;
const DEFAULT_CANCELLATION_TTL_MS = 60 * 60_000;
const MAX_CANCELLATION_TTL_MS = 24 * 60 * 60_000;
const MAX_SECRET_BYTES = 64 * 1024;

type Listener = (message: ChannelInboundMessage) => void | Promise<void>;

type PendingCredentialInternal = {
  readonly public: PendingCredentialCapture;
  readonly validateSecret?: CredentialCaptureRequest["validateSecret"];
  readonly successMessage?: string | undefined;
  readonly failureMessage?: string | undefined;
  readonly waiters: Set<(completion: CredentialCaptureCompletion) => void>;
  readonly timer: NodeJS.Timeout;
};

type PendingApprovalInternal = {
  readonly public: PendingChannelApproval;
  readonly resolve: (approved: boolean) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
};

type PendingPromptInternal = {
  readonly public: PendingChannelPrompt;
  readonly allowEmpty: boolean;
  readonly maxLength: number;
  readonly resolve: (value: string) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
};

type PendingCancellationInternal = {
  readonly public: PendingChannelCancellation;
  readonly controller: AbortController;
  readonly timer: NodeJS.Timeout;
};

function bounded(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function principalKey(principal: ChannelPrincipal): string {
  return JSON.stringify([
    bounded(principal.channel, "channel", 64),
    bounded(principal.accountId, "accountId", 128),
    bounded(principal.conversationId, "conversationId", 256),
    bounded(principal.senderId, "senderId", 256),
    principal.threadId?.trim() ?? "",
  ]);
}

function targetKey(target: Pick<ChannelTarget, "channel" | "accountId">): string {
  return `${target.channel}\u0000${target.accountId}`;
}

function targetFromPrincipal(principal: ChannelPrincipal): ChannelTarget {
  return Object.freeze({
    channel: principal.channel,
    accountId: principal.accountId,
    conversationId: principal.conversationId,
    ...(principal.threadId === undefined ? {} : { threadId: principal.threadId }),
  });
}

function clonePrincipal(principal: ChannelPrincipal): ChannelPrincipal {
  return Object.freeze({
    channel: principal.channel,
    accountId: principal.accountId,
    conversationId: principal.conversationId,
    senderId: principal.senderId,
    ...(principal.threadId === undefined ? {} : { threadId: principal.threadId }),
  });
}

function cloneAttachment(attachment: ChannelAttachment): ChannelAttachment {
  const externalId = bounded(sanitizeDisplayText(attachment.externalId) ?? "", "attachment external id", 256);
  const mimeType = attachment.mimeType === undefined ? undefined : sanitizeDisplayText(attachment.mimeType)?.slice(0, 128);
  const fileName = attachment.fileName === undefined ? undefined : sanitizeDisplayText(attachment.fileName);
  const sizeBytes = attachment.sizeBytes === undefined || !Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes < 0
    ? undefined
    : attachment.sizeBytes;
  const downloadUrl = attachment.downloadUrl === undefined ? undefined : sanitizeDisplayText(attachment.downloadUrl)?.slice(0, 4_096);
  return Object.freeze({
    kind: attachment.kind,
    externalId,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(fileName === undefined ? {} : { fileName }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(downloadUrl === undefined ? {} : { downloadUrl }),
  });
}

function approvalCode(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
}

function cancellationResponse(text: string, code: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  const expected = code.toLowerCase();
  return normalized === `cancel ${expected}`;
}

function approvalResponse(text: string, code: string): boolean | undefined {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  const expected = code.toLowerCase();
  if (normalized === `approve ${expected}`) return true;
  if (normalized === `deny ${expected}`) return false;
  return undefined;
}

function strictOpaqueToken(raw: string): string {
  if (!raw || raw !== raw.trim()) throw new Error("credential value must contain only the token");
  if (/\s/.test(raw)) throw new Error("credential token must not contain whitespace or surrounding prose");
  if (/^(?:api[-_ ]?key|token|secret|credential|password|endpoint)\s*[:=]/i.test(raw)) {
    throw new Error("credential token must not include a field label");
  }
  return raw;
}

function marker(raw: RawChannelInboundMessage, input: {
  text: string;
  classification: ChannelInboundMessage["classification"];
  credential?: ChannelInboundMessage["credential"];
  approval?: ChannelInboundMessage["approval"];
  prompt?: ChannelInboundMessage["prompt"];
  cancellation?: ChannelInboundMessage["cancellation"];
}): ChannelInboundMessage {
  return Object.freeze({
    id: bounded(raw.id, "message id", 256),
    principal: clonePrincipal(raw.principal),
    chatType: raw.chatType,
    text: input.text,
    timestamp: raw.timestamp,
    ...(raw.senderName === undefined ? {} : { senderName: sanitizeDisplayText(raw.senderName) }),
    ...(raw.conversationName === undefined ? {} : { conversationName: sanitizeDisplayText(raw.conversationName) }),
    ...(raw.replyToMessageId === undefined ? {} : { replyToMessageId: bounded(raw.replyToMessageId, "replyToMessageId", 256) }),
    attachments: Object.freeze([]),
    classification: input.classification,
    redactionCount: 0,
    ...(input.credential === undefined ? {} : { credential: input.credential }),
    ...(input.approval === undefined ? {} : { approval: input.approval }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.cancellation === undefined ? {} : { cancellation: input.cancellation }),
  });
}

export class ChannelHub {
  readonly #vault: ChannelHubOptions["credentialVault"];
  readonly #now: () => number;
  readonly #onError: (message: string, error?: unknown) => void;
  readonly #transports = new Map<string, ChannelTransport>();
  readonly #listeners = new Set<Listener>();
  readonly #admissionListeners = new Set<Listener>();
  readonly #pendingCaptures = new Map<string, PendingCredentialInternal>();
  readonly #pendingApprovals = new Map<string, PendingApprovalInternal>();
  readonly #pendingPrompts = new Map<string, PendingPromptInternal>();
  readonly #pendingCancellations = new Map<string, PendingCancellationInternal>();

  constructor(options: ChannelHubOptions) {
    this.#vault = options.credentialVault;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((message, error = new Error(message)) => {
      reportOperationalError({ component: "channels", operation: message, error });
    });
  }

  registerTransport(transport: ChannelTransport): void {
    const key = targetKey(transport);
    if (this.#transports.has(key)) {
      throw new Error(`Channel transport already registered: ${transport.channel}/${transport.accountId}`);
    }
    this.#transports.set(key, transport);
  }

  list(): readonly ChannelTransportStatus[] {
    return Object.freeze(
      [...this.#transports.values()]
        .map((transport) => Object.freeze({ ...transport.status() }))
        .sort((a, b) => `${a.channel}/${a.accountId}`.localeCompare(`${b.channel}/${b.accountId}`)),
    );
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Register a fail-closed ingress admission hook. Unlike ordinary observers,
   * failures propagate to the transport so provider acknowledgement is withheld.
   * This is intentionally host-internal and is not exposed through ChannelsService.
   */
  subscribeAdmission(listener: Listener): () => void {
    this.#admissionListeners.add(listener);
    return () => this.#admissionListeners.delete(listener);
  }

  async startAll(): Promise<void> {
    // A single unavailable provider must not take down FRIDAY or prevent healthy
    // channels from starting. Each transport records its own error state; the hub
    // reports failures and remains operational so the user can repair/reconfigure it.
    const transports = [...this.#transports.values()];
    const results = await Promise.allSettled(transports.map((transport) =>
      transport.start(async (message) => { await this.ingest(message); }),
    ));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      if (result.status === "fulfilled") continue;
      const transport = transports[index]!;
      this.#onError(`start ${transport.channel}/${transport.accountId}`, result.reason);
    }
  }

  async stopAll(): Promise<void> {
    for (const capture of this.#pendingCaptures.values()) {
      clearTimeout(capture.timer);
      this.#setInputPrivacy(capture.public.principal, "normal");
      for (const resolve of capture.waiters) resolve({ requestId: capture.public.id, status: "cancelled" });
    }
    this.#pendingCaptures.clear();
    for (const approval of this.#pendingApprovals.values()) {
      clearTimeout(approval.timer);
      approval.resolve(false);
    }
    this.#pendingApprovals.clear();
    for (const prompt of this.#pendingPrompts.values()) {
      clearTimeout(prompt.timer);
      prompt.reject(new Error("Channel stopped before protected prompt completed"));
    }
    this.#pendingPrompts.clear();
    for (const cancellation of this.#pendingCancellations.values()) {
      clearTimeout(cancellation.timer);
      cancellation.controller.abort(new Error("Channel stopped while operation was active"));
    }
    this.#pendingCancellations.clear();
    const results = await Promise.allSettled([...this.#transports.values()].map((transport) => transport.stop()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  requestCredentialCapture(request: CredentialCaptureRequest): PendingCredentialCapture {
    this.#purgeExpiredCaptures();
    const key = principalKey(request.principal);
    if (this.#pendingCaptures.has(key) || this.#pendingApprovals.has(key) || this.#pendingPrompts.has(key)) {
      throw new Error("Another protected interaction is already pending for this channel principal");
    }

    const ref = this.#vault.normalizeRef(request.ref);
    const kind = bounded(request.kind, "credential kind", 64);
    const exists = this.#vault.exists(ref);
    if (request.mode === "create" && exists) {
      throw new Error("Credential already exists; request an explicit rotation instead");
    }
    if (request.mode === "rotate" && !exists) {
      throw new Error("Credential does not exist; request an explicit create instead");
    }

    const ttlMs = request.ttlMs ?? DEFAULT_CAPTURE_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_CAPTURE_TTL_MS) {
      throw new Error(`Credential capture ttlMs must be between 1000 and ${MAX_CAPTURE_TTL_MS}`);
    }

    const now = this.#now();
    const pending: PendingCredentialCapture = Object.freeze({
      id: randomUUID(),
      principal: clonePrincipal(request.principal),
      ref,
      kind,
      mode: request.mode,
      label: bounded(sanitizeDisplayText(request.label ?? ref) ?? ref, "credential label", 160),
      inputMode: request.inputMode ?? "text",
      createdAt: now,
      expiresAt: now + ttlMs,
    });
    const waiters = new Set<(completion: CredentialCaptureCompletion) => void>();
    const timer = setTimeout(() => {
      const active = this.#pendingCaptures.get(key);
      if (active?.public.id !== pending.id) return;
      this.#pendingCaptures.delete(key);
      this.#setInputPrivacy(pending.principal, "normal");
      for (const resolve of active.waiters) resolve({ requestId: pending.id, status: "expired" });
      void this.send(targetFromPrincipal(pending.principal), `Credential capture for ${pending.label} expired.`).catch((error: unknown) => {
        this.#onError("deliver credential-capture expiry", error);
      });
    }, ttlMs);
    timer.unref?.();
    this.#pendingCaptures.set(key, Object.freeze({
      public: pending,
      ...(request.validateSecret === undefined ? {} : { validateSecret: request.validateSecret }),
      ...(request.successMessage === undefined ? {} : { successMessage: request.successMessage }),
      ...(request.failureMessage === undefined ? {} : { failureMessage: request.failureMessage }),
      waiters,
      timer,
    }));
    this.#setInputPrivacy(pending.principal, "secret");
    return pending;
  }

  waitForCredentialCapture(requestId: string): Promise<CredentialCaptureCompletion> {
    this.#purgeExpiredCaptures();
    for (const capture of this.#pendingCaptures.values()) {
      if (capture.public.id !== requestId) continue;
      return new Promise<CredentialCaptureCompletion>((resolve) => capture.waiters.add(resolve));
    }
    throw new Error(`Unknown or completed credential capture: ${requestId}`);
  }

  cancelCredentialCapture(requestId: string): boolean {
    this.#purgeExpiredCaptures();
    for (const [key, capture] of this.#pendingCaptures) {
      if (capture.public.id === requestId) {
        clearTimeout(capture.timer);
        this.#pendingCaptures.delete(key);
        this.#setInputPrivacy(capture.public.principal, "normal");
        for (const resolve of capture.waiters) resolve({ requestId, status: "cancelled" });
        return true;
      }
    }
    return false;
  }

  pendingCredentialCaptures(): readonly PendingCredentialCapture[] {
    this.#purgeExpiredCaptures();
    return Object.freeze([...this.#pendingCaptures.values()].map((entry) => Object.freeze({
      ...entry.public,
      principal: clonePrincipal(entry.public.principal),
    })));
  }

  async requestApproval(request: ChannelApprovalRequest): Promise<boolean> {
    this.#purgeExpiredApprovals();
    const key = principalKey(request.principal);
    if (this.#pendingApprovals.has(key) || this.#pendingCaptures.has(key) || this.#pendingPrompts.has(key)) {
      throw new Error("Another protected interaction is already pending for this channel principal");
    }
    const ttlMs = request.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_APPROVAL_TTL_MS) {
      throw new Error(`Channel approval ttlMs must be between 1000 and ${MAX_APPROVAL_TTL_MS}`);
    }
    const now = this.#now();
    const pending: PendingChannelApproval = Object.freeze({
      id: randomUUID(),
      code: approvalCode(),
      principal: clonePrincipal(request.principal),
      actionId: bounded(sanitizeDisplayText(request.actionId) ?? "", "approval action id", 128),
      effect: bounded(sanitizeDisplayText(request.effect) ?? "", "approval effect", 64),
      resource: bounded(sanitizeDisplayText(request.resource) ?? "", "approval resource", 512),
      reason: bounded(sanitizeDisplayText(request.reason) ?? "", "approval reason", 512),
      network: request.network === true,
      createdAt: now,
      expiresAt: now + ttlMs,
    });

    let resolvePromise!: (approved: boolean) => void;
    let rejectPromise!: (error: unknown) => void;
    const result = new Promise<boolean>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      const active = this.#pendingApprovals.get(key);
      if (active?.public.id !== pending.id) return;
      this.#pendingApprovals.delete(key);
      active.resolve(false);
      void this.send(targetFromPrincipal(pending.principal), `Approval ${pending.code} expired.`).catch((error: unknown) => {
        this.#onError("deliver approval expiry", error);
      });
    }, ttlMs);
    timer.unref?.();
    this.#pendingApprovals.set(key, { public: pending, resolve: resolvePromise, reject: rejectPromise, timer });

    try {
      await this.send(targetFromPrincipal(request.principal), [
        `FRIDAY approval ${pending.code} required`,
        `Action: ${pending.actionId}`,
        `Effect: ${pending.effect}`,
        `Resource: ${pending.resource}`,
        `Reason: ${pending.reason}`,
        ...(pending.network ? ["Network: requested"] : []),
        "",
        `Reply: approve ${pending.code}`,
        `or: deny ${pending.code}`,
      ].join("\n"));
    } catch (error) {
      const active = this.#pendingApprovals.get(key);
      if (active?.public.id === pending.id) {
        clearTimeout(active.timer);
        this.#pendingApprovals.delete(key);
        active.reject(error);
      }
    }
    return result;
  }

  cancelApproval(requestId: string): boolean {
    this.#purgeExpiredApprovals();
    for (const [key, approval] of this.#pendingApprovals) {
      if (approval.public.id === requestId) {
        clearTimeout(approval.timer);
        this.#pendingApprovals.delete(key);
        approval.resolve(false);
        return true;
      }
    }
    return false;
  }

  pendingApprovals(): readonly PendingChannelApproval[] {
    this.#purgeExpiredApprovals();
    return Object.freeze([...this.#pendingApprovals.values()].map((entry) => Object.freeze({
      ...entry.public,
      principal: clonePrincipal(entry.public.principal),
    })));
  }

  async requestPrompt(request: ChannelPromptRequest): Promise<string> {
    this.#purgeExpiredPrompts();
    const key = principalKey(request.principal);
    if (this.#pendingApprovals.has(key) || this.#pendingCaptures.has(key) || this.#pendingPrompts.has(key)) {
      throw new Error("Another protected interaction is already pending for this channel principal");
    }
    const ttlMs = request.ttlMs ?? DEFAULT_PROMPT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_PROMPT_TTL_MS) {
      throw new Error(`Channel prompt ttlMs must be between 1000 and ${MAX_PROMPT_TTL_MS}`);
    }
    const maxLength = request.maxLength ?? 8_192;
    if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 32_000) {
      throw new Error("Channel prompt maxLength must be between 1 and 32000");
    }
    const now = this.#now();
    const pending: PendingChannelPrompt = Object.freeze({
      id: randomUUID(),
      principal: clonePrincipal(request.principal),
      message: bounded(sanitizeDisplayText(request.message) ?? "", "prompt message", 2_000),
      createdAt: now,
      expiresAt: now + ttlMs,
    });
    let resolvePromise!: (value: string) => void;
    let rejectPromise!: (error: unknown) => void;
    const result = new Promise<string>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const timer = setTimeout(() => {
      const active = this.#pendingPrompts.get(key);
      if (active?.public.id !== pending.id) return;
      this.#pendingPrompts.delete(key);
      active.reject(new Error("Channel prompt expired"));
      void this.send(targetFromPrincipal(pending.principal), "That input request expired.").catch((error: unknown) => {
        this.#onError("deliver protected-input expiry", error);
      });
    }, ttlMs);
    timer.unref?.();
    this.#pendingPrompts.set(key, { public: pending, allowEmpty: request.allowEmpty === true, maxLength, resolve: resolvePromise, reject: rejectPromise, timer });
    try {
      await this.send(targetFromPrincipal(request.principal), [
        pending.message,
        ...(request.placeholder ? [`Expected: ${sanitizeDisplayText(request.placeholder)?.slice(0, 512) ?? "value"}`] : []),
        "Your next reply is captured directly and will not be sent to the AI router/model.",
      ].join("\n"));
    } catch (error) {
      const active = this.#pendingPrompts.get(key);
      if (active?.public.id === pending.id) {
        clearTimeout(active.timer);
        this.#pendingPrompts.delete(key);
        active.reject(error);
      }
    }
    return result;
  }

  cancelPrompt(requestId: string): boolean {
    this.#purgeExpiredPrompts();
    for (const [key, prompt] of this.#pendingPrompts) {
      if (prompt.public.id !== requestId) continue;
      clearTimeout(prompt.timer);
      this.#pendingPrompts.delete(key);
      prompt.reject(new Error("Channel prompt cancelled"));
      return true;
    }
    return false;
  }

  pendingPrompts(): readonly PendingChannelPrompt[] {
    this.#purgeExpiredPrompts();
    return Object.freeze([...this.#pendingPrompts.values()].map((entry) => Object.freeze({ ...entry.public, principal: clonePrincipal(entry.public.principal) })));
  }

  async watchCancellation(request: ChannelCancellationRequest): Promise<ChannelCancellationHandle> {
    this.#purgeExpiredCancellations();
    const key = principalKey(request.principal);
    if (this.#pendingCancellations.has(key)) throw new Error("A cancellable operation is already active for this channel principal");
    const ttlMs = request.ttlMs ?? DEFAULT_CANCELLATION_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_CANCELLATION_TTL_MS) {
      throw new Error(`Channel cancellation ttlMs must be between 1000 and ${MAX_CANCELLATION_TTL_MS}`);
    }
    const now = this.#now();
    const pending: PendingChannelCancellation = Object.freeze({
      id: randomUUID(),
      code: approvalCode(),
      principal: clonePrincipal(request.principal),
      label: bounded(sanitizeDisplayText(request.label) ?? "", "cancellation label", 160),
      createdAt: now,
      expiresAt: now + ttlMs,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const active = this.#pendingCancellations.get(key);
      if (active?.public.id !== pending.id) return;
      this.#pendingCancellations.delete(key);
    }, ttlMs);
    timer.unref?.();
    this.#pendingCancellations.set(key, { public: pending, controller, timer });
    try {
      await this.send(targetFromPrincipal(request.principal), `You can cancel ${pending.label} while it is running by replying: cancel ${pending.code}`);
    } catch (error) {
      const active = this.#pendingCancellations.get(key);
      if (active?.public.id === pending.id) {
        clearTimeout(active.timer);
        this.#pendingCancellations.delete(key);
      }
      throw error;
    }
    return Object.freeze({
      request: pending,
      signal: controller.signal,
      dispose: () => {
        const active = this.#pendingCancellations.get(key);
        if (active?.public.id !== pending.id) return;
        clearTimeout(active.timer);
        this.#pendingCancellations.delete(key);
      },
    });
  }

  async ingest(raw: RawChannelInboundMessage): Promise<ChannelInboundMessage> {
    this.#purgeExpiredCaptures();
    this.#purgeExpiredApprovals();
    this.#purgeExpiredPrompts();
    this.#purgeExpiredCancellations();
    const key = principalKey(raw.principal);
    const approval = this.#pendingApprovals.get(key);
    if (approval) return this.#resolveApproval(raw, key, approval);
    const prompt = this.#pendingPrompts.get(key);
    if (prompt) return this.#resolvePrompt(raw, key, prompt);
    const cancellation = this.#pendingCancellations.get(key);
    if (cancellation && cancellationResponse(raw.text, cancellation.public.code)) {
      clearTimeout(cancellation.timer);
      this.#pendingCancellations.delete(key);
      cancellation.controller.abort(new Error(`${cancellation.public.label} cancelled by user`));
      void this.send(targetFromPrincipal(raw.principal), `${cancellation.public.label} cancellation requested.`).catch((error: unknown) => {
        this.#onError("deliver cancellation acknowledgement", error);
      });
      return marker(raw, {
        text: `[${cancellation.public.label} cancellation requested]`,
        classification: "cancellation-requested",
        cancellation: { requestId: cancellation.public.id, code: cancellation.public.code },
      });
    }

    const capture = this.#pendingCaptures.get(key);
    const attachments = Object.freeze([...(raw.attachments ?? [])].map(cloneAttachment));

    let message: ChannelInboundMessage;
    if (capture) {
      message = await this.#captureCredential(raw, key, capture, attachments);
    } else {
      const sanitized = sanitizeChannelText(raw.text);
      message = Object.freeze({
        id: bounded(raw.id, "message id", 256),
        principal: clonePrincipal(raw.principal),
        chatType: raw.chatType,
        text: sanitized.text,
        timestamp: raw.timestamp,
        ...(raw.senderName === undefined ? {} : { senderName: sanitizeDisplayText(raw.senderName) }),
        ...(raw.conversationName === undefined ? {} : { conversationName: sanitizeDisplayText(raw.conversationName) }),
        ...(raw.replyToMessageId === undefined ? {} : { replyToMessageId: bounded(raw.replyToMessageId, "replyToMessageId", 256) }),
        attachments,
        classification: "message",
        redactionCount: sanitized.redactionCount,
      });
    }

    await this.#publish(message);
    return message;
  }

  async fetchAttachment(
    target: Pick<ChannelTarget, "channel" | "accountId">,
    attachment: ChannelAttachment,
    maxBytes = 25 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) {
      throw new Error("attachment maxBytes must be between 1 and 104857600");
    }
    const transport = this.#transports.get(targetKey(target));
    if (!transport) throw new Error(`No channel transport registered for ${target.channel}/${target.accountId}`);
    if (!transport.fetchAttachment) {
      throw new Error(`Channel transport ${target.channel}/${target.accountId} does not support attachment retrieval`);
    }
    return transport.fetchAttachment(cloneAttachment(attachment), maxBytes);
  }

  async send(target: ChannelTarget, text: string): Promise<ChannelSendResult> {
    const transport = this.#transports.get(targetKey(target));
    if (!transport) {
      throw new Error(`No channel transport registered for ${target.channel}/${target.accountId}`);
    }
    const sanitized = sanitizeChannelText(text);
    return transport.send(target, sanitized.text);
  }

  async #resolveApproval(raw: RawChannelInboundMessage, key: string, approval: PendingApprovalInternal): Promise<ChannelInboundMessage> {
    if ((raw.attachments?.length ?? 0) > 0) {
      return marker(raw, {
        text: `[approval ${approval.public.code} expects a text reply]`,
        classification: "approval-error",
        approval: { requestId: approval.public.id, code: approval.public.code, approved: false },
      });
    }
    const decision = approvalResponse(raw.text, approval.public.code);
    if (decision === undefined) {
      void this.send(targetFromPrincipal(raw.principal), `Reply exactly \"approve ${approval.public.code}\" or \"deny ${approval.public.code}\".`).catch((error: unknown) => {
        this.#onError("deliver approval correction", error);
      });
      return marker(raw, {
        text: `[approval ${approval.public.code} reply was not recognized]`,
        classification: "approval-error",
        approval: { requestId: approval.public.id, code: approval.public.code, approved: false },
      });
    }
    clearTimeout(approval.timer);
    this.#pendingApprovals.delete(key);
    approval.resolve(decision);
    return marker(raw, {
      text: decision ? `[approval ${approval.public.code} approved]` : `[approval ${approval.public.code} denied]`,
      classification: "approval-resolved",
      approval: { requestId: approval.public.id, code: approval.public.code, approved: decision },
    });
  }


  async #resolvePrompt(raw: RawChannelInboundMessage, key: string, prompt: PendingPromptInternal): Promise<ChannelInboundMessage> {
    if ((raw.attachments?.length ?? 0) > 0) {
      void this.send(targetFromPrincipal(raw.principal), "That input expects text only. Please reply again with text.").catch((error: unknown) => {
        this.#onError("deliver protected-input attachment rejection", error);
      });
      return marker(raw, { text: "[protected prompt rejected an attachment]", classification: "prompt-error", prompt: { requestId: prompt.public.id } });
    }
    const value = raw.text.trim();
    if (!prompt.allowEmpty && value.length === 0) {
      void this.send(targetFromPrincipal(raw.principal), "That value cannot be empty. Please reply again.").catch((error: unknown) => {
        this.#onError("deliver protected-input empty-value rejection", error);
      });
      return marker(raw, { text: "[protected prompt rejected an empty value]", classification: "prompt-error", prompt: { requestId: prompt.public.id } });
    }
    if (value.length > prompt.maxLength) {
      void this.send(targetFromPrincipal(raw.principal), `That value is too long. Maximum: ${prompt.maxLength} characters.`).catch((error: unknown) => {
        this.#onError("deliver protected-input size rejection", error);
      });
      return marker(raw, { text: "[protected prompt rejected an oversized value]", classification: "prompt-error", prompt: { requestId: prompt.public.id } });
    }
    clearTimeout(prompt.timer);
    this.#pendingPrompts.delete(key);
    prompt.resolve(value);
    return marker(raw, { text: "[protected prompt reply captured]", classification: "prompt-resolved", prompt: { requestId: prompt.public.id } });
  }

  async #captureCredential(
    raw: RawChannelInboundMessage,
    key: string,
    capture: PendingCredentialInternal,
    attachments: ChannelInboundMessage["attachments"],
  ): Promise<ChannelInboundMessage> {
    const pending = capture.public;
    let classification: ChannelInboundMessage["classification"] = "credential-captured";
    let text = `[credential supplied for ${pending.label}]`;
    let stored = false;

    try {
      if (attachments.length > 0) throw new Error("Credential capture accepts text only");
      const rawSecret = pending.inputMode === "opaque-token" ? strictOpaqueToken(raw.text) : raw.text;
      const secret = Buffer.from(rawSecret, "utf8");
      try {
        if (secret.byteLength === 0) throw new Error("Credential capture received an empty value");
        if (secret.byteLength > MAX_SECRET_BYTES) throw new Error("Credential capture value is too large");
        await capture.validateSecret?.(secret);
        if (pending.mode === "create") {
          this.#vault.create({ ref: pending.ref, kind: pending.kind, secret });
        } else {
          this.#vault.rotate(pending.ref, secret);
        }
        stored = true;
      } finally {
        secret.fill(0);
      }
    } catch (error) {
      this.#onError("capture or validate protected credential", error);
      classification = "credential-capture-error";
      text = `[credential capture failed for ${pending.label}; value was not forwarded]`;
    }

    if (stored) {
      clearTimeout(capture.timer);
      this.#pendingCaptures.delete(key);
      this.#setInputPrivacy(pending.principal, "normal");
      for (const resolve of capture.waiters) resolve({ requestId: pending.id, status: "stored" });
    }
    const userMessage = stored ? capture.successMessage : capture.failureMessage;
    if (userMessage) {
      void this.send(targetFromPrincipal(raw.principal), userMessage).catch((error: unknown) => {
        this.#onError("Credential result notification could not be delivered", error);
      });
    }

    return marker(raw, {
      text,
      classification,
      credential: Object.freeze({
        requestId: pending.id,
        ref: pending.ref,
        kind: pending.kind,
        mode: pending.mode,
      }),
    });
  }

  async #publish(message: ChannelInboundMessage): Promise<void> {
    // Durable admission runs before best-effort observers. If it fails, propagate
    // to the transport so the provider can retry rather than losing the message.
    for (const listener of this.#admissionListeners) await listener(message);

    for (const listener of this.#listeners) {
      try {
        await listener(message);
      } catch (error) {
        this.#onError("A channel subscriber failed while handling a sanitized inbound message", error);
      }
    }
  }

  #setInputPrivacy(principal: ChannelPrincipal, privacy: "normal" | "secret"): void {
    this.#transports.get(targetKey(principal))?.setInputPrivacy?.(privacy);
  }

  #purgeExpiredCaptures(): void {
    const now = this.#now();
    for (const [key, capture] of this.#pendingCaptures) {
      if (capture.public.expiresAt <= now) {
        clearTimeout(capture.timer);
        this.#pendingCaptures.delete(key);
        this.#setInputPrivacy(capture.public.principal, "normal");
        for (const resolve of capture.waiters) resolve({ requestId: capture.public.id, status: "expired" });
      }
    }
  }

  #purgeExpiredApprovals(): void {
    const now = this.#now();
    for (const [key, approval] of this.#pendingApprovals) {
      if (approval.public.expiresAt <= now) {
        clearTimeout(approval.timer);
        this.#pendingApprovals.delete(key);
        approval.resolve(false);
      }
    }
  }

  #purgeExpiredPrompts(): void {
    const now = this.#now();
    for (const [key, prompt] of this.#pendingPrompts) {
      if (prompt.public.expiresAt <= now) {
        clearTimeout(prompt.timer);
        this.#pendingPrompts.delete(key);
        prompt.reject(new Error("Channel prompt expired"));
      }
    }
  }

  #purgeExpiredCancellations(): void {
    const now = this.#now();
    for (const [key, cancellation] of this.#pendingCancellations) {
      if (cancellation.public.expiresAt <= now) {
        clearTimeout(cancellation.timer);
        this.#pendingCancellations.delete(key);
      }
    }
  }
}
