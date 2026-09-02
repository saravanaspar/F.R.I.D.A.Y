import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type SessionsRuntime = typeof import("@friday/sessions");

/** Durable session lifecycle and ownership inspection. */
export interface SessionsService {
  readonly SessionManager: SessionsRuntime["SessionManager"];
  readonly readSessionOwnerScope: SessionsRuntime["readSessionOwnerScope"];
}

export const SESSIONS_CAPABILITY: Capability<SessionsService> =
  defineCapability<SessionsService>("sessions");
