import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type RoutingDestinationKind = "session" | "transient" | "scheduler" | "system";
export type RoutingExecutionProfile = "agent" | "utility" | "scheduler" | "system";

export interface RoutingPrincipal {
  readonly authority: "local" | "channel";
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly threadId?: string | undefined;
}

export interface RoutingAttachment {
  readonly kind: "image" | "audio" | "video" | "document" | "sticker" | "other";
  readonly mimeType?: string | undefined;
  readonly fileName?: string | undefined;
  readonly sizeBytes?: number | undefined;
}

export interface RoutingMessage {
  readonly id: string;
  readonly principal: RoutingPrincipal;
  readonly text: string;
  readonly attachments?: readonly RoutingAttachment[] | undefined;
  readonly timestamp: number;
}

export interface RoutingDestination {
  readonly kind: RoutingDestinationKind;
  readonly id: string;
}

export interface RoutingExecution {
  readonly profile: RoutingExecutionProfile;
}

export interface RoutingDecision {
  readonly messageId: string;
  readonly destination: RoutingDestination;
  readonly execution: RoutingExecution;
  readonly confidence: number;
}

export interface RoutedMessage {
  readonly message: RoutingMessage;
  readonly decision: RoutingDecision;
}

export interface RoutingOptions {
  readonly signal?: AbortSignal | undefined;
}

export type RoutingListener = (routed: RoutedMessage) => void | Promise<void>;

export interface RoutingService {
  route(message: RoutingMessage, options?: RoutingOptions): Promise<RoutingDecision>;
  subscribe(listener: RoutingListener): () => void;
  recentContext(principal: RoutingPrincipal): readonly RoutingMessage[];
}

export const ROUTING_CAPABILITY: Capability<RoutingService> =
  defineCapability<RoutingService>("routing");
