import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type CompactionRuntime = typeof import("@friday/compaction");

/** Session-history compaction exposed without leaking the whole implementation module. */
export interface CompactionService {
  readonly compactSession: CompactionRuntime["compactSession"];
}

export const COMPACTION_CAPABILITY: Capability<CompactionService> =
  defineCapability<CompactionService>("compaction");
