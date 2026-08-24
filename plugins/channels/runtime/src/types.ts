export type ChannelKind =
  | "telegram"
  | "whatsapp"
  | "discord"
  | "slack"
  | "teams"
  | "google-chat"
  | "signal"
  | "email"
  | "sms"
  | (string & {});
export type ChannelChatType = "dm" | "group" | "channel" | "thread";
export type ChannelLifecycleState = "stopped" | "starting" | "running" | "error";

export interface ChannelPrincipal {
  readonly channel: ChannelKind;
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly threadId?: string | undefined;
}

export interface ChannelAttachment {
  readonly kind: "image" | "audio" | "video" | "document" | "sticker" | "other";
  readonly externalId: string;
  readonly mimeType?: string | undefined;
  readonly fileName?: string | undefined;
  readonly sizeBytes?: number | undefined;
  /** Optional transport-provided download URL. It is never trusted as a filesystem path. */
  readonly downloadUrl?: string | undefined;
}

export type ChannelInboundClassification =
  | "message"
  | "credential-captured"
  | "credential-capture-error"
  | "approval-resolved"
  | "approval-error"
  | "prompt-resolved"
  | "prompt-error"
  | "cancellation-requested";

export interface ChannelInboundMessage {
  readonly id: string;
  readonly principal: ChannelPrincipal;
  readonly chatType: ChannelChatType;
  readonly text: string;
  readonly timestamp: number;
  readonly senderName?: string | undefined;
  readonly conversationName?: string | undefined;
  readonly replyToMessageId?: string | undefined;
  readonly attachments: readonly ChannelAttachment[];
  readonly classification: ChannelInboundClassification;
  readonly redactionCount: number;
  readonly credential?: {
    readonly requestId: string;
    readonly ref: string;
    readonly kind: string;
    readonly mode: "create" | "rotate";
  } | undefined;
  readonly approval?: {
    readonly requestId: string;
    readonly code: string;
    readonly approved: boolean;
  } | undefined;
  readonly prompt?: {
    readonly requestId: string;
  } | undefined;
  readonly cancellation?: {
    readonly requestId: string;
    readonly code: string;
  } | undefined;
}

export interface RawChannelInboundMessage {
  readonly id: string;
  readonly principal: ChannelPrincipal;
  readonly chatType: ChannelChatType;
  readonly text: string;
  readonly timestamp: number;
  readonly senderName?: string | undefined;
  readonly conversationName?: string | undefined;
  readonly replyToMessageId?: string | undefined;
  readonly attachments?: readonly ChannelAttachment[] | undefined;
  readonly protectedAction?: { readonly requestId: string; readonly decision: "approve" | "deny" } | undefined;
}

export interface ChannelTarget {
  readonly channel: ChannelKind;
  readonly accountId: string;
  readonly conversationId: string;
  readonly threadId?: string | undefined;
}

export interface ChannelSendResult {
  readonly channel: ChannelKind;
  readonly accountId: string;
  readonly conversationId: string;
  readonly messageIds: readonly string[];
}

/** A provider-native protected action. Providers must authenticate the
 * callback principal and emit it as a normal channel ingress; the hub still
 * enforces the exact pending-principal match and one-shot expiry. */
export interface ChannelProtectedAction {
  readonly requestId: string;
  readonly approveLabel?: string | undefined;
  readonly denyLabel?: string | undefined;
}

export interface ChannelTransportStatus {
  readonly channel: ChannelKind;
  readonly accountId: string;
  readonly state: ChannelLifecycleState;
  readonly detail?: string | undefined;
}

export type ChannelInboundHandler = (message: RawChannelInboundMessage) => void | ChannelInboundMessage | Promise<void | ChannelInboundMessage>;

export interface ChannelAttachmentContent {
  readonly bytes: Uint8Array;
  readonly mimeType?: string | undefined;
  readonly fileName?: string | undefined;
}

export interface ChannelTransport {
  readonly channel: ChannelKind;
  readonly accountId: string;
  start(handler: ChannelInboundHandler): Promise<void>;
  stop(): Promise<void>;
  send(target: ChannelTarget, text: string): Promise<ChannelSendResult>;
  sendProtectedAction?(target: ChannelTarget, text: string, action: ChannelProtectedAction): Promise<ChannelSendResult>;
  /** Optional trusted fetch port for attachments previously emitted by this transport. */
  fetchAttachment?(attachment: ChannelAttachment, maxBytes: number): Promise<ChannelAttachmentContent>;
  /** Optional provider UI privacy control used while trusted credential capture is active. */
  setInputPrivacy?(privacy: "normal" | "secret"): void;
  status(): ChannelTransportStatus;
}

export interface CredentialVaultMetadata {
  readonly ref: string;
  readonly kind: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CredentialVaultPort {
  normalizeRef(ref: string): string;
  exists(ref: string): boolean;
  create(input: { ref: string; kind: string; secret: Uint8Array }): CredentialVaultMetadata;
  rotate(ref: string, secret: Uint8Array): CredentialVaultMetadata;
}

export type CredentialCaptureInputMode = "opaque-token" | "text";

export interface CredentialCaptureRequest {
  readonly principal: ChannelPrincipal;
  readonly ref: string;
  readonly kind: string;
  readonly mode: "create" | "rotate";
  readonly label?: string | undefined;
  readonly ttlMs?: number | undefined;
  /** opaque-token rejects whitespace/prose wrappers instead of guessing a token out of user text. */
  readonly inputMode?: CredentialCaptureInputMode | undefined;
  /** Trusted validation runs before Vault mutation; secret bytes are wiped immediately afterwards. */
  readonly validateSecret?: ((secret: Uint8Array) => void | Promise<void>) | undefined;
  readonly successMessage?: string | undefined;
  readonly failureMessage?: string | undefined;
}

export interface PendingCredentialCapture {
  readonly id: string;
  readonly principal: ChannelPrincipal;
  readonly ref: string;
  readonly kind: string;
  readonly mode: "create" | "rotate";
  readonly label: string;
  readonly inputMode: CredentialCaptureInputMode;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface CredentialCaptureCompletion {
  readonly requestId: string;
  readonly status: "stored" | "cancelled" | "expired";
}

export interface ChannelApprovalRequest {
  readonly principal: ChannelPrincipal;
  readonly actionId: string;
  readonly effect: string;
  readonly resource: string;
  readonly reason: string;
  /** True when the protected action requests outbound network access. */
  readonly network?: boolean | undefined;
  readonly ttlMs?: number | undefined;
}

export interface PendingChannelApproval {
  readonly id: string;
  readonly code: string;
  readonly principal: ChannelPrincipal;
  readonly actionId: string;
  readonly effect: string;
  readonly resource: string;
  readonly reason: string;
  readonly network: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ChannelPromptRequest {
  readonly principal: ChannelPrincipal;
  readonly message: string;
  readonly placeholder?: string | undefined;
  readonly allowEmpty?: boolean | undefined;
  readonly maxLength?: number | undefined;
  readonly ttlMs?: number | undefined;
}

export interface PendingChannelPrompt {
  readonly id: string;
  readonly principal: ChannelPrincipal;
  readonly message: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ChannelCancellationRequest {
  readonly principal: ChannelPrincipal;
  readonly label: string;
  readonly ttlMs?: number | undefined;
}

export interface PendingChannelCancellation {
  readonly id: string;
  readonly code: string;
  readonly principal: ChannelPrincipal;
  readonly label: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ChannelCancellationHandle {
  readonly request: PendingChannelCancellation;
  readonly signal: AbortSignal;
  dispose(): void;
}

export interface ChannelHubOptions {
  readonly credentialVault: CredentialVaultPort;
  /** Private host path used for crash-safe protected-interaction tombstones. */
  readonly protectedStatePath?: string | undefined;
  readonly now?: (() => number) | undefined;
  readonly onError?: ((message: string, error?: unknown) => void) | undefined;
}
