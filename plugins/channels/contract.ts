import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { ChannelHubStatus, ChannelInboundMessage, ChannelTransportStatus } from "@friday/channels";

export interface ChannelAccessSummary {
  readonly enabled: readonly string[];
  readonly allowAll: readonly string[];
  readonly whatsappEnabled: boolean;
}

export interface ChannelsService {
  list(): readonly ChannelTransportStatus[];
  status(): ChannelHubStatus;
  /** Sanitized persisted access-policy summary; never includes credentials or provider settings. */
  access(): ChannelAccessSummary;
  subscribe(listener: (message: ChannelInboundMessage) => void | Promise<void>): () => void;
}

export const CHANNELS_CAPABILITY: Capability<ChannelsService> =
  defineCapability<ChannelsService>("channels");
