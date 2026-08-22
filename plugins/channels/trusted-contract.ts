import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type {
  ChannelInboundMessage,
  ChannelSendResult,
  ChannelTarget,
  CredentialCaptureRequest,
  CredentialCaptureCompletion,
  PendingCredentialCapture,
  ChannelApprovalRequest,
  PendingChannelApproval,
  ChannelPromptRequest,
  PendingChannelPrompt,
  ChannelCancellationRequest,
  ChannelCancellationHandle,
} from "@friday/channels";

export interface ChannelsTrustedService {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(target: ChannelTarget, text: string): Promise<ChannelSendResult>;
  fetchAttachment(
    target: Pick<ChannelTarget, "channel" | "accountId">,
    attachment: import("@friday/channels").ChannelAttachment,
    maxBytes?: number,
  ): Promise<import("@friday/channels").ChannelAttachmentContent>;
  requestCredentialCapture(request: CredentialCaptureRequest): PendingCredentialCapture;
  waitForCredentialCapture(requestId: string): Promise<CredentialCaptureCompletion>;
  cancelCredentialCapture(requestId: string): boolean;
  pendingCredentialCaptures(): readonly PendingCredentialCapture[];
  requestApproval(request: ChannelApprovalRequest): Promise<boolean>;
  cancelApproval(requestId: string): boolean;
  pendingApprovals(): readonly PendingChannelApproval[];
  requestPrompt(request: ChannelPromptRequest): Promise<string>;
  cancelPrompt(requestId: string): boolean;
  pendingPrompts(): readonly PendingChannelPrompt[];
  watchCancellation(request: ChannelCancellationRequest): Promise<ChannelCancellationHandle>;
  ingestLocal(text: string, options?: { conversationId?: string; senderId?: string; threadId?: string }): Promise<ChannelInboundMessage>;
}

export const CHANNELS_TRUSTED_CAPABILITY: Capability<ChannelsTrustedService> =
  defineCapability<ChannelsTrustedService>("channels.trusted");
