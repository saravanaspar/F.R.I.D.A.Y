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
  ChannelProtectedAction,
  ChannelTarget,
  ChannelTransport,
  ChannelTransportStatus,
  ChannelHubStatus,
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
import { channelsStateRoot, readPrivateJson, writePrivateJson } from "./state.js";

const DEFAULT_CAPTURE_TTL_MS = 5 * 60_000;
const MAX_CAPTURE_TTL_MS = 15 * 60_000;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
const MAX_APPROVAL_TTL_MS = 15 * 60_000;
const DEFAULT_PROMPT_TTL_MS = 5 * 60_000;
const MAX_PROMPT_TTL_MS = 15 * 60_000;
const DEFAULT_CANCELLATION_TTL_MS = 60 * 60_000;
const MAX_CANCELLATION_TTL_MS = 24 * 60 * 60_000;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_FAILED_INGRESS = 10_000;

type Listener = (message: ChannelInboundMessage) => void | Promise<void>;

interface TransportObservation {
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastFailureAt?: string;
  retryCount: number;
  inboundFailures: number;
  outboundFailures: number;
  authFailures: number;
  networkFailures: number;
  inboundDegraded: boolean;
  outboundDegraded: boolean;
}

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

type ProtectedRecordKind = "capture" | "approval" | "prompt" | "cancellation";
type ProtectedRecord = {
  readonly kind: ProtectedRecordKind;
  readonly id: string;
  readonly principal: ChannelPrincipal;
  readonly code?: string | undefined;
  readonly expiresAt: number;
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
    principal.threadId === undefined ? "" : bounded(principal.threadId, "threadId", 256),
  ]);
}

function targetKey(target: Pick<ChannelTarget, "channel" | "accountId">): string {
  return `${target.channel}\u0000${target.accountId}`;
}

function failureCategory(error: unknown): "auth" | "network" | "other" {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown } : {};
  const text = [candidate.code, candidate.status, candidate.name, candidate.message, error]
    .filter((value) => value !== undefined)
    .map(String)
    .join(" ")
    .toLowerCase();
  if (/\b(?:401|403|auth|unauthori[sz]ed|forbidden|credential|token)\b/.test(text)) return "auth";
  if (/\b(?:network|timeout|timed out|fetch|connect|socket|dns|econn[a-z]*|enet[a-z]*|ehost[a-z]*|enotfound|unreachable)\b/.test(text)) return "network";
  return "other";
}

function latest(values: readonly (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => value !== undefined).sort().at(-1);
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

function protectedStatePath(explicit: string | undefined): string {
  if (explicit?.trim()) return explicit.trim();
  return `${channelsStateRoot()}/protected-interactions.json`;
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
  const normalized = protectedCommand(text).toLowerCase();
  const expected = code.toLowerCase();
  return normalized === `cancel ${expected}`;
}

function approvalResponse(text: string, code: string): boolean | undefined {
  const normalized = protectedCommand(text).toLowerCase();
  const expected = code.toLowerCase();
  if (normalized === `approve ${expected}`) return true;
  if (normalized === `deny ${expected}`) return false;
  return undefined;
}

function promptResponse(text: string, code: string): string | undefined {
  const command = protectedCommand(text);
  const match = /^answer\s+([A-Z0-9]{6})(?:\s+([\s\S]*))?$/i.exec(command);
  if (!match || match[1]!.toLowerCase() !== code.toLowerCase()) return undefined;
  return match[2] ?? "";
}

/** Providers may prepend a verified bot mention; email clients may quote the
 * previous thread. Only the first bounded non-quoted command line is used. */
function protectedCommand(text: string): string {
  const line = text.split(/\r?\n/).map((value) => value.trim()).find((value) => value && !value.startsWith(">") && !/^on .*wrote:$/i.test(value));
  return (line ?? "")
    .replace(/^<@!?[A-Za-z0-9._-]+>\s*/i, "")
    .replace(/^@[-\w.]+\s*/i, "")
    .replace(/\s+/g, " ");
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
  readonly #protectedStatePath: string;
  readonly #transports = new Map<string, ChannelTransport>();
  readonly #observations = new Map<string, TransportObservation>();
  readonly #failedIngress = new Set<string>();
  readonly #listeners = new Set<Listener>();
  readonly #admissionListeners = new Set<Listener>();
  readonly #pendingCaptures = new Map<string, PendingCredentialInternal>();
  readonly #pendingApprovals = new Map<string, PendingApprovalInternal>();
  readonly #pendingPrompts = new Map<string, PendingPromptInternal>();
  readonly #pendingCancellations = new Map<string, PendingCancellationInternal>();
  readonly #staleProtected = new Map<string, ProtectedRecord>();

  constructor(options: ChannelHubOptions) {
    this.#vault = options.credentialVault;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((message, error = new Error(message)) => {
      reportOperationalError({ component: "channels", operation: message, error });
    });
    this.#protectedStatePath = protectedStatePath(options.protectedStatePath);
    this.#loadProtectedState();
  }

  #protectedRecord(kind: ProtectedRecordKind, id: string, principal: ChannelPrincipal, expiresAt: number, code?: string): ProtectedRecord {
    return Object.freeze({ kind, id, principal: clonePrincipal(principal), ...(code === undefined ? {} : { code }), expiresAt });
  }

  #hasProtectedPrincipal(principal: ChannelPrincipal): boolean {
    this.#purgeStaleProtected();
    const key = principalKey(principal);
    return this.#pendingCaptures.has(key)
      || [...this.#pendingApprovals.values()].some((entry) => principalKey(entry.public.principal) === key)
      || [...this.#pendingPrompts.values()].some((entry) => principalKey(entry.public.principal) === key)
      || [...this.#staleProtected.values()].some((record) => (record.kind === "capture" || record.kind === "prompt") && principalKey(record.principal) === key);
  }

  #hasCancellationPrincipal(principal: ChannelPrincipal): boolean {
    this.#purgeStaleProtected();
    const key = principalKey(principal);
    return this.#pendingCancellations.has(key);
  }

  #newProtectedCode(principal: ChannelPrincipal): string {
    const key = principalKey(principal);
    for (;;) {
      const code = approvalCode();
      const collision = [...this.#staleProtected.values()].some((record) => principalKey(record.principal) === key && record.code === code)
        || [...this.#pendingApprovals.values()].some((entry) => principalKey(entry.public.principal) === key && entry.public.code === code)
        || [...this.#pendingPrompts.values()].some((entry) => principalKey(entry.public.principal) === key && entry.public.code === code)
        || [...this.#pendingCancellations.values()].some((entry) => principalKey(entry.public.principal) === key && entry.public.code === code);
      if (!collision) return code;
    }
  }

  #persistProtectedState(): void {
    const records = [...this.#staleProtected.values(),
      ...[...this.#pendingCaptures.values()].map((entry) => this.#protectedRecord("capture", entry.public.id, entry.public.principal, entry.public.expiresAt)),
      ...[...this.#pendingApprovals.values()].map((entry) => this.#protectedRecord("approval", entry.public.id, entry.public.principal, entry.public.expiresAt, entry.public.code)),
      ...[...this.#pendingPrompts.values()].map((entry) => this.#protectedRecord("prompt", entry.public.id, entry.public.principal, entry.public.expiresAt, entry.public.code)),
      ...[...this.#pendingCancellations.values()].map((entry) => this.#protectedRecord("cancellation", entry.public.id, entry.public.principal, entry.public.expiresAt, entry.public.code)),
    ];
    if (records.length > 256) throw new Error("Protected interaction state capacity exhausted; resolve or expire an existing interaction first");
    writePrivateJson(this.#protectedStatePath, { schema: 1, records });
  }

  #safePersistProtectedState(operation: string): void {
    try { this.#persistProtectedState(); }
    catch (error) { this.#onError(operation, error); }
  }

  #loadProtectedState(): void {
    let parsed: { schema?: unknown; records?: unknown } | undefined;
    try { parsed = readPrivateJson<{ schema?: unknown; records?: unknown }>(this.#protectedStatePath); }
    catch (error) { throw new Error(`Protected interaction state could not be loaded safely: ${error instanceof Error ? error.message : "read failure"}`); }
    if (!parsed) return;
    if (parsed.schema !== 1 || !Array.isArray(parsed.records)) throw new Error("Protected interaction state is malformed");
    const now = this.#now();
    if (parsed.records.length > 256) throw new Error("Protected interaction state exceeds its bounded record capacity");
    for (const value of parsed.records) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Protected interaction record is malformed");
      const raw = value as Record<string, unknown>;
      const principal = raw.principal;
      if (!principal || typeof principal !== "object" || Array.isArray(principal)) throw new Error("Protected interaction principal is malformed");
      const p = principal as Record<string, unknown>;
      if (!(["capture", "approval", "prompt", "cancellation"] as string[]).includes(String(raw.kind))) throw new Error("Protected interaction kind is malformed");
      if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 128 || typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt)) throw new Error("Protected interaction fields are malformed");
      if (raw.expiresAt <= now) continue;
      if (typeof p.channel !== "string" || p.channel.length === 0 || p.channel.length > 64
        || typeof p.accountId !== "string" || p.accountId.length === 0 || p.accountId.length > 128
        || typeof p.conversationId !== "string" || p.conversationId.length === 0 || p.conversationId.length > 256
        || typeof p.senderId !== "string" || p.senderId.length === 0 || p.senderId.length > 256
        || (p.threadId !== undefined && (typeof p.threadId !== "string" || p.threadId.length === 0 || p.threadId.length > 256))) throw new Error("Protected interaction principal is malformed");
      if ((raw.kind === "approval" || raw.kind === "cancellation") && (typeof raw.code !== "string" || !/^[A-Z0-9]{6}$/.test(raw.code))) throw new Error("Protected interaction code is malformed");
      const record = this.#protectedRecord(raw.kind as ProtectedRecordKind, raw.id, {
        channel: p.channel as string,
        accountId: p.accountId as string,
        conversationId: p.conversationId as string,
        senderId: p.senderId as string,
        ...(typeof p.threadId === "string" ? { threadId: p.threadId } : {}),
      }, raw.expiresAt, typeof raw.code === "string" ? raw.code : undefined);
      this.#staleProtected.set(record.id, record);
    }
    this.#persistProtectedState();
  }

  #consumeStale(raw: RawChannelInboundMessage): ChannelInboundMessage | undefined {
    const key = principalKey(raw.principal);
    const candidates = [...this.#staleProtected.values()].filter((record) => principalKey(record.principal) === key);
    const native = raw.protectedAction?.requestId;
    const specific = candidates.find((record) => native === record.id || (record.code !== undefined && (
      record.kind === "approval" ? approvalResponse(raw.text, record.code) !== undefined
        : record.kind === "prompt" ? promptResponse(raw.text, record.code) !== undefined
          : cancellationResponse(raw.text, record.code)
    )));
    // A post-crash capture/prompt consumes one ordinary exact-principal reply,
    // but never consumes a callback intended for a different tombstone.
    const record = specific ?? (native === undefined ? candidates.find((candidate) => candidate.kind === "capture" || candidate.kind === "prompt") : undefined);
    if (!record) return undefined;
    if (record.kind === "capture" || record.kind === "prompt") {
      this.#staleProtected.delete(record.id);
      try { this.#persistProtectedState(); }
      catch (error) { this.#staleProtected.set(record.id, record); this.#onError("persist consumed protected tombstone", error); }
    }
    if (record.kind === "capture") return marker(raw, { text: "[stale credential capture rejected after restart]", classification: "credential-capture-error" });
    if (record.kind === "prompt") return marker(raw, { text: "[stale protected prompt rejected after restart]", classification: "prompt-error", prompt: { requestId: record.id } });
    if (record.kind === "approval") return marker(raw, { text: "[stale approval rejected after restart]", classification: "approval-error", approval: { requestId: record.id, code: record.code ?? "", approved: false } });
    return marker(raw, { text: "[stale cancellation rejected after restart]", classification: "approval-error", cancellation: { requestId: record.id, code: record.code ?? "" } });
  }

  #retainApprovalTombstone(approval: PendingChannelApproval): void {
    if (approval.expiresAt > this.#now()) this.#staleProtected.set(approval.id, this.#protectedRecord("approval", approval.id, approval.principal, approval.expiresAt, approval.code));
  }

  #retainCancellationTombstone(cancellation: PendingChannelCancellation): void {
    if (cancellation.expiresAt > this.#now()) this.#staleProtected.set(cancellation.id, this.#protectedRecord("cancellation", cancellation.id, cancellation.principal, cancellation.expiresAt, cancellation.code));
  }

  #retainGenericTombstone(kind: "capture" | "prompt", id: string, principal: ChannelPrincipal, expiresAt: number, code?: string): void {
    if (expiresAt > this.#now()) this.#staleProtected.set(id, this.#protectedRecord(kind, id, principal, expiresAt, code));
  }

  #snapshotActiveAsStale(): void {
    for (const entry of this.#pendingCaptures.values()) this.#staleProtected.set(entry.public.id, this.#protectedRecord("capture", entry.public.id, entry.public.principal, entry.public.expiresAt));
    for (const entry of this.#pendingApprovals.values()) this.#retainApprovalTombstone(entry.public);
    for (const entry of this.#pendingPrompts.values()) this.#staleProtected.set(entry.public.id, this.#protectedRecord("prompt", entry.public.id, entry.public.principal, entry.public.expiresAt, entry.public.code));
    for (const entry of this.#pendingCancellations.values()) this.#retainCancellationTombstone(entry.public);
  }

  #purgeStaleProtected(): void {
    const now = this.#now();
    let changed = false;
    for (const [id, record] of this.#staleProtected) {
      if (record.expiresAt <= now) { this.#staleProtected.delete(id); changed = true; }
    }
    if (changed) this.#safePersistProtectedState("purge expired protected tombstones");
  }

  registerTransport(transport: ChannelTransport): void {
    const key = targetKey(transport);
    if (this.#transports.has(key)) {
      throw new Error(`Channel transport already registered: ${transport.channel}/${transport.accountId}`);
    }
    this.#transports.set(key, transport);
    this.#observations.set(key, {
      retryCount: 0,
      inboundFailures: 0,
      outboundFailures: 0,
      authFailures: 0,
      networkFailures: 0,
      inboundDegraded: false,
      outboundDegraded: false,
    });
  }

  list(): readonly ChannelTransportStatus[] {
    return Object.freeze(
      [...this.#transports.values()]
        .map((transport) => {
          const key = targetKey(transport);
          const base = transport.status();
          const observation = this.#observations.get(key)!;
          const pending = this.#pendingCount(key);
          const baseHealth = base.health ?? (base.state === "running" ? "up" : base.state === "error" ? "degraded" : "down");
          const health = baseHealth === "up" && (observation.inboundDegraded || observation.outboundDegraded)
            ? "degraded"
            : baseHealth;
          return Object.freeze({
            ...base,
            health,
            ...(observation.lastInboundAt === undefined ? {} : { lastInboundAt: observation.lastInboundAt }),
            ...(observation.lastOutboundAt === undefined ? {} : { lastOutboundAt: observation.lastOutboundAt }),
            ...(observation.lastFailureAt === undefined ? {} : { lastFailureAt: observation.lastFailureAt }),
            retryCount: observation.retryCount + (base.retryCount ?? 0),
            inboundFailures: observation.inboundFailures + (base.inboundFailures ?? 0),
            outboundFailures: observation.outboundFailures + (base.outboundFailures ?? 0),
            authFailures: observation.authFailures + (base.authFailures ?? 0),
            networkFailures: observation.networkFailures + (base.networkFailures ?? 0),
            backlog: pending + (base.backlog ?? 0),
          });
        })
        .sort((a, b) => `${a.channel}/${a.accountId}`.localeCompare(`${b.channel}/${b.accountId}`)),
    );
  }

  status(): ChannelHubStatus {
    const transports = this.list();
    const pending = Object.freeze({
      credentialCaptures: this.#pendingCaptures.size,
      approvals: this.#pendingApprovals.size,
      prompts: this.#pendingPrompts.size,
      cancellations: this.#pendingCancellations.size,
      failedIngressAwaitingRetry: this.#failedIngress.size,
    });
    const configured = transports.length;
    const up = transports.filter((entry) => entry.health === "up").length;
    const degraded = transports.filter((entry) => entry.health === "degraded").length;
    const down = configured - up - degraded;
    return Object.freeze({
      health: configured === 0 ? "unconfigured" : degraded > 0 || down > 0 ? "degraded" : "healthy",
      configured,
      up,
      degraded,
      down,
      ...(latest(transports.map((entry) => entry.lastInboundAt)) === undefined ? {} : { lastInboundAt: latest(transports.map((entry) => entry.lastInboundAt))! }),
      ...(latest(transports.map((entry) => entry.lastOutboundAt)) === undefined ? {} : { lastOutboundAt: latest(transports.map((entry) => entry.lastOutboundAt))! }),
      ...(latest(transports.map((entry) => entry.lastFailureAt)) === undefined ? {} : { lastFailureAt: latest(transports.map((entry) => entry.lastFailureAt))! }),
      retryCount: transports.reduce((sum, entry) => sum + (entry.retryCount ?? 0), 0),
      inboundFailures: transports.reduce((sum, entry) => sum + (entry.inboundFailures ?? 0), 0),
      outboundFailures: transports.reduce((sum, entry) => sum + (entry.outboundFailures ?? 0), 0),
      authFailures: transports.reduce((sum, entry) => sum + (entry.authFailures ?? 0), 0),
      networkFailures: transports.reduce((sum, entry) => sum + (entry.networkFailures ?? 0), 0),
      backlog: transports.reduce((sum, entry) => sum + (entry.backlog ?? 0), 0),
      pending,
      transports,
    });
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
      transport.start(async (message) => {
        const transportKey = targetKey(message.principal);
        const ingressKey = `${transportKey}\u0000${message.id}`;
        const observation = this.#observations.get(transportKey);
        if (observation) {
          observation.lastInboundAt = new Date(this.#now()).toISOString();
        }
        try {
          const result = await this.ingest(message);
          if (observation) {
            if (this.#failedIngress.delete(ingressKey)) observation.retryCount += 1;
            observation.inboundDegraded = this.#hasFailedIngress(transportKey);
          }
          return result;
        } catch (error) {
          if (observation) this.#recordFailure(observation, "inbound", error);
          this.#rememberFailedIngress(ingressKey);
          throw error;
        }
      }),
    ));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      const transport = transports[index]!;
      const observation = this.#observations.get(targetKey(transport))!;
      if (result.status === "fulfilled") {
        observation.inboundDegraded = this.#hasFailedIngress(targetKey(transport));
        continue;
      }
      this.#recordFailure(observation, "inbound", result.reason);
      this.#onError(`start ${transport.channel}/${transport.accountId}`, result.reason);
    }
  }

  async stopAll(): Promise<void> {
    this.#snapshotActiveAsStale();
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
    let persistenceFailure: unknown;
    try { this.#persistProtectedState(); } catch (error) { persistenceFailure = error; this.#onError("persist stopped protected interactions", error); }
    const results = await Promise.allSettled([...this.#transports.values()].map((transport) => transport.stop()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    if (persistenceFailure) throw persistenceFailure;
  }

  requestCredentialCapture(request: CredentialCaptureRequest): PendingCredentialCapture {
    this.#purgeExpiredCaptures();
    const key = principalKey(request.principal);
    if (this.#hasProtectedPrincipal(request.principal)) {
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
      this.#safePersistProtectedState("expire credential capture");
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
    try { this.#persistProtectedState(); }
    catch (error) { this.#pendingCaptures.delete(key); clearTimeout(timer); throw error; }
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
        this.#retainGenericTombstone("capture", capture.public.id, capture.public.principal, capture.public.expiresAt);
        this.#safePersistProtectedState("cancel credential capture");
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
    if (this.#pendingCaptures.has(principalKey(request.principal))) {
      throw new Error("A credential capture is already pending for this channel principal");
    }
    const ttlMs = request.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_APPROVAL_TTL_MS) {
      throw new Error(`Channel approval ttlMs must be between 1000 and ${MAX_APPROVAL_TTL_MS}`);
    }
    const now = this.#now();
    const pending: PendingChannelApproval = Object.freeze({
      id: randomUUID(),
      code: this.#newProtectedCode(request.principal),
      principal: clonePrincipal(request.principal),
      actionId: bounded(sanitizeDisplayText(request.actionId) ?? "", "approval action id", 128),
      effect: bounded(sanitizeDisplayText(request.effect) ?? "", "approval effect", 64),
      resource: bounded(sanitizeDisplayText(request.resource) ?? "", "approval resource", 512),
      reason: bounded(sanitizeDisplayText(request.reason) ?? "", "approval reason", 512),
      network: request.network === true,
      ...(request.jobId === undefined ? {} : { jobId: bounded(sanitizeDisplayText(request.jobId) ?? "", "approval job id", 128) }),
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
      const active = this.#pendingApprovals.get(pending.id);
      if (!active) return;
      this.#pendingApprovals.delete(pending.id);
      active.resolve(false);
      this.#safePersistProtectedState("expire approval");
      void this.send(targetFromPrincipal(pending.principal), `Approval ${pending.code} expired.`).catch((error: unknown) => {
        this.#onError("deliver approval expiry", error);
      });
    }, ttlMs);
    timer.unref?.();
    this.#pendingApprovals.set(pending.id, { public: pending, resolve: resolvePromise, reject: rejectPromise, timer });
    try { this.#persistProtectedState(); }
    catch (error) { this.#pendingApprovals.delete(pending.id); clearTimeout(timer); throw error; }

    try {
      const target = targetFromPrincipal(request.principal);
      const notice = [
        `FRIDAY approval ${pending.code} required`,
        `Request ID: ${pending.id}`,
        ...(pending.jobId === undefined ? [] : [`Job ID: ${pending.jobId}`]),
        `Action: ${pending.actionId}`,
        `Effect: ${pending.effect}`,
        `Resource: ${pending.resource}`,
        `Reason: ${pending.reason}`,
        ...(pending.network ? ["Network: requested"] : []),
        "",
        `Reply: approve ${pending.code}`,
        `or: deny ${pending.code}`,
      ].join("\n");
      const sanitizedNotice = sanitizeChannelText(notice).text;
      const transport = this.#transports.get(targetKey(target));
      if (transport?.sendProtectedAction) {
        await transport.sendProtectedAction(target, sanitizedNotice, {
          requestId: pending.id,
          approveLabel: "Approve",
          denyLabel: "Deny",
        });
      } else {
        await this.send(target, sanitizedNotice);
      }
    } catch (error) {
      const active = this.#pendingApprovals.get(pending.id);
      if (active) {
        clearTimeout(active.timer);
        this.#pendingApprovals.delete(pending.id);
        this.#retainApprovalTombstone(pending);
        active.reject(error);
        this.#safePersistProtectedState("retain failed approval delivery");
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
        this.#retainApprovalTombstone(approval.public);
        approval.resolve(false);
        this.#safePersistProtectedState("cancel approval");
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
    if (this.#pendingCaptures.has(principalKey(request.principal))) {
      throw new Error("A credential capture is already pending for this channel principal");
    }
    const ttlMs = request.ttlMs ?? DEFAULT_PROMPT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_PROMPT_TTL_MS) {
      throw new Error(`Channel prompt ttlMs must be between 1000 and ${MAX_PROMPT_TTL_MS}`);
    }
    const maxLength = request.maxLength ?? 8_192;
    if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 32_000) {
      throw new Error("Channel prompt maxLength must be between 1 and 32000");
    }
    if (request.options !== undefined && (request.options.length < 1 || request.options.length > 5)) {
      throw new Error("Channel prompt options must contain between 1 and 5 choices");
    }
    const options = Object.freeze((request.options ?? []).map((option) => Object.freeze({
      label: bounded(sanitizeDisplayText(option.label) ?? "", "prompt option label", 80),
      value: bounded(sanitizeDisplayText(option.value) ?? "", "prompt option value", 512),
      ...(option.description === undefined ? {} : { description: bounded(sanitizeDisplayText(option.description) ?? "", "prompt option description", 240) }),
    })));
    const now = this.#now();
    const pending: PendingChannelPrompt = Object.freeze({
      id: randomUUID(),
      code: this.#newProtectedCode(request.principal),
      principal: clonePrincipal(request.principal),
      message: bounded(sanitizeDisplayText(request.message) ?? "", "prompt message", 2_000),
      title: bounded(sanitizeDisplayText(request.title ?? "FRIDAY question") ?? "", "prompt title", 160),
      ...(request.notes === undefined ? {} : { notes: bounded(sanitizeDisplayText(request.notes) ?? "", "prompt notes", 1_000) }),
      options,
      allowCustom: request.allowCustom !== false,
      ...(request.jobId === undefined ? {} : { jobId: bounded(sanitizeDisplayText(request.jobId) ?? "", "prompt job id", 128) }),
      createdAt: now,
      expiresAt: now + ttlMs,
    });
    let resolvePromise!: (value: string) => void;
    let rejectPromise!: (error: unknown) => void;
    const result = new Promise<string>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const timer = setTimeout(() => {
      const active = this.#pendingPrompts.get(pending.id);
      if (!active) return;
      this.#pendingPrompts.delete(pending.id);
      active.reject(new Error("Channel prompt expired"));
      this.#safePersistProtectedState("expire protected prompt");
      void this.send(targetFromPrincipal(pending.principal), "That input request expired.").catch((error: unknown) => {
        this.#onError("deliver protected-input expiry", error);
      });
    }, ttlMs);
    timer.unref?.();
    this.#pendingPrompts.set(pending.id, { public: pending, allowEmpty: request.allowEmpty === true, maxLength, resolve: resolvePromise, reject: rejectPromise, timer });
    try { this.#persistProtectedState(); }
    catch (error) { this.#pendingPrompts.delete(pending.id); clearTimeout(timer); throw error; }
    try {
      const target = targetFromPrincipal(request.principal);
      const notice = [
        pending.title,
        `Request ID: ${pending.id}`,
        ...(pending.jobId === undefined ? [] : [`Job ID: ${pending.jobId}`]),
        "",
        pending.message,
        ...(pending.notes === undefined ? [] : [`Notes: ${pending.notes}`]),
        ...pending.options.map((option, index) => `${index + 1}. ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`),
        ...(request.placeholder ? [`Expected: ${sanitizeDisplayText(request.placeholder)?.slice(0, 512) ?? "value"}`] : []),
        pending.allowCustom
          ? `Reply: answer ${pending.code} <choice number or custom answer>`
          : `Reply: answer ${pending.code} <choice number>`,
        "This reply is captured directly and will not be sent to the AI router/model.",
      ].join("\n");
      const sanitizedNotice = sanitizeChannelText(notice).text;
      const transport = this.#transports.get(targetKey(target));
      if (pending.options.length > 0 && transport?.sendProtectedQuestion) {
        await transport.sendProtectedQuestion(target, sanitizedNotice, {
          requestId: pending.id,
          choices: pending.options.map((option) => ({ label: option.label })),
        });
      } else {
        await this.send(target, sanitizedNotice);
      }
    } catch (error) {
      const active = this.#pendingPrompts.get(pending.id);
      if (active) {
        clearTimeout(active.timer);
        this.#pendingPrompts.delete(pending.id);
        this.#retainGenericTombstone("prompt", pending.id, pending.principal, pending.expiresAt, pending.code);
        active.reject(error);
        this.#safePersistProtectedState("retain failed protected-prompt delivery");
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
      this.#retainGenericTombstone("prompt", prompt.public.id, prompt.public.principal, prompt.public.expiresAt, prompt.public.code);
      this.#safePersistProtectedState("cancel protected prompt");
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
    if (this.#hasCancellationPrincipal(request.principal)) throw new Error("A cancellable operation is already active for this channel principal");
    const ttlMs = request.ttlMs ?? DEFAULT_CANCELLATION_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_CANCELLATION_TTL_MS) {
      throw new Error(`Channel cancellation ttlMs must be between 1000 and ${MAX_CANCELLATION_TTL_MS}`);
    }
    const now = this.#now();
    const pending: PendingChannelCancellation = Object.freeze({
      id: randomUUID(),
      code: this.#newProtectedCode(request.principal),
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
      this.#safePersistProtectedState("expire cancellation watcher");
    }, ttlMs);
    timer.unref?.();
    this.#pendingCancellations.set(key, { public: pending, controller, timer });
    try { this.#persistProtectedState(); }
    catch (error) { this.#pendingCancellations.delete(key); clearTimeout(timer); throw error; }
    try {
      await this.send(targetFromPrincipal(request.principal), `You can cancel ${pending.label} while it is running by replying: cancel ${pending.code}`);
    } catch (error) {
      const active = this.#pendingCancellations.get(key);
      if (active?.public.id === pending.id) {
        clearTimeout(active.timer);
        this.#pendingCancellations.delete(key);
        this.#retainCancellationTombstone(pending);
        this.#safePersistProtectedState("retain failed cancellation delivery");
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
        this.#retainCancellationTombstone(pending);
        this.#safePersistProtectedState("dispose cancellation watcher");
      },
    });
  }

  async ingest(raw: RawChannelInboundMessage): Promise<ChannelInboundMessage> {
    this.#purgeStaleProtected();
    this.#purgeExpiredCaptures();
    this.#purgeExpiredApprovals();
    this.#purgeExpiredPrompts();
    this.#purgeExpiredCancellations();
    const key = principalKey(raw.principal);
    const cancellation = this.#pendingCancellations.get(key);
    if (cancellation && cancellationResponse(raw.text, cancellation.public.code)) {
      clearTimeout(cancellation.timer);
      this.#pendingCancellations.delete(key);
      this.#retainCancellationTombstone(cancellation.public);
      this.#safePersistProtectedState("resolve cancellation watcher");
      cancellation.controller.abort(new Error(`${cancellation.public.label} cancelled by user`));
      void this.send(targetFromPrincipal(raw.principal), `${cancellation.public.label} cancellation requested.`).catch((error: unknown) => {
        this.#onError("deliver cancellation acknowledgement", error);
      });
      return marker(raw, { text: `[${cancellation.public.label} cancellation requested]`, classification: "cancellation-requested", cancellation: { requestId: cancellation.public.id, code: cancellation.public.code } });
    }
    const principalApprovals = [...this.#pendingApprovals.values()].filter((entry) => principalKey(entry.public.principal) === key);
    const approval = raw.protectedAction && "decision" in raw.protectedAction
      ? principalApprovals.find((entry) => entry.public.id === raw.protectedAction?.requestId)
      : principalApprovals.find((entry) => approvalResponse(raw.text, entry.public.code) !== undefined);
    if (approval) return this.#resolveApproval(raw, approval);
    const principalPrompts = [...this.#pendingPrompts.values()].filter((entry) => principalKey(entry.public.principal) === key);
    const exactPrompt = raw.protectedAction && "selection" in raw.protectedAction
      ? principalPrompts.find((entry) => entry.public.id === raw.protectedAction?.requestId)
      : principalPrompts.find((entry) => promptResponse(raw.text, entry.public.code) !== undefined);
    if (exactPrompt) return this.#resolvePrompt(raw, exactPrompt, false);
    const stale = this.#consumeStale(raw);
    if (stale) return stale;
    if (raw.protectedAction) {
      // Provider callbacks are privileged control traffic. A stale, replayed,
      // malformed, or wrong-principal token must never fall through as a
      // normal empty user message.
      return "selection" in raw.protectedAction
        ? marker(raw, { text: "[protected question action rejected]", classification: "prompt-error", prompt: { requestId: raw.protectedAction.requestId } })
        : marker(raw, { text: "[protected action rejected]", classification: "approval-error", approval: { requestId: raw.protectedAction.requestId, code: "", approved: false } });
    }
    const protectedText = protectedCommand(raw.text);
    if (/^(?:approve|deny)\s+[A-Z0-9]{6}$/i.test(protectedText)) {
      return marker(raw, { text: "[approval rejected: no live request]", classification: "approval-error", approval: { requestId: "", code: "", approved: false } });
    }
    if (principalApprovals.length > 0) {
      const codes = principalApprovals.map((entry) => entry.public.code).join(", ");
      void this.send(targetFromPrincipal(raw.principal), `Approval replies must name a request code. Waiting: ${codes}.`).catch((error: unknown) => {
        this.#onError("deliver approval correction", error);
      });
      return marker(raw, { text: "[approval reply was not scoped to a request]", classification: "approval-error", approval: { requestId: "", code: "", approved: false } });
    }
    if (/^answer\s+[A-Z0-9]{6}(?:\s|$)/i.test(protectedText)) {
      return marker(raw, { text: "[question answer rejected: no live request]", classification: "prompt-error", prompt: { requestId: "" } });
    }
    if (/^cancel\s+[A-Z0-9]{6}$/i.test(protectedText)) {
      return marker(raw, { text: "[cancellation rejected: no live request]", classification: "approval-error", cancellation: { requestId: "", code: "" } });
    }
    if (principalPrompts.length > 1) {
      void this.send(targetFromPrincipal(raw.principal), "Several questions are waiting. Reply with the exact `answer CODE ...` shown on the question you mean to answer.").catch((error: unknown) => {
        this.#onError("deliver concurrent-question correction", error);
      });
      return marker(raw, { text: "[question answer needs a request code]", classification: "prompt-error", prompt: { requestId: "" } });
    }
    if (principalPrompts.length === 1) return this.#resolvePrompt(raw, principalPrompts[0]!, true);
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
    const observation = this.#observations.get(targetKey(target))!;
    try {
      const result = await transport.send(target, sanitized.text);
      observation.lastOutboundAt = new Date(this.#now()).toISOString();
      observation.outboundDegraded = false;
      return result;
    } catch (error) {
      this.#recordFailure(observation, "outbound", error);
      throw error;
    }
  }

  #recordFailure(observation: TransportObservation, direction: "inbound" | "outbound", error: unknown): void {
    observation.lastFailureAt = new Date(this.#now()).toISOString();
    if (direction === "inbound") {
      observation.inboundFailures += 1;
      observation.inboundDegraded = true;
    } else {
      observation.outboundFailures += 1;
      observation.outboundDegraded = true;
    }
    const category = failureCategory(error);
    if (category === "auth") observation.authFailures += 1;
    if (category === "network") observation.networkFailures += 1;
  }

  #rememberFailedIngress(ingressKey: string): void {
    this.#failedIngress.add(ingressKey);
    while (this.#failedIngress.size > MAX_FAILED_INGRESS) {
      const oldest = this.#failedIngress.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#failedIngress.delete(oldest);
    }
  }

  #hasFailedIngress(transportKey: string): boolean {
    for (const ingressKey of this.#failedIngress) {
      if (ingressKey.startsWith(`${transportKey}\u0000`)) return true;
    }
    return false;
  }

  #pendingCount(key: string): number {
    const matches = (principal: ChannelPrincipal): boolean => targetKey(principal) === key;
    return [...this.#pendingCaptures.values()].filter((entry) => matches(entry.public.principal)).length
      + [...this.#pendingApprovals.values()].filter((entry) => matches(entry.public.principal)).length
      + [...this.#pendingPrompts.values()].filter((entry) => matches(entry.public.principal)).length
      + [...this.#pendingCancellations.values()].filter((entry) => matches(entry.public.principal)).length
      + [...this.#failedIngress].filter((entry) => entry.startsWith(`${key}\u0000`)).length;
  }

  async #resolveApproval(raw: RawChannelInboundMessage, approval: PendingApprovalInternal): Promise<ChannelInboundMessage> {
    if ((raw.attachments?.length ?? 0) > 0) {
      return marker(raw, {
        text: `[approval ${approval.public.code} expects a text reply]`,
        classification: "approval-error",
        approval: { requestId: approval.public.id, code: approval.public.code, approved: false },
      });
    }
    const decision = raw.protectedAction?.requestId === approval.public.id && "decision" in raw.protectedAction
      ? raw.protectedAction.decision === "approve"
      : approvalResponse(raw.text, approval.public.code);
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
    this.#pendingApprovals.delete(approval.public.id);
    this.#retainApprovalTombstone(approval.public);
    this.#safePersistProtectedState("resolve approval");
    approval.resolve(decision);
    return marker(raw, {
      text: decision ? `[approval ${approval.public.code} approved]` : `[approval ${approval.public.code} denied]`,
      classification: "approval-resolved",
      approval: { requestId: approval.public.id, code: approval.public.code, approved: decision },
    });
  }


  async #resolvePrompt(raw: RawChannelInboundMessage, prompt: PendingPromptInternal, allowBareReply: boolean): Promise<ChannelInboundMessage> {
    if ((raw.attachments?.length ?? 0) > 0) {
      void this.send(targetFromPrincipal(raw.principal), "That input expects text only. Please reply again with text.").catch((error: unknown) => {
        this.#onError("deliver protected-input attachment rejection", error);
      });
      return marker(raw, { text: "[protected prompt rejected an attachment]", classification: "prompt-error", prompt: { requestId: prompt.public.id } });
    }
    const nativeSelection = raw.protectedAction && "selection" in raw.protectedAction && raw.protectedAction.requestId === prompt.public.id
      ? raw.protectedAction.selection
      : undefined;
    const coded = promptResponse(raw.text, prompt.public.code);
    const submitted = nativeSelection === undefined
      ? coded ?? (allowBareReply ? raw.text.trim() : undefined)
      : String(nativeSelection + 1);
    if (submitted === undefined) {
      return marker(raw, { text: "[question answer did not match this request]", classification: "prompt-error", prompt: { requestId: prompt.public.id } });
    }
    const selectedIndex = /^\d+$/.test(submitted) ? Number(submitted) - 1 : -1;
    const selected = selectedIndex >= 0 ? prompt.public.options[selectedIndex] : undefined;
    if (selectedIndex >= 0 && !selected) {
      void this.send(targetFromPrincipal(raw.principal), `That choice is not available. Reply with a number from 1 to ${prompt.public.options.length}.`).catch((error: unknown) => {
        this.#onError("deliver protected-input choice rejection", error);
      });
      return marker(raw, { text: "[protected prompt rejected an invalid choice]", classification: "prompt-error", prompt: { requestId: prompt.public.id } });
    }
    if (!selected && prompt.public.options.length > 0 && !prompt.public.allowCustom) {
      void this.send(targetFromPrincipal(raw.principal), `A listed choice is required. Reply: answer ${prompt.public.code} <choice number>.`).catch((error: unknown) => {
        this.#onError("deliver protected-input custom rejection", error);
      });
      return marker(raw, { text: "[protected prompt rejected a custom answer]", classification: "prompt-error", prompt: { requestId: prompt.public.id } });
    }
    const value = selected?.value ?? submitted.trim();
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
    this.#pendingPrompts.delete(prompt.public.id);
    try { this.#persistProtectedState(); }
    catch (error) {
      this.#retainGenericTombstone("prompt", prompt.public.id, prompt.public.principal, prompt.public.expiresAt, prompt.public.code);
      this.#onError("persist consumed protected prompt", error);
    }
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
      try { this.#persistProtectedState(); }
      catch (error) {
        this.#retainGenericTombstone("capture", pending.id, pending.principal, pending.expiresAt);
        this.#onError("persist consumed credential capture", error);
      }
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
        this.#safePersistProtectedState("expire credential capture");
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
        this.#safePersistProtectedState("expire approval");
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
        this.#safePersistProtectedState("expire protected prompt");
      }
    }
  }

  #purgeExpiredCancellations(): void {
    const now = this.#now();
    for (const [key, cancellation] of this.#pendingCancellations) {
      if (cancellation.public.expiresAt <= now) {
        clearTimeout(cancellation.timer);
        this.#pendingCancellations.delete(key);
        this.#safePersistProtectedState("expire cancellation watcher");
      }
    }
  }
}
