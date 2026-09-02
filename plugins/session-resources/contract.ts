import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type SessionResourcesRuntime = typeof import("@friday/session-resources");

/** Session-scoped cleanup registration shared by long-lived runtime owners. */
export interface SessionResourcesService {
  readonly registerSessionResourceCleanup: SessionResourcesRuntime["registerSessionResourceCleanup"];
  readonly cleanupSessionResources: SessionResourcesRuntime["cleanupSessionResources"];
}

export const SESSION_RESOURCES_CAPABILITY: Capability<SessionResourcesService> =
  defineCapability<SessionResourcesService>("session.resources");
