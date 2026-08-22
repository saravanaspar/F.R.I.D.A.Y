import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type SessionsModule = typeof import("@friday/sessions");

export interface SessionsService {
  readonly api: SessionsModule;
}

export const SESSIONS_CAPABILITY: Capability<SessionsService> =
  defineCapability<SessionsService>("sessions");
