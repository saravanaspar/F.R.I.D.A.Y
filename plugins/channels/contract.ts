import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { ChannelInboundMessage, ChannelTransportStatus } from "@friday/channels";

export interface ChannelsService {
  list(): readonly ChannelTransportStatus[];
  subscribe(listener: (message: ChannelInboundMessage) => void | Promise<void>): () => void;
}

export const CHANNELS_CAPABILITY: Capability<ChannelsService> =
  defineCapability<ChannelsService>("channels");
