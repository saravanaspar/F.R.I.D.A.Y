import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type SessionResourcesModule = typeof import("@friday/session-resources");

export interface SessionResourcesService {
  readonly api: SessionResourcesModule;
}

export const SESSION_RESOURCES_CAPABILITY: Capability<SessionResourcesService> =
  defineCapability<SessionResourcesService>("session.resources");
