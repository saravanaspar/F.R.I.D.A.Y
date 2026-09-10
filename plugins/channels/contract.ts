import type { Capability, Contribution } from "../capabilities/protocol.js";
import { defineCapability, defineContribution } from "../capabilities/protocol.js";
import type { ChannelHubStatus, ChannelInboundMessage, ChannelTransportStatus } from "@friday/channels";

export interface ChannelAccessSummary {
  readonly enabled: readonly string[];
  readonly allowAll: readonly string[];
  readonly whatsappEnabled: boolean;
}



export interface ChannelTurnIngressContext {
  readonly id: string;
  readonly principal: {
    readonly channel: string;
    readonly accountId: string;
    readonly conversationId: string;
    readonly senderId: string;
    readonly threadId?: string | undefined;
  };
  readonly text: string;
  readonly timestamp: number;
  readonly attachments: readonly {
    readonly kind: "image" | "audio" | "video" | "document" | "sticker" | "other";
    readonly externalId: string;
    readonly mimeType?: string | undefined;
    readonly fileName?: string | undefined;
    readonly sizeBytes?: number | undefined;
    readonly downloadUrl?: string | undefined;
  }[];
  readonly chatType?: "dm" | "group" | "channel" | "thread" | undefined;
  readonly senderName?: string | undefined;
  readonly conversationName?: string | undefined;
  readonly replyToMessageId?: string | undefined;
}

export interface ChannelSelectedAgent {
  readonly id: string;
  readonly label: string;
  readonly notificationPreference: "all" | "important" | "muted";
}

export interface ChannelTurnEnrichment {
  /** Command was fully handled by the host; do not submit a Turn Loop turn. */
  readonly handled?: boolean | undefined;
  readonly replyText?: string | undefined;
  readonly text?: string | undefined;
  readonly sharedConversationId?: string | undefined;
  readonly sessionAffinityId?: string | undefined;
  readonly agentProfileId?: string | undefined;
  readonly agentProfileLabel?: string | undefined;
  readonly agentNotificationPreference?: "all" | "important" | "muted" | undefined;
  readonly collaboratingAgents?: readonly ChannelSelectedAgent[] | undefined;
  readonly internalThreadId?: string | undefined;
}

/** Host-owned post-ingress seam. Providers remain transport-only; trusted plugins select internal context here. */
export interface ChannelTurnEnricher {
  readonly id: string;
  readonly priority?: number | undefined;
  enrich(context: ChannelTurnIngressContext): Promise<ChannelTurnEnrichment | undefined>;
}

export const CHANNEL_TURN_ENRICHER_CONTRIBUTION: Contribution<ChannelTurnEnricher> =
  defineContribution<ChannelTurnEnricher>("channels.turn-enricher");

export interface ChannelsService {
  list(): readonly ChannelTransportStatus[];
  status(): ChannelHubStatus;
  /** Sanitized persisted access-policy summary; never includes credentials or provider settings. */
  access(): ChannelAccessSummary;
  subscribe(listener: (message: ChannelInboundMessage) => void | Promise<void>): () => void;
}

export const CHANNELS_CAPABILITY: Capability<ChannelsService> =
  defineCapability<ChannelsService>("channels");
